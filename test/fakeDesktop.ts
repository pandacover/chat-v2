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
}

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
    ports: null as unknown as ComputerPorts
  }
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
      capture: async (size, cover) => {
        d.covers.push(cover)
        return { dataUrl: 'data:image/jpeg;base64,SHOT', w: size.w, h: size.h }
      }
    },
    overlay: {
      send: (e) => void d.overlay.push(e),
      onCommand: (handler) => {
        d.stop = () => handler('stop')
      },
      hiddenWhile: (capture) => capture()
    },
    chatWindows: { hide: () => void d.chat.push('hide'), show: () => void d.chat.push('show') }
  }
  return d
}
