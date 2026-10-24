<img src="assets/icon.svg" width="64" height="64" alt="">

# chat-v2

chat-v2 is a desktop chat app for any model on [OpenRouter](https://openrouter.ai). It transcribes voice with [ElevenLabs](https://elevenlabs.io) Scribe. It is built with Electron, Svelte 5, and Effect.

## What it does

- Stores every chat in SQLite, with search, pins, renames, and a draft per chat.
- Branches a chat when you edit a message or regenerate a reply. **Fork** copies a chat up to any message into a new one.
- Keeps a reply going when you reload or close the window. If the app quits mid-reply, **Continue** resumes it.
- Remembers facts about you across chats. The **Memory** tab in Settings lists every version and restores any of them.
- Takes images, PDFs, and text files up to 25 MB each.
- Opens HTML artifacts from the model in a sandboxed side panel.
- Has a built-in browser that the model can use. It blocks ad and tracker hosts listed in `src/shared/blocklist.ts`.
- Lets the model work in your apps on Windows and macOS. See [Computer use](#computer-use).
- Transcribes voice input. Hold the mic button, or press `Ctrl+M` to start and stop.

## Run it from source

```bash
bun install
bun run dev
```

Open **Settings** with `Ctrl+,`, add your OpenRouter key, and pick a default model. Voice input also needs an ElevenLabs key. The app encrypts both keys with the OS keychain. The `OPENROUTER_API_KEY` and `ELEVENLABS_API_KEY` environment variables also work.

If your shell sets `ELECTRON_RUN_AS_NODE=1`, unset it first. Otherwise Electron starts as plain Node.

| Command | What it does |
| --- | --- |
| `bun run build` | Builds the production bundle into `out/`. |
| `bun run preview` | Runs the production bundle. |
| `bun run typecheck` | Runs `tsc` and `svelte-check`. |
| `bun test` | Runs the unit and integration tests. |
| `bun run build:mac-capture` | Builds the macOS screen capture helper. Needs the Xcode command-line tools. |

## Where your data lives

The app keeps its files in `%APPDATA%\chat-v2` on Windows, `~/Library/Application Support/chat-v2` on macOS, and `~/.config/chat-v2` on Linux.

- `config.json` holds the settings and the system prompt. You can edit it by hand.
- `secrets.json` holds the encrypted API keys.
- `chat.db` holds chats, branches, and memory.
- `attachments/` holds uploaded files.
- `timing.jsonl` logs where each computer-use reply spent its time.

For tests, `OPENROUTER_BASE_URL` and `ELEVENLABS_BASE_URL` point the app at a mock server. `CHAT_V2_HEADLESS=1` keeps the window hidden.

## Computer use

Turn on **Computer** in the composer. The model sees the main screen and works in your apps with its own cursor. It clicks and types without moving your mouse. Drags borrow the pointer for under a second. A tag beside its cursor says what it is doing, and it can draw marks on the screen to show you where things are. **Stop** in the bar at the top of the screen ends the run.

A guard in `src/shared/computer.ts` checks every action. It hides system settings, security prompts, terminals, password managers, and chat-v2 itself from the model, and refuses input to them. You can add apps in Settings. A refused step ends the reply and asks you to do that step yourself.

On macOS, computer use needs Accessibility and Screen Recording permission. Linux has no computer use.

## Releases

Each push to `main` runs `.github/workflows/release.yml`. It builds a Windows installer and macOS builds for Apple silicon and Intel, then publishes them as a [GitHub release](https://github.com/pandacover/chat-v2/releases). Installed apps check for updates on launch and every 30 minutes.

CI signs macOS builds with a self-signed certificate (`build/chat-v2-signing.cer`) and does not notarize them. The first open of a downloaded DMG needs **Open Anyway** in Privacy & Security settings. The `MAC_CERT_P12` and `MAC_CERT_PASSWORD` secrets hold the private key. Keep a backup of both. A new certificate resets every user's macOS permissions and stops installed apps from updating.

## Code layout

- `src/main` is the Electron main process. Its Effect services are in `src/main/services`.
- `src/renderer` is the Svelte 5 UI.
- `src/preload` exposes `window.api` to the renderer.
- `src/shared` holds code that the main process and the renderer share.
- `native/mac-capture` is the Swift helper that captures the screen on macOS.

Messages form a tree through `parent_id`. Edits, regenerations, and forks add messages and never change existing ones.

`bun scripts/make-icons.ts` regenerates the icons from `src/shared/logo.ts`.

## License

[MIT](LICENSE)
