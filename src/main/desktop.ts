// The Electron half of computer use: capturing the screen, the see-through overlay that draws
// the sketch cursor and marks, and moving the chat window out of the way.
import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } from 'electron'
import type { OverlayCommand, OverlayEvent, Rect } from '@shared/computer'

export interface DisplayInfo {
  /** The primary display in physical pixels. */
  x: number
  y: number
  w: number
  h: number
  scale: number
}

export interface ScreenPort {
  display(): DisplayInfo
  /** Where Electron says the cursor is, in physical pixels, to check the input helper agrees. */
  cursor(): { x: number; y: number }
  /**
   * A JPEG of the primary display at about `size`, with `cover` (image pixels) painted over.
   * With `crop` (physical pixels), only that part, captured at full resolution and scaled to `size`.
   */
  capture(size: { w: number; h: number }, cover: Rect[], crop?: Rect): Promise<{ dataUrl: string; w: number; h: number }>
}

export interface OverlayPort {
  send(event: OverlayEvent): void
  onCommand(handler: (command: OverlayCommand) => void): void
}

export interface ChatWindowsPort {
  /** Minimises the app's windows so the assistant has the screen. */
  hide(): void
  show(): void
}

export const electronScreen: ScreenPort = {
  display: () => {
    const d = screen.getPrimaryDisplay()
    const origin =
      process.platform === 'win32' ? screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y }) : { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor }
    return { x: origin.x, y: origin.y, w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), scale: d.scaleFactor }
  },
  cursor: () => {
    const p = screen.getCursorScreenPoint()
    return process.platform === 'win32' ? screen.dipToScreenPoint(p) : p
  },
  capture: async (size, cover, crop) => {
    const primary = screen.getPrimaryDisplay()
    const physical = { width: Math.round(primary.size.width * primary.scaleFactor), height: Math.round(primary.size.height * primary.scaleFactor) }
    // Chromium scales the frame down itself, which is faster than resizing a full-size capture.
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: crop ? physical : { width: size.w, height: size.h } })
    const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('the screen could not be captured')
    let image = source.thumbnail
    if (crop) {
      const full = image.getSize()
      const k = full.width / physical.width
      const origin = electronScreen.display()
      image = image
        .crop({ x: Math.round((crop.x - origin.x) * k), y: Math.round((crop.y - origin.y) * k), width: Math.max(1, Math.round(crop.w * k)), height: Math.max(1, Math.round(crop.h * k)) })
        .resize({ width: size.w, height: size.h, quality: 'best' })
    }
    const { width: w, height: h } = image.getSize()
    if (cover.length > 0) {
      const bitmap = image.toBitmap()
      for (const r of cover) paintHidden(bitmap, w, h, r)
      image = nativeImage.createFromBitmap(bitmap, { width: w, height: h })
    }
    return { dataUrl: `data:image/jpeg;base64,${image.toJPEG(75).toString('base64')}`, w, h }
  }
}

/** Grey with diagonal stripes, so the model can tell a hidden area from an empty one. BGRA. */
const paintHidden = (bitmap: Buffer, w: number, h: number, r: Rect) => {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(w, Math.ceil(r.x + r.w))
  const y1 = Math.min(h, Math.ceil(r.y + r.h))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = (x + y) % 16 < 3 ? 0x6e : 0x9a
      const i = (y * w + x) * 4
      bitmap[i] = v
      bitmap[i + 1] = v
      bitmap[i + 2] = v
      bitmap[i + 3] = 0xff
    }
  }
}

/**
 * A transparent window over the primary display that never takes the mouse (except over its
 * Stop pill) and is left out of screen captures, so the model never sees its own drawing.
 */
