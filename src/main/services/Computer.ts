// Computer use: the assistant sees the primary display and works its mouse and keyboard.
// Electron and Windows are injected (see desktop.ts and winHelper.ts), so this loads in tests.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import {
  type DesktopOs,
  type DesktopState,
  type Frame,
  type Hidden,
  type Mark,
  type MarkColor,
  type OverlayCommand,
  type WindowInfo,
  appName,
  hiddenRegions,
  inShot,
  makeFrame,
  parseKeys,
  protectedAppName,
  protectedChord,
  protectedReason,
  shotRect,
  toOverlay,
  toPhysical,
  windowAt
} from '@shared/computer'
import type { AppTip } from '@shared/types'
import type { ChatWindowsPort, OverlayPort, ScreenPort } from '../desktop'
import { errorMessage } from '../errors'
import type { Driver } from '../driver'
import { AppPaths } from './AppPaths'
import { SettingsStore } from './SettingsStore'

/** `blocked`: the guard refused, which ends the run's control. */
export class ComputerError extends Schema.TaggedError<ComputerError>()('ComputerError', {
  message: Schema.String,
  kind: Schema.Literals(['failed', 'blocked'])
}) {}

/** What the model gets back after looking or acting. */
export interface Look {
  image: string
  frame: Frame
  text: string
}

export interface Acted {
  look: Look
  /** The app the action landed in, for the step label. */
  app: string
}

/** A mark as the model gives it, in screenshot pixels. */
export type MarkInput =
  | { kind: 'circle' | 'box' | 'underline' | 'highlight'; x: number; y: number; w: number; h: number; color?: MarkColor; label?: string }
  | { kind: 'arrow'; from: [number, number]; to: [number, number]; color?: MarkColor; label?: string }
  | { kind: 'path'; points: Array<[number, number]>; color?: MarkColor; label?: string }
  | { kind: 'text'; x: number; y: number; text: string; color?: MarkColor }

export interface ComputerPorts {
  /** Null where computer use isn't built (Linux). */
  driver: Driver | null
  /** Picks the protected apps and blocked shortcuts. */
  os: DesktopOs
  /** Why computer use can't start yet (a permission the system hasn't granted), or null. */
  permissions?: () => Promise<string | null>
  screen: ScreenPort
  overlay: OverlayPort
  chatWindows: ChatWindowsPort
  selfPid: number
}

export interface ComputerApi {
  readonly supported: boolean
  /** Takes control for one reply. Fails while another chat has it. */
  readonly begin: (owner: string) => Effect.Effect<void, ComputerError>
  /** Hands control back. Marks stay on screen until the user clears them. Safe to call twice. */
  readonly end: (owner: string) => Effect.Effect<void>
  readonly owner: () => string | null
  /** Called with the owning reply when the user presses Stop on the overlay. */
  readonly onStop: (handler: (owner: string) => void) => void
  /**
   * Computer mode, on while a chat with computer use switched on is open: the sketch cursor stays
   * on screen and follows the user's pointer between tasks.
   */
  readonly setMode: (on: boolean) => Effect.Effect<void>
  /** What the assistant is doing between actions (thinking, reading a page), shown under the cursor. */
  readonly hint: (label: string) => Effect.Effect<void>
  readonly look: (label: string) => Effect.Effect<Look, ComputerError>
  /** A close-up of part of the last screenshot, at full resolution, for reading small text. */
  readonly zoom: (x: number, y: number, w: number, h: number) => Effect.Effect<{ image: string; text: string }, ComputerError>
  readonly click: (x: number, y: number, opts: { button: 'left' | 'right' | 'middle'; count: number; label: string }) => Effect.Effect<Acted, ComputerError>
  readonly move: (x: number, y: number, label: string) => Effect.Effect<Acted, ComputerError>
  readonly drag: (from: [number, number], to: [number, number], label: string) => Effect.Effect<Acted, ComputerError>
  readonly scroll: (x: number, y: number, dx: number, dy: number, label: string) => Effect.Effect<Acted, ComputerError>
  readonly type: (text: string, label: string) => Effect.Effect<Acted, ComputerError>
  readonly keys: (combo: string, label: string) => Effect.Effect<Acted, ComputerError>
  readonly openApp: (name: string) => Effect.Effect<Acted, ComputerError>
  readonly focusWindow: (title: string) => Effect.Effect<Acted, ComputerError>
  /** A menu-bar command by its path, in the app it last worked in (macOS). */
  readonly menu: (path: string[]) => Effect.Effect<Acted, ComputerError>
  readonly annotate: (marks: MarkInput[], label: string) => Effect.Effect<number, ComputerError>
  readonly clearMarks: Effect.Effect<void>
  readonly tips: Effect.Effect<AppTip[]>
  readonly saveTip: (app: string, tip: string) => Effect.Effect<AppTip, ComputerError>
  readonly removeTip: (id: string) => Effect.Effect<AppTip[]>
}

