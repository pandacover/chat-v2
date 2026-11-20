// CHAT_V2_FAKE_COMPUTER for the end-to-end test (e2e.mjs bundles this to CommonJS): a platform
// that never touches the desktop. Each call that would act prints "[fake-computer] <call>".
import type { Platform, ScreenRect } from '../../src/main/computer/platform/types'

const log = (line: string) => console.log(`[fake-computer] ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const win = { title: 'Notepad', process: 'notepad' }
let cursor = { x: 0, y: 0 }
/**
 * Set from the test through app.evaluate (this runs in the app's main process): where the user's
 * pointer is, whether they pressed the button, and where element 4 is now.
 */
const g = globalThis as { e2eUserCursor?: { x: number; y: number } | null; e2ePressed?: boolean; e2eRect?: { x: number; y: number; width: number; height: number } }

// Point: a "Save" button at 400,300 (120x36 DIPs) on the primary display, which pointAt finds and
// the fake capture draws. Electron is only there when this runs inside the app.
const screen = () => (require('electron') as typeof import('electron')).screen
const inputScale = () => (process.platform === 'win32' ? screen().getPrimaryDisplay().scaleFactor : 1)
const saveButton = (): ScreenRect => {
  const s = inputScale()
  const o = screen().getPrimaryDisplay().bounds
  return { x: Math.round((o.x + 400) * s), y: Math.round((o.y + 300) * s), width: Math.round(120 * s), height: Math.round(36 * s) }
}

export const platform: Platform = {
  name: process.platform === 'darwin' ? 'macos' : 'windows',
  remember: async () => win,
  restoreFocus: async () => win,
  foreground: async () => win,
  windows: async () => [win],
  focusWindow: async () => win,
  // A 1920x1080 screen captured down to 1024x576.
  screenshot: async () => ({ data: '', mime: 'image/jpeg', imageWidth: 1024, imageHeight: 576, screen: { x: 0, y: 0, width: 1920, height: 1080 }, window: win }),
  cursor: async () => g.e2eUserCursor ?? cursor,
  pressed: async () => {
    const down = !!g.e2ePressed
    g.e2ePressed = false
    return down
  },
  move: async (x, y) => {
    log(`move ${x},${y}`)
    cursor = { x, y }
  },
  click: async (x, y, button, count) => {
    log(`click ${x},${y} ${button} x${count}`)
    cursor = { x, y }
  },
  drag: async () => log('drag'),
  scroll: async () => log('scroll'),
  // About 4 ms a character, like the Windows host.
  type: async (text) => {
    await sleep(text.length * 4)
    log(`type ${text.length}`)
  },
  keys: async (combo) => log(`keys ${combo}`),
  uiTree: async () => ({ window: win, elements: [] }),
  invoke: async () => 'invoked',
  setValue: async () => 'set',
  elementRect: async () => g.e2eRect ?? { x: 100, y: 100, width: 40, height: 20 },
  elementAt: async () => null,
  pointAt: async (x, y) => {
    log(`pointAt ${x},${y}`)
    const b = saveButton()
    const on = x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
    return { window: { title: 'Untitled - Notepad', process: 'notepad' }, control: on ? { ...b, type: 'Button', name: 'Save' } : null }
  },
  search: async () => [],
  open: async (target) => log(`open ${target}`),
  reveal: async (path) => log(`reveal ${path}`),
  dispose: () => log('dispose')
}

/** Point's screen capture: a plain window-coloured display with the Save button on it, never the real screen. */
export const capture = async (d: { id: number; bounds: ScreenRect; scaleFactor: number }) => {
  log(`capture display ${d.id}`)
  const width = Math.round(d.bounds.width * d.scaleFactor)
  const height = Math.round(d.bounds.height * d.scaleFactor)
  const bgra = new Uint8Array(width * height * 4)
  const fill = (x0: number, y0: number, w: number, h: number, [b, g, r]: [number, number, number]) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) bgra.set([b, g, r, 255], (y * width + x) * 4)
  }
  fill(0, 0, width, height, [0xf3, 0xf3, 0xf3])
  const k = d.scaleFactor
  fill(Math.round(380 * k), Math.round(250 * k), Math.round(520 * k), Math.round(1 * k), [0xc8, 0xc8, 0xc8])
  fill(Math.round(400 * k), Math.round(300 * k), Math.round(120 * k), Math.round(36 * k), [0xd4, 0x78, 0x00])
  fill(Math.round(540 * k), Math.round(300 * k), Math.round(120 * k), Math.round(36 * k), [0xe0, 0xe0, 0xe0])
  return { width, height, bgra }
}
