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
bun run build:mac-capture  # macOS only: the Swift screen capture helper, see Computer use
```

> If `ELECTRON_RUN_AS_NODE=1` is set in your shell (some editors/terminals that are themselves Electron apps set it), unset it before `bun run dev`/`preview`, or Electron starts as plain Node.

## Releases and updates

Every push to `main` runs `.github/workflows/release.yml`. It sets the version to `0.1.<run number>`, builds a Windows installer (`.exe`) and, for Apple silicon (`-arm64`) and Intel (`-x64`), macOS `.dmg`s (first installs) and `.zip`s (updates), and publishes them as a [release of this repo](https://github.com/pandacover/chat-v2/releases) once the tests and every build have passed. A run that fails deletes its draft release.

Installed apps check for updates in the background on launch and every 30 minutes. One icon button at the bottom of the sidebar, beside the theme buttons, shows where an update is (`src/renderer/src/components/UpdateButton.svelte`, driven by the state machine in `src/main/updateMachine.ts`); hovering it shows a popover:

- **Up to date:** the retry arrows. Click to check now (they spin while it checks). The popover gives the version and when it was last checked, or why the last check failed.
- **Update available:** a download arrow. The popover shows the new version and what changed (the release notes, which the release step fills with the commit message). Click to download.
- **Downloading:** a ring filling with the download; the popover gives the percentage.
- **Ready:** a filled accent badge. Click to restart into the new version; otherwise it installs the next time the app quits.

Windows installs with NSIS. On macOS, Squirrel.Mac replaces the app in place; run from anywhere but Applications, the app offers to move itself there first, since it can't update itself otherwise.

**macOS signing.** There's no paid Apple Developer ID, so releases are signed with one long-lived self-signed certificate (`chat-v2 Code Signing`, made once by `scripts/make-mac-cert.sh`) and not notarised. The app's designated requirement is then `identifier "com.pandacover.chatv2" and certificate root = H"<the certificate's SHA-1>"`, the same for every version. That's what keeps macOS's permissions (Screen Recording, Accessibility, Automation, microphone) across updates, and what Squirrel.Mac checks before it installs one. An ad-hoc signature, as before, pins each build's own hash instead, so every update was a new app to macOS. The public certificate is `build/chat-v2-signing.cer`; the `.p12` and its password live outside the repository and in the `MAC_CERT_P12` and `MAC_CERT_PASSWORD` secrets. **Keep a backup of them: signing with a new certificate resets everyone's permissions and stops installed apps from updating.** CI (`scripts/ci-mac-signing.sh`) trusts the certificate on the runner so codesign will use it, and `scripts/ci-mac-verify.sh` fails the release unless every app and zip has that exact designated requirement. The **Mac signing proof** workflow (`.github/workflows/mac-signing-proof.yml`) builds two versions and checks the second satisfies the first's requirement, an ad-hoc build doesn't, and Squirrel.Mac really updates one to the other (`scripts/mac-update-proof.ts`). Without notarisation, macOS still asks on the first open of a downloaded DMG (System Settings → Privacy & Security → Open Anyway); updates aren't downloaded through a browser, so they aren't asked about. Branch builds (`check.yml`) are ad-hoc signed.

**Quitting.** Cmd+Q, the Dock's Quit and installing an update all hide the windows at once and stop the helper processes, then give the services up to 3 s to close (replies still streaming are marked interrupted) before the app exits regardless. Each step is logged with its time as `[quit] …`. `bun scripts/quit-smoke.ts` (after `bun run build`; CI runs it on macOS) checks the app exits within seconds, also when closing hangs, and leaves no helper process behind.

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

On Windows, input goes through one long-lived PowerShell process that compiles a small C# class over `user32` (`src/main/winHelper.ts`), so there are no native modules. It's per-monitor DPI aware, so coordinates are physical pixels on scaled displays too. It never moves the mouse. Clicks, drags and scrolls are posted to the innermost window under the point, inside the top-level window the guard checked, as the messages a real mouse would produce. The coordinates are converted for that window's DPI awareness. So you can keep using your mouse while it works. Drags are the exception: drag and drop between panels (a clip onto a timeline, a file into a folder) follows only the real mouse, so `borrowdrag` moves the pointer through the drag with `SendInput` and puts it back, unless that's turned off in Settings. Most Win32, Qt and Chromium apps take these clicks; some apps (games in particular, and some WinUI/UWP apps) ignore them, and the model is told to use the keyboard then. Keys and text go through `SendInput`, which needs the target app in front, so the app the model last clicked in is brought forward first. The screen is sent at up to 1280×800, and the model gives coordinates in those pixels. While computer use works, a hidden page (`src/renderer/capture.html`) keeps a stream of the primary display open, so a screenshot is the newest frame, drawn and encoded there in about 15 ms, instead of a `desktopCapturer.getSources` call (about 270 ms whatever the size). Until the stream is up, or if it fails, captures use `getSources`; `CHAT_V2_CAPTURE=sources` turns the stream off, to compare. Unlike `getSources`, the stream shows the user's mouse pointer, and the model is told to pay it no attention. The overlay is a transparent, click-through window with content protection (`WDA_EXCLUDEFROMCAPTURE`), so the model never sees its own cursor or marks.

The guard (`src/shared/computer.ts`) runs in the main process on every action, whatever the model asks:

- **Off limits:** Windows Settings and Control Panel, Windows Security, passkey and Windows Hello prompts, admin tools, terminals, Start, search and Run, password managers, browser pages about passwords, passkeys or settings, and chat-v2 itself. Add more apps or title words in Settings → Computer use.
- **Hidden:** the visible parts of protected windows are painted grey before the model sees the screen, and their titles aren't sent.
- **Refused:** clicks, drags and scrolls that would land in a protected window, typing or keys while one has focus, Windows-key shortcuts, Ctrl+Alt+Delete and Ctrl+Shift+Esc, and opening protected apps by name. A refusal ends the reply and tells you to do that step yourself.
- **Never reachable at all:** UAC prompts run on the secure desktop, where nothing can capture or click them, and Windows drops input to apps running as administrator.

To work out an app it doesn't know, the model searches with `browser_search` and reads pages with `browser_read`, which returns a page's main text (headings, numbered steps, tables) without menus, cookie banners or footers, about 10,000 characters at a time. Its instructions say to read two sources before acting, and to click or mark only what it can see in the latest screenshot. `computer_zoom` captures part of the screen at full resolution, so it can read small menu text first. Pages count as loaded once their own document is parsed and its text stops growing, so ad and tracker frames that never finish don't hold a read up. (Scripts run through `webContents.mainFrame`: `webContents.executeJavaScript` waits for the whole page, frames included.)

While a chat with computer use is open, the overlay stays up and its cursor follows your pointer (the main process polls the pointer, since the overlay lets every event through). Before the model starts acting, the cursor's tag shows what it's doing, like "Reading brawlhalla.wiki.gg". Each move glides for about 250 ms (drags 400 ms) before the real input fires, so you can follow it. While the model decides its next step, the cursor waits where it last acted with a spinner and "Deciding next step"; the next action, or the reply ending however it ends (Stop and errors included), takes it down. It's never up while an action waits for the screen or captures it, and the overlay is out of every capture anyway (content protection on Windows, left out of the stream on a Mac, or hidden for the moment of each screenshot when a Mac has no stream). After a task, the cursor comes back to you. The marks are hand-drawn by the cursor itself, stroke by stroke. Labels and the status bar are plain dark tags in the interface font from Settings → Appearance, so they read over any app. The status bar moves to the bottom when the cursor works near the top. Mouse forwarding, which on Windows takes a system-wide mouse hook, is on only while the bar is showing.

Only one chat can use the computer at a time. The chat window minimises while it works and comes back when the reply ends. If the model left marks on screen, the window stays down until you press **Show chat** or **Clear**.

Settings → Computer use → **Computer use model** picks the model that runs computer-use replies, so a chat can talk with one model and act with a faster one (empty uses the chat's model). It needs to see images, since every request carries a screenshot: if it can't, the vision model answers instead, and failing that the chat's model. The reply is saved and timed under the model that answered. Titles and memory keep their own models.

Most of a run's time is the model's wait before its first token, so steps are kept few and their requests cacheable:

- **The screen comes with the request.** The first request of a reply in a chat with computer use carries the window list and a screenshot, so the model can act on its first step instead of asking for a screenshot. Taking it doesn't take over the screen: the chat window stays up, and it minimises only when the first computer action runs (a reply that never acts never minimises it). On Windows the screenshot shows what's under the chat: for that one capture the app's windows get content protection (`WDA_EXCLUDEFROMCAPTURE`, as the overlay has), the capture waits 80 ms for the desktop to recompose and then takes a stream frame that came in at least 34 ms after protection was turned on, so it can't predate it (or a fresh one from `getSources` if none comes within 150 ms), and protection comes off straight after, so you can still screenshot or share the chat. The chat is left out of the window list too, so a protected window under it is still found and painted over. The first action's coordinates come from that screenshot, and they land on what was under the chat because the chat has minimised by then. On a Mac the stream never has the app's windows in it (see below), so the screenshot shows what's under the chat the same way, without anything to turn on or off. A Mac without the stream, where content protection doesn't reliably keep a window out of captures, paints the chat grey like any protected window, and if it covers more than half the screen the request gets the window list only. Whenever there's no screenshot (that case, or a failed capture), the model is told its first action's result brings one and to start with `computer_open_app` or `computer_focus_window` when it can, rather than spend a step on `computer_screenshot`. On a Mac this starts once computer use has been allowed: in this run, or before (checked without asking), so it never sets off a permission prompt.
- **Every action waits for the screen to settle.** After the input, it waits a short minimum, then probes a small thumbnail of the stream every 80 ms until two probes in a row show no change (the user's pointer moving doesn't count), at most 1.5 s. The screenshot it returns is the finished screen, and the model is told so, so it doesn't spend a step on `computer_screenshot`. If the screen was still changing at 1.5 s, the result says so. On a Mac the stream reports each change itself, so there's nothing to probe: an action ends once the screen has been still for 160 ms since the input (the two probes' worth, without waiting to take them). A Mac without the stream waits fixed times as before. Opening an app polls for its window every 120 ms; when a new window comes up, it then waits as `computer_wait` does (changed and held still for 0.5 s, or still for 1.2 s, at most 3 s), so the screenshot shows the app loaded rather than its splash or a blank window. A Mac without the stream waits 1 s for a new window.
- **Little waiting around the model.** The screen stream opens when a chat with computer use is opened, and again whenever you type in one, so a reply's first look is a frame already in hand; with nothing captured for 30 s it closes. Getting ready waits only until the minimised chat is off the window list, not for its animation: actions wait for the screen after acting anyway, and a plain `computer_screenshot` straight after lets it settle first (a Mac without the stream waits a fixed 350 ms as before). `computer_annotate` returns as soon as the marks are sent, so the model's next call runs while the cursor draws them; an action that would clear them waits until they're drawn.
- **Waiting ends when the screen is ready.** `computer_wait`'s `seconds` is a maximum. It probes the same way: after 0.5 s it returns once the screen has changed and then held still for 0.5 s, or after 2 s if nothing changes at all (so a still loading screen gets a chance), and never later than `seconds`. The overlay is out of the stream, and the user's pointer moving changes too little of the thumbnail to count. The result and the step label say how long it really waited ("Waited 1.8s") and whether the screen settled, never changed, or was still changing at the cap; the timing log's `wait` phase is that real time. The model is told a long maximum costs nothing. A Mac watches its stream's change reports the same way. Whether a run can watch the screen is settled when the reply starts, before the model is told: on a Mac without the stream (no helper, no permission yet, or it keeps failing), `computer_wait` waits the whole time for that run, and the model is told so.
- **Only the newest screenshot goes.** Each request carries the latest screenshot (the glance's included) and no other: when a new one comes, the one before becomes a short note. That screenshot was the end of the previous request, so everything before it is unchanged, and OpenAI, Gemini and the like serve it from their caches. Models whose wait grows with the images they get answer sooner too. For Claude, OpenRouter needs breakpoints: requests to `anthropic/` models mark the system prompt (which covers the tools) and the newest message without an image with `cache_control`, since a screenshot's message changes next step.
- **Thinking carries over.** The model's `reasoning_details` (or plain `reasoning`) from each step goes back on its assistant message with the tool calls, as OpenRouter sends them, so reasoning models keep their train of thought from step to step. This applies to browser runs too.
- **Little thinking per step.** Computer-use requests ask for `reasoning.effort` low by default (Settings → Computer use → Thinking between steps). Models that don't think ignore it; one that rejects it is asked again without it.

Each reply's model calls and actions, and where their time went, are logged to `timing.jsonl` in the data folder. `CHAT_V2_TIMING=1` also prints a table per reply to the console. There's no computer use on Linux: the switch doesn't appear there.

On macOS, the helper is one long-lived `osascript` process running JavaScript for Automation (`src/main/macHelper.ts`), which reaches CoreGraphics, AppKit and the Accessibility API through its Objective-C bridge, again with no native modules:

- **Windows:** it lists them with `CGWindowListCopyWindowInfo`, with each window's app name and bundle id.
- **Clicks and scrolls:** a click finds the element under the point inside the target app, via Accessibility, and presses it. That covers buttons, menu items, rows, tabs, links and checkboxes; text fields get the text cursor. Mac apps ignore most mouse events posted to them, but Accessibility actions they can't ignore, and each one reports whether it worked. Electron and Chromium apps are asked to build their accessibility tree first (`AXManualAccessibility`, `AXEnhancedUserInterface`). Scrolling moves the scroll area's scroll bar. Where nothing takes an action (a canvas, a game), mouse events are posted to the app instead, and the model is told the click may not have happened. The menu bar belongs to the window server, which posted events can't reach, so the model uses shortcuts or Ctrl+F2 for menus.
- **Menus by name:** `computer_menu` (Mac only) chooses menu-bar commands by name through System Events. If a name is wrong, the error lists what that menu has. Accessibility calls set up their reply slot the way the bridge accepts (it rejected the first attempt on a real Mac). If the bridge still refuses, a click falls back to System Events' `click at`.
- **Drags and timeline clicks:** macOS has no way to drag without the pointer, and an area an app draws itself (a video timeline, a canvas) doesn't respond to Accessibility. So these borrow the real pointer for under a second, as system events, and put it back where it was. Turn that off in Settings → Computer use → Borrow the pointer when needed. With it off, they're posted to the app as events, most apps ignore them, and the model is told to find another way.
- **Keys and text:** keys are posted as keyboard events. Text goes through System Events, and macOS asks once to let chat-v2 control it. Nothing the bridge hands back is released by hand: the bridge frees it itself, and releasing it again crashed the helper.
- **Permissions:** it needs Accessibility and Screen Recording. Turning it on asks for both and says what to allow in System Settings.
- **Protected apps:** System Settings, Keychain Access and Passwords, password and Touch ID prompts, terminals, script tools and Spotlight, as well as password managers. Cmd works as it does on a Mac. Cmd+Space, Cmd+Option+Esc and Ctrl+Cmd+Q are refused.
- **Screen capture:** a small Swift helper (`native/mac-capture/main.swift`, driven by `src/main/macCapture.ts` over the same line protocol as the other helpers) keeps a ScreenCaptureKit stream of the main display open while computer use works, opened and closed as the Windows stream is (opened when a computer chat is open or written in, closed after 10 s unused and when a reply ends). It runs at up to 15 frames a second. A screenshot is its newest frame, scaled, painted and encoded as a JPEG by the helper. The stream leaves out the app as a whole, so the overlay, the chat and anything it opens later are never in a frame, and nothing is hidden for a capture. The pointer isn't in it either. Each frame says whether the screen changed and which parts were redrawn; a frame counts as a change when those parts add up to 0.1% of the screen or more, so a blinking caret or a small spinner doesn't keep a wait going (about what Windows' thumbnails tolerate). Redraws that stay inside the menu bar don't count either: while any app records the screen, macOS pulses its recording indicator there about 30 times a second, and the clock ticks. A menu opening reaches below the bar, so it still counts. The helper needs no permission of its own: the app spawns it, so macOS counts its capture as chat-v2's, and it checks the permission (without asking) before touching ScreenCaptureKit. The app only starts it once its own permission check has passed. Without the helper (not built, failing, no Screen Recording permission, or macOS without ScreenCaptureKit) captures go through `getSources`, about 300 ms each, with the overlay hidden for the moment of each screenshot (macOS 15 captures windows even when they ask to be left out), and actions wait fixed times. `CHAT_V2_CAPTURE=sources` forces that, to compare. In `timing.jsonl` a stream capture shows as `capture.sck` (with the helper's `capture.draw`, `capture.cover` and `capture.encode`); a fallback shows as `capture.sources` and `capture.hide`.
- **Building the helper:** `bun run build:mac-capture` (macOS with Xcode's command-line tools) builds it universal (arm64 and x86_64) for macOS 13, Electron 44's minimum, into `native/mac-capture/out/`, where development runs find it. Elsewhere it says it's skipped, and the app works without it. Release builds compile it on the macOS runner and ship it in the app's `Resources`, signed with the app. `chat-v2-capture --selftest` prints the macOS version, the architecture, whether ScreenCaptureKit is there and whether Screen Recording is allowed, without capturing or asking. `bun scripts/mac-capture-smoke.ts` drives a real stream, screenshot and close-up and times them; CI runs it on every branch.
- **Untested:** the Mac side was written without a Mac to run it on. To see what the helper can reach, run `echo '1 state' | osascript -l JavaScript ~/Library/Application\ Support/chat-v2/computer-helper.js` after turning computer use on once. The first line lists the bridge functions it found (`has`) and whether it has Accessibility (`trusted`). The second lists the windows; if every title is empty, Screen Recording isn't reaching the helper. Run from Terminal, `trusted` is Terminal's permission, not chat-v2's. The `at:` lines on stderr name each step, so a crash shows where it happened, and the app's error names the same step. Builds before the self-signed ones were ad-hoc signed, so macOS may keep showing chat-v2 as allowed in Accessibility without honouring it. Remove it and add it again (or `tccutil reset Accessibility com.pandacover.chatv2`). The capture helper has been built and run on GitHub's macOS runners, but not yet with the app on a real Mac: `/Applications/chat-v2.app/Contents/Resources/chat-v2-capture --selftest` shows what it sees, and a computer-use reply's `timing.jsonl` lines show which path captured (`capture.sck` or `capture.sources`).

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
native/
  mac-capture/ the macOS screen capture helper (Swift, ScreenCaptureKit)
```

Messages form a tree (`parent_id`). Each node records its `active_child_id`, so the visible
conversation is a walk down from a hidden root. Branching and forking never mutate history.
