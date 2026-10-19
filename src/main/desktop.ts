// The Electron half of computer use: capturing the screen, the see-through overlay that draws
// the sketch cursor and marks, and moving the chat window out of the way.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, desktopCapturer, ipcMain, nativeImage, screen, systemPreferences } from 'electron'
import type { OverlayCommand, OverlayEvent, Rect } from '@shared/computer'
import { macCaptureScreen } from './macCapture'

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
   * `ms` says how long its parts took (grabbing the frame, painting covers, encoding), for timing.
   * `fresh` asks for a frame grabbed after the call starts, never one already in hand (the stream's);
   * with `after` (from `mark`), a frame the stream got after that mark will do instead.
   * `withoutApp` needs this app's windows out of the picture (see `keepsAppOut`): it fails rather
   * than capture them.
   */
  capture(
    size: { w: number; h: number },
    cover: Rect[],
    crop?: Rect,
    opts?: { fresh?: boolean; after?: number; withoutApp?: boolean }
  ): Promise<{ dataUrl: string; w: number; h: number; ms?: Record<string, number> }>
  /**
   * A small grey thumbnail of the screen as it is now, cheap enough to take every few dozen
   * milliseconds, to wait until the screen stops changing (see screenChanged in Computer.ts).
   * Null while it can't be had. Without it, actions wait fixed times for the screen to settle.
   */
  probe?(): Promise<Uint8Array | null>
  /**
   * Where the screen reports its own changes (macOS, ScreenCaptureKit): how many times it has
   * changed so far, and how long it has been still. Null while the stream isn't up. A port has
   * `probe` or this, not both.
   */
  changes?(): Promise<ScreenChanges | null>
  /** Whether the stream is up now (macOS), so `changes` answers and `keepsAppOut` holds. */
  live?(): boolean
  /**
   * Whether the stream can come up: it opens it, and resolves once it is up (true) or can't be
   * (false: no helper, no permission, it keeps failing), waiting a little at most (macOS).
   */
  watchable?(): Promise<boolean>
  /** This app's windows (the chat, the overlay) are never in the stream's frames (macOS). */
  keepsAppOut?(): boolean
  /**
   * Keeps the overlay out of its captures itself (hiding it only when it must), so the caller
   * doesn't wrap them in OverlayPort.hiddenWhile (macOS).
   */
  keepsOverlayOut?: boolean
  /**
   * A mark for now, to ask `capture` with `after` for a stream frame that came in after it (and
   * after whatever the caller changes next has reached the screen). Null while the stream isn't up.
   */
  mark?(): Promise<number | null>
  /** Gets ready to capture often (opens the stream); captures work meanwhile. */
  prepare?(): void
  /** Done capturing for now. */
  release?(): void
}

/** How the screen has changed, as a stream that reports it says (see ScreenPort.changes). */
export interface ScreenChanges {
  /** Changes so far: two answers with the same count mean nothing changed in between. */
  count: number
  /** How long since the last change. */
  stillMs: number
}

export interface OverlayPort {
  send(event: OverlayEvent): void
  onCommand(handler: (command: OverlayCommand) => void): void
  /**
   * Runs a screen capture with the overlay out of the picture. Windows leaves it out of captures
   * by itself; recent macOS versions capture it anyway, so there it's hidden for that moment
   * (only without the stream, which leaves it out: see ScreenPort.keepsOverlayOut).
   */
  hiddenWhile<A>(capture: () => Promise<A>): Promise<A>
}

export interface ChatWindowsPort {
  /** Minimises the app's windows so the assistant has the screen. */
  hide(): void
  show(): void
  /**
   * Windows only: leaves the app's windows out of screen captures (WDA_EXCLUDEFROMCAPTURE, as the
   * overlay is) until `restore`, so a capture shows what's under them. Call `restore` straight
   * after capturing, so the user can still screenshot or share the chat. Resolves once the
   * desktop has had time to drop them, with their window handles; capture a fresh frame then
   * (see ScreenPort.capture). Absent on macOS, whose capture doesn't reliably honour content
   * protection; its stream leaves the app out instead (ScreenPort.keepsAppOut).
   */
  leaveOut?(): Promise<{ hwnds: number[]; restore(): void }>
}

