/**
 * Whisper Mic — the server half of the plugin.
 *
 * Starts the audio bridge (src/bridge.ts) and registers the `whisper-mic`
 * RPC domain so the GUI half can discover the bridge port and keep user
 * preferences. Transcription itself is a whisper-cli run per clip, with the
 * same local install (~/.local) the voice-input plugin uses.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { commandHint, startBridge, stripSilenceHallucinations, whisperCli, type BridgeHandle } from "./bridge"
import { WhisperMicRpc, type Prefs } from "./rpc"

const PREFS_KEY = "whisper-mic/prefs"

const LOCAL = join(homedir(), ".local")

function defaultWhisperBin(): string {
  const local = join(LOCAL, "bin/whisper-cli")
  return existsSync(local) ? local : "whisper-cli"
}

const DEFAULT_PREFS: Prefs = {
  lang: "auto",
  threads: 8,
  whisperBin: defaultWhisperBin(),
  model: join(LOCAL, "share/whisper-models/ggml-large-v3-turbo.bin"),
  stripSilence: true,
}

function normalizePrefs(stored: Partial<Prefs> | undefined): Prefs {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFS }
  const threads = Number(stored.threads)
  return {
    lang: typeof stored.lang === "string" && stored.lang ? stored.lang : DEFAULT_PREFS.lang,
    threads: Number.isFinite(threads) ? Math.max(1, Math.min(64, Math.round(threads))) : DEFAULT_PREFS.threads,
    whisperBin: typeof stored.whisperBin === "string" && stored.whisperBin ? stored.whisperBin : DEFAULT_PREFS.whisperBin,
    model: typeof stored.model === "string" && stored.model ? stored.model : DEFAULT_PREFS.model,
    stripSilence: stored.stripSilence !== false,
  }
}

export default Plugin.define({
  id: "whisper-mic",
  async setup(ctx) {
    let prefs: Prefs = { ...DEFAULT_PREFS }
    let bridge: BridgeHandle | undefined
    let bridgeError = ""

    try {
      const stored = (await ctx.storage.get(PREFS_KEY)) as Partial<Prefs> | undefined
      prefs = normalizePrefs(stored)
    } catch {
      /* first run */
    }

    const settings = () => ({ bin: prefs.whisperBin, model: prefs.model, threads: prefs.threads })

    const transcribe = async (request: { wav: Uint8Array; language: string }) => {
      const run = whisperCli(settings())
      const text = await run({ wav: request.wav, language: request.language || prefs.lang })
      return prefs.stripSilence ? stripSilenceHallucinations(text) : text
    }

    try {
      bridge = await startBridge({ onTranscribe: transcribe })
      console.info(`[whisper-mic] bridge listening on http://whisper-mic.localhost:${bridge.port}`)
    } catch (error) {
      bridgeError = error instanceof Error ? error.message : String(error)
      console.error(`[whisper-mic] bridge failed to start: ${bridgeError}`)
    }

    await ctx.rpc.register(WhisperMicRpc, {
      bridge: async () => ({
        port: bridge?.port ?? 0,
        origin: bridge ? `http://whisper-mic.localhost:${bridge.port}` : "",
        ready: Boolean(bridge),
        ...(bridgeError ? { error: bridgeError } : {}),
        command: commandHint(settings()),
      }),
      prefs: async () => ({ ...prefs }),
      setPrefs: async (raw) => {
        prefs = normalizePrefs({ ...prefs, ...(raw ?? {}) })
        try {
          await ctx.storage.set(PREFS_KEY, { ...prefs })
        } catch {
          /* keep the in-memory value even if storage is unavailable */
        }
        return { ...prefs }
      },
    })
  },
})
