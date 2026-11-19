/**
 * A tiny HTTP bridge for the microphone capture.
 *
 * The browser context cannot run programs, so recorded clips are POSTed here
 * and handed to whisper.cpp; the transcribed text comes back as JSON. The
 * page reaches the bridge through http://whisper-mic.localhost:<port>, which
 * browsers treat as a local (secure) origin — that is what keeps getUserMedia
 * available — while the OpenCode server's own port stays off-limits to page
 * fetches (a secure page refuses to mix in a different, non-allowlisted port).
 *
 * Two runtime notes, both measured rather than assumed:
 *
 *  - The bridge must run on `Bun.serve` when the host is Bun (which the
 *    OpenCode server always is). A node:http server on another port makes
 *    every browser fetch to it stall ~5 s before the request even lands —
 *    plain `curl` hits the same server instantly — so on Node the whole
 *    dictation pipeline would feel broken. `Bun.serve` answers immediately.
 *  - No WebSocket: replies ride on the same fetch that uploaded the clip, so
 *    there is one channel less that could hit the port policy above.
 */

import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/** Fixed origin port so the page can build its URL without a discovery step. */
export const BRIDGE_PORT = 2026

const MAX_BYTES = 8 * 1024 * 1024

/** The pieces of `Bun.serve` this file uses, typed locally to stay Bun-type-free. */
type BunServe = (options: {
  port: number
  hostname?: string
  fetch(request: Request): Response | Promise<Response>
}) => { port: number; stop?: (closeActiveConnections?: boolean) => void }

/* eslint-disable @typescript-eslint/no-explicit-any */
const bunServe = (): BunServe | undefined => (globalThis as any).Bun?.serve

export interface BridgeRequest {
  wav: Uint8Array
  language: string
}

/** One transcription run (a whisper.cpp call in production, a stub in tests). */
export type Transcriber = (request: BridgeRequest) => Promise<string>

export interface BridgeOptions {
  onTranscribe: Transcriber
  /** Fixed port (default {@link BRIDGE_PORT}); pass 0 for an ephemeral one. */
  port?: number
  /** Test seam: use another server implementation. */
  serverFactory?: () => Promise<BridgeHandle>
}

export interface BridgeHandle {
  port: number
  close(): void
}

/** Body limit enforced while streaming so a stray upload cannot grow in memory. */
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BYTES) throw new Error("audio too large")
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error("audio too large")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { ...CORS, "content-type": "application/json" } })

/** The whole request handler, shared by every server implementation. */
export async function bridgeHandler(request: Request, onTranscribe: Transcriber): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "OPTIONS") return json({ ok: true })
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "whisper-mic" })
  if (request.method !== "POST" || url.pathname !== "/transcribe") return json({ error: "not found" }, 404)

  const language = url.searchParams.get("lang") ?? "auto"
  try {
    const wav = await readBody(request)
    if (wav.byteLength < 2048) return json({ error: "empty audio" }, 400)
    const text = await onTranscribe({ wav, language })
    return json({ text })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}

/** Bun path: browsers connect with no stall; fixed port. */
function startBun(port: number, onTranscribe: Transcriber): BridgeHandle {
  const serve = bunServe()
  if (!serve) throw new Error("Bun.serve is not available")
  const server = serve({ port, hostname: "127.0.0.1", fetch: (request) => bridgeHandler(request, onTranscribe) })
  return { port: server.port, close: () => server.stop?.(true) }
}

/** node:http fallback for hosts without Bun (slower first request; see header). */
function startNode(port: number, onTranscribe: Transcriber): Promise<BridgeHandle> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<import("node:net").Socket>()
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on("data", (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BYTES) {
          res.writeHead(413)
          res.end()
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => {
        const localPort = (server.address() as { port?: number } | null)?.port ?? port
        const base = `http://127.0.0.1:${localPort}`
        void bridgeHandler(
          new Request(new URL(req.url ?? "/", base), {
            method: req.method,
            body: req.method === "POST" ? new Uint8Array(Buffer.concat(chunks)) : undefined,
          }),
          onTranscribe,
        )
          .then(async (response) => {
            res.writeHead(response.status, Object.fromEntries(response.headers))
            res.end(Buffer.from(await response.arrayBuffer()))
          })
          .catch(() => {
            res.writeHead(500)
            res.end()
          })
      })
    })
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    server.on("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        close: () => {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.close()
        },
      })
    })
  })
}

const isAddrInUse = (error: unknown) => error instanceof Error && (error as { code?: string }).code === "EADDRINUSE"

/** Start the bridge: the fixed port first, an ephemeral one if it is taken. */
export async function startBridge(options: BridgeOptions): Promise<BridgeHandle> {
  if (options.serverFactory) return options.serverFactory()
  const port = options.port ?? BRIDGE_PORT
  try {
    if (bunServe()) return startBun(port, options.onTranscribe)
    return await startNode(port, options.onTranscribe)
  } catch (error) {
    if (!isAddrInUse(error)) throw error
    if (bunServe()) return startBun(0, options.onTranscribe)
    return await startNode(0, options.onTranscribe)
  }
}

/* ------------------------------------------------------------------ */
/* whisper.cpp                                                          */
/* ------------------------------------------------------------------ */

const LOCAL = join(homedir(), ".local")
const LIB_DIR = join(LOCAL, "usr/lib/x86_64-linux-gnu")

/** whisper.cpp hallucinates these on silent clips; keeping them lies to the user. */
const SILENCE_HALLUCINATION_RE =
  /(ご視聴(?:いただき)?ありがとうございました|ご清聴ありがとうございました|字幕ご協力ありがとうございました|日本語の字幕を確認しました|チャンネル登録(?:を)?(?:お願いします|よろしくお願いします)?|thanks?\s+for\s+watching!?)/gi