const physicalSize = (d: Electron.Display) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) })

const display = (): DisplayInfo => {
  const d = screen.getPrimaryDisplay()
  const origin =
    process.platform === 'win32' ? screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y }) : { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor }
  return { x: origin.x, y: origin.y, w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), scale: d.scaleFactor }
}

const cursor = () => {
  const p = screen.getCursorScreenPoint()
  if (process.platform === 'win32') return screen.dipToScreenPoint(p)
  const scale = screen.getPrimaryDisplay().scaleFactor
  return { x: Math.round(p.x * scale), y: Math.round(p.y * scale) }
}

/** A capture with desktopCapturer.getSources: about 270 ms whatever the size, but always fresh. */
const captureSources: ScreenPort['capture'] = async (size, cover, crop) => {
  const primary = screen.getPrimaryDisplay()
  const physical = physicalSize(primary)
  // Chromium scales the frame down itself, which is faster than resizing a full-size capture.
  const t0 = performance.now()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: crop ? physical : { width: size.w, height: size.h } })
  const t1 = performance.now()
  const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('the screen could not be captured')
  let image = source.thumbnail
  if (crop) {
    const full = image.getSize()
    const k = full.width / physical.width
    const origin = display()
    image = image
      .crop({ x: Math.round((crop.x - origin.x) * k), y: Math.round((crop.y - origin.y) * k), width: Math.max(1, Math.round(crop.w * k)), height: Math.max(1, Math.round(crop.h * k)) })
      .resize({ width: size.w, height: size.h, quality: 'best' })
  }
  const { width: w, height: h } = image.getSize()
  const t2 = performance.now()
  if (cover.length > 0) {
    const bitmap = image.toBitmap()
    for (const r of cover) paintHidden(bitmap, w, h, r)
    image = nativeImage.createFromBitmap(bitmap, { width: w, height: h })
  }
  const t3 = performance.now()
  const dataUrl = `data:image/jpeg;base64,${image.toJPEG(75).toString('base64')}`
  const ms = { sources: t1 - t0, ...(crop ? { crop: t2 - t1 } : {}), cover: t3 - t2, encode: performance.now() - t3 }
  return { dataUrl, w, h, ms }
}

/**
 * macOS without the capture helper (see macScreen) captures fresh every time: the overlay is in
 * its captures and has to be hidden for each one (see hiddenWhile).
 */
const sourcesScreen: ScreenPort = { display, cursor, capture: captureSources }

/** With nothing captured for this long, the stream closes. */
const STREAM_IDLE_MS = 30_000

/**
 * Windows: a stream of the primary display kept open in a hidden page (renderer/capture.html)
 * while computer use works. A screenshot is the newest frame, drawn, covered and encoded there
 * (about 15 ms), and `probe` reads a small thumbnail of it to tell when the screen stops
 * changing. The overlay is left out of the stream as it is out of every capture
 * (WDA_EXCLUDEFROMCAPTURE). Until the stream is up, or if it fails, captures use getSources.
 * It opens when a chat with computer use is open or being written in (see Computer.prewarm), and
 * closes after STREAM_IDLE_MS without use. CHAT_V2_CAPTURE=sources turns the stream off, to compare.
 */