const sleep = (ms: number) => Effect.sleep(`${ms} millis`)

/** The overlay's cursor glides this long before the real input fires. */
const GLIDE_MS = 420

const MAX_TIPS = 200

/**
 * How long the overlay's cursor spends on each mark: travelling to it, drawing it and showing its
 * label. The overlay fits a batch into this (see `fitPen` in overlay/main.ts).
 */
export const ANNOTATE_MS = 1200
/** The longest a batch of marks may take, however many there are. */
export const ANNOTATE_MAX_MS = 8000

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** A tip applies to a window when the app it names appears in its title or exe. */
const tipMatches = (tip: AppTip, w: WindowInfo) => {
  const app = tip.app.toLowerCase()
  return w.title.toLowerCase().includes(app) || (w.exe !== '' && app.includes(w.exe.toLowerCase().replace(/\.exe$/, '')))
}

export class Computer extends Context.Service<Computer, ComputerApi>()('chat-v2/Computer') {
  static readonly layer = (ports: ComputerPorts) =>
    Layer.effect(
      Computer,
      Effect.gen(function* () {
        const settings = yield* SettingsStore
        const paths = yield* AppPaths
        const { driver, screen, overlay, chatWindows } = ports
        const tipsFile = join(paths.root, 'app-tips.json')

        let owner: string | null = null
        let frame: Frame | null = null
        /** The window the assistant last worked in: keys and text go there. */
        let workWindow: number | null = null
        /** Where the sketch cursor was left, in screenshot pixels. The user's own pointer is theirs. */
        let agentAt: { x: number; y: number } | null = null
        let marks: Mark[] = []
        let markSeq = 0
        let stopHandler: (owner: string) => void = () => {}
        let mode = false
        /** What the overlay shows while no reply has control. */
        let resting: 'off' | 'idle' | 'done' = 'off'

        /** Back to rest: the marks stay if there are any, else the cursor keeps the user company in computer mode. */
        const rest = () => {
          resting = marks.length ? 'done' : mode ? 'idle' : 'off'
          overlay.send({ type: 'mode', follow: mode })
          overlay.send({ type: 'status', state: resting, label: resting === 'done' ? 'Done' : '' })
        }

        const fail = (message: string, kind: 'failed' | 'blocked' = 'failed') => new ComputerError({ message, kind })
        const attempt = <A>(what: string, f: () => Promise<A>) =>
          Effect.tryPromise({ try: f, catch: (cause) => fail(`${what}: ${errorMessage(cause)}`) })

        const needDriver = Effect.suspend(() =>
          driver ? Effect.succeed(driver) : Effect.fail(fail("Computer use isn't available on this system yet."))
        )

        const guard = settings.get.pipe(
          Effect.map((s) => ({ selfPid: ports.selfPid, extra: s.computerProtected, os: ports.os })),
          Effect.orElseSucceed(() => ({ selfPid: ports.selfPid, extra: [] as string[], os: ports.os }))
        )

        // --- Tips the model saved about apps ---------------------------------------------------

        const readTips = (): AppTip[] => {
          try {
            if (!existsSync(tipsFile)) return []
            const raw = JSON.parse(readFileSync(tipsFile, 'utf8')) as unknown
            return Array.isArray(raw) ? raw.filter((t): t is AppTip => typeof t?.app === 'string' && typeof t?.tip === 'string' && typeof t?.id === 'string') : []
          } catch {
            return []
          }
        }
        const writeTips = (tips: AppTip[]) => {
          writeFileSync(`${tipsFile}.tmp`, JSON.stringify(tips, null, 2) + '\n', 'utf8')
          renameSync(`${tipsFile}.tmp`, tipsFile)
        }

        // --- Looking -------------------------------------------------------------------------------

        const readState = Effect.flatMap(needDriver, (d) => attempt('Reading the windows', () => d.state()))

        const describe = (s: DesktopState, f: Frame, hidden: Hidden[], reasonOf: (w: WindowInfo) => string | null) => {
          const screenRect = { x: f.screenX, y: f.screenY, w: f.screenW, h: f.screenH }
          const onScreen = (w: WindowInfo) =>
            !w.clickThrough && w.x < screenRect.x + screenRect.w && w.y < screenRect.y + screenRect.h && w.x + w.w > screenRect.x && w.y + w.h > screenRect.y
          const fg = s.windows.find((w) => w.hwnd === s.foreground) ?? null
          const lines = [
            `Screenshot: ${f.shotW}×${f.shotH} pixels of the primary display. Give every coordinate in these pixels.`,
            fg ? (reasonOf(fg) ? `Active window: protected (${reasonOf(fg)})` : `Active window: "${clip(fg.title, 90)}" (${fg.exe || 'unknown app'})`) : 'Active window: none (the desktop)'
          ]
          // macOS only names windows to apps it lets record the screen; list them by app then.
          const named = (w: WindowInfo) => w.title.trim() !== '' || (ports.os === 'darwin' && w.exe !== '' && w.cls === 'layer 0')
          const listed = s.windows.filter((w) => onScreen(w) && named(w) && !reasonOf(w)).slice(0, 15)
          if (listed.length) {
            lines.push('Windows, front to back:')
            for (const w of listed) {
              const r = shotRect(f, w)
              lines.push(`- ${w.title.trim() ? `"${clip(w.title, 80)}"` : 'A window'} (${w.exe || '?'}) at ${r.x},${r.y} ${r.w}×${r.h}`)
            }
          }
          if (hidden.length) {
            lines.push('Hidden from you (protected, painted grey). Do not try to reach these; ask the user to do anything that needs them:')
            for (const h of hidden) {
              const r = shotRect(f, h.window)
              lines.push(`- ${h.reason} at ${r.x},${r.y} ${r.w}×${r.h}`)
            }
          }
          const tips = fg && !reasonOf(fg) ? readTips().filter((t) => tipMatches(t, fg)).slice(-12) : []
          if (tips.length) {
            lines.push(`Tips you saved earlier for ${tips[0]!.app}:`)
            for (const t of tips) lines.push(`- ${t.tip}`)
          }
          return lines.join('\n')
        }

        const capture = (s: DesktopState) =>
          Effect.gen(function* () {
            const ctx = yield* guard
            const reasonOf = (w: WindowInfo) => protectedReason(w, ctx)
            const display = screen.display()
            let f = makeFrame(display)
            const hidden = hiddenRegions(s.windows, reasonOf, { x: display.x, y: display.y, w: display.w, h: display.h })
            // A pixel of margin, so rounding never lets an edge of a protected window show.
            const cover = hidden.flatMap((h) => h.parts.map((p) => shotRect(f, p))).map((r) => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 }))
            const shot = yield* attempt('Capturing the screen', () => overlay.hiddenWhile(() => screen.capture({ w: f.shotW, h: f.shotH }, cover)))
            if (shot.w !== f.shotW || shot.h !== f.shotH) f = { ...f, shotW: shot.w, shotH: shot.h }
            frame = f
            return { image: shot.dataUrl, frame: f, text: describe(s, f, hidden, reasonOf) } satisfies Look
          })

        const status = (label: string) => Effect.sync(() => overlay.send({ type: 'status', state: 'working', label }))

        const look = (label: string) =>
          Effect.gen(function* () {
            yield* status(label)
            return yield* capture(yield* readState)
          })

        /** The driver's word on how an action went goes first, before the screen it led to. */
        const noted = (look: Look, note: string | null | void): Look => (note ? { ...look, text: `${note}\n${look.text}` } : look)

        /** Waits for the screen to react, then looks again. */
        const settleAndLook = (ms: number) =>
          Effect.gen(function* () {
            yield* sleep(ms)
            const s = yield* readState
            return yield* capture(s)
          })

        // --- Acting --------------------------------------------------------------------------------

        const requireFrame = Effect.suspend(() =>
          frame ? Effect.succeed(frame) : Effect.fail(fail('Take a screenshot first (computer_screenshot).'))
        )

        const toScreen = (f: Frame, x: number, y: number) =>
          inShot(f, x, y)
            ? Effect.succeed(toPhysical(f, x, y))
            : Effect.fail(fail(`(${x}, ${y}) is outside the screenshot, which is ${f.shotW}×${f.shotH}.`))

        const blocked = (reason: string) =>
          fail(`Blocked: ${reason} is protected, so I can't use it. Don't look for another way in; ask the user to do this step.`, 'blocked')

        /** The window a pointer action would land in, refused when it's protected. */
        const targetAt = (s: DesktopState, p: { x: number; y: number }) =>
          Effect.gen(function* () {
            const ctx = yield* guard
            const w = windowAt(s.windows, p.x, p.y)
            const reason = w && protectedReason(w, ctx)
            if (reason) return yield* Effect.fail(blocked(reason))
            return w
          })

        /**
         * The window keystrokes go to: the one the assistant last worked in, brought to the front
         * if the user has since moved on, else whatever is in front. Refused when it's protected
         * (this app included), before and after it comes forward.
         */
        const keyTarget = (d: Driver, s: DesktopState) =>
          Effect.gen(function* () {
            const ctx = yield* guard
            const check = (w: WindowInfo | null) => {
              const reason = w && protectedReason(w, ctx)
              return reason ? Effect.fail(blocked(reason)) : Effect.succeed(w)
            }
            const front = s.windows.find((x) => x.hwnd === s.foreground) ?? null
            const work = s.windows.find((x) => x.hwnd === workWindow) ?? null
            // A menu or dialog of the same app counts as that app being in front.
            if (!work || (front && front.pid === work.pid)) return yield* check(front)
            yield* check(work)
            yield* attempt('Switching windows', () => d.focus(work.hwnd))
            yield* sleep(150)
            const after = yield* readState
            const now = after.windows.find((x) => x.hwnd === after.foreground) ?? null
            if (!now || now.pid !== work.pid) return yield* Effect.fail(fail(`Couldn't bring ${appName(work)} to the front to type in it. Click in it first.`))
            return yield* check(now)
          })

        /** Fresh window state before acting. */
        const before = (label: string) =>
          Effect.gen(function* () {
            const d = yield* needDriver
            const f = yield* requireFrame
            yield* status(label)
            const s = yield* readState
            // Marks belong to the screen they were drawn on; acting changes it.
            if (marks.length) {
              marks = []
              overlay.send({ type: 'clear' })
            }
            return { d, f, s }
          })

        const glide = (f: Frame, x: number, y: number, label: string, action?: 'click' | 'double' | 'right' | 'drag' | 'scroll' | 'type') =>
          Effect.gen(function* () {
            const p = toOverlay(f, x, y)
            overlay.send({ type: 'cursor', x: p.x, y: p.y, label, ...(action ? { action } : {}) })
            agentAt = { x, y }
            yield* sleep(GLIDE_MS)
          })

        /** The window a pointer action goes to; there must be one (the desktop counts). */
        const pointerTarget = (s: DesktopState, p: { x: number; y: number }) =>
          Effect.flatMap(targetAt(s, p), (w) => (w ? Effect.succeed(w) : Effect.fail(fail("There's no window there to act on."))))

        /** The sketch cursor shows where keys go: it stays where it was left. */
        const showTyping = (f: Frame, label: string) =>
          Effect.sync(() => {
            if (agentAt) overlay.send({ type: 'cursor', ...toOverlay(f, agentAt.x, agentAt.y), label, action: 'type' })
          })

        /**
         * The helper and Electron must agree on where the cursor is. If they don't, the helper's
         * coordinates are scaled (DPI) and every click would land somewhere else: refuse to start.
         */
        const checkScale = Effect.gen(function* () {
          for (let i = 0; i < 3; i++) {
            const s = yield* readState
            const e = screen.cursor()
            if (Math.hypot(s.cursor.x - e.x, s.cursor.y - e.y) <= 4) return
            // The user may just be moving the mouse; look again.
            yield* sleep(120)
          }
          return yield* Effect.fail(fail("Computer use can't line up its clicks with this screen's scaling, so it won't start. Try setting display scaling to 100%, or tell the developer."))
        })

        const nameOf = (w: WindowInfo | null) => (w ? appName(w) : 'the desktop')

        const api: ComputerApi = {
          supported: driver !== null,

          begin: (id) =>
            Effect.gen(function* () {
              yield* needDriver
              if (owner && owner !== id) return yield* Effect.fail(fail('Another chat is using the computer. Wait for it to finish, or stop it.'))
              if (owner === id) return
              const missing = ports.permissions ? yield* attempt('Checking permissions', ports.permissions) : null
              if (missing) return yield* Effect.fail(fail(missing))
              yield* checkScale
              owner = id
              workWindow = null
              agentAt = null
              frame = null
              if (marks.length) {
                marks = []
                overlay.send({ type: 'clear' })
              }
              overlay.send({ type: 'mode', follow: mode })
              overlay.send({ type: 'status', state: 'working', label: 'Getting ready' })
              chatWindows.hide()
              // Let the minimise animation finish before the first screenshot.
              yield* sleep(350)
            }),

          end: (id) =>
            Effect.sync(() => {
              if (owner !== id) return
              owner = null
              frame = null
              workWindow = null
              agentAt = null
              rest()
              // With marks up, they are the answer: the chat comes back when the user is done reading.
              if (resting !== 'done') chatWindows.show()
            }),

          owner: () => owner,
          onStop: (handler) => (stopHandler = handler),

          setMode: (on) =>
            Effect.sync(() => {
              if (!driver || on === mode) return
              mode = on
              if (owner) overlay.send({ type: 'mode', follow: mode })
              // Leaving computer mode keeps marks the user hasn't read yet.
              else if (resting !== 'done') rest()
              else overlay.send({ type: 'mode', follow: mode })
            }),

          hint: (label) =>
            Effect.sync(() => {
              if (owner) overlay.send({ type: 'status', state: 'working', label })
              else if (mode) overlay.send({ type: 'hint', label })
            }),

          look,

          zoom: (x, y, w, h) =>
            Effect.gen(function* () {
              const f = yield* requireFrame
              yield* status('Looking closer')
              const s = yield* readState
              // Clamp to the screenshot, and never smaller than a button.
              const x0 = Math.max(0, Math.min(f.shotW - 20, Math.round(x)))
              const y0 = Math.max(0, Math.min(f.shotH - 20, Math.round(y)))
              const x1 = Math.min(f.shotW, Math.max(x0 + 20, Math.round(x + w)))
              const y1 = Math.min(f.shotH, Math.max(y0 + 20, Math.round(y + h)))
              const a = toPhysical(f, x0, y0)
              const b = toPhysical(f, x1, y1)
              const crop = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
              const k = Math.min(1280 / crop.w, 800 / crop.h, 3)
              const size = { w: Math.max(1, Math.round(crop.w * k)), h: Math.max(1, Math.round(crop.h * k)) }
              const ctx = yield* guard
              const hidden = hiddenRegions(s.windows, (win) => protectedReason(win, ctx), { x: f.screenX, y: f.screenY, w: f.screenW, h: f.screenH })
              const sx = size.w / crop.w
              const sy = size.h / crop.h
              const cover = hidden
                .flatMap((hd) => hd.parts)
                .map((p) => ({ x: (p.x - crop.x) * sx - 2, y: (p.y - crop.y) * sy - 2, w: p.w * sx + 4, h: p.h * sy + 4 }))
                .filter((r) => r.x < size.w && r.y < size.h && r.x + r.w > 0 && r.y + r.h > 0)
              const shot = yield* attempt('Capturing the screen', () => overlay.hiddenWhile(() => screen.capture(size, cover, crop)))
              const zoomed = Math.round((shot.w / (x1 - x0)) * 10) / 10
              return {
                image: shot.dataUrl,
                text: `Close-up of ${x0},${y0} to ${x1},${y1} of the screenshot, magnified ${zoomed}×. It is for reading detail only: keep giving coordinates in the full screenshot's pixels.`
              }
            }),

          click: (x, y, { button, count, label }) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const p = yield* toScreen(f, x, y)
              const w = yield* pointerTarget(s, p)
              yield* glide(f, x, y, label, button === 'right' ? 'right' : count > 1 ? 'double' : 'click')
              const note = yield* attempt('Clicking', () => d.click(w.hwnd, p.x, p.y, button, count))
              workWindow = w.hwnd
              return { look: noted(yield* settleAndLook(550), note), app: nameOf(w) }
            }),

