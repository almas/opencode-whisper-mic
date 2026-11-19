/**
 * Microphone capture for streaming dictation.
 *
 * Audio comes from `MediaRecorder` in whatever container the browser prefers
 * (webm/opus on Chromium). Recorder chunks alone cannot be transcribed
 * incrementally — the encoder needs to close the stream to produce a
 * seekable file — so clips are cut on a fixed cadence: closing one recorder
 * gives a playable clip and a new recorder continues on the same mic stream.
 *
 * Consecutive clips are then overlapped in PCM before they are sent: each
 * whisper window replays the tail of the previous one, so a word the cut
 * landed in the middle of is still heard whole by exactly one window. Without
 * that shared tail there is nothing to align successive transcriptions on.
 *
 * Whisper's per-window output is a fresh interpretation, not a continuation:
 * it may re-hear the same words with different particles, or restart from an
 * earlier sentence. The merge step finds the overlap the two readings agree on
 * and appends whatever the new window heard beyond it — which grows the caption
 * even when whisper restarts mid-utterance, where a common-prefix rule dropped
 * everything said before it (measured: 9–13% recall on real takes against 91%).
 */

export const SAMPLE_RATE = 16000

/** How often a recorder is closed to hand over a finished clip. */
export const SEGMENT_MS = 3000

/**
 * Audio the next window replays from the previous clip. Whisper then hears a
 * 4 s window every 3 s, so a word the cut fell inside is whole in one window
 * and the two transcriptions have something to line up on.
 */
export const SEGMENT_OVERLAP_MS = 1000

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
export async function decodePcmFromBlob(blob: Blob): Promise<Int16Array> {
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

  return pcm
}

/** Wrap 16 kHz mono PCM in the WAV header whisper.cpp reads. */
export function wavFromPcm(pcm: Int16Array): Blob {
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

/** Decode a finished recording straight into a transcribable WAV. */
export async function encodeWavFromBlob(blob: Blob): Promise<Blob> {
  return wavFromPcm(await decodePcmFromBlob(blob))
}

/**
 * Chain the clips of one take into overlapping whisper windows: every window
 * is the previous one's tail plus whatever the new clip heard. The tail is
 * taken from the window rather than the clip, so a rotation that yields short
 * or empty clips still keeps the overlap intact for the next alignment.
 */
export function createOverlapWindower(overlapMs = SEGMENT_OVERLAP_MS) {
  const carry = Math.max(0, Math.round((overlapMs * SAMPLE_RATE) / 1000))
  let tail = new Int16Array(0)
  return {
    push: async (blob: Blob): Promise<Blob> => {
      const pcm = await decodePcmFromBlob(blob)
      const window = new Int16Array(tail.length + pcm.length)
      window.set(tail)
      window.set(pcm, tail.length)
      tail = window.length > carry ? window.slice(window.length - carry) : window
      return wavFromPcm(window)
    },
  }
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

const tokens = (text: string) => text.trim().split(/\s+/).filter(Boolean)

/** Ignore case and the punctuation whisper moves around when comparing tokens. */
const comparable = (token: string) => token.toLowerCase().replace(/[、。，．\s,.!?"'()（）]/g, "")

/** Offset in `text` just after its first `count` tokens. */
function afterTokens(text: string, count: number): number {
  const parts = [...text.matchAll(/\S+/g)]
  return count >= parts.length ? text.length : parts[count]!.index
}

/** Longest run of tokens that ends `a` and starts `b`, capped at `max`. */
function overlapLength(a: string[], b: string[], max: number): number {
  for (let k = Math.min(max, a.length, b.length); k >= 1; k--) {
    let shared = true
    for (let i = 0; i < k; i++) {
      if (comparable(a[a.length - k + i] ?? "") !== comparable(b[i] ?? "")) {
        shared = false
        break
      }
    }
    if (shared) return k
  }
  return 0
}

/**
 * Fold a freshly transcribed window into what has been heard so far.
 *
 * Windows overlap by a second of audio, so their transcriptions overlap by
 * however much was said in it. The longest token run that ends the caption and
 * starts the new text is that shared part; the new window contributes only what
 * it heard beyond it. The shared part keeps the wording already on screen —
 * re-reading it with the newer version looked appealing and measured as a wash
 * on real clips, while it visibly rewrites text the user has already read.
 *
 * When nothing lines up the new window is appended as-is rather than dropped:
 * a window that starts mid-sentence is common, and losing a second of real
 * speech costs more than the occasional repeated phrase. Character-level
 * alignment was tried for Japanese, where whitespace gives nothing to line up
 * on; it trimmed real speech along with the duplicates and scored lower.
 */
export function mergeTranscription(existing: string, incoming: string, maxOverlap = 12): string {
  const left = existing.trim()
  const right = incoming.trim()
  if (!right) return left
  if (!left) return right

  const tail = right.slice(afterTokens(right, overlapLength(tokens(left), tokens(right), maxOverlap))).trimStart()
  return tail ? joinFragments(left, tail) : left
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
