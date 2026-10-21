// Computer use: the assistant sees the primary display and works its mouse and keyboard.
// Electron and Windows are injected (see desktop.ts and winHelper.ts), so this loads in tests.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import {
  type DesktopOs,
  type DesktopState,
  type Frame,
  type Hidden,
  type Mark,
  type MarkColor,
  type Rect,
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
import type { ChatWindowsPort, OverlayPort, ScreenChanges, ScreenPort } from '../desktop'
import { errorMessage } from '../errors'
import type { Driver } from '../driver'
import { CurrentStopwatch, timed } from '../timing'
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
  /** After an action: false when the screen was still changing as the wait for it ran out. */
  settled?: boolean
}

export interface Acted {
  look: Look
  /** The app the action landed in, for the step label. */
  app: string
}

/**
 * What a reply starts with: the window list, and a screenshot unless it couldn't be taken or (on
 * a Mac) this chat's window is in the way.
 */
export interface Glance {
  image: string | null
  text: string
}

/**
 * How a `wait` ended: the screen changed and then held still (`settled`), never changed (`still`),
 * was still changing when the time ran out (`changing`), or wasn't watched (`unknown`: the stream
 * isn't up, or the run was told it waits the whole time), in which case it waited the whole time.
 */
export type WaitEnd = 'settled' | 'still' | 'changing' | 'unknown'

export interface Waited {
  look: Look
  /** How long it waited, before looking. */
  ms: number
  end: WaitEnd
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
  /** Whether those permissions are granted already, checked without asking for them (macOS). */
  hasPermissions?: () => boolean
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
  /**
   * A reply in a computer chat is over, however it went: the screen stream it may have opened (its
   * glance, the prewarm while the user wrote) closes now rather than when idle, unless a reply has
   * control or another reply has glanced since. The next glance or prewarm opens it again.
   */
  readonly replyEnded: (reply: string) => Effect.Effect<void>
  readonly owner: () => string | null
  /** Called with the owning reply when the user presses Stop on the overlay. */
  readonly onStop: (handler: (owner: string) => void) => void
  /**
   * Computer mode, on while a chat with computer use switched on is open: the sketch cursor stays
   * on screen and follows the user's pointer between tasks, and the input helper and the screen
   * stream get ready ahead of a reply.
   */
  readonly setMode: (on: boolean) => Effect.Effect<void>
  /** What the assistant is doing between actions (reading a page), shown under the cursor. */
  readonly hint: (label: string) => Effect.Effect<void>
  /**
   * A model call is deciding the next step: the sketch cursor waits where it is with a spinner and
   * THINKING_LABEL. The next action, a hint, or the reply ending (`end`, or `hint('')` when it
   * never took control) clears it. Never on while the screen is settling or being captured.
   */
  readonly thinking: Effect.Effect<void>
  /** Gets the screen ready to look at (opens the stream), ahead of a reply. */
  readonly prewarm: Effect.Effect<void>
  /**
   * Whether `wait` can end as soon as the screen is ready, for a run about to start: Windows' stream
   * can always be watched; a Mac's once its ScreenCaptureKit stream is up (this waits a moment for
   * it). The model is told what this says, and the run's waits are held to it (`wait`'s `watch`).
   */
  readonly canWatch: Effect.Effect<boolean>
  readonly look: (label: string) => Effect.Effect<Look, ComputerError>
  /**
   * Waits up to `maxMs` for something on screen to finish, then looks: it ends early once the
   * screen has changed and held still, or has stayed still a while (see WAIT_* below). With
   * `watch: false` (the run was told the screen can't be watched) it waits the whole time.
   */
  readonly wait: (maxMs: number, opts?: { watch?: boolean }) => Effect.Effect<Waited, ComputerError>
  /**
   * The screen as a reply starts, before it has control: no overlay status, and the chat window
   * stays where it is. It is left out of the capture (Windows, or a Mac's stream), so the
   * screenshot shows what's under it; a Mac without the stream paints it grey as protected, and
   * past half the screen there's no screenshot. The screenshot's frame carries over to `begin` for the same reply, so the model
   * can act on its first step. Null when computer use isn't ready to look (another reply has it,
   * or macOS permissions haven't been granted yet).
   */
  readonly glance: (owner: string) => Effect.Effect<Glance | null>
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
/** A pause for the screen or an app to catch up, timed apart from the action's own waits. */
const wait = (ms: number) => sleep(ms).pipe(timed('wait'))

/** The overlay's cursor glides this long before the real input fires (GLIDE_MS in overlay/main.ts too). */
export const GLIDE_MS = 250

/** What the sketch cursor says while the model decides what to do. */
export const THINKING_LABEL = 'Deciding next step'

/** The longest an action waits for the screen to stop changing. */
export const SETTLE_MAX_MS = 1500
/** How often it looks while it waits; the screen counts as settled after two looks in a row show no change. */
const SETTLE_STEP_MS = 80
/**
 * Where the stream says how long the screen has been still (macOS), it counts as settled once it
 * has been this long since the action: the two looks' worth, without waiting to take them.
 */
export const SETTLE_QUIET_MS = 2 * SETTLE_STEP_MS

/**
 * Whether two `probe` thumbnails show a different screen: more than a few pixels changed by more
 * than a little. The user's mouse pointer moving, or a blinking text cursor, changes less.
 */
export const screenChanged = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return true
  let n = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 24 && ++n > 4) return true
  return false
}

/** `wait` always waits this long first, so what the last action set off has a moment to start. */
export const WAIT_MIN_MS = 500
/** Once the screen has changed, it counts as ready after holding still this long. */
export const WAIT_QUIET_MS = 500
/** A screen that never changes counts as ready after this long, so a still loading screen gets a chance. */
export const WAIT_STILL_MS = 2000

/** Past this share of the screen, a glance shows the chat's own grey window more than anything else. */
const GLANCE_MAX_COVERED = 0.5

/** What the model is told when a reply starts without a screenshot, whatever the reason. */
const noScreenshot = (why: string) =>
  `No screenshot yet: ${why}. Don't start with computer_screenshot: your first action's result includes a screenshot, taken after this chat minimises. If the app you need is in the window list or installed, start with computer_open_app or computer_focus_window; only otherwise call computer_screenshot.`

const MAX_TIPS = 200

/**
 * How long the overlay's cursor spends on each mark: travelling to it, drawing it and showing its
 * label. The overlay fits a batch into this (see `planMark` in overlay/main.ts). `annotate` returns
 * at once, so the model's next call overlaps the drawing; only an action that would clear the marks
 * waits for them to finish first, so the user always sees them drawn whole.
 */
export const ANNOTATE_MS = 1200
/** The longest a batch of marks may take, however many there are. */
export const ANNOTATE_MAX_MS = 8000

/**
 * After minimising the chat, `begin` waits at most this long for its windows to leave the window
 * list, so the first action can't land on them and be refused. The animation may still be playing:
 * actions settle after acting anyway, and a plain look settles first (see `afterBegin`).
 */
const BEGIN_MAX_MS = 400