          move: (x, y, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const p = yield* toScreen(f, x, y)
              const w = yield* pointerTarget(s, p)
              yield* glide(f, x, y, label)
              yield* attempt('Pointing', () => d.hover(w.hwnd, p.x, p.y))
              return { look: yield* settleAndLook(450), app: nameOf(w) }
            }),

          drag: (from, to, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const a = yield* toScreen(f, from[0], from[1])
              const b = yield* toScreen(f, to[0], to[1])
              const w = yield* pointerTarget(s, a)
              yield* targetAt(s, b)
              yield* glide(f, from[0], from[1], label)
              const p = toOverlay(f, to[0], to[1])
              overlay.send({ type: 'cursor', x: p.x, y: p.y, label, action: 'drag' })
              agentAt = { x: to[0], y: to[1] }
              // The helper moves through the drag over about the time the overlay's cursor takes.
              const note = yield* attempt('Dragging', () => d.drag(w.hwnd, a, b))
              workWindow = w.hwnd
              return { look: noted(yield* settleAndLook(500), note), app: nameOf(w) }
            }),

          scroll: (x, y, dx, dy, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const p = yield* toScreen(f, x, y)
              const w = yield* pointerTarget(s, p)
              yield* glide(f, x, y, label, 'scroll')
              const note = yield* attempt('Scrolling', () => d.wheel(w.hwnd, p.x, p.y, dx, dy))
              return { look: noted(yield* settleAndLook(450), note), app: nameOf(w) }
            }),

          type: (text, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const w = yield* keyTarget(d, s)
              yield* showTyping(f, label)
              yield* attempt('Typing', () => d.text(text))
              return { look: yield* settleAndLook(350), app: nameOf(w) }
            }),

          keys: (combo, label) =>
            Effect.gen(function* () {
              const vks = yield* Effect.try({ try: () => parseKeys(combo), catch: (e) => fail(errorMessage(e)) })
              const chord = protectedChord(vks, ports.os)
              if (chord) return yield* Effect.fail(fail(`Blocked: ${chord}, which are protected. Don't look for another way in; ask the user.`, 'blocked'))
              const { d, f, s } = yield* before(label)
              const w = yield* keyTarget(d, s)
              yield* showTyping(f, label)
              yield* attempt('Pressing keys', () => d.keys(vks))
              return { look: yield* settleAndLook(450), app: nameOf(w) }
            }),

          openApp: (name) =>
            Effect.gen(function* () {
              const d = yield* needDriver
              yield* status(`Opening ${name}`)
              const ctx = yield* guard
              const apps = yield* attempt('Listing apps', () => d.apps())
              const want = name.trim().toLowerCase()
              const found =
                apps.find((a) => a.name.toLowerCase() === want) ??
                apps.find((a) => a.name.toLowerCase().startsWith(want)) ??
                apps.find((a) => a.name.toLowerCase().includes(want))
              if (!found) {
                const words = want.split(/\s+/).filter((w) => w.length > 2)
                const near = apps.filter((a) => words.some((w) => a.name.toLowerCase().includes(w))).slice(0, 8).map((a) => a.name)
                return yield* Effect.fail(fail(`No installed app called "${name}".${near.length ? ` Close matches: ${near.join(', ')}.` : ''}`))
              }
              const reason = protectedAppName(found.name, found.id, ctx.extra, ports.os)
              if (reason) return yield* Effect.fail(blocked(reason))
              const s0 = yield* readState
              yield* attempt('Opening the app', () => d.launch(found.id))
              // Wait for its window: a new foreground window, up to a few seconds for big apps.
              for (let i = 0; i < 24; i++) {
                yield* sleep(500)
                const s = yield* readState
                if (s.foreground !== s0.foreground) break
              }
              const s = yield* readState
              const fg = s.windows.find((w) => w.hwnd === s.foreground) ?? null
              if (fg && s.foreground !== s0.foreground) workWindow = fg.hwnd
              return { look: yield* settleAndLook(600), app: fg ? appName(fg) : found.name }
            }),

          focusWindow: (title) =>
            Effect.gen(function* () {
              const d = yield* needDriver
              yield* status(`Switching to ${title}`)
              const ctx = yield* guard
              const s = yield* readState
              const want = title.trim().toLowerCase()
              const candidates = s.windows.filter((w) => !w.clickThrough && w.title.trim() && w.title.toLowerCase().includes(want))
              const w = candidates.find((c) => !protectedReason(c, ctx)) ?? null
              if (!w) {
                const reason = candidates[0] && protectedReason(candidates[0], ctx)
                if (reason) return yield* Effect.fail(blocked(reason))
                return yield* Effect.fail(fail(`No open window titled like "${title}".`))
              }
              yield* attempt('Switching windows', () => d.focus(w.hwnd))
              workWindow = w.hwnd
              return { look: yield* settleAndLook(500), app: appName(w) }
            }),

          menu: (path) =>
            Effect.gen(function* () {
              const label = `Choosing ${path.join(' > ')}`
              const { d, f, s } = yield* before(label)
              const choose = d.menu?.bind(d)
              if (!choose) return yield* Effect.fail(fail("Choosing menu commands by name only works on a Mac. Use the app's keyboard shortcuts or click the menu."))
              // The app it last worked in, brought forward and checked like keystrokes are.
              const w = yield* keyTarget(d, s)
              if (!w) return yield* Effect.fail(fail('No app is in front to choose a menu command in. Click in the app first.'))
              yield* showTyping(f, label)
              const note = yield* attempt('Choosing from the menu', () => choose(w.hwnd, path))
              return { look: noted(yield* settleAndLook(500), note), app: nameOf(w) }
            }),

          annotate: (input, label) =>
            Effect.gen(function* () {
              const f = yield* requireFrame
              yield* status(label)
              const pt = (x: number, y: number) => toOverlay(f, x, y)
              const added: Mark[] = []
              for (const m of input) {
                const id = `m${++markSeq}`
                const color = m.color ?? 'red'
                if (m.kind === 'arrow') added.push({ id, kind: 'arrow', from: pt(...m.from), to: pt(...m.to), color, ...(m.label ? { label: m.label } : {}) })
                else if (m.kind === 'path') added.push({ id, kind: 'path', points: m.points.map(([x, y]) => pt(x, y)), color, ...(m.label ? { label: m.label } : {}) })
                else if (m.kind === 'text') added.push({ id, kind: 'text', ...pt(m.x, m.y), text: m.text, color })
                else {
                  const a = pt(m.x, m.y)
                  const b = pt(m.x + m.w, m.y + m.h)
                  added.push({ id, kind: m.kind, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, color, ...(m.label ? { label: m.label } : {}) })
                }
              }
              marks = [...marks, ...added].slice(-40)
              overlay.send({ type: 'marks', marks })
              // The overlay's cursor draws the marks one after another; let it finish first.
              yield* sleep(Math.min(ANNOTATE_MAX_MS, 300 + added.length * ANNOTATE_MS))
              return added.length
            }),

          clearMarks: Effect.sync(() => {
            marks = []
            overlay.send({ type: 'clear' })
          }),

          tips: Effect.sync(readTips),

          saveTip: (app, tip) =>
            Effect.try({
              try: () => {
                const entry: AppTip = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, app: clip(app.trim(), 60), tip: clip(tip.trim().replace(/\s+/g, ' '), 400), at: Date.now() }
                if (!entry.app || !entry.tip) throw new Error('A tip needs an app and some text')
                const tips = readTips()
                // The same advice twice is kept once, as the newest.
                const rest = tips.filter((t) => !(t.app.toLowerCase() === entry.app.toLowerCase() && t.tip === entry.tip))
                writeTips([...rest, entry].slice(-MAX_TIPS))
                return entry
              },
              catch: (e) => fail(`Could not save the tip: ${errorMessage(e)}`)
            }),

          removeTip: (id) =>
            Effect.sync(() => {
              const tips = readTips().filter((t) => t.id !== id)
              try {
                writeTips(tips)
              } catch {
                // Nothing was removed; the list is still right.
              }
              return readTips()
            })
        }

        overlay.onCommand((command: OverlayCommand) => {
          if (command === 'stop') {
            if (owner) stopHandler(owner)
          } else if (command === 'show-chat') {
            chatWindows.show()
          } else {
            marks = []
            overlay.send({ type: 'clear' })
            if (!owner) {
              rest()
              chatWindows.show()
            }
          }
        })

        // Quitting mid-run: nothing stays drawn on screen and the chat isn't left minimised.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            driver?.close()
            overlay.send({ type: 'status', state: 'off', label: '' })
            chatWindows.show()
          })
        )

        return Computer.of(api)
      })
    )
}
