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
import {
  commandHint,
  listModels,
  MODEL_DIRS,
  startBridge,
  stripSilenceHallucinations,
  whisperCli,
  type BridgeHandle,
} from "./bridge"
import { WhisperMicRpc, type Prefs } from "./rpc"

const PREFS_KEY = "whisper-mic/prefs"

const LOCAL = join(homedir(), ".local")

function defaultWhisperBin(): string {
  const local = join(LOCAL, "bin/whisper-cli")
  return existsSync(local) ? local : "whisper-cli"
}

const PREFERRED_MODEL = join(LOCAL, "share/whisper-models/ggml-large-v3-turbo.bin")

/** The biggest installed model, on machines that do not have the preferred one. */
async function defaultModel(): Promise<string> {
  if (existsSync(PREFERRED_MODEL)) return PREFERRED_MODEL
  const found = await listModels()
  return found[0]?.path ?? PREFERRED_MODEL
}

const DEFAULT_PREFS: Prefs = {
  lang: "auto",
  threads: 8,
  whisperBin: defaultWhisperBin(),
  model: PREFERRED_MODEL,
  stripSilence: true,
}

function normalizePrefs(stored: Partial<Prefs> | undefined, fallback: Prefs): Prefs {
  if (!stored || typeof stored !== "object") return { ...fallback }
  const threads = Number(stored.threads)
  return {
    lang: typeof stored.lang === "string" && stored.lang ? stored.lang : fallback.lang,
    threads: Number.isFinite(threads) ? Math.max(1, Math.min(64, Math.round(threads))) : fallback.threads,
    whisperBin: typeof stored.whisperBin === "string" && stored.whisperBin ? stored.whisperBin : fallback.whisperBin,
    model: typeof stored.model === "string" && stored.model ? stored.model : fallback.model,
    stripSilence: stored.stripSilence !== false,
  }
}

/**
 * A window reload re-runs setup() in the same server process. A bridge left
 * behind would hold the fixed port — pushing the next one onto an ephemeral one
 * the GUI has to rediscover — and keep transcribing with stale prefs, so this
 * module hands out exactly one handle.
 */
let owned: BridgeHandle | undefined

export default Plugin.define({
  id: "whisper-mic",
  async setup(ctx) {
    const defaults: Prefs = { ...DEFAULT_PREFS, model: await defaultModel() }
    let prefs: Prefs = { ...defaults }
    let bridge: BridgeHandle | undefined
    let bridgeError = ""

    try {
      const stored = (await ctx.storage.get(PREFS_KEY)) as Partial<Prefs> | undefined
      prefs = normalizePrefs(stored, defaults)
    } catch {
      /* first run */
    }

    const settings = () => ({ bin: prefs.whisperBin, model: prefs.model, threads: prefs.threads })

    const transcribe = async (request: { wav: Uint8Array; language: string }) => {
      const run = whisperCli(settings())
      const text = await run({ wav: request.wav, language: request.language || prefs.lang })
      return prefs.stripSilence ? stripSilenceHallucinations(text) : text
    }

    owned?.close()
    owned = undefined
    try {
      bridge = await startBridge({ onTranscribe: transcribe })
      owned = bridge
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
        command: commandHint(settings(), prefs.lang),
      }),
      prefs: async () => ({ ...prefs }),
      models: async () => {
        const models = await listModels()
        return {
          models,
          configured: prefs.model,
          configuredExists: existsSync(prefs.model),
          dirs: MODEL_DIRS,
        }
      },
      setPrefs: async (raw) => {
        prefs = normalizePrefs({ ...prefs, ...(raw ?? {}) }, defaults)
        try {
          await ctx.storage.set(PREFS_KEY, { ...prefs })
        } catch {
          /* keep the in-memory value even if storage is unavailable */
        }
        return { ...prefs }
      },
    })

    return () => {
      if (!bridge || owned !== bridge) return
      owned = undefined
      bridge.close()
      bridge = undefined
    }
  },
})
