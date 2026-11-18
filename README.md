# opencode-whisper-mic

Streaming voice input (dictation) for **OpenCode Desktop**, powered by local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — no cloud keys, no Python, everything stays on your machine.

You talk, the caption grows while you talk: short WAV clips are streamed to a local whisper bridge one after another, and each result is merged into the live caption — so by the time you stop, almost everything is already on screen and the final pass is a short polish instead of a long wait.

日本語は[下のセクション](#日本語)にあります。

## Features

- **Streams while you speak** — the mic is captured in rotating 4-second clips (with a small overlap so words at the seams survive); each clip is transcribed as soon as it is uploaded and folded into the live caption by longest-common-prefix merge.
- **Three ways to start**: a mic button next to the composer send button, a mic button in the session header, and a command palette entry (default keybind `Ctrl/Cmd+Shift+M`). Click again (or the shortcut) to stop; a tap shorter than 0.7 s is ignored so accidental clicks do not cancel dictation.
- **Local whisper.cpp**: the plugin's server half runs a tiny HTTP bridge on `http://whisper-mic.localhost:2026` and invokes your `whisper-cli` with the model, language and thread count you set in the settings page. The exact command line is shown there verbatim, and a one-tap **Test** records 3 seconds through the full pipeline so you can hear/see the result immediately.
- **Sanitised output**: silence-hallucination boilerplate (「ご視聴ありがとうございました」, `[Applause]`, 【音楽】 …) is stripped before it ever reaches the caption.
- **Language-aware merge**: CJK text is joined without spaces; latin words keep theirs.

## Requirements

- OpenCode Desktop 2.x (the GUI half loads through the `./gui-experimental` export).
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) built locally, e.g. binaries at `~/.local/bin/whisper-cli` plus `libggml*` under `~/.local/usr/lib/x86_64-linux-gnu` (the plugin sets `LD_LIBRARY_PATH` to that directory automatically).
- A GGUF model, e.g. `ggml-small.bin` or `ggml-medium.bin`.

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "github:almas/opencode-whisper-mic" }
    // or: "/absolute/path/to/opencode-whisper-mic"
  ]
}
```

Reload the window, open **Settings → Whisper Mic**, point *Binary* and *Model* at your whisper.cpp build, press **Test**, and dictation is live.

## Usage

1. Focus the composer (or just press `Ctrl/Cmd+Shift+M`).
2. Speak. The caption under the header grows as whisper answers each clip.
3. Click the mic again to stop. The final merged text lands in the composer, ready to edit and send.

Short acknowledgement replies ("Yes.", "いいよ", "了解") that whisper sometimes hears while the assistant is speaking are held back instead of polluting your dictation.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # vite build -> dist/gui-experimental.cjs (commit it)
```

Layout:

| File | Role |
| --- | --- |
| `src/index.ts` | server half: `prefs`/`setPrefs`/`status` RPC + HTTP bridge lifecycle |
| `src/bridge.ts` | `Bun.serve`/`node:http` bridge, whisper-cli invocation, hallucination filter |
| `src/capture.ts` | MediaRecorder rotation, WAV encoding, transcription merge |
| `src/rpc.ts` | JSON contracts shared by both halves |
| `src/gui.tsx` | header/composer mic buttons, overlay caption, settings page |

## Troubleshooting

- **Nothing happens on stop** — check the settings page status line; if the bridge failed to start its error is shown there.
- **First request slow (~5 s)** — the plugin prefers `Bun.serve` (the OpenCode server's own runtime) and falls back to `node:http`; browsers talk to `whisper-mic.localhost` so the app's CSP stays happy.
- **No audio on Windows over RDP** — enable "Record from remote computer" in the RDP client; Chromium's legacy capture may need `chrome://flags` → "System Audio Capture".
- **Hallucinated Japanese on silence** — whisper invents YouTube outro text on quiet clips; it is stripped, but a noisy room still hurts accuracy. Use `medium` for Japanese.

## 日本語

OpenCode Desktop で使える、ローカル whisper.cpp による音声入力（ディクテーション）プラグインです。

- 話している最前から文字起こしが画面に育ちます: 4 秒ごとの音声クリップを順にブリッジへ送り、結果を接頭辞マッチで結合します。
- 起動は composer のマイク、ヘッダーのマイク、`Ctrl/Cmd+Shift+M`（コマンドパレット）の三経路。もう一度押すと停止します。
- 設定ページに whisper-cli の実行コマンドをそのまま表示、ワンタップの 3 秒テストで全経路を確認できます。
- 無音で湧くハルシネーション（「ご視聴ありがとうございました」等）は除去してから表示します。

whisper.cpp のビルド（`whisper-cli` と GGUF モデル）が必要です。`~/.config/opencode/opencode.jsonc` の `plugins` に登録し、ウィンドウを再読み込みしてください。

## License

MIT