export const electronOverlay = (headless: boolean): OverlayPort => {
  let win: BrowserWindow | null = null
  let loaded: Promise<void> | null = null
  let queue: OverlayEvent[] = []
  let handler: (command: OverlayCommand) => void = () => {}
  let mode: OverlayEvent = { type: 'mode', follow: false }
  let poll: ReturnType<typeof setInterval> | null = null
  let lastPointer = ''
  let forwarding = false

  // The overlay can't see the mouse (it lets every event through), so its cursor learns where
  // the user's pointer is from here, about once a frame, and only when it has moved.
  const followPointer = (w: BrowserWindow) => {
    if (poll) clearInterval(poll)
    lastPointer = ''
    poll = setInterval(() => {
      if (w.isDestroyed()) return
      const b = screen.getPrimaryDisplay().bounds
      const p = screen.getCursorScreenPoint()
      const on = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height
      const key = on ? `${p.x},${p.y}` : 'off'
      if (key === lastPointer) return
      lastPointer = key
      w.webContents.send('overlay:event', on ? { type: 'pointer', x: p.x - b.x, y: p.y - b.y } : { type: 'pointer', x: null, y: null })
    }, 16)
  }
  const stopPolling = () => {
    if (poll) clearInterval(poll)
    poll = null
  }

  const create = () => {
    const d = screen.getPrimaryDisplay()
    const w = new BrowserWindow({
      ...d.bounds,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    w.setIgnoreMouseEvents(true)
    w.setContentProtection(true)
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true)
    forwarding = false
    w.on('closed', () => {
      if (win === w) win = null
      loaded = null
      stopPolling()
    })
    const url = process.env.ELECTRON_RENDERER_URL
    loaded = (url ? w.loadURL(`${url}/overlay.html`) : w.loadFile(join(__dirname, '../renderer/overlay.html'))).then(() => {
      if (w.isDestroyed()) return
      w.showInactive()
      // Windows fits a new window to the work area; the overlay also covers the taskbar.
      w.setBounds(d.bounds)
      w.webContents.send('overlay:event', mode)
      for (const e of queue.splice(0)) w.webContents.send('overlay:event', e)
      followPointer(w)
    })
    win = w
  }

  ipcMain.on('overlay:interactive', (event, on: unknown) => {
    if (win && event.sender === win.webContents) win.setIgnoreMouseEvents(on !== true, forwarding ? { forward: true } : undefined)
  })
  ipcMain.on('overlay:command', (event, command: unknown) => {
    if (win && event.sender === win.webContents && (command === 'stop' || command === 'show-chat' || command === 'clear')) handler(command)
  })

  return {
    send: (event) => {
      // Headless test runs never put anything on the real screen.
      if (headless) return
      if (event.type === 'status' && event.state === 'off') {
        stopPolling()
        win?.destroy()
        win = null
        queue = []
        return
      }
      // The mode outlives the window: a new overlay starts with the latest one.
      if (event.type === 'mode') mode = event
      // A hint or the mode alone doesn't bring the overlay up.
      if (!win && (event.type === 'mode' || event.type === 'hint' || event.type === 'clear')) return
      if (!win) create()
      // Hovering the status bar needs mouse moves forwarded, which on Windows takes a system-wide
      // mouse hook: only while the bar is up, not the whole time computer mode keeps the overlay open.
      if (event.type === 'status' && win) {
        const bar = event.state === 'working' || event.state === 'done'
        if (bar !== forwarding) {
          forwarding = bar
          win.setIgnoreMouseEvents(true, bar ? { forward: true } : undefined)
        }
      }
      if (loaded) void loaded.then(() => win && !win.isDestroyed() && win.webContents.send('overlay:event', event))
      else queue.push(event)
    },
    onCommand: (h) => (handler = h)
  }
}

export const electronChatWindows = (headless: boolean): ChatWindowsPort => {
  let hidden: BrowserWindow[] = []
  // The overlay is the one window that can't take focus.
  const appWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isFocusable() && w.isVisible())
  return {
    hide: () => {
      if (headless) return
      for (const w of appWindows()) {
        if (w.isMinimized()) continue
        w.minimize()
        hidden.push(w)
      }
    },
    show: () => {
      for (const w of hidden.splice(0)) if (!w.isDestroyed()) w.restore()
    }
  }
}