const streamedScreen = (): ScreenPort => {
  let win: BrowserWindow | null = null
  /** The display the stream shows (id and physical size); a change of display reopens it. */
  let streaming: string | null = null
  let opening = false
  let failures = 0
  let idle: ReturnType<typeof setTimeout> | null = null
  /** Counts closes, so an open that finishes after a close throws its stream away. */
  let generation = 0

  const displayKey = () => {
    const d = screen.getPrimaryDisplay()
    const p = physicalSize(d)
    return `${d.id}:${p.width}x${p.height}`
  }
  const close = () => {
    generation++
    if (idle) clearTimeout(idle)
    idle = null
    streaming = null
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }
  const run = <A>(code: string): Promise<A | null> =>
    win && !win.isDestroyed() ? (win.webContents.executeJavaScript(code) as Promise<A>).catch(() => null) : Promise.resolve(null)
  /** Whether the stream is up and still shows the primary display; if not, starts opening it. */
  const live = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(close, STREAM_IDLE_MS)
    if (streaming !== null && streaming !== displayKey()) close()
    if (streaming !== null) return true
    // A stream that keeps failing stays off; getSources still works.
    if (opening || failures >= 3) return false
    opening = true
    const gen = generation
    void (async () => {
      const key = displayKey()
      const primary = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
      if (!source) throw new Error('no screen to stream')
      // Never shown, and not focusable, so the chat-window code and the helper's window list skip it.
      const w = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      })
      if (gen !== generation) return void w.destroy()
      win = w
      const url = process.env.ELECTRON_RENDERER_URL
      await (url ? w.loadURL(`${url}/capture.html`) : w.loadFile(join(__dirname, '../renderer/capture.html')))
      const p = physicalSize(primary)
      const started = await run<boolean>(`capture.start(${JSON.stringify(source.id)}, ${p.width}, ${p.height})`)
      if (gen !== generation) return void (w.isDestroyed() || w.destroy())
      if (!started) throw new Error('the screen stream sent no frame')
      streaming = key
    })()
      .catch(() => {
        if (gen !== generation) return
        failures++
        close()
      })
      .finally(() => (opening = false))
    return false
  }

  return {
    display,
    cursor,
    capture: async (size, cover, crop, opts) => {
      // The stream's newest frame can predate what the caller just changed; getSources looks now,
      // unless the stream has had a frame since the caller's mark (it waits a moment for one).
      if (opts?.fresh && opts.after === undefined) return captureSources(size, cover, crop)
      if (live()) {
        const t = performance.now()
        const origin = display()
        const rel = crop ? { x: crop.x - origin.x, y: crop.y - origin.y, w: crop.w, h: crop.h } : null
        const after = opts?.fresh ? opts.after : undefined
        const shot = await run<{ dataUrl: string; w: number; h: number; ms: Record<string, number> }>(
          `capture.grab(${JSON.stringify(size)}, ${JSON.stringify(cover)}, ${JSON.stringify(rel)}, ${origin.w}, ${JSON.stringify(after ?? null)})`
        )
        if (shot) return { ...shot, ms: { stream: performance.now() - t, ...shot.ms } }
      }
      return captureSources(size, cover, crop)
    },
    mark: async () => (live() ? Date.now() : null),
    probe: async () => {
      if (!live()) return null
      const sig = await run<number[]>('capture.probe()')
      return sig ? Uint8Array.from(sig) : null
    },
    prepare: () => void live(),
    release: close
  }
}

export const electronScreen: ScreenPort = process.platform === 'win32' && process.env.CHAT_V2_CAPTURE !== 'sources' ? streamedScreen() : sourcesScreen

/**
 * The capture helper: built into native/mac-capture/out by scripts/build-mac-capture.ts in
 * development, shipped in the app's Resources (electron-builder.yml).
 */
const macCaptureHelper = () =>
  app.isPackaged ? join(process.resourcesPath, 'chat-v2-capture') : join(app.getAppPath(), 'native/mac-capture/out/chat-v2-capture')

/**
 * macOS: a ScreenCaptureKit stream kept by the capture helper (see macCapture.ts), opened and
 * closed as the Windows stream is. Without the helper it captures with getSources, hiding the
 * overlay for each capture. CHAT_V2_CAPTURE=sources turns the stream off, to compare.
 */
