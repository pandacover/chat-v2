<img src="assets/icon.svg" width="64" height="64" alt="">

# chat-v2

A desktop chatbot built with Electron, Svelte 5 and Effect. It talks to any model on
[OpenRouter](https://openrouter.ai) and uses [ElevenLabs](https://elevenlabs.io) Scribe for speech-to-text.

## Features

| Feature | How it works |
| --- | --- |
| **Session history** | Every chat is stored in SQLite (`node:sqlite`, no native modules). The sidebar supports search, rename (double-click), pin and delete. A new chat is saved when its first message is sent, so empty chats never pile up. |
| **Drafts** | Each chat keeps its own unsent text and attachments. A chat with a draft moves to a **Drafts** group at the top of the sidebar, marked with a pen; a new chat appears there only while its composer has something in it. Draft text is kept on this device across restarts. |
| **Memory** | Each message you send is checked in the background, beside the reply. A local script first drops what you pasted (code, quotes, links) and skips messages that don't talk about you; the rest go to a model (`memoryModel`, Gemini 2.5 Flash with thinking off by default) with the facts so far, which replies with facts to add, change or remove. Passwords, keys and account numbers are filtered out. A chat gets the facts once, in its system prompt, as they were when it started. Every change is a version in SQLite, so Settings → Memory can show the history and restore any earlier version. Pick "None" to turn memory off. |
| **Chat titles** | A new chat is titled with the start of its first message right away. In the background, a small model (`titleModel`, Mistral NeMo by default, about $0.00001 a title) reads that message and renames the chat. A rename you make first is kept, and forks keep their "(fork)" title. Pick "None" in Settings to keep the first-message titles. |
| **File uploads** | Attach with the paperclip, drag and drop, or paste. Images go to vision models as `image_url` parts, PDFs as OpenRouter `file` parts (parsing engine set in Settings), and text/code files are inlined. 25 MB per file. |
| **Interactive artifacts** | The model wraps self-contained HTML/CSS/JS in `<artifact>` tags. Artifacts open in a side panel inside an opaque-origin sandboxed iframe, served from a custom `artifact://` scheme with its own CSP. The panel has preview/code tabs, a version switcher, copy, download and reload. |
| **Computer use** (Windows, macOS) | Turn on **Computer** in a chat's composer and the model can see the main screen and work in your apps there with its own cursor (your mouse stays yours), with the built-in browser to look up how an unfamiliar app works (it saves what it learns as per-app tips, listed in Settings). While computer mode is on, a sketched cursor follows your pointer. Give it a task or ask how to do something and it goes and does it: it glides to each target with a tag underneath saying what it's doing, and draws on the screen (circles, boxes, arrows, highlights, freehand lines) with labelled tags to show you where things are. A bar at the top of the screen has **Stop**. See [Computer use](#computer-use). |
| **Speech-to-text** | Push-to-talk on the mic button: hold to talk, or click to start and stop (`Ctrl+M`). Audio is recorded as WebM/Opus and transcribed by ElevenLabs (`scribe_v2` by default). |
| **Lists in the composer** | Shift+Enter on a Markdown list item (`-`, `*`, `+`, `1.`, `1)`, `- [ ]`) starts the next one, numbered. Shift+Enter on an empty item ends the list, or moves a nested item out a level. Tab and Shift+Tab nest and un-nest items. Numbered lists renumber when items are added, nested or deleted, and every change can be undone with Ctrl+Z. |
| **Reply to a passage** | Select text in a reply and a **Reply** button appears above it. It opens a one-line box; press Enter and the passage goes into the composer as a Markdown quote, with what you typed under it. Quote several passages, then send. |
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

Every push to `main` runs `.github/workflows/release.yml`. It tests, sets the version to `0.1.<run number>`, builds a Windows installer (`.exe`) and macOS `.dmg`s for Apple Silicon (`-arm64`) and Intel (`-x64`), and publishes them as a [release of this repo](https://github.com/pandacover/chat-v2/releases). It uses the workflow's own token, so no secrets are needed.

Installed apps check for updates on launch and every 30 minutes. When one is out, an update button appears at the bottom of the sidebar:

- **Windows:** downloads the update and restarts into it.
- **macOS:** builds are only ad-hoc signed (no Developer ID), so the app downloads the new DMG and opens it; drag chat-v2 into Applications to replace the old one. It fetches only the DMG for this Mac's processor (Apple silicon or Intel, read from the hardware, so an Intel build running under Rosetta moves to the native one), checks it against the release's checksum, and reuses a DMG it already downloaded instead of fetching it again.

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
    "artifactsEnabled": true,
    "titleModel": "mistralai/mistral-nemo",
    "memoryModel": "google/gemini-2.5-flash"
  }
  ```

- `secrets.json`: encrypted API keys (written by the app)
- `chat.db`: sessions, messages, branches, and memory (facts and their versions)
- `attachments/`: uploaded files

For automated testing, `OPENROUTER_BASE_URL` and `ELEVENLABS_BASE_URL` point the app at a mock server, and `CHAT_V2_HEADLESS=1` keeps the window hidden (it still renders, so Playwright can drive it and take screenshots).

## Computer use

On Windows, input goes through one long-lived PowerShell process that compiles a small C# class over `user32` (`src/main/winHelper.ts`), so there are no native modules. It's per-monitor DPI aware, so coordinates are physical pixels on scaled displays too. It never moves the mouse. Clicks, drags and scrolls are posted to the innermost window under the point, inside the top-level window the guard checked, as the messages a real mouse would produce. The coordinates are converted for that window's DPI awareness. So you can keep using your mouse while it works. Most Win32, Qt and Chromium apps take these clicks; some apps (games in particular, and some WinUI/UWP apps) ignore them, and the model is told to use the keyboard then. Keys and text go through `SendInput`, which needs the target app in front, so the app the model last clicked in is brought forward first. The screen is captured with Electron's `desktopCapturer` and sent at up to 1280×800. The model gives coordinates in those pixels. The overlay is a transparent, click-through window with content protection (`WDA_EXCLUDEFROMCAPTURE`), so the model never sees its own cursor or marks.

The guard (`src/shared/computer.ts`) runs in the main process on every action, whatever the model asks:

- **Off limits:** Windows Settings and Control Panel, Windows Security, passkey and Windows Hello prompts, admin tools, terminals, Start, search and Run, password managers, browser pages about passwords, passkeys or settings, and chat-v2 itself. Add more apps or title words in Settings → Computer use.
- **Hidden:** the visible parts of protected windows are painted grey before the model sees the screen, and their titles aren't sent.
- **Refused:** clicks, drags and scrolls that would land in a protected window, typing or keys while one has focus, Windows-key shortcuts, Ctrl+Alt+Delete and Ctrl+Shift+Esc, and opening protected apps by name. A refusal ends the reply and tells you to do that step yourself.
- **Never reachable at all:** UAC prompts run on the secure desktop, where nothing can capture or click them, and Windows drops input to apps running as administrator.

To work out an app it doesn't know, the model searches with `browser_search` and reads pages with `browser_read`, which returns a page's main text (headings, numbered steps, tables) without menus, cookie banners or footers, about 10,000 characters at a time. Its instructions say to read two sources before acting, and to click or mark only what it can see in the latest screenshot. `computer_zoom` captures part of the screen at full resolution, so it can read small menu text first. Pages count as loaded once their own document is parsed and its text stops growing, so ad and tracker frames that never finish don't hold a read up. (Scripts run through `webContents.mainFrame`: `webContents.executeJavaScript` waits for the whole page, frames included.)

While a chat with computer use is open, the overlay stays up and its cursor follows your pointer (the main process polls the pointer, since the overlay lets every event through). Before the model starts acting, the cursor's tag shows what it's doing, like "Reading brawlhalla.wiki.gg". After a task, the cursor comes back to you. The marks are hand-drawn by the cursor itself, stroke by stroke. Labels and the status bar are plain dark tags in the interface font from Settings → Appearance, so they read over any app. The status bar moves to the bottom when the cursor works near the top. Mouse forwarding, which on Windows takes a system-wide mouse hook, is on only while the bar is showing.

Only one chat can use the computer at a time. The chat window minimises while it works and comes back when the reply ends. If the model left marks on screen, the window stays down until you press **Show chat** or **Clear**. Only the latest three screenshots are kept in a request, so long runs don't grow without limit. There's no computer use on Linux: the switch doesn't appear there.

On macOS, the helper is one long-lived `osascript` process running JavaScript for Automation (`src/main/macHelper.ts`), which reaches CoreGraphics, AppKit and the Accessibility API through its Objective-C bridge, again with no native modules:

- **Windows:** it lists them with `CGWindowListCopyWindowInfo`, with each window's app name and bundle id.
- **Clicks and scrolls:** a click finds the element under the point inside the target app, via Accessibility, and presses it. That covers buttons, menu items, rows, tabs, links and checkboxes; text fields get the text cursor. Mac apps ignore most mouse events posted to them, but Accessibility actions they can't ignore, and each one reports whether it worked. Electron and Chromium apps are asked to build their accessibility tree first (`AXManualAccessibility`, `AXEnhancedUserInterface`). Scrolling moves the scroll area's scroll bar. Where nothing takes an action (a canvas, a game), mouse events are posted to the app instead, and the model is told the click may not have happened. The menu bar belongs to the window server, which posted events can't reach, so the model uses shortcuts or Ctrl+F2 for menus.
- **No dragging:** macOS has no way to drag without moving the pointer. A drag is posted as events, which most apps ignore, and the model is told to find another way or ask you.
- **Keys and text:** keys are posted as keyboard events. Text goes through System Events, and macOS asks once to let chat-v2 control it. Nothing the bridge hands back is released by hand: the bridge frees it itself, and releasing it again crashed the helper.
- **Permissions:** it needs Accessibility and Screen Recording. Turning it on asks for both and says what to allow in System Settings.
- **Protected apps:** System Settings, Keychain Access and Passwords, password and Touch ID prompts, terminals, script tools and Spotlight, as well as password managers. Cmd works as it does on a Mac. Cmd+Space, Cmd+Option+Esc and Ctrl+Cmd+Q are refused.
- **Overlay:** macOS 15 captures windows even when they ask to be left out, so the overlay is hidden for the moment of each screenshot.
- **Untested:** the Mac side was written without a Mac to run it on. To see what the helper can reach, run `echo '1 state' | osascript -l JavaScript ~/Library/Application\ Support/chat-v2/computer-helper.js` after turning computer use on once. The first line lists the bridge functions it found (`has`) and whether it has Accessibility (`trusted`). The second lists the windows; if every title is empty, Screen Recording isn't reaching the helper. Run from Terminal, `trusted` is Terminal's permission, not chat-v2's. The `at:` lines on stderr name each step, so a crash shows where it happened, and the app's error names the same step. Builds are ad-hoc signed, so after an update macOS may keep showing chat-v2 as allowed in Accessibility without honouring it. Remove it and add it again.

## Architecture

```
src/
  shared/      types, line buffer, artifact parser (used by main and renderer)
  main/        Electron main process: Effect services wired with Layers
    services/  Db (SQLite repo), SettingsStore, OpenRouter (SSE stream), ElevenLabs,
               Attachments, Chat (generation fibers, branching, durable streaming),
               Browser (the built-in browser), Computer (computer use)
    ipc.ts     IPC handlers → Effect programs; typed errors serialized as { tag, message }
    protocols.ts  artifact:// and attachment:// schemes
  preload/     contextBridge API (`window.api`)
  renderer/    Svelte 5 UI (runes store in lib/store.svelte.ts)
```

Messages form a tree (`parent_id`). Each node records its `active_child_id`, so the visible
conversation is a walk down from a hidden root. Branching and forking never mutate history.
