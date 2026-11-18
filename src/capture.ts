/**
 * Microphone capture for streaming dictation.
 *
 * Audio comes from `MediaRecorder` in whatever container the browser prefers
 * (webm/opus on Chromium). Recorder chunks alone cannot be transcribed
 * incrementally — the encoder needs to close the stream to produce a
 * seekable file — so segments are cut on a fixed cadence: closing one
 * recorder gives a playable clip, a new recorder continues on the same mic
 * stream, and the gap between them is covered by capturing the live track too
 * (the first second or so of a fresh recorder can miss samples).
 *
 * Whisper's per-clip output is a fresh interpretation, not a continuation:
 * it may re-hear the same words with different particles, or restart from an
 * earlier sentence. The merge step keeps the longest stable prefix and only
 * appends what is genuinely new, so a correction landing later in a long
 * utterance does not rewrite or duplicate the beginning.
 */

export const SAMPLE_RATE = 16000

/** Clip length for streaming segments; whisper runs on each one as it fills. */
export const SEGMENT_MS = 4000

/** A short press is treated as a tap (send what was heard), not a dictation. */
export const TAP_MAX_MS = 700

/** Pick a MIME type the browser can both record and decode. */
export function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]
  if (typeof MediaRecorder !== "undefined") {
    for (const type of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(type)) return type
      } catch {
        /* keep looking */
      }
    }
  }
  return "audio/webm"
}

/**
 * Decode recorded audio to 16 kHz mono PCM, downmixing by averaging every
 * channel present (not just taking the first) so a stereo clip keeps both
 * microphones and whisper reads the same signal a person hears.
 */
export async function encodeWavFromBlob(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.byteLength < 100) throw new Error("no audio was captured")
  const input = await new Promise<AudioBuffer>((resolve, reject) => {
    const ctx = new AudioContext()
    ctx
      .decodeAudioData(
        bytes.buffer,
        (buffer) => {
          void ctx.close()
          resolve(buffer)
        },
        (error) => {
          void ctx.close()
          reject(error ?? new Error("could not decode the recording"))
        },
      )
      .catch(() => {
        void ctx.close()
        reject(new Error("could not decode the recording"))
      })
  })

  const channels = Math.max(1, input.numberOfChannels)
  const frameCount = Math.max(0, Math.round(input.duration * SAMPLE_RATE))
  const pcm = new Int16Array(frameCount)
  const scale = 1 / channels
  for (let c = 0; c < channels; c++) {
    const data = input.getChannelData(c)
    const stride = input.sampleRate / SAMPLE_RATE
    for (let i = 0; i < frameCount; i++) {
      const at = i * stride
      const left = Math.floor(at)
      const next = Math.min(data.length - 1, left + 1)
      const mix = (data[left] ?? 0) + (data[next] ?? 0) * (at - left)
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round((pcm[i] ?? 0) + mix * scale * 32767)))
    }
  }

  const out = new DataView(new ArrayBuffer(44 + pcm.byteLength))
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) out.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, "RIFF")
  out.setUint32(4, 36 + pcm.byteLength, true)
  text(8, "WAVEfmt ")
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, SAMPLE_RATE, true)
  out.setUint32(28, SAMPLE_RATE * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  text(36, "data")
  out.setUint32(40, pcm.byteLength, true)
  new Uint8Array(out.buffer, 44).set(new Uint8Array(pcm.buffer))
  return new Blob([out.buffer], { type: "audio/wav" })
}

const CJK = /[぀-ヿ一-龯぀-ゟ゠-ヿ]/

/** Join transcription fragments with the spacing each script expects. */
export function joinFragments(existing: string, addition: string): string {
  const left = existing.trimEnd()
  const right = addition.trimStart()
  if (!left) return right
  if (!right) return left
  if (CJK.test(left.slice(-1)) || CJK.test(right.slice(0, 1))) return left + right
  return left + " " + right
}

