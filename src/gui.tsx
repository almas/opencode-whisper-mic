/**
 * Whisper Mic — the GUI half of the plugin.
 *
 * Dictation streams: while you speak, short WAV clips are uploaded to the
 * local whisper.cpp bridge one after another, and each result is merged into
 * a live caption that grows as you talk — so by the time you stop, almost
 * everything is already on screen. Triggers: the mic button beside the
 * composer's send button, the header mic, or the palette command; a quick tap
 * starts hands-free mode, a second press ends the take.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Command, Plugin, SettingsPage, Slot, type MountedSession } from "@opencode/plugin/gui"
import { WhisperMicRpc, type BridgeInfo, type ModelList, type Prefs } from "./rpc"
import {
  TAP_MAX_MS,
  createOverlapWindower,
  encodeWavFromBlob,
  looksLikeAck,
  mergeTranscription,
  recordSegments,
  type RecorderHandle,
} from "./capture"

/** The host components we use; the public types keep the registry open, so we type the calls. */
interface IconProps {
  name: string
  size?: "small" | "normal" | "large"
  class?: string
  style?: JSX.CSSProperties
}

/** `SlotMap["session.header"]`: the session and active fields are reactive getters. */
interface HeaderProps {
  readonly screen: unknown
  readonly session: MountedSession
  readonly active: boolean
  readonly compact: boolean
}

interface RpcLike {
  bridge(input?: object): Promise<unknown>
  prefs(input?: object): Promise<unknown>
  models(input?: object): Promise<unknown>
  setPrefs(input: Partial<Prefs>): Promise<unknown>
}

/** Select value for a model path the scan did not find, so it stays editable. */
const CUSTOM_MODEL = "custom"

const formatSize = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`

const DEFAULT_PREFS: Prefs = {
  lang: "auto",
  threads: 8,
  whisperBin: "whisper-cli",
  model: "",
  stripSilence: true,
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const formatClock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

/** The microphone glyph, shared by the header button and the composer button. */
const MIC_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`

