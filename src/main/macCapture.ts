// The macOS screen for computer use: a ScreenCaptureKit stream kept by a small Swift helper
// (native/mac-capture/main.swift), as the hidden stream page is on Windows (streamedScreen in
// desktop.ts). A screenshot is the newest frame, scaled, covered and encoded by the helper, and the
// stream's own frame reports say when the screen changed, so actions wait only until it holds
// still. The whole app is left out of the stream: the overlay is never hidden for a capture, and a
// reply's first look sees what's under the chat. Without the helper (not built, failing, no
// permission) it captures as before: getSources, with the overlay hidden for each capture.
// Electron is injected (see macScreen in desktop.ts), so this loads in tests.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DisplayInfo, ScreenChanges, ScreenPort } from './desktop'
import { type HelperProcess, helperProcess } from './helperProcess'

export interface MacCaptureDeps {
  /** Starts the helper; null where there is none (it wasn't built). */
  spawnHelper: (() => ChildProcessWithoutNullStreams) | null
  display(): DisplayInfo
  /** The primary display's id as ScreenCaptureKit knows it (Electron's display id on a Mac). */
  displayId(): number
  cursor: ScreenPort['cursor']
  /** A capture without the stream (desktopCapturer.getSources), which has the overlay in it. */
  fallback: ScreenPort['capture']
  /** Keeps the overlay out of a capture that would show it (OverlayPort.hiddenWhile). */
  hiddenWhile: <A>(capture: () => Promise<A>) => Promise<A>
  /** This app's process: the stream leaves its windows out. */
  pid: number
  /** Says why the stream isn't being used, once per reason. */
  warn?: (message: string) => void
  idleMs?: number
  /** How long a stream opened ahead of a reply (`prepare`) stays open unused. */
  prewarmIdleMs?: number
}

/**
 * With nothing captured for this long, the stream closes. Shorter than on Windows: while it runs,
 * macOS keeps its recording indicator up and the helper keeps receiving frames.
 */
export const MAC_STREAM_IDLE_MS = 10_000
/**
 * Opened ahead of a reply (computer mode starting, the user writing: `prepare`), as on Windows
 * (PREWARM_IDLE_MS in desktop.ts): the reply's glance renews it, and every reply in a computer
 * chat closes it when it ends.
 */
