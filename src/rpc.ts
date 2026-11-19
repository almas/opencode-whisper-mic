/**
 * Whisper Mic — RPC contract shared by the server and GUI halves.
 *
 * Plain JSON Schema literals: the server validates input and output with
 * them, and the GUI types its client proxy from the same definition. The
 * audio itself does not travel over RPC — clips go to the local bridge over
 * HTTP — this surface only carries the bridge location and preferences.
 */
import type { Rpc } from "@opencode/schema/rpc"

export type Prefs = {
  /** whisper language code ("auto" or "en", "ja", ...). */
  lang: string
  /** Inference threads passed to whisper-cli. */
  threads: number
  /** whisper-cli binary (absolute path or a name on PATH). */
  whisperBin: string
  /** ggml model file. */
  model: string
  /** Drop silence-hallucination phrases (on by default, rarely useful off). */
  stripSilence: boolean
}

export interface BridgeInfo {
  /** Port the bridge actually listens on (2026 unless it was taken). */
  port: number
  /** Origin the page should use; browsers resolve *.localhost to 127.0.0.1. */
  origin: string
  /** False while startup failed; `error` then explains why. */
  ready: boolean
  error?: string
  /** The whisper command currently in use, for display. */
  command: string
}

export interface ModelOption {
  /** Absolute path — this is also the value stored in `Prefs.model`. */
  path: string
  name: string
  bytes: number
}

/** What the model picker shows: installed models plus the state of the saved one. */
export interface ModelList {
  models: ModelOption[]
  configured: string
  configuredExists: boolean
  /** Directories the scan looked in, so the page can say where to put models. */
  dirs: string[]
}

export const WhisperMicRpc = {
  id: "whisper-mic",
  methods: {
    // Where the audio bridge lives, plus the command it runs.
    bridge: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          port: { type: "number" },
          origin: { type: "string" },
          ready: { type: "boolean" },
          error: { type: "string" },
          command: { type: "string" },
        },
        required: ["port", "origin", "ready", "command"],
      },
    },
    // Preferences.
    prefs: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
          stripSilence: { type: "boolean" },
        },
        required: ["lang", "threads", "whisperBin", "model", "stripSilence"],
      },
    },
    // Models already on disk, for the settings picker.
    models: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                name: { type: "string" },
                bytes: { type: "number" },
              },
              required: ["path", "name", "bytes"],
            },
          },
          configured: { type: "string" },
          configuredExists: { type: "boolean" },
          dirs: { type: "array", items: { type: "string" } },
        },
        required: ["models", "configured", "configuredExists", "dirs"],
      },
    },
    setPrefs: {
      input: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
          stripSilence: { type: "boolean" },
        },
      },
      output: {
        type: "object",
        properties: {
          lang: { type: "string" },
          threads: { type: "number" },
          whisperBin: { type: "string" },
          model: { type: "string" },
          stripSilence: { type: "boolean" },
        },
        required: ["lang", "threads", "whisperBin", "model", "stripSilence"],
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition
