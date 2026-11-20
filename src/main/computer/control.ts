import { Data, Effect } from 'effect'
import type { FileHit, Platform, ScreenRect, Screenshot, SearchQuery, UiElement, WindowInfo } from './platform/types'

export class ControlError extends Data.TaggedError('ControlError')<{ readonly message: string }> {}

/** Raised when the physical mouse moved since computer use last placed it. */
export class UserTookOver extends Data.TaggedError('UserTookOver')<{}> {}

/** Raised by an input action once the user has stopped the reply. */
export class Stopped extends Data.TaggedError('Stopped')<{}> {}

type Ctl<A> = Effect.Effect<A, ControlError>
type Act<A> = Effect.Effect<A, ControlError | UserTookOver | Stopped>

const TAKEOVER_PX = 28
/** Screenshots are scaled to this width: ~35% fewer image tokens than 1280, and clicks go by element id. */
export const SHOT_WIDTH = 1024
/** Typed text goes to the host in chunks this long (~4 ms a character), so Stop lands within ~100 ms. */
export const TYPE_CHUNK = 16
/** Element names kept for step labels, across the last few control lists. */
const MAX_NAMES = 2000

/** Split text for typing without breaking a surrogate pair. */
export const typeChunks = (text: string, size = TYPE_CHUNK): string[] => {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

/**
 * Safe, Effect-shaped access to the computer, plus the bookkeeping the tools need: mapping between
 * screenshot pixels and screen space, giving focus back to the user's app before input, noticing
 * when the user grabs the mouse, and the Stop gate.
 */
export const makeControl = (p: Platform) => {
  let shot: Pick<Screenshot, 'imageWidth' | 'imageHeight' | 'screen'> | null = null
  let leftAt: { x: number; y: number } | null = null
  const names = new Map<number, string>()
  let gate = new AbortController()

  const checkpoint: Effect.Effect<void, Stopped> = Effect.suspend(() => (gate.signal.aborted ? Effect.fail(new Stopped()) : Effect.void))

  /** Completes as soon as `cancel` is called (at once if it already was). */
  const whenStopped: Effect.Effect<void> = Effect.suspend(() => {
    const signal = gate.signal
    if (signal.aborted) return Effect.void
    return Effect.callback<void>((resume) => {
      const on = () => resume(Effect.void)
      signal.addEventListener('abort', on, { once: true })
      return Effect.sync(() => signal.removeEventListener('abort', on))
    })
  })

  const lift = <A>(f: () => Promise<A>): Ctl<A> =>
    Effect.tryPromise({
      try: f,
      catch: (e) => new ControlError({ message: e instanceof Error ? e.message : String(e) })
    })

  /** Before any input: hand focus back, refuse elevated targets, detect takeover. */
  const preflight: Act<void> = Effect.gen(function* () {
    yield* checkpoint
    const fg = yield* lift(() => p.restoreFocus())
    if (fg.blocked) {
      return yield* new ControlError({
        message: `"${fg.title || fg.process}" is running as administrator, so Windows blocks chat-v2's input to it. Tell the user; they can run chat-v2 as administrator to allow it.`
      })
    }
    if (leftAt) {
      const now = yield* lift(() => p.cursor())
      if (Math.hypot(now.x - leftAt.x, now.y - leftAt.y) > TAKEOVER_PX) {
        leftAt = null
        return yield* new UserTookOver()
      }
    }
    yield* checkpoint
  })

  const act = <A>(f: () => Promise<A>, cursorAfter?: { x: number; y: number }): Act<A> =>
    preflight.pipe(
      Effect.andThen(lift(f)),
      Effect.tap(() =>
        Effect.sync(() => {
          if (cursorAfter) leftAt = cursorAfter
        })
      )
    )

  const needShot = Effect.suspend(() =>
    shot ? Effect.succeed(shot) : Effect.fail(new ControlError({ message: 'Call look_at_screen first so coordinates have a frame of reference.' }))
  )

  const toScreenPoint = (s: NonNullable<typeof shot>, x: number, y: number) => ({
    x: Math.round(s.screen.x + (x * s.screen.width) / s.imageWidth),
    y: Math.round(s.screen.y + (y * s.screen.height) / s.imageHeight)
  })

  return {
    platform: p.name,
    /** Whether the platform can read controls (ui_elements). */
    controls: p.controls !== false,
    remember: (): Ctl<WindowInfo> => lift(() => p.remember()),
    screenshot: (): Ctl<Screenshot> =>
      lift(() => p.screenshot(SHOT_WIDTH)).pipe(
        Effect.tap((s) =>
          Effect.sync(() => {
            shot = { imageWidth: s.imageWidth, imageHeight: s.imageHeight, screen: s.screen }
          })
        )
      ),
    /** Map a point in the last screenshot's pixel space to screen space. */
    toScreen: (x: number, y: number): Ctl<{ x: number; y: number }> => needShot.pipe(Effect.map((s) => toScreenPoint(s, x, y))),
    rectToScreen: (r: ScreenRect): Ctl<ScreenRect> =>
      needShot.pipe(
        Effect.map((s) => {
          const kx = s.screen.width / s.imageWidth
          const ky = s.screen.height / s.imageHeight
          return {
            x: Math.round(s.screen.x + r.x * kx),
            y: Math.round(s.screen.y + r.y * ky),
            width: Math.round(r.width * kx),
            height: Math.round(r.height * ky)
          }
        })
      ),
    rectToImage: (r: ScreenRect): ScreenRect | null => {
      if (!shot) return null
      const kx = shot.imageWidth / shot.screen.width
      const ky = shot.imageHeight / shot.screen.height
      return {
        x: Math.round((r.x - shot.screen.x) * kx),
        y: Math.round((r.y - shot.screen.y) * ky),
        width: Math.round(r.width * kx),
        height: Math.round(r.height * ky)
      }
    },
    click: (x: number, y: number, button: 'left' | 'right' | 'middle', count: number): Act<void> =>
      act(() => p.click(x, y, button, count), { x, y }),
    drag: (x1: number, y1: number, x2: number, y2: number): Act<void> => act(() => p.drag(x1, y1, x2, y2), { x: x2, y: y2 }),
    scroll: (x: number, y: number, dy: number, dx: number): Act<void> => act(() => p.scroll(x, y, dy, dx), { x, y }),
    type: (text: string): Act<void> =>
      Effect.gen(function* () {
        yield* preflight
        for (const part of typeChunks(text)) {
          yield* checkpoint
          yield* lift(() => p.type(part))
        }
      }),
    keys: (combo: string): Act<void> => act(() => p.keys(combo)),
    uiTree: (max: number): Ctl<{ window: WindowInfo; elements: ReadonlyArray<UiElement>; truncated?: boolean }> =>
      lift(() => p.uiTree(max)).pipe(
        Effect.tap((t) =>
          Effect.sync(() => {
            // Ids aren't reused across lists, so older names stay right; keep the latest few lists'.
            for (const e of t.elements) if (e.name) names.set(e.id, e.name)
            while (names.size > MAX_NAMES) names.delete(names.keys().next().value!)
          })
        )
      ),
    /** The accessible name of an element from the last ui_elements, for readable step labels. */
    elementName: (id: number): string | undefined => names.get(id),
    invoke: (id: number): Act<string> =>
      Effect.gen(function* () {
        yield* checkpoint
        const r = yield* lift(() => p.elementRect(id))
        const how = yield* act(() => p.invoke(id))
        // Only a fallback click moves the cursor; UI Automation patterns don't.
        if (how === 'clicked') leftAt = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
        return how
      }),
    setValue: (id: number, text: string): Act<string> => act(() => p.setValue(id, text)),
    elementRect: (id: number): Ctl<ScreenRect> => lift(() => p.elementRect(id)),
    /** Map a point from the last screenshot to screen space and return the control there, if any. */
    elementAtImagePoint: (x: number, y: number): Ctl<{ point: { x: number; y: number }; rect: ScreenRect | null }> =>
      needShot.pipe(
        Effect.map((s) => toScreenPoint(s, x, y)),
        Effect.flatMap((point) =>
          lift(() => p.elementAt(point.x, point.y)).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((rect) => ({ point, rect }))
          )
        )
      ),
    windows: (): Ctl<ReadonlyArray<WindowInfo & { minimized?: boolean }>> => lift(() => p.windows()),
    focusWindow: (title: string): Ctl<WindowInfo> => lift(() => p.focusWindow(title)),
    foreground: (): Ctl<WindowInfo> => lift(() => p.foreground()),
    search: (q: SearchQuery): Ctl<ReadonlyArray<FileHit>> => lift(() => p.search(q)),
    open: (target: string): Ctl<void> => lift(() => p.open(target)),
    reveal: (path: string): Ctl<void> => lift(() => p.reveal(path)),
    /** If a chat-v2 window has focus, hand it back to the app the user was in. */
    restoreFocus: (): Ctl<WindowInfo> => lift(() => p.restoreFocus()),
    /** Forget where we left the cursor (a new user turn, or the user just acted). */
    resetTakeover: () => {
      leftAt = null
    },
    /** Forget the last screenshot (a new user turn): the screen may have changed since, so coordinates need a fresh look. */
    forgetShot: () => {
      shot = null
    },
    /**
     * Stop: every input action checks this between its steps (focus, each typed chunk, the
     * click) and fails with `Stopped`. Stays on until `resume`.
     */
    cancel: () => {
      gate.abort()
      // Also abort the host's in-flight step (a long type, a drag, a slow UI tree read).
      void p.cancel?.().catch(() => undefined)
    },
    /** A new turn: input is allowed again. */
    resume: () => {
      if (gate.signal.aborted) gate = new AbortController()
    },
    stopped: () => gate.signal.aborted,
    whenStopped
  }
}

export type Control = ReturnType<typeof makeControl>