export const macScreen = (overlay: OverlayPort): ScreenPort => {
  if (process.env.CHAT_V2_CAPTURE === 'sources') return sourcesScreen
  const path = macCaptureHelper()
  return macCaptureScreen({
    // Spawned by the app, so macOS counts its screen capture as the app's (one permission, one prompt).
    spawnHelper: existsSync(path) ? () => spawn(path, [], { stdio: 'pipe' }) : null,
    display,
    displayId: () => screen.getPrimaryDisplay().id,
    cursor,
    fallback: captureSources,
    hiddenWhile: (capture) => overlay.hiddenWhile(capture),
    pid: process.pid,
    warn: (m) => console.warn(m)
  })
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
      // On macOS a non-activating panel: it floats over apps in full screen without taking focus
      // from the chat (or anything else) when it appears.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
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
    // On macOS, also over apps in full screen, which live in their own Space. Without
    // skipTransformProcessType, Electron briefly turns the whole app into a background app to do
    // this, which hides its windows for a moment and hands focus to whatever app is behind.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
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
      const got = w.getBounds()
      w.webContents.send('overlay:event', { type: 'frame', dx: got.x - d.bounds.x, dy: got.y - d.bounds.y, w: d.bounds.width, h: d.bounds.height } satisfies OverlayEvent)
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
    onCommand: (h) => (handler = h),
    hiddenWhile: async (capture) => {
      const w = win
      if (process.platform !== 'darwin' || !w || w.isDestroyed() || !w.isVisible()) return capture()
      w.setOpacity(0)
      // A frame for the window server to drop it from the screen.
      await new Promise((r) => setTimeout(r, 50))
      try {
        return await capture()
      } finally {
        if (!w.isDestroyed()) w.setOpacity(1)
      }
    }
  }
}

/** Whether macOS already lets the app work other apps and record the screen; asks for nothing. */
export const macHasPermissions = () => systemPreferences.isTrustedAccessibilityClient(false) && systemPreferences.getMediaAccessStatus('screen') === 'granted'

/**
 * macOS asks before an app may watch the screen or send input to other apps. Says what's still
 * missing, after asking for it (macOS shows its own prompt the first time), or null.
 */
export const macPermissions = async (): Promise<string | null> => {
  // Asking with `true` shows the system prompt the first time and only checks after that.
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    return 'Computer use needs Accessibility access to work your apps. Allow chat-v2 in System Settings → Privacy & Security → Accessibility, then try again.'
  }
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    // Trying to capture is what makes macOS ask for Screen Recording.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      return 'Computer use needs Screen Recording access to see your screen. Allow chat-v2 in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen chat-v2.'
    }
  }
  return null
}

/**
 * How long a change of content protection is given to reach the screen: it takes effect with the
 * next desktop composition (about 16 ms at 60 Hz), not when the call returns.
 */
const COMPOSITION_MS = 80

/** A window's HWND, as the input helper lists it. */
const hwndOf = (w: BrowserWindow) => {
  const b = w.getNativeWindowHandle()
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)
}

export const electronChatWindows = (headless: boolean): ChatWindowsPort => {
  let hidden: BrowserWindow[] = []
  // The overlay is the one window that can't take focus.
  const appWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isFocusable() && w.isVisible())
  /** The last `leaveOut`'s restore while it hasn't run, so a lost one is caught up on next time. */
  let unrestored: (() => void) | null = null
  const leaveOut: NonNullable<ChatWindowsPort['leaveOut']> = async () => {
    unrestored?.()
    const windows = appWindows()
    // Only what this turns on is turned off again.
    const changed: BrowserWindow[] = []
    const restore = () => {
      if (unrestored === restore) unrestored = null
      for (const w of changed.splice(0)) if (!w.isDestroyed()) w.setContentProtection(false)
    }
    unrestored = restore
    try {
      for (const w of windows) {
        if (w.isContentProtected()) continue
        w.setContentProtection(true)
        changed.push(w)
      }
      const hwnds = windows.map(hwndOf)
      if (changed.length) await new Promise((r) => setTimeout(r, COMPOSITION_MS))
      return { hwnds, restore }
    } catch (e) {
      restore()
      throw e
    }
  }
  return {
    ...(process.platform === 'win32' ? { leaveOut } : {}),
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