/** The stop square shown in place of the mic while recording. */
const STOP_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`

const ICON_STYLE = { display: "inline-flex", "align-items": "center", "justify-content": "center" } as const

/**
 * The GUI bundle can mount before the server half of the plugin answers RPC
 * (a window reload races the plugin loader), so bridge discovery retries for
 * a few seconds before giving up.
 */
async function retryRpc<T>(label: string, call: () => Promise<T>, attempts = 6, delayMs = 1000): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await call()
    } catch (error) {
      console.warn(`[whisper-mic] ${label} failed (${i + 1}/${attempts}): ${errorText(error)}`)
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  return undefined
}

export default Plugin.define({
  i18n: {
    en: {
      "whisper-mic.name": "Whisper Mic",
      "whisper-mic.action.start": "Dictate (whisper)",
      "whisper-mic.action.stop": "Stop dictation",
      "whisper-mic.action.busy": "Finishing transcription…",
      "whisper-mic.overlay.recording": "Listening",
      "whisper-mic.overlay.processing": "Transcribing…",
      "whisper-mic.overlay.hint": "Press the mic again to stop",
      "whisper-mic.inserted": "Dictation inserted",
      "whisper-mic.empty": "No speech recognized",
      "whisper-mic.empty.hint": "Check the microphone, or whisper's model path in Settings → Whisper Mic.",
      "whisper-mic.no-session": "Open a session to dictate into",
      "whisper-mic.copied": "Nothing to insert — the text was copied instead.",
      "whisper-mic.error": "Whisper Mic",
      "whisper-mic.mic-denied": "Microphone access was denied.",
      "whisper-mic.bridge-down": "The audio bridge is not running. Reload the window; if it stays down, check Settings → Whisper Mic.",
      "whisper-mic.command": "Command whisper runs for each clip",
      "whisper-mic.copy": "Copy",
      "whisper-mic.copied-done": "Copied",
      "whisper-mic.test": "Test (record 3 seconds)",
      "whisper-mic.test.running": "Recording 3 seconds — speak now…",
      "whisper-mic.test.ok": "Test passed",
      "whisper-mic.settings.title": "Whisper Mic",
      "whisper-mic.settings.intro":
        "Dictation streams to local whisper.cpp: speak, watch the caption grow, press the mic again to insert. The reply to the assistant is not spoken — this is input only.",
      "whisper-mic.settings.lang": "Language",
      "whisper-mic.settings.threads": "Threads",
      "whisper-mic.settings.bin": "whisper-cli path",
      "whisper-mic.settings.model": "Model file",
      "whisper-mic.settings.model.custom": "Other path…",
      "whisper-mic.settings.model.none": "No ggml model found on this machine",
      "whisper-mic.settings.model.missing": "That file is not there — transcription will fail until a model that exists is selected.",
      "whisper-mic.settings.model.rescan": "Rescan",
      "whisper-mic.settings.model.searched": "Looked in",
      "whisper-mic.settings.model.speed": "Bigger models transcribe better and slower.",
      "whisper-mic.test.silent": "whisper returned no text — nothing was picked up, or the model failed.",
      "whisper-mic.settings.strip": "Drop silence hallucinations (「ご視聴ありがとうございました」 etc.)",
      "whisper-mic.settings.bridge": "Bridge",
      "whisper-mic.settings.bridge.ready": "listening on",
      "whisper-mic.settings.bridge.down": "not running",
      "whisper-mic.lang.auto": "Auto-detect",
    },
    ja: {
      "whisper-mic.name": "Whisperマイク",
      "whisper-mic.action.start": "音声入力（whisper）",
      "whisper-mic.action.stop": "録音を停止",
      "whisper-mic.action.busy": "文字起こし中…",
      "whisper-mic.overlay.recording": "聞き取り中",
      "whisper-mic.overlay.processing": "文字起こし中…",
      "whisper-mic.overlay.hint": "もう一度マイクを押すと停止",
      "whisper-mic.inserted": "文字起こしを挿入しました",
      "whisper-mic.empty": "音声が認識されませんでした",
      "whisper-mic.empty.hint": "マイク、または設定 → Whisperマイクのモデルパスを確認してください。",
      "whisper-mic.no-session": "挿入先のセッションを開いてください",
      "whisper-mic.copied": "挿入できなかったためコピーしました",
      "whisper-mic.error": "Whisperマイク",
      "whisper-mic.mic-denied": "マイクへのアクセスが拒否されました。",
      "whisper-mic.bridge-down": "音声ブリッジが起動していません。ウィンドウを再読み込みしてください。改善しなければ設定 → Whisperマイクを確認してください。",
      "whisper-mic.command": "クリップごとにwhisperが実行するコマンド",
      "whisper-mic.copy": "コピー",
      "whisper-mic.copied-done": "コピーしました",
      "whisper-mic.test": "テスト（3秒録音）",
      "whisper-mic.test.running": "3秒録音します — 話してください…",
      "whisper-mic.test.ok": "テスト成功",
      "whisper-mic.settings.title": "Whisperマイク",
      "whisper-mic.settings.intro":
        "音声はローカルのwhisper.cppへストリーミングされます。話しながら字幕が育ち、もう一度マイクを押すと入力欄に挿入されます。読み上げ（TTS）とは別に、入力だけの機能です。",
      "whisper-mic.settings.lang": "言語",
      "whisper-mic.settings.threads": "スレッド数",
      "whisper-mic.settings.bin": "whisper-cliパス",
      "whisper-mic.settings.model": "モデルファイル",
      "whisper-mic.settings.model.custom": "その他のパス…",
      "whisper-mic.settings.model.none": "このマシンにggmlモデルが見当たりません",
      "whisper-mic.settings.model.missing": "ファイルが存在しません — 存在するモデルを選ぶまで文字起こしは失敗します。",
      "whisper-mic.settings.model.rescan": "再検索",
      "whisper-mic.settings.model.searched": "検索先",
      "whisper-mic.settings.model.speed": "モデルは大きいほど精度が上がりますが遅くなります。",
      "whisper-mic.test.silent": "whisperはテキストを返しませんでした — 音声が拾えていないか、モデルが失敗しています。",
      "whisper-mic.settings.strip": "無音の幻覚表現（「ご視聴ありがとうございました」等）を除去",
      "whisper-mic.settings.bridge": "ブリッジ",
      "whisper-mic.settings.bridge.ready": "待受中:",
      "whisper-mic.settings.bridge.down": "起動していません",
      "whisper-mic.lang.auto": "自動判定",
    },
  },
  setup(ctx) {
    const Icon = (ctx.ui as unknown as { Icon: (props: IconProps) => JSX.Element }).Icon
    const rpc = ctx.client.rpc(WhisperMicRpc) as unknown as RpcLike

    // ---------- preferences + bridge discovery ----------
    const [prefs, setPrefs] = createSignal<Prefs>({ ...DEFAULT_PREFS })
    const [bridge, setBridge] = createSignal<BridgeInfo>()

    void retryRpc("prefs", () => rpc.prefs({})).then((value) => {
      if (value) setPrefs({ ...DEFAULT_PREFS, ...(value as Prefs) })
    })
    const refreshBridge = async () => {
      const value = await retryRpc("bridge", () => rpc.bridge({}))
      if (value) setBridge(value as BridgeInfo)
      return value as BridgeInfo | undefined
    }
    void refreshBridge()

    // Only the settings page shows this, but fetching at mount means the picker
    // is already filled when it opens, and a plain path box is the fallback if
    // the server half is too old to answer.
    const [modelList, setModelList] = createSignal<ModelList>()
    const refreshModels = async () => {
      const value = await retryRpc("models", () => rpc.models({}), 3)
      if (value) setModelList(value as ModelList)
    }
    void refreshModels()

    const savePrefs = async (patch: Partial<Prefs>) => {
      const next = { ...prefs(), ...patch }
      setPrefs(next)
      try {
        setPrefs((await rpc.setPrefs(next)) as Prefs)
      } catch (error) {
        ctx.toast.show({ title: ctx.t("whisper-mic.error"), description: errorText(error), variant: "error" })
      }
    }

    // ---------- dictation state ----------
    type Phase = "idle" | "recording" | "processing"
    const [phase, setPhase] = createSignal<Phase>("idle")
    const [caption, setCaption] = createSignal("")
    const [pending, setPending] = createSignal(0)
    const [elapsed, setElapsed] = createSignal(0)

    let recorder: RecorderHandle | undefined
    let startedAt = 0
    /** Whisper replies for short filler clips; keep them until a real reply confirms them. */
    let heldFragment = ""
    /** Overlaps each clip with the previous one; replaced at the start of every take. */
    let windower = createOverlapWindower()

    // Uploads are strictly serialized: the merge rule needs results in order.
    let uploadChain: Promise<void> = Promise.resolve()

    const transcribeClip = async (body: Blob | Uint8Array): Promise<string> => {
      const info = bridge() ?? (await refreshBridge())
      if (!info?.ready) throw new Error(ctx.t("whisper-mic.bridge-down"))
      const lang = prefs().lang || "auto"
      const response = await fetch(`${info.origin}/transcribe?lang=${encodeURIComponent(lang)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: body as BodyInit,
      })
      const payload = (await response.json().catch(() => undefined)) as { text?: string; error?: string } | undefined
      if (!response.ok) throw new Error(payload?.error ?? `bridge responded ${response.status}`)
      return (payload?.text ?? "").trim()
    }

    const absorb = (text: string) => {
      if (!text) return
      if (looksLikeAck(text)) {
        // A 4-second clip of "嗯"/"あ" is usually just a listener noise; hold
        // it so the next real reply can confirm or replace it.
        heldFragment = heldFragment ? `${heldFragment} ${text}` : text
        return
      }
      if (heldFragment) {
        // Keep the held noise only when the model repeats it in a longer take.
        text = text.startsWith(heldFragment) ? text : `${heldFragment} ${text}`
        heldFragment = ""
      }
      setCaption((current) => mergeTranscription(current, text))
    }

    const processSegment = (blob: Blob) => {
      // Anything under ~1 kB of encoded audio captured nothing usable.
      if (blob.size < 1024) return
      setPending((n) => n + 1)
      uploadChain = uploadChain
        .then(async () => {
          try {
            // Decode, overlap and resample inside the chain: whisper replies
            // must merge in recording order, and the resample is CPU work
            // worth serialising.
            absorb(await transcribeClip(await windower.push(blob)))
          } catch (error) {
            console.error(`[whisper-mic] clip failed: ${errorText(error)}`)
          } finally {
            setPending((n) => n - 1)
          }
        })
        .catch(() => {})
    }

    const copyToClipboard = async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    const insert = async (text: string) => {
      if (!text) {
        ctx.toast.show({
          title: ctx.t("whisper-mic.empty"),
          description: ctx.t("whisper-mic.empty.hint"),
          variant: "default",
        })
        return
      }
      const screen = ctx.screen.current()
      if (!screen) {
        if (await copyToClipboard(text)) {
          ctx.toast.show({ title: ctx.t("whisper-mic.no-session"), description: ctx.t("whisper-mic.copied"), variant: "default" })
        } else {
          ctx.toast.show({ title: ctx.t("whisper-mic.no-session"), variant: "default" })
        }
        return
      }
      const existing = screen.composer.text()
      const needsSpace = existing.length > 0 && !/\s$/.test(existing)
      screen.composer.insert(needsSpace ? ` ${text}` : text)
      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
      ctx.toast.show({ title: ctx.t("whisper-mic.inserted"), description: preview, variant: "success" })
    }

    const reset = () => {
      setCaption("")
      setPending(0)
      setElapsed(0)
      heldFragment = ""
      windower = createOverlapWindower()
    }

    const start = async () => {
      if (phase() !== "idle") return
      reset()
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        })
        startedAt = Date.now()
        setPhase("recording")
        setElapsed(0)
        void refreshBridge()

        // The take ends when the recorder flushes its final clip: stop()
        // resolves this promise through `onStopped`, after the last
        // `onSegment` (if any) has been queued on the upload chain.
        await new Promise<void>((resolve) => {
          recorder = recordSegments(stream, {
            onSegment: (blob) => void processSegment(blob),
            onStopped: () => resolve(),
          })
        })
        stream.getTracks().forEach((track) => track.stop())

        // Drain the upload chain, then insert.
        setPhase("processing")
        await uploadChain
        if (heldFragment) {
          // Only filler was recognized; append it if nothing else arrived.
          setCaption((current) => (current ? current : heldFragment))
          heldFragment = ""
        }
        await insert(caption())
      } catch (error) {
        const message = errorText(error)
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          ctx.toast.show({ title: ctx.t("whisper-mic.mic-denied"), variant: "error" })
        } else {
          ctx.toast.show({ title: ctx.t("whisper-mic.error"), description: message, variant: "error" })
        }
      } finally {
        recorder = undefined
        setPhase("idle")
        reset()
      }
    }

    const stop = () => {
      // A quick tap means "start hands-free": ignore the stop until the take
      // has lasted a beat.
      if (Date.now() - startedAt < TAP_MAX_MS) return
      recorder?.stop()
    }

    const toggle = () => {
      if (phase() === "idle") void start()
      else if (phase() === "recording") stop()
    }

    const ticker = setInterval(() => {
      if (phase() === "recording") setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    onCleanup(() => {
      clearInterval(ticker)
      recorder?.stop()
    })

    // ---------- palette command ----------
    ctx.add(Command, {
      id: "whisper-mic.record",
      get title() {
        return ctx.t("whisper-mic.action.start")
      },
      keywords: "whisper mic dictation stt microphone stream",
      // voice-input already owns mod+shift+m; sharing it would start both
      // recorders on one keypress, so each plugin gets its own key.
      bind: "mod+shift+d",
      section: "prompt",
      run: () => toggle(),
    })

    // ---------- composer control: a mic icon beside send ----------
    // Same host-styled injection the voice-input plugin uses: copy the submit
    // button's classes so it matches the composer footer, prune duplicates,
    // and show a red stop square while recording.
    const MIC_SELECTOR = 'button[data-oc-whisper-mic="1"]'

    // The button copies the submit button's classes for size and radius, but the
    // submit variant paints a filled accent square; unlayered styles here beat
    // the host's Tailwind layers, so the mic reads as a quiet ghost icon instead.
    const styleSheet = document.createElement("style")
    styleSheet.textContent = `
@keyframes wm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
[data-oc-whisper-mic="1"] {
  background: transparent !important;
  border-color: transparent !important;
  color: inherit;
  opacity: 0.75;
  margin-inline-end: 2px;
  flex-shrink: 0;
}
[data-oc-whisper-mic="1"]:hover { opacity: 1; background: color-mix(in oklab, currentColor 12%, transparent) !important; }
[data-oc-whisper-mic="1"][data-recording="1"] { opacity: 1; color: #e5484d; animation: wm-pulse 1s ease-in-out infinite; }
`
    document.head.append(styleSheet)
    onCleanup(() => styleSheet.remove())

    const syncMicButton = () => {
      const found = Array.from(document.querySelectorAll<HTMLElement>('[data-action="composer-submit"]'))
      const submits = found.filter((el) => !found.some((other) => other !== el && el.contains(other)))

      const footers = new Map<HTMLElement, HTMLElement>()
      for (const submit of submits) {
        const footer = submit.parentElement
        if (footer && !footers.has(footer)) footers.set(footer, submit)
      }

      // Prune mics whose footer lost its submit button, and extras.
      const kept = new Set<HTMLElement>()
      for (const mic of Array.from(document.querySelectorAll<HTMLButtonElement>(MIC_SELECTOR))) {
        const host = mic.parentElement
        if (!host || !footers.has(host) || kept.has(host)) {
          mic.remove()
          continue
        }
        kept.add(host)
      }

      for (const [footer, submit] of footers) {
        if (kept.has(footer)) continue
        const button = document.createElement("button")
        button.type = "button"
        button.setAttribute("data-oc-whisper-mic", "1")
        button.setAttribute("title", ctx.t("whisper-mic.action.start"))
        button.setAttribute("aria-label", ctx.t("whisper-mic.action.start"))
        for (const cls of submit.classList) button.classList.add(cls)
        button.style.setProperty("position", "relative")
        button.style.setProperty("z-index", "1")
        button.innerHTML = MIC_SVG
        button.dataset.icon = MIC_SVG
        button.dataset.recording = "0"
        button.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          toggle()
        })
        footer.insertBefore(button, submit)
      }
    }

    const paintMicButtons = () => {
      const recording = phase() === "recording"
      const icon = recording ? STOP_SVG : MIC_SVG
      const label = recording ? ctx.t("whisper-mic.action.stop") : ctx.t("whisper-mic.action.start")
      for (const mic of Array.from(document.querySelectorAll<HTMLButtonElement>(MIC_SELECTOR))) {
        // Compare the source string held on the element, never mic.innerHTML:
        // parsing then re-serialising an SVG rewrites self-closing tags and
        // adds attribute quotes, so that comparison never settles and the write
        // repeats forever — and each write is a childList mutation on the very
        // subtree composerObserver watches, which wedges the renderer.
        if (mic.dataset.icon !== icon) {
          mic.dataset.icon = icon
          mic.innerHTML = icon
        }
        const state = recording ? "1" : "0"
        if (mic.dataset.recording !== state) {
          mic.dataset.recording = state
          // Set only on the transition: getPropertyValue("color") reads back as
          // rgb(), so comparing it to a hex literal would never settle and every
          // paint would dirty the style attribute other plugins observe.
          mic.style.setProperty("color", recording ? "#e5484d" : "")
        }
        if (mic.title !== label) {
          mic.title = label
          mic.setAttribute("aria-label", label)
        }
      }
    }
    createEffect(paintMicButtons)

    let pendingSync = false
    const composerObserver = new MutationObserver(() => {
      if (pendingSync) return
      pendingSync = true
      queueMicrotask(() => {
        pendingSync = false
        syncMicButton()
        paintMicButtons()
      })
    })
    composerObserver.observe(document.body, { childList: true, subtree: true })
    const resync = setInterval(() => {
      syncMicButton()
      paintMicButtons()
    }, 2500)
    onMount(() => {
      syncMicButton()
      paintMicButtons()
    })
    onCleanup(() => {
      composerObserver.disconnect()
      clearInterval(resync)
      document.querySelectorAll(MIC_SELECTOR).forEach((el) => el.remove())
    })

    // ---------- header control ----------
    ctx.add(Slot, {
      at: "session.header",
      order: 37,
      render: (props: HeaderProps) => (
        <Show when={props.active}>
          <button
            type="button"
            title={
              phase() === "recording"
                ? `${ctx.t("whisper-mic.action.stop")} ${formatClock(elapsed())}`
                : phase() === "processing"
                  ? ctx.t("whisper-mic.action.busy")
                  : ctx.t("whisper-mic.action.start")
            }
            aria-label={ctx.t("whisper-mic.action.start")}
            onClick={toggle}
            style={{
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              height: "24px",
              padding: "0 6px",
              background: "transparent",
              border: "none",
              "border-radius": "4px",
              cursor: "pointer",
              color: phase() === "recording" ? "#e5484d" : "inherit",
            }}
          >
            <Show
              when={phase() === "processing"}
              fallback={<span style={ICON_STYLE} innerHTML={phase() === "recording" ? STOP_SVG : MIC_SVG} />}
            >
              <span style={{ ...ICON_STYLE, animation: "wm-pulse 1s ease-in-out infinite" }}>
                <Icon name="refresh" size="small" />
              </span>
            </Show>
          </button>
        </Show>
      ),
    })

    // ---------- live caption overlay ----------
    function Overlay() {
      return (
        <Portal mount={document.body}>
          <Show when={phase() !== "idle"}>
            <div
              style={{
                position: "fixed",
                bottom: "96px",
                left: "50%",
                transform: "translateX(-50%)",
                "z-index": "2147483000",
              }}
            >
              <div
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "6px",
                  padding: "10px 16px",
                  "max-width": "min(680px, 80vw)",
                  background: "rgba(20, 20, 22, 0.92)",
                  color: "#f2f2f2",
                  border: "1px solid rgba(255,255,255,0.12)",
                  "border-radius": "10px",
                  "box-shadow": "0 8px 30px rgba(0,0,0,0.35)",
                  "font-size": "13px",
                }}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                  <Show when={phase() === "recording"}>
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        "border-radius": "50%",
                        background: "#e5484d",
                        animation: "wm-pulse 1s ease-in-out infinite",
                      }}
                    />
                    <span style={{ "font-weight": "600", "font-variant-numeric": "tabular-nums" }}>
                      {ctx.t("whisper-mic.overlay.recording")} {formatClock(elapsed())}
                    </span>
                    <span style={{ opacity: 0.6 }}>{ctx.t("whisper-mic.overlay.hint")}</span>
                  </Show>
                  <Show when={phase() === "processing" || pending() > 0}>
                    <span style={{ display: "inline-flex", animation: "wm-pulse 1.2s ease-in-out infinite" }}>
                      <Icon name="refresh" size="small" />
                    </span>
                    <span style={{ "font-weight": "600" }}>{ctx.t("whisper-mic.overlay.processing")}</span>
                  </Show>
                </div>
                <Show when={caption()}>
                  <div style={{ "line-height": 1.5, "white-space": "pre-wrap", "word-break": "break-word" }}>{caption()}</div>
                </Show>
              </div>
            </div>
          </Show>
        </Portal>
      )
    }
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => <Overlay />,
    })

    // ---------- settings ----------
    const CODE_STYLE = {
      padding: "8px 10px",
      background: "rgba(127,127,127,0.12)",
      border: "1px solid rgba(127,127,127,0.25)",
      "border-radius": "6px",
      "font-family": "monospace",
      "font-size": "12px",
      "white-space": "pre-wrap",
      "word-break": "break-all",
    } as const
    const fieldStyle = { padding: "4px 8px", "min-width": "320px", "max-width": "480px" } as const
    const labelStyle = { display: "flex", "flex-direction": "column", gap: "6px" } as const

    const [copied, setCopied] = createSignal(false)
    const [testState, setTestState] = createSignal<"idle" | "recording" | "running" | "ok" | "empty">("idle")
    const [testResult, setTestResult] = createSignal("")

    const runTest = async () => {
      if (testState() === "recording" || testState() === "running") return
      setTestState("recording")
      setTestResult("")
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const wav = await new Promise<Blob>((resolve, reject) => {
          const recorder = new MediaRecorder(stream)
          const chunks: BlobPart[] = []
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data)
          }
          recorder.onerror = () => reject(new Error("recording failed"))
          recorder.onstop = () => {
            stream.getTracks().forEach((track) => track.stop())
            void encodeWavFromBlob(new Blob(chunks, { type: recorder.mimeType }))
              .then(resolve)
              .catch(reject)
          }
          recorder.start()
          setTimeout(() => {
            if (recorder.state !== "inactive") recorder.stop()
          }, 3000)
        })
        setTestState("running")
        const text = await transcribeClip(wav)
        setTestResult(text)
        setTestState(text ? "ok" : "empty")
      } catch (error) {
        setTestResult(errorText(error))
        setTestState("idle")
        ctx.toast.show({ title: ctx.t("whisper-mic.error"), description: errorText(error), variant: "error" })
      }
    }

    /** A configured path the scan did not find still has to be selectable and editable. */
    const modelChoice = () => {
      const list = modelList()
      if (!list) return CUSTOM_MODEL
      return list.models.some((model) => model.path === prefs().model) ? prefs().model : CUSTOM_MODEL
    }

    ctx.add(SettingsPage, {
      id: "whisper-mic",
      get title() {
        return ctx.t("whisper-mic.settings.title")
      },
      icon: "outline-audio",
      render: () => (
        <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "4px 0", "font-size": "13px" }}>
          <p style={{ margin: 0, opacity: 0.75, "line-height": 1.5 }}>{ctx.t("whisper-mic.settings.intro")}</p>

          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <span style={{ opacity: 0.75 }}>{ctx.t("whisper-mic.settings.bridge")}</span>
            <Show
              when={bridge()?.ready}
              fallback={<span style={{ color: "#e5484d" }}>{ctx.t("whisper-mic.settings.bridge.down")}</span>}
            >
              <span style={{ "font-family": "monospace", "font-size": "12px" }}>
                {ctx.t("whisper-mic.settings.bridge.ready")} {bridge()?.origin}
              </span>
            </Show>
          </div>

          <label style={labelStyle}>
            <span>{ctx.t("whisper-mic.settings.lang")}</span>
            <select value={prefs().lang} onChange={(event) => void savePrefs({ lang: event.currentTarget.value })} style={fieldStyle}>
              <option value="auto">{ctx.t("whisper-mic.lang.auto")}</option>
              <option value="ja">日本語</option>
              <option value="en">English</option>
              <option value="zh">中文</option>
              <option value="ko">한국어</option>
            </select>
          </label>

          <label style={labelStyle}>
            <span>{ctx.t("whisper-mic.settings.threads")}</span>
            <input
              type="number"
              min="1"
              max="64"
              value={prefs().threads}
              onChange={(event) => void savePrefs({ threads: Number(event.currentTarget.value) })}
              style={fieldStyle}
            />
          </label>

          <label style={labelStyle}>
            <span>{ctx.t("whisper-mic.settings.bin")}</span>
            <input
              type="text"
              value={prefs().whisperBin}
              onChange={(event) => void savePrefs({ whisperBin: event.currentTarget.value })}
              style={fieldStyle}
            />
          </label>

          <div style={labelStyle}>
            <span>{ctx.t("whisper-mic.settings.model")}</span>
            <Show
              when={modelList()}
              fallback={
                <input
                  type="text"
                  value={prefs().model}
                  onChange={(event) => void savePrefs({ model: event.currentTarget.value })}
                  style={fieldStyle}
                />
              }
            >
              {(list) => (
                <>
                  <select
                    value={modelChoice()}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      if (value !== CUSTOM_MODEL) void savePrefs({ model: value })
                    }}
                    style={fieldStyle}
                  >
                    <Show when={list().models.length === 0}>
                      <option value="">{ctx.t("whisper-mic.settings.model.none")}</option>
                    </Show>
                    <For each={list().models}>
                      {(model) => (
                        <option value={model.path}>
                          {model.name} · {formatSize(model.bytes)}
                        </option>
                      )}
                    </For>
                    <Show when={modelChoice() === CUSTOM_MODEL}>
                      <option value={CUSTOM_MODEL}>{ctx.t("whisper-mic.settings.model.custom")}</option>
                    </Show>
                  </select>
                  <Show when={modelChoice() === CUSTOM_MODEL}>
                    <input
                      type="text"
                      value={prefs().model}
                      onChange={(event) => void savePrefs({ model: event.currentTarget.value })}
                      style={fieldStyle}
                    />
                  </Show>
                  <Show when={!list().configuredExists}>
                    <span style={{ color: "#e5484d", "font-size": "12px" }}>
                      {ctx.t("whisper-mic.settings.model.missing")}
                    </span>
                  </Show>
                  <div style={{ display: "flex", gap: "8px", "align-items": "center", "font-size": "11px", opacity: 0.75 }}>
                    <button
                      type="button"
                      style={{ padding: "2px 8px", "border-radius": "6px", cursor: "pointer" }}
                      onClick={() => void refreshModels()}
                    >
                      {ctx.t("whisper-mic.settings.model.rescan")}
                    </button>
                    <span>
                      {ctx.t("whisper-mic.settings.model.searched")}: <code>{list().dirs.join("  ")}</code>
                    </span>
                  </div>
                  <span style={{ "font-size": "11px", opacity: 0.6 }}>{ctx.t("whisper-mic.settings.model.speed")}</span>
                </>
              )}
            </Show>
          </div>

          <label style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <input type="checkbox" checked={prefs().stripSilence} onChange={(event) => void savePrefs({ stripSilence: event.currentTarget.checked })} />
            <span>{ctx.t("whisper-mic.settings.strip")}</span>
          </label>

          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span style={{ opacity: 0.75 }}>{ctx.t("whisper-mic.command")}</span>
            <div style={{ display: "flex", gap: "8px", "align-items": "flex-start" }}>
              <code style={{ ...CODE_STYLE, flex: "1" }}>{bridge()?.command ?? "…"}</code>
              <button
                type="button"
                style={{ padding: "4px 10px", "border-radius": "6px", cursor: "pointer" }}
                onClick={() => {
                  const command = bridge()?.command ?? ""
                  if (!command) return
                  void navigator.clipboard.writeText(command).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
              >
                {copied() ? ctx.t("whisper-mic.copied-done") : ctx.t("whisper-mic.copy")}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", "align-items": "center", gap: "10px", "flex-wrap": "wrap" }}>
            <button
              type="button"
              style={{ padding: "6px 12px", "border-radius": "6px", cursor: "pointer" }}
              onClick={() => void runTest()}
            >
              {testState() === "recording" || testState() === "running" ? ctx.t("whisper-mic.test.running") : ctx.t("whisper-mic.test")}
            </button>
            <Show when={testState() === "empty"} fallback={
              <Show when={testState() === "ok"}>
                <span style={{ color: "#2fb457", "font-weight": "600" }}>{ctx.t("whisper-mic.test.ok")}</span>
              </Show>
            }>
              <span style={{ color: "#e5484d", "font-weight": "600" }}>{ctx.t("whisper-mic.test.silent")}</span>
            </Show>
            <Show when={testState() !== "empty" && testResult()}>
              <span style={{ "font-family": "monospace", "font-size": "12px", opacity: 0.85 }}>{testResult()}</span>
            </Show>
          </div>
        </div>
      ),
    })
  },
})
