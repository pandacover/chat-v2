<img src="assets/icon.svg" width="64" height="64" alt="">

# chat-v2

A desktop chatbot built with Electron, Svelte 5 and Effect. It talks to any model on
[OpenRouter](https://openrouter.ai) and uses [ElevenLabs](https://elevenlabs.io) Scribe for speech-to-text.

## Features

| Feature | How it works |
| --- | --- |
| **Session history** | Every chat is stored in SQLite (`node:sqlite`, no native modules). The sidebar supports search, rename (double-click) and delete. |
| **File uploads** | Attach with the paperclip, drag and drop, or paste. Images go to vision models as `image_url` parts, PDFs as OpenRouter `file` parts (parsing engine set in Settings), and text/code files are inlined. 25 MB per file. |
| **Interactive artifacts** | The model wraps self-contained HTML/CSS/JS in `<artifact>` tags. Artifacts open in a side panel inside an opaque-origin sandboxed iframe, served from a custom `artifact://` scheme with its own CSP. The panel has preview/code tabs, a version switcher, copy, download and reload. |
| **Speech-to-text** | Push-to-talk on the mic button: hold to talk, or click to start and stop (`Ctrl+M`). Audio is recorded as WebM/Opus and transcribed by ElevenLabs (`scribe_v2` by default). |
| **Session branching** | Editing a message or regenerating a reply adds a sibling branch; switch with the `‹ 1/3 ›` arrows. "Fork" copies the conversation up to any message into a new, independent session. |
| **Durable streams** | Generation runs in the main process, not the window. Each completed line is written to the database *before* it is shown. Reloading or closing the window doesn't interrupt a reply; the window reattaches from its last line offset. If the app quits mid-reply, the reply is marked *interrupted* and **Continue** resumes it (via assistant prefill), joining any half-received line. |
| **Line-by-line streaming** | Token deltas are buffered in the main process and released only as complete lines (`src/shared/lines.ts`). |
| **System instructions** | A global system prompt lives in `config.json` (editable in Settings, or open the file directly; changes apply on the next message). Each chat can override it from its header. |
| **API keys** | Enter the OpenRouter and ElevenLabs keys in Settings. They are encrypted with the OS keychain (`safeStorage`) in `secrets.json`. `OPENROUTER_API_KEY` / `ELEVENLABS_API_KEY` environment variables also work. |

## Getting started

```bash
bun install
bun run dev        # Vite + Electron with HMR
```

Then open **Settings** (`Ctrl+,`), add your OpenRouter key (and your ElevenLabs key for voice input), and pick a default model.

Other scripts:

```bash
bun run build      # production bundle into out/
bun run preview    # run the production bundle
bun run typecheck  # tsc (main/preload) + svelte-check (renderer)
bun test           # unit + integration tests (line buffer, SSE, artifacts, chat engine)
```

> If `ELECTRON_RUN_AS_NODE=1` is set in your shell (some editors/terminals that are themselves Electron apps set it), unset it before `bun run dev`/`preview`, or Electron starts as plain Node.

## Releases and updates

Every push to `main` runs `.github/workflows/release.yml`. It tests, sets the version to `0.1.<run number>`, builds a Windows installer (`.exe`) and a macOS universal `.dmg`, and publishes them as a [release of this repo](https://github.com/pandacover/chat-v2/releases). It uses the workflow's own token, so no secrets are needed.

Installed apps check for updates on launch and every 30 minutes. When one is out, an update button appears at the bottom of the sidebar:

- **Windows:** downloads the update and restarts into it.
- **macOS:** builds are unsigned, so the app downloads the new DMG and opens it; drag chat-v2 into Applications to replace the old one.

The logo is generated: edit `src/shared/logo.ts`, then run `bun scripts/make-icons.ts`.

## Configuration

Files live in Electron's user-data folder (`%APPDATA%\chat-v2` on Windows, `~/Library/Application Support/chat-v2` on macOS, `~/.config/chat-v2` on Linux):

- `config.json`: settings and system instructions (hand-editable):

  ```json
  {
    "defaultModel": "openrouter/auto",
    "systemPrompt": "You are a helpful, concise assistant. Format answers with Markdown.",
    "temperature": 0.7,
    "sttModel": "scribe_v2",
    "sttLanguage": "",
    "pdfEngine": "cloudflare-ai",
    "artifactsEnabled": true
  }
  ```

- `secrets.json`: encrypted API keys (written by the app)
- `chat.db`: sessions, messages, branches
- `attachments/`: uploaded files

For automated testing, `OPENROUTER_BASE_URL` and `ELEVENLABS_BASE_URL` point the app at a mock server, and `CHAT_V2_HEADLESS=1` keeps the window hidden (it still renders, so Playwright can drive it and take screenshots).

## Architecture

```
src/
  shared/      types, line buffer, artifact parser (used by main and renderer)
  main/        Electron main process: Effect services wired with Layers
    services/  Db (SQLite repo), SettingsStore, OpenRouter (SSE stream), ElevenLabs,
               Attachments, Chat (generation fibers, branching, durable streaming)
    ipc.ts     IPC handlers → Effect programs; typed errors serialized as { tag, message }
    protocols.ts  artifact:// and attachment:// schemes
  preload/     contextBridge API (`window.api`)
  renderer/    Svelte 5 UI (runes store in lib/store.svelte.ts)
```

Messages form a tree (`parent_id`). Each node records its `active_child_id`, so the visible
conversation is a walk down from a hidden root. Branching and forking never mutate history.