/** Bracketed non-speech markers whisper invents: 【音楽】（拍手）[Applause]. */
const NON_SPEECH_MARKER = /[【[(（［][^】\])］（）()]{0,16}[】\])）］]/g

export function stripSilenceHallucinations(text: string): string {
  const out = text.replace(SILENCE_HALLUCINATION_RE, "").replace(NON_SPEECH_MARKER, "")
  return out
    .replace(/^[\s。、．!！？?,;:]+/, "")
    .replace(/[。、．!！？?,;:]{2,}$/, "。")
    .replace(/\s+/g, " ")
    .trim()
}

export interface WhisperSettings {
  bin: string
  model: string
  threads: number
}

/**
 * Prompt biasing for Japanese, where whisper otherwise writes the kanji it
 * expects instead of the kana it heard and drops particles; measured at +5–11
 * recall points over the bare `-l ja` on real clips.
 */
const JA_PROMPT = "技術的な内容を日本語で正しく書き起こします。"

/**
 * The exact flags we run; shown verbatim on the settings page.
 *
 * Flag meanings are build-specific and were checked against the installed
 * whisper-cli: threads are `-t` (`-tp` is --temperature, so `-tp 8` would run
 * at temperature 8), and there is no `-mfa` — an unknown argument there prints
 * usage and still exits 0, which loses the transcription silently.
 */
export function whisperArgs(settings: WhisperSettings, wavPath: string, outPath: string, language: string): string[] {
  const lang = language || "auto"
  return [
    "-m",
    settings.model,
    "-f",
    wavPath,
    "-l",
    lang,
    "-t",
    String(settings.threads),
    "-nt",
    "-np",
    ...(lang === "ja" ? ["-sns", "--prompt", JA_PROMPT, "--carry-initial-prompt"] : []),
    "-otxt",
    "-of",
    outPath,
  ]
}

/** One-line copyable form of a command (single-quote escaping included). */
export function formatCommand(bin: string, args: string[]): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  return [bin, ...args].map(quote).join(" ")
}

/**
 * One-line copyable form of what actually runs for the configured language,
 * so the settings page cannot promise flags the bridge does not pass.
 */
export function commandHint(settings: WhisperSettings, language = "auto"): string {
  return formatCommand(settings.bin, whisperArgs(settings, "CLIP.wav", "OUT", language))
}

/** Last lines of a command's output, for error messages that quote it. */
function tail(log: string): string {
  const clean = log.replace(/\s+/g, " ").trim()
  return clean ? `: ${clean.slice(-240)}` : ""
}

/* ------------------------------------------------------------------ */
/* model discovery                                                      */
/* ------------------------------------------------------------------ */

/** Where installed models usually live; the settings page lists what it finds. */
export const MODEL_DIRS = [
  join(LOCAL, "share/whisper-models"),
  join(homedir(), ".cache/whisper"),
  join(homedir(), "models"),
  "/usr/local/share/whisper-models",
]

export interface ModelFile {
  path: string
  name: string
  bytes: number
}

/**
 * ggml model files already on disk, largest (best) first. Directories that do
 * not exist are normal, not an error — this runs on every settings page open.
 */
export async function listModels(dirs: string[] = MODEL_DIRS): Promise<ModelFile[]> {
  const found = new Map<string, ModelFile>()
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^ggml.*\.bin$/i.test(name)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => undefined)
      if (info?.isFile()) found.set(path, { path, name, bytes: info.size })
    }
  }
  return [...found.values()].sort((a, b) => b.bytes - a.bytes)
}

/**
 * Default transcriber: write the clip to a temp WAV, run whisper-cli, read
 * the .txt it prints. `LD_LIBRARY_PATH` carries the local libwhisper install
 * because the desktop server's environment does not include ~/.local.
 */
export function whisperCli(settings: WhisperSettings): Transcriber {
  return async ({ wav, language }) => {
    if (!existsSync(settings.model)) throw new Error(`whisper model not found: ${settings.model}`)
    const dir = await mkdtemp(join(tmpdir(), "oc-mic-"))
    try {
      const wavPath = join(dir, "clip.wav")
      const outPath = join(dir, "clip")
      await writeFile(wavPath, wav)
      const env: NodeJS.ProcessEnv = { ...process.env }
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${LIB_DIR}:${env.LD_LIBRARY_PATH}` : LIB_DIR
      // whisper.cpp reports bad arguments on stdout and usage on stderr, and
      // both can come with exit 0, so the tail is what makes the failure
      // readable in the settings page instead of a bare ENOENT.
      let log = ""
      await new Promise<void>((resolve, reject) => {
        const child = spawn(settings.bin, whisperArgs(settings, wavPath, outPath, language), {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
        const keep = (chunk: Buffer) => {
          if (log.length < 4000) log += chunk.toString()
        }
        child.stdout?.on("data", keep)
        child.stderr?.on("data", keep)
        child.on("error", (error) => reject(new Error(`cannot start ${settings.bin}: ${error.message}`)))
        child.on("close", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`${settings.bin} exited ${code}${tail(log)}`))
        })
      })
      const text = await readFile(`${outPath}.txt`, "utf8").catch(() => undefined)
      if (text === undefined) {
        throw new Error(
          `${settings.bin} produced no text (model ${settings.model})${tail(log)} — check the model path and language in Settings.`,
        )
      }
      return text.replace(/\s+/g, " ").trim()
    } finally {
      void rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