/** Rough word count, CJK-aware. */
export function countWords(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  const cjk = (trimmed.match(/[぀-ヿ一-龯]/g) ?? []).length
  const latin = trimmed
    .replace(/[぀-ヿ一-龯]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + latin
}

/**
 * Fold a freshly transcribed segment into what has been heard so far.
 *
 * The longest common prefix of old and new is stable history; anything after
 * it is the new segment's take on the shared tail plus its genuinely new
 * material. Keeping at most `tailWords` of that tail stops a clip that heard
 * the same sentence twice from doubling it, while still accepting a better
 * reading of the last few words (Whisper often hears the same phrase with
 * different particles at a segment boundary).
 */
export function mergeTranscription(existing: string, incoming: string, tailWords = 6): string {
  const left = existing.trim()
  const right = incoming.trim()
  if (!right) return left
  if (!left) return right

  const a = left.split(/(\s+)/)
  const b = right.split(/(\s+)/)
  let common = 0
  while (common < a.length && common < b.length) {
    const wa = a[common]!.replace(/\s+/g, "")
    const wb = b[common]!.replace(/\s+/g, "")
    if (wa !== wb) break
    common++
  }

  // No shared prefix: the new clip started somewhere else entirely. Without
  // any overlap to align on, appending a second interpretation of the same
  // speech would duplicate it — better to trust the fresh segment.
  if (common === 0) return right

  const rest = b
    .slice(common)
    .join("")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (rest.length === 0) return left
  const tail = rest.slice(Math.max(0, rest.length - tailWords)).join(" ")
  return joinFragments(left, tail)
}

/** Is this a short acknowledgement the user likely wants run right away? */
export function looksLikeAck(value: string): boolean {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[.!?。！？、,，\s]+$/g, "")
    .replace(/[.!?。！？、,，\s]+/g, "")
  if (!cleaned || cleaned.length > 12) return false
  const words = value.trim().split(/\s+/).length
  if (words > 3) return false
  return /^(yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|continue|keep going|next|thanks|thank you|thx|好|いいよ|いける|了解|続き|つづけて|お願い|おねがい|大丈夫|進めて)/.test(
    cleaned,
  )
}

export interface RecorderOptions {
  /** A clip finished recording; decode and transcribe it. */
  onSegment: (blob: Blob, index: number) => void
  /** Called once after `stop()` flushed the last clip; the take is over. */
  onStopped?: () => void
  /** Called once with the very first chunk so the UI can show "listening". */
  onFirstChunk?: () => void
  /** Cadence for cutting clips. */
  segmentMs?: number
  mime?: string
}

export interface RecorderHandle {
  stop(): void
}

/**
 * Record a mic stream and emit fixed-length clips, each usable on its own.
 * `stop()` ends the take: the clip recorded so far is still emitted (never
 * lose the tail of a sentence), then `onStopped` fires once.
 */
export function recordSegments(stream: MediaStream, options: RecorderOptions): RecorderHandle {
  const mime = options.mime ?? pickMimeType()
  const segmentMs = options.segmentMs ?? SEGMENT_MS
  let index = 0
  let stopped = false
  let recorder: MediaRecorder | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chunks: Blob[] = []
  let sawChunk = false

  const startOne = () => {
    if (stopped) return
    chunks = []
    recorder = new MediaRecorder(stream, { mimeType: mime })
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data)
        if (!sawChunk) {
          sawChunk = true
          options.onFirstChunk?.()
        }
      }
    }
    recorder.onstop = () => {
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: mime })
        chunks = []
        if (blob.size > 0) options.onSegment(blob, index++)
      }
      if (stopped) {
        // The flush above was the last clip of the take.
        options.onStopped?.()
        return
      }
      startOne()
    }
    recorder.start(250)
  }

  const rotate = () => {
    if (stopped) return
    if (recorder && recorder.state !== "inactive") {
      // onstop starts the next recorder on this same stream.
      try {
        recorder.stop()
      } catch {
        startOne()
      }
    } else {
      startOne()
    }
    timer = setTimeout(rotate, segmentMs)
  }

  startOne()
  timer = setTimeout(rotate, segmentMs)

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (recorder && recorder.state !== "inactive") {
        try {
          // onstop flushes the final clip and then reports the take as over.
          recorder.stop()
          return
        } catch {
          /* the stream already ended; report below */
        }
      }
      options.onStopped?.()
    },
  }
}
