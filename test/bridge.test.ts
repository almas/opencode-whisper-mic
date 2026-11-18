import { describe, expect, it } from "vitest"
import {
  bridgeHandler,
  commandHint,
  formatCommand,
  stripSilenceHallucinations,
  whisperArgs,
  type BridgeRequest,
} from "../src/bridge"

const SETTINGS = { bin: "/home/u/.local/bin/whisper-cli", model: "/m/ggml.bin", threads: 4 }

const post = (body: BodyInit, path = "/transcribe?lang=ja") =>
  new Request(`http://whisper-mic.localhost:2026${path}`, { method: "POST", body })

describe("bridgeHandler", () => {
  it("answers the health probe", async () => {
    const response = await bridgeHandler(new Request("http://x/health"), async () => "")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "whisper-mic" })
  })

  it("answers CORS preflight", async () => {
    const response = await bridgeHandler(new Request("http://x/transcribe", { method: "OPTIONS" }), async () => "")
    expect(response.status).toBe(200)
  })

  it("404s anything else", async () => {
    const response = await bridgeHandler(new Request("http://x/nope", { method: "POST", body: "x" }), async () => "")
    expect(response.status).toBe(404)
  })

  it("rejects clips too small to be audio", async () => {
    const response = await bridgeHandler(post(new Uint8Array(64)), async () => "")
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "empty audio" })
  })

  it("passes bytes and language to the transcriber and returns the text", async () => {
    let seen: BridgeRequest | undefined
    const response = await bridgeHandler(post(new Uint8Array(4096)), async (request) => {
      seen = request
      return "こんにちは"
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ text: "こんにちは" })
    expect(seen?.language).toBe("ja")
    expect(seen?.wav.byteLength).toBe(4096)
  })

  it("reports transcriber failures as a 500 with the message", async () => {
    const response = await bridgeHandler(post(new Uint8Array(4096)), async () => {
      throw new Error("whisper-cli exited 1")
    })
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: "whisper-cli exited 1" })
  })
})

describe("whisperArgs", () => {
  it("carries the flags the settings page promises", () => {
    const args = whisperArgs(SETTINGS, "/tmp/clip.wav", "/tmp/out", "ja")
    expect(args).toEqual([
      "-m", "/m/ggml.bin",
      "-f", "/tmp/clip.wav",
      "-l", "ja",
      "-mfa",
      "-nt",
      "-tp", "4",
      "-otxt",
      "-of", "/tmp/out",
    ])
  })

  it("falls back to auto detection for an empty language", () => {
    const args = whisperArgs(SETTINGS, "c.wav", "o", "")
    expect(args).toContain("auto")
  })
})

describe("commandHint", () => {
  it("quotes paths and shows the real binary", () => {
    expect(formatCommand("/bin/a b", ["-f", "it's"])).toBe("'/bin/a b' '-f' 'it'\\''s'")
    const hint = commandHint(SETTINGS)
    expect(hint).toContain("'/home/u/.local/bin/whisper-cli'")
    expect(hint).toContain("-mfa")
  })
})

describe("stripSilenceHallucinations", () => {
  it("drops the boilerplate whisper invents on silence", () => {
    expect(stripSilenceHallucinations("ご視聴ありがとうございました")).toBe("")
    expect(stripSilenceHallucinations("Thanks for watching!")).toBe("")
    expect(stripSilenceHallucinations("【音楽】")).toBe("")
  })

  it("keeps real speech intact", () => {
    expect(stripSilenceHallucinations("ビルドを走らせて")).toBe("ビルドを走らせて")
    expect(stripSilenceHallucinations("はい、ありがとう")).toBe("はい、ありがとう")
  })
})
