// CHAT_V2_FAKE_COMPUTER for the end-to-end test (e2e.mjs bundles this to CommonJS): a platform
// that never touches the desktop. Each call that would act prints "[fake-computer] <call>".
import type { Platform } from '../../src/main/computer/platform/types'

const log = (line: string) => console.log(`[fake-computer] ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const win = { title: 'Notepad', process: 'notepad' }
let cursor = { x: 0, y: 0 }
/**
 * Set from the test through app.evaluate (this runs in the app's main process): where the user's
 * pointer is, whether they pressed the button, and where element 4 is now.
 */
const g = globalThis as { e2eUserCursor?: { x: number; y: number } | null; e2ePressed?: boolean; e2eRect?: { x: number; y: number; width: number; height: number } }

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
  search: async () => [],
  open: async (target) => log(`open ${target}`),
  reveal: async (path) => log(`reveal ${path}`),
  dispose: () => log('dispose')
}
