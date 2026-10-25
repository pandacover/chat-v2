<img src="assets/icon.svg" width="64" height="64" alt="">

# chat-v2

chat-v2 is a desktop chat app for any model on [OpenRouter](https://openrouter.ai), and for Claude models on the [Claude API](https://platform.claude.com). It transcribes voice with [ElevenLabs](https://elevenlabs.io) Scribe. It is built with Electron, Svelte 5, and Effect.

## What it does

- Stores every chat in SQLite, with search, pins, renames, and a draft per chat.
- Branches a chat when you edit a message or regenerate a reply. **Fork** copies a chat up to any message into a new one.
- Keeps a reply going when you reload or close the window. If the app quits mid-reply, **Continue** resumes it.
- Remembers facts about you across chats. The **Memory** tab in Settings lists every version and restores any of them.
- Takes images, PDFs, and text files up to 25 MB each.
- Opens HTML artifacts from the model in a sandboxed side panel.
- Has a built-in browser that the model can use. It blocks ad and tracker hosts listed in `src/shared/blocklist.ts`.
- Lets the model work in your apps on Windows and macOS. See [Computer use](#computer-use).
- Researches a question in depth and writes a report that cites its sources. See [Research](#research).
- Transcribes voice input. Hold the mic button, or press `Ctrl+M` to start and stop.

## Run it from source

```bash
bun install
bun run dev
```

Open **Settings** with `Ctrl+,`, add your OpenRouter key, and pick a default model. Claude models on the Claude API, and research, need a Claude API key. Voice input needs an ElevenLabs key. The app encrypts the keys with the OS keychain. The `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` environment variables also work.

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

For tests, `OPENROUTER_BASE_URL`, `ANTHROPIC_BASE_URL` and `ELEVENLABS_BASE_URL` point the app at a mock server. `CHAT_V2_HEADLESS=1` keeps the window hidden.

## Computer use

Turn on **Computer** in the composer. The model sees the main screen and works in your apps with its own cursor. It clicks and types without moving your mouse. Drags borrow the pointer for under a second. A tag beside its cursor says what it is doing, and it can draw marks on the screen to show you where things are. **Stop** in the bar at the top of the screen ends the run.

A guard in `src/shared/computer.ts` checks every action. It hides system settings, security prompts, terminals, password managers, and chat-v2 itself from the model, and refuses input to them. You can add apps in Settings. A refused step ends the reply and asks you to do that step yourself.

On macOS, computer use needs Accessibility and Screen Recording permission. Linux has no computer use.

## Research

Turn on **Research** in the composer. Each reply in that chat searches the web, reads the pages that matter, and writes a report with numbered links to its sources and a source list at the end. The searches and reads show as steps while it works. Research uses the Claude API's web search and web fetch tools, which run on Anthropic's servers. Turn on **Browser** as well for pages those can't read, such as ones behind a login or built by JavaScript: the model then has both. With **Computer** on, research keeps the chat's Claude model rather than the computer use model.

Research runs on the chat's model if that is a Claude API model (`claude/…`). Otherwise it uses the research model in **Settings → Research**, which is Claude Opus 5.5 by default. That section also sets the depth (the effort) and the most searches one reply may make. A report usually costs $0.50 to $3: tokens at Claude API list prices, plus $0.01 a search. The cost shows under each reply.

Claude API models (`claude/…`) appear in the model picker once a Claude API key is saved. They also work for ordinary chats, the browser and computer use. The app sends them `fallbacks: "default"`, so a request Claude's safety classifiers decline is retried on the model Anthropic recommends. `src/main/claude.ts` converts the app's requests and the API's stream.

## Releases

Each push to `main` runs `.github/workflows/release.yml`. It builds a Windows installer and macOS builds for Apple silicon and Intel, then publishes them as a [GitHub release](https://github.com/pandacover/chat-v2/releases). Installed apps check for updates on launch and every 30 minutes.

The release workflow signs macOS builds with a self-signed certificate (`build/chat-v2-signing.cer`) and does not notarize them. The first open of a downloaded DMG needs **Open Anyway** in Privacy & Security settings. The `MAC_CERT_P12` and `MAC_CERT_PASSWORD` secrets hold the private key. Keep a backup of both. A new certificate resets every user's macOS permissions and stops installed apps from updating.

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