export const MAC_PREWARM_IDLE_MS = 10_000
/** How long `watchable` waits for the stream to come up, when it wasn't already. */
export const WATCHABLE_WAIT_MS = 3000
/** A stream that failed this many times stays off; getSources still works. */
const MAX_FAILURES = 3

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const macCaptureScreen = (deps: MacCaptureDeps): ScreenPort & { close(): void } => {
  let helper: HelperProcess | null = null
  /** Why the helper can't be used at all (not built, an old macOS, no permission): for good. */
  let unusable: string | null = deps.spawnHelper ? null : 'the capture helper was not built'
  /** The display the stream shows (id and size); a change of display reopens it. */
  let streaming: string | null = null
  /** The stream leaves out the app as a whole, not only the windows it had when it started. */
  let appOut = false
  let opening: Promise<boolean> | null = null
  let failures = 0
  let idle: ReturnType<typeof setTimeout> | null = null
  /** Counts closes, so a start that finishes after a close is thrown away. */
  let generation = 0

  const warned = new Set<string>()
  const warn = (m: string) => {
    if (warned.has(m)) return
    warned.add(m)
    deps.warn?.(`Screen stream not used: ${m}`)
  }
  const displayKey = () => {
    const d = deps.display()
    return `${deps.displayId()}:${d.w}x${d.h}`
  }

  const getHelper = () =>
    (helper ??= helperProcess(
      deps.spawnHelper!,
      (ready) => {
        const problem =
          ready.sck !== true
            ? `ScreenCaptureKit isn't available on macOS ${String(ready.os)}`
            : ready.permission !== true
              ? 'the capture helper has no Screen Recording permission'
              : null
        if (problem) unusable = problem
        return problem
      },
      'the capture helper'
    ))

  const close = () => {
    generation++
    if (idle) clearTimeout(idle)
    idle = null
    const was = streaming !== null || opening !== null
    streaming = null
    appOut = false
    opening = null
    // Requests run in order, so this also stops a stream that is still starting.
    if (was && helper) void helper.request('stop').catch(() => undefined)
  }

  /** A grab or a look at the changes failed: the stream is taken as down, and reopens next time. */
  const failed = (e: unknown) => {
    failures++
    streaming = null
    appOut = false
    warn(message(e))
  }

  const open = (): Promise<boolean> => {
    if (streaming !== null) return Promise.resolve(true)
    if (unusable || failures >= MAX_FAILURES) return Promise.resolve(false)
    if (opening) return opening
    const gen = generation
    const key = displayKey()
    const d = deps.display()
    const p = getHelper()
      .request('start', deps.displayId(), deps.pid, d.w, d.h)
      .then(
        (r) => {
          if (gen !== generation) return false
          streaming = key
          appOut = r.appExcluded === true
          return true
        },
        (e) => {
          if (gen !== generation) return false
          if (unusable) warn(unusable)
          else failed(e)
          return false
        }
      )
      .finally(() => {
        if (opening === p) opening = null
      })
    opening = p
    return p
  }

  /**
   * Whether the stream is up and still shows the primary display; if not, starts opening it. It
   * closes after `idleMs` without another call.
   */
  const use = (idleMs = deps.idleMs ?? MAC_STREAM_IDLE_MS) => {
    if (streaming !== null && streaming !== displayKey()) close()
    if (idle) clearTimeout(idle)
    idle = setTimeout(close, idleMs)
    if (streaming !== null) return true
    void open()
    return false
  }

  const live = () => streaming !== null && streaming === displayKey()

  return {
    display: deps.display,
    cursor: deps.cursor,
    keepsOverlayOut: true,
    live,
    keepsAppOut: () => live() && appOut,

    capture: async (size, cover, crop, opts) => {
      // The stream's newest frame is the screen: every change reaches it within a frame (1/15 s),
      // and this app is never in it, so `fresh` needs nothing more.
      if (use() && helper) {
        const t = performance.now()
        const d = deps.display()
        const rel = crop ? { x: crop.x - d.x, y: crop.y - d.y, w: crop.w, h: crop.h } : null
        const h = helper
        const grab = () => h.request('grab', size.w, size.h, JSON.stringify(cover), JSON.stringify(rel), d.w)
        if (opts?.withoutApp && !appOut) throw new Error("the screen stream doesn't leave this app's windows out")
        try {
          // Leaving the app out leaves out an overlay opened later too; leaving out its windows
          // (when the app wasn't listed yet) may not, so then the overlay is hidden as before.
          const r = appOut ? await grab() : await deps.hiddenWhile(grab)
          const ms = (r.ms ?? {}) as Record<string, number>
          return { dataUrl: `data:image/jpeg;base64,${String(r.jpeg)}`, w: Number(r.w), h: Number(r.h), ms: { sck: performance.now() - t, ...ms } }
        } catch (e) {
          failed(e)
        }
      }
      if (opts?.withoutApp) throw new Error("the screen stream isn't up, so this app's windows can't be left out of the capture")
      const t = performance.now()
      let inner = 0
      const shot = await deps.hiddenWhile(async () => {
        const t1 = performance.now()
        try {
          return await deps.fallback(size, cover, crop)
        } finally {
          inner = performance.now() - t1
        }
      })
      return { ...shot, ms: { hide: performance.now() - t - inner, ...shot.ms } }
    },

    changes: async (): Promise<ScreenChanges | null> => {
      if (!use() || !helper) return null
      try {
        const r = await helper.request('changes')
        return { count: Number(r.count), stillMs: Number(r.stillMs) }
      } catch (e) {
        failed(e)
        return null
      }
    },

    watchable: async () => {
      if (use()) return true
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), WATCHABLE_WAIT_MS)))
      try {
        return await Promise.race([open(), timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    prepare: () => void use(deps.prewarmIdleMs ?? MAC_PREWARM_IDLE_MS),
    release: close,
    /** Quitting: stops the stream and ends the helper process; nothing starts it again. */
    close: () => {
      close()
      unusable = 'the app is quitting'
      helper?.close()
    }
  }
}
