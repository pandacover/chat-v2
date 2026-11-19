# Computer use

A port of Tomo's computer use. The model looks at the screen, reads and drives the user's apps, finds files, and in Show-me mode spotlights each control and waits for the user to do it. `index.ts` is the only entry point.

## Wiring it in

`src/main/index.ts` builds the layer, and `src/main/services/Chat.ts` uses it:

```ts
ComputerUse.layer({
  platform: supported ? makePlatform({ track: trackChild }) : null, // track: quitting ends the host
  overlay: makeElectronOverlay({ refocus }), // never shown with CHAT_V2_HEADLESS=1; refocus: platform.remember() then restoreFocus()
  remember: async (fact, ctx) => void db.changeMemory({ add: [fact], update: [], remove: [] }, { kind: 'learned', sessionId: ctx.sessionId })
})
```

- **A reply**: `computer.module(ctx, { mode, stop })` joins the reply's tool sets when its chat has computer use on. `mode` is read at every tool call; `stop` is the chat's Stop for that reply. `decideMode(text, previous)` reads a message for doing it or showing how (`intent.ts`, no model call); `previous` is what the chat's last message was read as, which follow-ups like "next" keep. Put `modeTag(mode, text)` in front of each user message. A "just do it" typed during a Show-me step (`handsOver`) switches the running reply to do. `effortFor(model)` gives Tomo's effort. The module's `end` releases its waits, and after the last computer reply turns content protection off and lets the Stop shortcut go.
- **Steps**: the module's own tools send steps with `tool: 'computer_<name>'`. Claude Code runs the built-ins (Read, Glob, Grep, WebSearch, Bash) itself; the module's `stepFor` (`builtinStep`) gives their lines, which the driver adds when each call's result comes back.
- **Stop**: the chat's Stop runs `computer.stop` as well as stopping the reply. Input stays off until `computer.userTurn`, which `module` runs. The overlay port holds the global Stop shortcut (`STOP_SHORTCUT` in `@shared/computer`) while a computer reply runs; pressing it runs `stop` and every running reply's `stop`.
- **Waits**: `computer.subscribe` reports the approval or Show-me step waiting on the user (with its `sessionId` and `messageId`), and `null` when none is. The chat answers with `computer.approve(id, approved)` and `computer.teachDone(id)`. A message the user types during a Show-me step goes to `teachDone(id, teachAnswer(text))`: "done" and the like finish the step, anything else is passed on. The overlay's Done resolves the step too.

## Behaviour

- The overlay (`overlay.ts`) is one full-screen, click-through window: the acting frame, the Show-me spotlight and its callout (draggable, kept where dragged until the next step 1), and the notch, shown while a computer reply runs and no chat-v2 window has focus. It takes the mouse only while the pointer is on the callout or the notch: main polls the pointer every 40 ms against the rects the page reports. Electron's `forward` option isn't used, because on Windows it is a low-level mouse hook that Windows drops when the main thread stalls. The window is focusable, because Chromium drops a click on a window that can't be activated (`MA_NOACTIVATEANDEAT`). After a press or a drag, `refocus` gives focus back to the app under it.
- The notch wraps a MacBook's camera housing. Electron doesn't report the housing, so `cameraHousing` reads it from the built-in screen: a menu bar of 30 pt or more, or a screen narrower than 1.58:1.
- Screenshots are 1024 px wide. Coordinates in screenshot pixels map to the monitor of the window being worked in.
- Before each input, focus goes back to the app the user was in. On Windows, when a chat-v2 window is in front, that app is the topmost app window under it in z-order. On macOS it is the app of the frontmost normal window that isn't chat-v2's.
- If the mouse moves more than 28 px from where computer use left it, the reply pauses.
- Windows only: a window running as administrator drops chat-v2's input, so the tools say so instead of trying.
- Linux (`platform/linux.ts`) needs an X11 display (not Wayland or XWayland) and the command-line tools `xdotool`, `xprop`, `wmctrl`, ImageMagick's `import`, `find`, `grep` and `xdg-open` (Debian: `xdotool x11-utils wmctrl imagemagick xdg-utils`); a missing tool is reported as such. The tools always run with a UTF-8 locale.
  - It can't read controls yet, so ui_elements fails and the Linux prompt tells the model to work from screenshots and pixels.
  - Linux can't hide windows from capture, so when chat-v2 is in front a screenshot first brings the remembered app back. The overlay isn't shown on Linux (without a compositor X11 draws it solid black over the screen); set `CHAT_V2_LINUX_OVERLAY=1` to show it on a desktop with a compositor.
  - Focus: restoreFocus falls back to the next app window if the remembered one closed, skips panels, docks and desktop windows, and fails if the app won't come to the front, so input never lands in chat-v2.
  - Typing: ASCII goes in short `xdotool type` chunks so Stop never cuts a key press in half. Non-ASCII characters are sent as Unicode key presses, capitals with Shift, because `xdotool type` lowercases capital non-ASCII letters.
  - Keys: names and punctuation are mapped to X keysyms (`ctrl+/` → `ctrl+slash`), and a key xdotool doesn't know is an error, not a silent no-op.
  - `open` takes a path, a URL, or an app by its name or command name, never a command line: arguments would run without the approval shell commands need.
- Every chat-v2 window has content protection while a computer reply runs, so none appears in screenshots. That also hides them from screen sharing for that time.

## Packaging

The Windows host (`host.ps1` and `host.cs`) is inlined in `platform/hostSource.ts`, so it ships inside app.asar. On first use it is written to `%LOCALAPPDATA%\chat-v2\computer-host\<hash>\`, and host.ps1 compiles the C# once into a DLL beside it. The first start takes about 1.5 s, later ones about 0.8 s.

## Tests

- `bun test test/computer`: Control, the tools and the policy against a fake platform, and the real Windows host with read-only calls only.
- `DISPLAY=:99 bun test test/computer/linux.test.ts`: the Linux parsers, and with an X display, window manager and xterm, the real Linux platform: windows, focus, screenshots, clicks, typing, Stop and file search. Without a display only the parsers run.
- `bun run build && bun test/computer/render-overlay.ts [dir]`: renders the acting frame, a Show-me step and the notch (also around a MacBook camera) to PNGs without showing a window.
- `bun test/computer/live-look.ts ["request"]`: one look-only reply with the real SDK (Haiku, teach mode). It uses the Claude Code login.
- `bun test test/chat.test.ts -t "computer use"`: computer replies through the chat, with a fake `query` and platform.
- `node test/computer/e2e.mjs <playwright-core dir> [out dir]`, after `bun run build`: the hidden app with a scripted model and a fake platform (`CHAT_V2_FAKE_COMPUTER`). It clicks Approve and Deny, Show-me Done in the chat and in the overlay, drags the callout, uses the notch and its Stop, and Stop, and captures the cards. With a stand-in pointer it checks the overlay takes the mouse only over its controls.
