<img src="assets/icon.svg" width="64" height="64" alt="">

# chat-v2

chat-v2 is a desktop chat app for Claude. Replies run on Claude Code, which comes with the app, through the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). It transcribes voice with [ElevenLabs](https://elevenlabs.io) Scribe. It is built with Electron, Svelte 5, and Effect.

## What it does

- Chats with Fable 5.2, Opus 5.5, Sonnet 5.5 or Haiku 5.5, on your Claude sign-in or an Anthropic API key. Each reply shows its tokens and cost.
- Stores every chat in SQLite, with search, pins, renames, and a draft per chat.
- Branches a chat when you edit a message or regenerate a reply. **Fork** copies a chat up to any message into a new one.
- Keeps a reply going when you reload or close the window. If the app quits mid-reply, **Continue** resumes it.
- Remembers facts about you across chats. The **Memory** tab in Settings lists every version and restores any of them.
- Takes images, PDFs, and text files up to 25 MB each. Claude reads images and PDFs itself.
- Opens HTML artifacts from the model in a sandboxed side panel.
- Has a built-in browser that Claude can use. It blocks ad and tracker hosts listed in `src/shared/blocklist.ts`.
- Uses your computer on Windows and macOS: Claude looks at the screen, uses your apps and finds your files, or shows you each step to do yourself. See [Computer use](#computer-use).
- Transcribes voice input. Hold the mic button, or press `Ctrl+M` to start and stop.

## Run it from source

```bash
bun install
bun run dev
```

The app uses your Claude Code sign-in by default. If you haven't signed in yet, install [Claude Code](https://code.claude.com), run `claude`, and type `/login`. To use an Anthropic API key instead, open **Settings** with `Ctrl+,` and pick **API key** under **Account & keys**. Voice input also needs an ElevenLabs key. The app encrypts both keys with the OS keychain. The `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` environment variables also work.

If your shell sets `ELECTRON_RUN_AS_NODE=1`, unset it first. Otherwise Electron starts as plain Node.

| Command | What it does |
| --- | --- |
| `bun run build` | Builds the production bundle into `out/`. |
| `bun run preview` | Runs the production bundle. |
| `bun run typecheck` | Runs `tsc` and `svelte-check`. |
| `bun test` | Runs the unit and integration tests. |

## Computer use

Turn on **Computer** in the composer, and Claude can see your screen and use your apps in that chat. It is a port of Tomo's computer use, in `src/main/computer`.

There is nothing to switch: each message is read for what you want.

- **Doing it** ("draw me a cat", "turn on dark mode"): Claude clicks and types for you. Before each input it gives focus back to the app you were in. If you move the mouse, it pauses.
- **Showing you** ("show me how…", "how do I…", "walk me through…"): Claude never clicks or types. It highlights each control on screen with what to do, and waits. Press **Done** beside the highlight or in the chat, or type what happened. Type "just do it" to have it finish for you.
- A follow-up like "next" or a plain question carries on the way the chat was going.
- Drag the step box beside a highlight if it covers something you need; it stays there for the rest of the lesson.
- While the chat window isn't in front (minimised, or behind the app being used), a notch at the top of the screen says what Claude is doing, with **Stop**. Clicking it brings the chat back. On a MacBook with a camera notch it wraps around the camera.
- Before anything you can't take back (deleting, sending, buying, installing, changing settings), a card in the chat asks for your OK, and the chat window comes to the front. `Ctrl+Enter` (`⌘ Enter` on a Mac) approves once the button has filled; `Esc` denies.
- `Ctrl+Alt+Esc` (`⌃⌥Esc` on a Mac) stops a computer reply from any app, as Stop does. The app holds the shortcut only while a computer reply runs.
- Shell commands that only read run freely. Any other command, and any file write, asks first.
- While a computer reply runs, chat-v2's windows are left out of screenshots, which also hides them from screen sharing.
- Computer replies think at low effort on Sonnet and Haiku and medium on the others, whatever Settings say: they make many short look-and-click calls.
- On Windows, a window running as administrator drops chat-v2's input, and Claude says so.
- On macOS, chat-v2 needs Accessibility and Screen Recording permission. This side hasn't run on a Mac yet.

## Where your data lives

The app keeps its files in `%APPDATA%\chat-v2` on Windows, `~/Library/Application Support/chat-v2` on macOS, and `~/.config/chat-v2` on Linux.

- `config.json` holds the settings and the system prompt. You can edit it by hand.
- `secrets.json` holds the encrypted API keys.
- `chat.db` holds chats, branches, and memory.
- `attachments/` holds uploaded files.
- `claude/` is Claude Code's folder for the app. It holds the sessions each chat's turns resume from, so they stay out of your own `~/.claude` history. The sign-in is still the one `claude` keeps.

For tests, `CHAT_V2_FAKE_QUERY` names a module whose `query` stands in for the SDK's, `CHAT_V2_FAKE_COMPUTER` one whose `platform` stands in for the real computer, and `ELEVENLABS_BASE_URL` points voice input at a mock server. `CHAT_V2_HEADLESS=1` keeps the windows hidden. `node test/computer/e2e.mjs <playwright-core dir> [out dir]`, after `bun run build`, drives computer use in the hidden app with both.

## Releases

Each push to `main` runs `.github/workflows/release.yml`. It builds a Windows installer and macOS builds for Apple silicon and Intel, then publishes them as a [GitHub release](https://github.com/pandacover/chat-v2/releases). Each build carries the Claude Code binary for its platform and processor. Installed apps check for updates on launch and every 30 minutes.

The release workflow signs macOS builds with a self-signed certificate (`build/chat-v2-signing.cer`) and does not notarize them. The first open of a downloaded DMG needs **Open Anyway** in Privacy & Security settings. The `MAC_CERT_P12` and `MAC_CERT_PASSWORD` secrets hold the private key. Keep a backup of both. A new certificate resets every user's macOS permissions and stops installed apps from updating.

## Code layout

- `src/main` is the Electron main process. Its Effect services are in `src/main/services`.
- `src/main/agent` runs replies on the Claude Agent SDK. `driver.ts` makes the queries, `history.ts` picks the session a turn resumes, and `module.ts` is the contract for tool sets. The browser (`browser.ts`) is one: an in-process MCP server whose tools wait behind Claude Code's tool search until the model loads them. Computer use (`src/main/computer`, with its own README) is the other.
- `src/renderer` is the Svelte 5 UI.
- `src/preload` exposes `window.api` to the renderer.
- `src/shared` holds code that the main process and the renderer share.

Messages form a tree through `parent_id`. Edits, regenerations, and forks add messages and never change existing ones.

`bun scripts/make-icons.ts` regenerates the icons from `src/shared/logo.ts`.

## License

[MIT](LICENSE)