/** `open_app` waits at most this long, once the new window shows, for its content to stop changing. */
export const OPEN_SETTLE_MAX_MS = 3000

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
        /** The reply whose glance took the current frame (see `glance`). */
        let glancedFor: string | null = null
        /** macOS has granted what computer use needs, so looking before `begin` won't prompt. */
        let granted = !ports.permissions
        /** What the overlay shows while no reply has control. */
        let resting: 'off' | 'idle' | 'done' = 'off'
        /** The cursor shows the thinking spinner (see `thinking`). */
        let thinkingOn = false
        /** `begin` has minimised the chat and nothing has settled the screen since. */
        let afterBegin = false
        /** When the overlay will have drawn the newest marks (performance.now()). */
        let marksDrawnAt = 0

        /** Back to rest: the marks stay if there are any, else the cursor keeps the user company in computer mode. */
        const rest = () => {
          thinkingOn = false
          resting = marks.length ? 'done' : mode ? 'idle' : 'off'
          overlay.send({ type: 'mode', follow: mode })
          overlay.send({ type: 'status', state: resting, label: resting === 'done' ? 'Done' : '' })
        }

        const fail = (message: string, kind: 'failed' | 'blocked' = 'failed') => new ComputerError({ message, kind })
        const attempt = <A>(what: string, f: () => Promise<A>) =>
          Effect.tryPromise({ try: f, catch: (cause) => fail(`${what}: ${errorMessage(cause)}`) })
        /** A call into the input helper that acts on the desktop. */
        const act = <A>(what: string, f: () => Promise<A>) => attempt(what, f).pipe(timed('driver'))

        const needDriver = Effect.suspend(() =>
          driver ? Effect.succeed(driver) : Effect.fail(fail("Computer use isn't available on this system yet."))
        )

        const guard = settings.get.pipe(
          Effect.map((s) => ({ selfPid: ports.selfPid, extra: s.computerProtected, os: ports.os })),
          Effect.orElseSucceed(() => ({ selfPid: ports.selfPid, extra: [] as string[], os: ports.os }))
        )

        /** Whether the user lets drags (and Mac clicks nothing else reaches) borrow the real pointer. */
        const borrowPointer = settings.get.pipe(
          Effect.map((s) => s.computerBorrowPointer),
          Effect.orElseSucceed(() => false)
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

        const readState = Effect.flatMap(needDriver, (d) => attempt('Reading the windows', () => d.state())).pipe(timed('readState'))

        /** `active` says what's in front instead, when that window isn't in `s` (left out of a glance). */
        const describe = (s: DesktopState, f: Frame, hidden: Hidden[], reasonOf: (w: WindowInfo) => string | null, active?: string) => {
          const screenRect = { x: f.screenX, y: f.screenY, w: f.screenW, h: f.screenH }
          const onScreen = (w: WindowInfo) =>
            !w.clickThrough && w.x < screenRect.x + screenRect.w && w.y < screenRect.y + screenRect.h && w.x + w.w > screenRect.x && w.y + w.h > screenRect.y
          const fg = s.windows.find((w) => w.hwnd === s.foreground) ?? null
          const lines = [
            `Screenshot: ${f.shotW}×${f.shotH} pixels of the primary display. Give every coordinate in these pixels.`,
            active
              ? `Active window: ${active}`
              : fg
                ? reasonOf(fg)
                  ? `Active window: protected (${reasonOf(fg)})`
                  : `Active window: "${clip(fg.title, 90)}" (${fg.exe || 'unknown app'})`
                : 'Active window: none (the desktop)'
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

        /**
         * Captures the screen with the overlay out of the picture. The time goes to `capture`, and
         * its parts to `capture.*`: `hide` is what keeping the overlay out added (macOS without its
         * stream), the rest is what the screen port reports (grabbing the frame, painting covers,
         * encoding). A port that keeps the overlay out itself (a Mac's) reports its own `hide`.
         */
        const shoot = (size: { w: number; h: number }, cover: Rect[], crop?: Rect, opts?: { fresh?: boolean; after?: number; withoutApp?: boolean }) =>
          Effect.gen(function* () {
            calm()
            const sw = yield* CurrentStopwatch
            const t = performance.now()
            let inner = 0
            const keepOut = screen.keepsOverlayOut ? <A>(f: () => Promise<A>) => f() : overlay.hiddenWhile.bind(overlay)
            const shot = yield* attempt('Capturing the screen', () =>
              keepOut(async () => {
                const t1 = performance.now()
                try {
                  return await screen.capture(size, cover, crop, opts)
                } finally {
                  inner = performance.now() - t1
                }
              })
            )
            if (sw) {
              const total = performance.now() - t
              sw.add('capture', total)
              if (!screen.keepsOverlayOut) sw.add('capture.hide', total - inner)
              for (const [part, ms] of Object.entries(shot.ms ?? {})) sw.add(`capture.${part}`, ms)
            }
            return shot
          })

        /**
         * Looks at the screen with `s`'s protected windows painted over. A glance passes a state
         * without the windows it left out of the capture, a fresh frame, and what's in front.
         */
        const capture = (s: DesktopState, opts?: { fresh?: boolean; after?: number; withoutApp?: boolean; active?: string }) =>
          Effect.gen(function* () {
            const ctx = yield* guard
            const reasonOf = (w: WindowInfo) => protectedReason(w, ctx)
            const display = screen.display()
            let f = makeFrame(display)
            const hidden = hiddenRegions(s.windows, reasonOf, { x: display.x, y: display.y, w: display.w, h: display.h })
            // A pixel of margin, so rounding never lets an edge of a protected window show.
            const cover = hidden.flatMap((h) => h.parts.map((p) => shotRect(f, p))).map((r) => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 }))
            const fresh = opts?.fresh ? { fresh: true, ...(opts.after !== undefined ? { after: opts.after } : {}) } : undefined
            const shot = yield* shoot({ w: f.shotW, h: f.shotH }, cover, undefined, opts?.withoutApp ? { ...fresh, withoutApp: true } : fresh)
            if (shot.w !== f.shotW || shot.h !== f.shotH) f = { ...f, shotW: shot.w, shotH: shot.h }
            frame = f
            return { image: shot.dataUrl, frame: f, text: describe(s, f, hidden, reasonOf, opts?.active) } satisfies Look
          })

        const status = (label: string) =>
          Effect.sync(() => {
            thinkingOn = false
            overlay.send({ type: 'status', state: 'working', label })
          })

        /**
         * Takes the thinking spinner down if it's somehow still up. Every action replaces it with
         * its own status first, so this is a safeguard: the overlay is out of every capture
         * (content protection on Windows, `hiddenWhile` on a Mac), but nothing should animate on it
         * while the screen is watched or captured all the same.
         */
        function calm() {
          if (!thinkingOn) return
          thinkingOn = false
          overlay.send(owner ? { type: 'status', state: 'working', label: '' } : { type: 'hint', label: '' })
        }

        /** Right after `begin` the chat may still be minimising: a plain look lets the screen settle first. */
        const settleAfterBegin = Effect.suspend(() => {
          if (!afterBegin) return Effect.void
          afterBegin = false
          return Effect.asVoid(settle(100, 350))
        })

        const look = (label: string) =>
          Effect.gen(function* () {
            yield* status(label)
            yield* settleAfterBegin
            return yield* capture(yield* readState)
          })

        /** The driver's word on how an action went goes first, before the screen it led to. */
        const noted = (look: Look, note: string | null | void): Look => (note ? { ...look, text: `${note}\n${look.text}` } : look)

        /**
         * How this system watches the screen for changes: by comparing `probe` thumbnails (Windows'
         * stream), or by the change reports of a stream that makes them (`changes`, a Mac's
         * ScreenCaptureKit stream), which also say how long the screen has been still. Null where
         * it can't at all; a look is null while the stream isn't up.
         */
        type Watch = {
          peek: Effect.Effect<unknown>
          changed: (a: unknown, b: unknown) => boolean
          stillMs?: (look: unknown) => number
        }
        const watcher = (): Watch | null => {
          const probe = screen.probe?.bind(screen)
          if (probe) return { peek: Effect.promise(() => probe().catch(() => null)), changed: (a, b) => screenChanged(a as Uint8Array, b as Uint8Array) }
          const changes = screen.changes?.bind(screen)
          if (!changes) return null
          return {
            peek: Effect.promise(() => changes().catch(() => null)),
            changed: (a, b) => (a as ScreenChanges).count !== (b as ScreenChanges).count,
            stillMs: (look) => (look as ScreenChanges).stillMs
          }
        }
        /** Whether the screen can be watched right now (a Mac's stream may not be up). */
        const watchingNow = () => !!screen.probe || (!!screen.changes && screen.live?.() === true)

        /**
         * Waits for the screen to react to an action and stop changing: at least `min` ms, then
         * until two looks in a row (SETTLE_STEP_MS apart) match, at most SETTLE_MAX_MS. Says
         * whether it settled. A stream that says how long the screen has been still (macOS) ends
         * it as soon as that's SETTLE_QUIET_MS since the action. Where the screen can't be watched
         * (the stream isn't up), it waits `fixed` ms instead.
         */
        const settle = (min: number, fixed: number) =>
          Effect.gen(function* () {
            calm()
            afterBegin = false
            const w = watcher()
            const t = performance.now()
            yield* sleep(w ? min : fixed)
            let prev = w ? yield* w.peek : null
            if (!w || !prev) {
              yield* sleep(Math.max(0, fixed - (performance.now() - t)))
              return true
            }
            let still = 0
            while (performance.now() - t < SETTLE_MAX_MS) {
              // Still since the action at the earliest: a quiet screen before it proves nothing.
              const quiet = w.stillMs ? Math.min(w.stillMs(prev), performance.now() - t) : 0
              if (w.stillMs && quiet >= SETTLE_QUIET_MS) return true
              yield* sleep(w.stillMs ? Math.max(10, Math.min(SETTLE_STEP_MS, SETTLE_QUIET_MS - quiet)) : SETTLE_STEP_MS)
              const next = yield* w.peek
              if (!next) return true
              still = w.changed(prev, next) ? 0 : still + 1
              if (still >= 2) return true
              prev = next
            }
            return false
          }).pipe(timed('settle'))

        /**
         * `computer_wait`: up to `maxMs` for the screen to be ready, probed as `settle` probes it.
         * After WAIT_MIN_MS, it ends once the screen has changed and then held still for
         * WAIT_QUIET_MS, or has not changed at all for WAIT_STILL_MS. Where the screen can't be
         * watched, or `whole` says not to, it waits the whole time. Says how long it waited and how
         * it ended. `opts` change those times (see `openApp`), and `changed` counts the screen as
         * changed from the start.
         */
        const waitForScreen = (maxMs: number, opts: { min?: number; quiet?: number; still?: number; changed?: boolean; whole?: boolean } = {}) =>
          Effect.gen(function* () {
            calm()
            afterBegin = false
            const { min = WAIT_MIN_MS, quiet: quietMs = WAIT_QUIET_MS, still: stillMs = WAIT_STILL_MS } = opts
            const w = opts.whole ? null : watcher()
            const t = performance.now()
            const elapsed = () => performance.now() - t
            if (!w) {
              yield* sleep(maxMs)
              return { ms: elapsed(), end: 'unknown' as WaitEnd }
            }
            const peek = () => w.peek
            // The first look, to tell a change from; what changed last, and when.
            let base = yield* peek()
            let prev = base
            let since = performance.now()
            let changed = opts.changed === true
            while (elapsed() < maxMs) {
              yield* sleep(Math.min(SETTLE_STEP_MS, maxMs - elapsed()))
              const next = yield* peek()
              if (!next) continue
              if (!prev || !base) {
                base = prev = next
                since = performance.now()
                continue
              }
              // A change shows between two looks, or as a slow drift away from the first.
              if (w.changed(prev, next) || (!changed && w.changed(base, next))) {
                changed = true
                since = performance.now()
              }
              prev = next
              const quiet = performance.now() - since
              if (elapsed() >= WAIT_MIN_MS && quiet >= (changed ? WAIT_QUIET_MS : WAIT_STILL_MS)) {
                return { ms: elapsed(), end: changed ? 'settled' : 'still' } as const
              }
            }
            const end: WaitEnd = !base ? 'unknown' : changed && performance.now() - since < WAIT_QUIET_MS ? 'changing' : changed ? 'settled' : 'still'
            return { ms: elapsed(), end }
          }).pipe(timed('wait'))

        /** Waits for the screen to settle (see `settle`), then looks again. */
        const settleAndLook = (min: number, fixed: number) =>
          Effect.gen(function* () {
            const settled = yield* settle(min, fixed)
            return { ...(yield* capture(yield* readState)), settled } satisfies Look
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
            yield* act('Switching windows', () => d.focus(work.hwnd))
            yield* wait(150)
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
            // Marks belong to the screen they were drawn on; acting changes it. The user sees them
            // drawn whole first.
            if (marks.length) {
              const left = marksDrawnAt - performance.now()
              if (left > 0) yield* wait(left)
              marks = []
              overlay.send({ type: 'clear' })
            }
            const s = yield* readState
            return { d, f, s }
          })

        const glide = (f: Frame, x: number, y: number, label: string, action?: 'click' | 'double' | 'right' | 'drag' | 'scroll' | 'type') =>
          Effect.gen(function* () {
            const p = toOverlay(f, x, y)
            overlay.send({ type: 'cursor', x: p.x, y: p.y, label, ...(action ? { action } : {}) })
            agentAt = { x, y }
            yield* sleep(GLIDE_MS).pipe(timed('glide'))
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
            yield* wait(120)
          }
          return yield* Effect.fail(fail("Computer use can't line up its clicks with this screen's scaling, so it won't start. Try setting display scaling to 100%, or tell the developer."))
        })

        /**
         * After `begin` minimises the chat. Windows: until its windows are off the window list
         * (minimised windows drop off straight away, while the animation still plays), at most
         * BEGIN_MAX_MS. Actions settle the screen after acting, and a plain look right after
         * settles first (`afterBegin`). Where the screen can't be watched (a Mac without its
         * stream), it waits a fixed time for the animation instead.
         */
        const chatGone = Effect.gen(function* () {
          if (!watchingNow()) return yield* Effect.asVoid(settle(150, 350))
          const t = performance.now()
          for (;;) {
            const s = yield* readState
            if (!s.windows.some((w) => w.pid === ports.selfPid && !w.clickThrough)) break
            if (performance.now() - t >= BEGIN_MAX_MS) break
            yield* wait(30)
          }
          afterBegin = true
        })

        /**
         * Once `open_app` has a window in front. One that just appeared draws its content after it
         * shows, and a starting app may show a blank or loading window for a while: it waits until
         * the screen has changed and held still, or stayed still for over a second, at most
         * OPEN_SETTLE_MAX_MS, so the screenshot it returns is usable. A window that was already
         * open only comes forward. Where the screen can't be watched (a Mac without its stream),
         * it waits a fixed time.
         */
        const settleOpened = (launched: boolean) =>
          Effect.gen(function* () {
            if (!launched || !watchingNow()) return yield* settle(250, launched ? 1000 : 600)
            const { end } = yield* waitForScreen(OPEN_SETTLE_MAX_MS, { min: 300, still: 1200 })
            return end !== 'changing'
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
              granted = true
              // The stream opens while the chat gets out of the way.
              screen.prepare?.()
              yield* checkScale
              owner = id
              // And stays open until `end`, however long the model takes: a Mac hides the overlay
              // for a capture the stream can't take, which shows as a blink.
              screen.hold?.()
              workWindow = null
              agentAt = null
              // The reply's glance is the screenshot its first action aims at.
              if (glancedFor !== id) frame = null
              glancedFor = null
              if (marks.length) {
                marks = []
                overlay.send({ type: 'clear' })
              }
              overlay.send({ type: 'mode', follow: mode })
              yield* status('Getting ready')
              chatWindows.hide()
              yield* chatGone
            }),

          end: (id) =>
            Effect.sync(() => {
              if (glancedFor === id) glancedFor = null
              if (owner !== id) return
              owner = null
              frame = null
              workWindow = null
              agentAt = null
              afterBegin = false
              screen.release?.()
              rest()
              // With marks up, they are the answer: the chat comes back when the user is done reading.
              if (resting !== 'done') chatWindows.show()
            }),

          replyEnded: (id) =>
            Effect.sync(() => {
              if (owner !== null || (glancedFor !== null && glancedFor !== id)) return
              glancedFor = null
              screen.release?.()
            }),

          owner: () => owner,
          onStop: (handler) => (stopHandler = handler),

          setMode: (on) =>
            Effect.sync(() => {
              if (!driver || on === mode) return
              mode = on
              // Start the input helper now (about 0.6 s on Windows), not on the first action. On a
              // Mac, not before the permissions it needs are granted.
              if (on && granted) void driver.state().catch(() => undefined)
              // And the screen stream, so the first reply's glance doesn't wait for it (it closes
              // itself when idle).
              if (on && granted) screen.prepare?.()
              // No chat that could use the computer is open: nothing needs the screen stream.
              if (!on && !owner) screen.release?.()
              if (owner) overlay.send({ type: 'mode', follow: mode })
              // Leaving computer mode keeps marks the user hasn't read yet.
              else if (resting !== 'done') rest()
              else overlay.send({ type: 'mode', follow: mode })
            }),

          hint: (label) =>
            Effect.sync(() => {
              thinkingOn = false
              if (owner) overlay.send({ type: 'status', state: 'working', label })
              else if (mode) overlay.send({ type: 'hint', label })
            }),

          thinking: Effect.sync(() => {
            if (owner) overlay.send({ type: 'status', state: 'working', label: THINKING_LABEL, busy: true })
            else if (mode) overlay.send({ type: 'hint', label: THINKING_LABEL, busy: true })
            else return
            thinkingOn = true
          }),

          prewarm: Effect.sync(() => {
            if (driver && granted) screen.prepare?.()
          }),

          canWatch: Effect.suspend(() => {
            if (!driver) return Effect.succeed(false)
            if (screen.probe) return Effect.succeed(true)
            // A Mac: its stream only opens once the permissions it needs are granted. Granted in an
            // earlier session counts, so the first reply after launch can watch too (checking asks nothing).
            if (!granted && ports.hasPermissions?.()) granted = true
            const watchable = screen.watchable?.bind(screen)
            if (!watchable || !granted) return Effect.succeed(false)
            return Effect.promise(() => watchable().catch(() => false))
          }),

          look,

          wait: (maxMs, opts) =>
            Effect.gen(function* () {
              yield* needDriver
              yield* status('Waiting for the screen')
              const { ms, end } = yield* waitForScreen(maxMs, { whole: opts?.watch === false })
              return { look: yield* capture(yield* readState), ms, end } satisfies Waited
            }),

          glance: (id) =>
            Effect.gen(function* () {
              if (!driver || !granted || (owner && owner !== id)) return null
              screen.prepare?.()
              const ctx = yield* guard
              const reasonOf = (w: WindowInfo) => protectedReason(w, ctx)
              const s = yield* readState
              const display = screen.display()
              const f = makeFrame(display)
              /**
               * The glance, with the windows in `left` out of the capture. They are out of the
               * window list too, so protected windows under them are worked out (and painted over)
               * as if they weren't there: nothing that was under the chat shows unchecked.
               */
              const glanceWith = (left: ReadonlySet<number>, shot: { fresh?: boolean; after?: number; withoutApp?: boolean } = {}) =>
                Effect.gen(function* () {
                  const seen = left.size ? { ...s, windows: s.windows.filter((w) => !left.has(w.hwnd)) } : s
                  const active = left.has(s.foreground) ? 'this chat, which minimises when you first act' : undefined
                  const hidden = hiddenRegions(seen.windows, reasonOf, { x: display.x, y: display.y, w: display.w, h: display.h })
                  // This app's windows still in the picture, painted grey.
                  const mine = hidden.filter((h) => h.window.pid === ports.selfPid)
                  const covered = mine.flatMap((h) => h.parts).reduce((n, p) => n + p.w * p.h, 0) / (display.w * display.h)
                  const windowsOnly = (why: string): Glance => ({
                    image: null,
                    text: `${describe(seen, f, hidden, reasonOf, active).split('\n').slice(1).join('\n')}\n${noScreenshot(why)}`
                  })
                  if (covered > GLANCE_MAX_COVERED) return windowsOnly("this chat's window covers most of the screen")
                  const look = yield* Effect.option(capture(seen, { ...(left.size > 0 ? shot : {}), ...(active ? { active } : {}) }))
                  if (Option.isNone(look)) return windowsOnly("the screen couldn't be captured just now")
                  glancedFor = id
                  const chat = mine.length
                    ? "This chat's own window is in front for now (grey above); it minimises when you first act, so what's under it shows then."
                    : ''
                  return { image: look.value.image, text: chat ? `${look.value.text}\n${chat}` : look.value.text } satisfies Glance
                })
              const leaveOut = chatWindows.leaveOut?.bind(chatWindows)
              if (!leaveOut) {
                // A Mac's stream never has this app's windows in it: the screenshot shows what's
                // under the chat, as on Windows. It's taken from the stream or not at all.
                if (screen.keepsAppOut?.()) {
                  const mine = new Set(s.windows.filter((w) => w.pid === ports.selfPid).map((w) => w.hwnd))
                  return yield* glanceWith(mine, { withoutApp: true })
                }
                return yield* glanceWith(new Set())
              }
              // Where the screen stream is before the chat is left out: the capture takes a frame
              // from after that, which shows what's under the chat, instead of grabbing a new one.
              const mark = screen.mark?.bind(screen)
              const after = mark ? yield* Effect.promise(() => mark().catch(() => null)) : null
              // Windows: the chat is left out of the capture, so the screenshot shows what's under
              // it, and back in straight after, so the user can still capture it themselves.
              // Stop pressed meanwhile must not leave the chat out of the user's own captures.
              return yield* Effect.acquireUseRelease(
                Effect.uninterruptible(Effect.option(attempt('Leaving the chat out of the capture', leaveOut).pipe(timed('leaveOut')))),
                (left) => glanceWith(Option.isSome(left) ? new Set(left.value.hwnds) : new Set(), { fresh: true, ...(after !== null ? { after } : {}) }),
                (left) => Effect.sync(() => Option.isSome(left) && left.value.restore())
              )
            }).pipe(Effect.orElseSucceed(() => null)),

          zoom: (x, y, w, h) =>
            Effect.gen(function* () {
              const f = yield* requireFrame
              yield* status('Looking closer')
              yield* settleAfterBegin
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
              const shot = yield* shoot(size, cover, crop)
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
              const borrow = yield* borrowPointer
              const note = yield* act('Clicking', () => d.click(w.hwnd, p.x, p.y, button, count, { borrow }))
              workWindow = w.hwnd
              return { look: noted(yield* settleAndLook(150, 550), note), app: nameOf(w) }
            }),

          move: (x, y, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const p = yield* toScreen(f, x, y)
              const w = yield* pointerTarget(s, p)
              yield* glide(f, x, y, label)
              yield* act('Pointing', () => d.hover(w.hwnd, p.x, p.y))
              return { look: yield* settleAndLook(100, 450), app: nameOf(w) }
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
              const borrow = yield* borrowPointer
              const note = yield* act('Dragging', () => d.drag(w.hwnd, a, b, { borrow }))
              workWindow = w.hwnd
              return { look: noted(yield* settleAndLook(150, 500), note), app: nameOf(w) }
            }),

          scroll: (x, y, dx, dy, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const p = yield* toScreen(f, x, y)
              const w = yield* pointerTarget(s, p)
              yield* glide(f, x, y, label, 'scroll')
              const note = yield* act('Scrolling', () => d.wheel(w.hwnd, p.x, p.y, dx, dy))
              return { look: noted(yield* settleAndLook(120, 450), note), app: nameOf(w) }
            }),

          type: (text, label) =>
            Effect.gen(function* () {
              const { d, f, s } = yield* before(label)
              const w = yield* keyTarget(d, s)
              yield* showTyping(f, label)
              yield* act('Typing', () => d.text(text))
              return { look: yield* settleAndLook(100, 350), app: nameOf(w) }
            }),

          keys: (combo, label) =>
            Effect.gen(function* () {
              const vks = yield* Effect.try({ try: () => parseKeys(combo), catch: (e) => fail(errorMessage(e)) })
              const chord = protectedChord(vks, ports.os)
              if (chord) return yield* Effect.fail(fail(`Blocked: ${chord}, which are protected. Don't look for another way in; ask the user.`, 'blocked'))
              const { d, f, s } = yield* before(label)
              const w = yield* keyTarget(d, s)
              yield* showTyping(f, label)
              yield* act('Pressing keys', () => d.keys(vks))
              return { look: yield* settleAndLook(150, 450), app: nameOf(w) }
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
              yield* act('Opening the app', () => d.launch(found.id))
              // Wait for its window: a new foreground window, up to several seconds for big apps.
              // An app that was already in front only adds a window, if anything; give it a moment.
              const before = new Set(s0.windows.map((w) => w.hwnd))
              let s = s0
              let appeared: number | null = null
              const t = performance.now()
              while (performance.now() - t < 12_000) {
                yield* wait(120)
                s = yield* readState
                if (s.foreground !== s0.foreground) break
                if (appeared === null && s.windows.some((w) => !before.has(w.hwnd))) appeared = performance.now()
                if (appeared !== null && performance.now() - appeared > 600) break
              }
              const fg = s.windows.find((w) => w.hwnd === s.foreground) ?? null
              if (fg && s.foreground !== s0.foreground) workWindow = fg.hwnd
              // A window in front that wasn't there before: the app is starting, or opened a new window.
              const launched = fg !== null && !before.has(fg.hwnd)
              const settled = yield* settleOpened(launched)
              return { look: { ...(yield* capture(yield* readState)), settled }, app: fg ? appName(fg) : found.name }
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
              yield* act('Switching windows', () => d.focus(w.hwnd))
              workWindow = w.hwnd
              return { look: yield* settleAndLook(120, 500), app: appName(w) }
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
              const note = yield* act('Choosing from the menu', () => choose(w.hwnd, path))
              return { look: noted(yield* settleAndLook(150, 500), note), app: nameOf(w) }
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
              // The overlay's cursor draws the marks one after another, after any still being drawn.
              // The model goes on meanwhile; an action that would clear them waits (see `before`).
              marksDrawnAt = Math.max(performance.now(), marksDrawnAt) + Math.min(ANNOTATE_MAX_MS, 300 + added.length * ANNOTATE_MS)
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

        // Quitting, mid-run or not: nothing stays drawn on screen, the chat isn't left minimised,
        // and the screen stream (and the helper keeping it, on a Mac) ends for good.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            driver?.close()
            if (screen.close) screen.close()
            else screen.release?.()
            overlay.send({ type: 'status', state: 'off', label: '' })
            chatWindows.show()
          })
        )

        return Computer.of(api)
      })
    )
}
