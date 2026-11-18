# Computer use

A port of Tomo's computer use. The model looks at the screen, reads and drives the user's apps, finds files, and in Show-me mode spotlights each control and waits for the user to do it. `index.ts` is the only entry point.

## Wiring it in

`src/main/index.ts` builds the layer, and `src/main/services/Chat.ts` uses it:

```ts
ComputerUse.layer({
  platform: supported ? makePlatform({ track: trackChild }) : null, // track: quitting ends the host
  overlay: makeElectronOverlay(), // never shown with CHAT_V2_HEADLESS=1
  remember: async (fact, ctx) => void db.changeMemory({ add: [fact], update: [], remove: [] }, { kind: 'learned', sessionId: ctx.sessionId })
})
```

- **A reply**: `computer.module(ctx, { mode, stop })` joins the reply's tool sets when its chat has computer use on. `mode` reads the chat's mode at every tool call; `stop` is the chat's Stop for that reply. Put `modeTag(mode, text)` in front of each user message. `effortFor(model)` gives Tomo's effort. The module's `end` releases its waits, and after the last computer reply turns content protection off and lets the Stop shortcut go.
- **Steps**: the module's own tools send steps with `tool: 'computer_<name>'`. Claude Code runs the built-ins (Read, Glob, Grep, WebSearch, Bash) itself; the module's `stepFor` (`builtinStep`) gives their lines, which the driver adds when each call's result comes back.
- **Stop**: the chat's Stop runs `computer.stop` as well as stopping the reply. Input stays off until `computer.userTurn`, which `module` runs. The overlay port holds the global Stop shortcut (`STOP_SHORTCUT` in `@shared/computer`) while a computer reply runs; pressing it runs `stop` and every running reply's `stop`.
- **Waits**: `computer.subscribe` reports the approval or Show-me step waiting on the user (with its `sessionId` and `messageId`), and `null` when none is. The chat answers with `computer.approve(id, approved)` and `computer.teachDone(id)`. A message the user types during a Show-me step goes to `teachDone(id, teachAnswer(text))`: "done" and the like finish the step, anything else is passed on. The overlay's Done resolves the step too.

## Behaviour

- Screenshots are 1024 px wide. Coordinates in screenshot pixels map to the monitor of the window being worked in.
- Before each input, focus goes back to the app the user was in. On Windows, when a chat-v2 window is in front, that app is the topmost app window under it in z-order. On macOS it is the app of the frontmost normal window that isn't chat-v2's.
- If the mouse moves more than 28 px from where computer use left it, the reply pauses.
- Windows only: a window running as administrator drops chat-v2's input, so the tools say so instead of trying.
- Every chat-v2 window has content protection while a computer reply runs, so none appears in screenshots. That also hides them from screen sharing for that time.

## Packaging

The Windows host (`host.ps1` and `host.cs`) is inlined in `platform/hostSource.ts`, so it ships inside app.asar. On first use it is written to `%LOCALAPPDATA%\chat-v2\computer-host\<hash>\`, and host.ps1 compiles the C# once into a DLL beside it. The first start takes about 1.5 s, later ones about 0.8 s.

## Tests

- `bun test test/computer`: Control, the tools and the policy against a fake platform, and the real Windows host with read-only calls only.
- `bun run build && bun test/computer/render-overlay.ts [dir]`: renders the acting frame and a Show-me step to PNGs without showing a window.
- `bun test/computer/live-look.ts ["request"]`: one look-only reply with the real SDK (Haiku, Show-me mode). It uses the Claude Code login.
- `bun test test/chat.test.ts -t "computer use"`: computer replies through the chat, with a fake `query` and platform.
- `node test/computer/e2e.mjs <playwright-core dir> [out dir]`, after `bun run build`: the hidden app with a scripted model and a fake platform (`CHAT_V2_FAKE_COMPUTER`). It clicks Approve and Deny, Show-me Done in the chat and in the overlay, and Stop, and captures the cards.
