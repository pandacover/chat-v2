// A pretend Windows desktop for computer-use tests: windows, a cursor, and logs of what was
// done to them. Nothing touches the real screen, mouse or keyboard.
import type { DesktopState, OverlayEvent, WindowInfo } from '../src/shared/computer'
import type { ComputerPorts } from '../src/main/services/Computer'

export const SELF_PID = 4242

export const win = (over: Partial<WindowInfo>): WindowInfo => ({
  hwnd: 1,
  pid: 100,
  exe: 'notepad.exe',
  title: 'notes.txt - Notepad',
  cls: 'Notepad',
  x: 0,
  y: 0,
  w: 1920,
  h: 1040,
  clickThrough: false,
  ...over
})

export interface FakeDesktop {
  ports: ComputerPorts
  state: DesktopState
  /** Input that reached the "OS": clicks and the like posted to windows, keys, text. */
  input: string[]
  overlay: OverlayEvent[]
  chat: string[]
  /** Rectangles painted over in each capture, in screenshot pixels. */
  covers: Array<Array<{ x: number; y: number; w: number; h: number }>>
  apps: Array<{ name: string; id: string }>
  /** Pretend the helper isn't DPI aware: Electron sees the cursor elsewhere. */
  skewCursor: boolean
  stop: (() => void) | null
  /**
   * What the screen looks like to `probe`, asked each time it probes (Windows only, as in the
   * app): a still screen by default. `probes` counts the looks.
   */
  look: () => Uint8Array
  probes: number
  /**
   * Each capture: whether it asked for a fresh frame, and whether this app's windows were left out
   * of it; `after` when it would take a stream frame newer than that mark (Windows).
   */
  shots: Array<{ fresh: boolean; chatLeftOut: boolean; after?: number }>
  /** This app's windows are out of captures now (Windows, see ChatWindowsPort.leaveOut). */
  leftOut: boolean
  /** What the pretend stream's `mark` says the time is (Windows). */
  markTime: number
  /** Times the screen was asked to get ready (the stream opened), Windows only. */
  prepared: number
  /** The overlay shows the thinking spinner now (a busy status or hint, until the next event). */
  spinning: boolean
  /** Captures and probes taken while the spinner was up: there should be none. */
  watchedWhileSpinning: number
}

/** A probe thumbnail of a screen of one grey level. */
export const still = (level = 0) => new Uint8Array(64 * 36).fill(level)

export const fakeDesktop = (windows: WindowInfo[] = [win({})], os: 'win32' | 'darwin' = 'win32'): FakeDesktop => {
  const d: FakeDesktop = {
    state: { cursor: { x: 50, y: 50 }, foreground: windows[0]?.hwnd ?? 0, windows },
    input: [],
    overlay: [],
    chat: [],
    covers: [],
    apps: [
      { name: 'DaVinci Resolve', id: 'resolve' },
      { name: 'Settings', id: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' },
      { name: 'Command Prompt', id: '{1AC14E77}\\cmd.exe' }
    ],
    skewCursor: false,
    stop: null,
    look: () => still(),
    probes: 0,
    shots: [],
    leftOut: false,
    markTime: 0,
    prepared: 0,
    spinning: false,
    watchedWhileSpinning: 0,
    ports: null as unknown as ComputerPorts
  }
  const minimised: WindowInfo[] = []
  d.ports = {
    selfPid: SELF_PID,
    os,
    driver: {
      state: async () => structuredClone(d.state),
      click: async (hwnd, x, y, button, count) => void d.input.push(`click ${hwnd} ${Math.round(x)},${Math.round(y)} ${button}${count > 1 ? ` x${count}` : ''}`),
      hover: async (hwnd, x, y) => void d.input.push(`hover ${hwnd} ${Math.round(x)},${Math.round(y)}`),
      drag: async (hwnd, a, b, opts) => void d.input.push(`${opts?.borrow ? 'pointer drag' : 'drag'} ${hwnd} ${Math.round(a.x)},${Math.round(a.y)} to ${Math.round(b.x)},${Math.round(b.y)}`),
      wheel: async (hwnd, x, y, dx, dy) => void d.input.push(`wheel ${hwnd} ${Math.round(x)},${Math.round(y)} ${dx},${dy}`),
      text: async (text) => void d.input.push(`text ${text}`),
      keys: async (vks) => void d.input.push(`keys ${vks.join(',')}`),
      focus: async (hwnd) => {
        d.input.push(`focus ${hwnd}`)
        d.state.foreground = hwnd
      },
      // Menus by name are a Mac thing.
      ...(os === 'darwin' ? { menu: async (hwnd: number, path: string[]) => void d.input.push(`menu ${hwnd} ${path.join(' > ')}`) } : {}),
      apps: async () => d.apps,
      launch: async (id) => {
        d.input.push(`launch ${id}`)
        const w = win({ hwnd: 99, pid: 500, exe: 'Resolve.exe', title: 'DaVinci Resolve - Untitled Project' })
        d.state.windows = [w, ...d.state.windows]
        d.state.foreground = 99
      },
      close: () => {}
    },
    // A 1920×1080 display at 100%: screenshots are 1280×720, so model pixels are ×1.5.
    screen: {
      display: () => ({ x: 0, y: 0, w: 1920, h: 1080, scale: 1 }),
      cursor: () => (d.skewCursor ? { x: d.state.cursor.x * 1.25, y: d.state.cursor.y * 1.25 } : d.state.cursor),
      capture: async (size, cover, _crop, opts) => {
        if (d.spinning) d.watchedWhileSpinning++
        d.covers.push(cover)
        d.shots.push({ fresh: opts?.fresh === true, chatLeftOut: d.leftOut, ...(opts?.after !== undefined ? { after: opts.after } : {}) })
        // Made-up part timings, so tests can see them reach the timing log.
        return { dataUrl: 'data:image/jpeg;base64,SHOT', w: size.w, h: size.h, ms: { sources: 3, cover: 1, encode: 2 } }
      },
      // A Mac has no stream to probe, so it waits fixed times for the screen.
      ...(os === 'win32'
        ? {
            probe: async () => {
              if (d.spinning) d.watchedWhileSpinning++
              d.probes++
              return d.look()
            },
            mark: async () => d.markTime,
            prepare: () => void d.prepared++
          }
        : {})
    },
    overlay: {
      send: (e) => {
        d.overlay.push(e)
        if (e.type === 'status' || e.type === 'hint') d.spinning = e.busy === true
        else if (e.type === 'cursor' || e.type === 'marks') d.spinning = false
      },
      onCommand: (handler) => {
        d.stop = () => handler('stop')
      },
      hiddenWhile: (capture) => capture()
    },
    // Minimised, this app's windows drop off the window list, as they do from the helper's.
    chatWindows: {
      hide: () => {
        d.chat.push('hide')
        minimised.push(...d.state.windows.filter((w) => w.pid === SELF_PID))
        d.state.windows = d.state.windows.filter((w) => w.pid !== SELF_PID)
      },
      show: () => {
        d.chat.push('show')
        d.state.windows = [...minimised.splice(0), ...d.state.windows]
      },
      // Windows leaves this app's windows out of a capture on request; a Mac can't.
      ...(os === 'win32'
        ? {
            leaveOut: async () => {
              d.chat.push('leave out')
              d.leftOut = true
              const hwnds = d.state.windows.filter((w) => w.pid === SELF_PID).map((w) => w.hwnd)
              return { hwnds, restore: () => void (d.chat.push('let in'), (d.leftOut = false)) }
            }
          }
        : {})
    }
  }
  return d
}
