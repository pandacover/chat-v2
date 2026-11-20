// Point: the user marks a spot or a box on screen for the agent. The overlay covers the display
// under the pointer and takes every click (a crosshair; hovering highlights the control under it
// where the platform can read controls); a click or a drag finishes, Esc cancels. The finished
// mark becomes two attachments on the user's next message: the marked area with the mark drawn
// in, and a note with its coordinates in the computer tools' own screenshot pixels (pointing.ts).
//
// Started from the chat (its Point button or shortcut), the chat windows are minimised for the
// time, so they don't cover what the user wants to show, and come back after. Started from the
// overlay's notch, focus goes back to the app the user was in.
import { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen, type Display } from 'electron'
import type { Attachment, IpcResult, NewAttachmentInput } from '@shared/types'
import type { OverlayPointHit, OverlayPointMark } from '../../preload/computer-overlay'
import type { ElectronOverlay } from './overlay'
import type { Platform, PointHit } from './platform/types'
import { cropFor, describePoint, dipToInput, drawMark, inputToDip, type PointDisplay } from './pointing'

/** A screen capture as raw BGRA pixels. */
export interface Bitmap {
  width: number
  height: number
  bgra: Uint8Array
}

export interface PointerOptions {
  readonly overlay: ElectronOverlay
  /** Null where computer use isn't supported: Point is off too. */
  readonly platform: Platform | null
  /** Saves a file as an attachment waiting for the next message. */
  readonly attach: (file: NewAttachmentInput) => Promise<Attachment>
  /** Tells the chat windows Point started or ended, with a finished mark's attachments. */
  readonly tell: (event: { active: boolean; attachments: Attachment[]; error?: string }) => void
  /** Gives focus back to the app the user was in. */
  readonly refocus?: () => void
  /** Captures a whole display; the default asks Electron's desktopCapturer. Tests pass a fake. */
  readonly capture?: (display: Display) => Promise<Bitmap>
  /** Why Point can't run here, if it can't (the overlay is off on Linux without a compositor). */
  readonly unavailable?: string
  /** CHAT_V2_HEADLESS=1: no window is minimised, focused or shown, and no global key is taken. */
  readonly headless?: boolean
}

/** How long hovering may search a window for its controls; finishing gets longer. */
const HOVER_BUDGET_MS = 350
const FINISH_BUDGET_MS = 1500
/** How often the pointer is checked for moving to another display. */
const FOLLOW_MS = 60

const captureDisplay = async (d: Display): Promise<Bitmap> => {
  const size = {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor)
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: size
  })
  const source = sources.find((s) => s.display_id === String(d.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) throw new Error("Couldn't capture the screen")
  const img = source.thumbnail
  const { width, height } = img.getSize()
  return { width, height, bgra: new Uint8Array(img.toBitmap()) }
}

const crop = (b: Bitmap, r: { x: number; y: number; width: number; height: number }): Bitmap => {
  const x0 = Math.max(0, Math.min(b.width - 1, Math.round(r.x)))
  const y0 = Math.max(0, Math.min(b.height - 1, Math.round(r.y)))
  const width = Math.max(1, Math.min(b.width - x0, Math.round(r.width)))
  const height = Math.max(1, Math.min(b.height - y0, Math.round(r.height)))
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) out.set(b.bgra.subarray(((y0 + y) * b.width + x0) * 4, ((y0 + y) * b.width + x0 + width) * 4), y * width * 4)
  return { width, height, bgra: out }
}

const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The platform's input space: physical pixels on Windows, DIPs (points) elsewhere, as overlay.ts has it. */
const inputRect = (d: Display) => (process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds)

const describeDisplays = (): Array<PointDisplay & { id: number }> => {
  const primary = screen.getPrimaryDisplay().id
  const all = [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  return all.map((d, i) => ({
    id: d.id,
    bounds: d.bounds,
    input: inputRect(d),
    scaleFactor: d.scaleFactor,
    primary: d.id === primary,
    index: i + 1,
    count: all.length
  }))
}

const label = (c: NonNullable<PointHit['control']>) => {
  const type = c.type.replace(/([a-z])([A-Z])/g, '$1 $2')
  const name = c.name.replace(/\s+/g, ' ').trim()
  return name ? `${type} · ${name.length > 48 ? `${name.slice(0, 48)}…` : name}` : type
}

export const makePointer = (o: PointerOptions) => {
  const headless = o.headless ?? process.env.CHAT_V2_HEADLESS === '1'
  const capture = o.capture ?? captureDisplay
  type Session = {
    display: Display
    from: 'chat' | 'overlay'
    minimized: BrowserWindow[]
    dragging: boolean
    finishing: boolean
    follow: ReturnType<typeof setInterval>
  }
  let session: Session | null = null
  /** A finished mark is being captured and saved; a new Point waits for it. */
  let saving = false
  let escape = false

  const overlayContents = () => {
    const w = o.overlay.window
    return w && !w.isDestroyed() ? w.webContents : null
  }
  const fromOverlay = (sender: Electron.WebContents) => sender === overlayContents()
  const send = (channel: string, payload: unknown) => overlayContents()?.send(channel, payload)

  /** Puts the overlay on `display` in Point mode and tells its page. */
  const place = (display: Display) => {
    o.overlay.point(display)
    const tell = () => send('computer-overlay:point', { display: display.id })
    // The overlay window may only now have been made: its page hears it once loaded.
    const wc = overlayContents()
    if (wc?.isLoading()) wc.once('did-finish-load', () => void (session?.display.id === display.id && tell()))
    else tell()
  }

  const holdEscape = (on: boolean) => {
    if (headless || on === escape) return
    escape = on
    // Esc cancels even if the overlay didn't get focus; only for the moment Point is on.
    if (on) {
      if (!globalShortcut.register('Escape', () => cancel())) escape = false
    } else globalShortcut.unregister('Escape')
  }

  const end = (s: Session) => {
    clearInterval(s.follow)
    holdEscape(false)
    o.overlay.point(null)
    send('computer-overlay:point', null)
    session = null
  }

  /** Brings back the chat windows Point minimised, and the chat to the front. */
  const restore = (s: Session, showChat: boolean) => {
    if (headless) return
    for (const w of s.minimized) if (!w.isDestroyed()) w.restore()
    if (showChat) o.overlay.showChat()
  }

  const start = (from: 'chat' | 'overlay'): boolean => {
    if (session) return true
    if (saving) return false
    if (o.unavailable) throw new Error(o.unavailable)
    if (!o.platform) throw new Error('Computer use is off on this computer, so Point is too.')
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const minimized: BrowserWindow[] = []
    if (from === 'chat' && !headless) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w === o.overlay.window || w.isDestroyed() || !w.isVisible() || w.isMinimized()) continue
        w.minimize()
        minimized.push(w)
      }
    }
    const s: Session = {
      display,
      from,
      minimized,
      dragging: false,
      finishing: false,
      // The overlay follows the pointer to another display, except mid-drag.
      follow: setInterval(() => {
        if (session !== s || s.dragging || s.finishing) return
        const now = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        if (now.id === s.display.id) return
        s.display = now
        place(now)
      }, FOLLOW_MS)
    }
    session = s
    place(display)
    if (!headless) {
      const w = o.overlay.window
      // Focus, so Esc reaches the page; the global Esc covers a focus Windows refuses.
      if (w && !w.isDestroyed()) w.focus()
      holdEscape(true)
    }
    o.tell({ active: true, attachments: [] })
    return true
  }

  const cancel = () => {
    const s = session
    if (!s || s.finishing) return
    end(s)
    restore(s, s.from === 'chat')
    if (s.from === 'overlay' && !headless) o.refocus?.()
    o.tell({ active: false, attachments: [] })
  }

  /** Point from the chat: starts it, or cancels the one under way. True while it is on. */
  const toggle = (from: 'chat' | 'overlay'): boolean => {
    if (!session) return start(from)
    if (!session.finishing) cancel()
    return false
  }

  const displayInfo = (d: Display) => {
    const all = describeDisplays()
    return {
      all,
      info: all.find((x) => x.id === d.id) ?? {
        ...all[0]!,
        bounds: d.bounds,
        input: inputRect(d),
        scaleFactor: d.scaleFactor
      }
    }
  }

  // Hover: one look at a time, and only the latest point waits.
  let looking = false
  let wanted: { x: number; y: number } | null = null
  const look = async (at: { x: number; y: number }) => {
    const s = session
    const p = o.platform
    if (!s || !p?.pointAt) return
    if (looking) {
      wanted = at
      return
    }
    looking = true
    try {
      const { info } = displayInfo(s.display)
      const input = dipToInput(info, { x: at.x, y: at.y, width: 0, height: 0 })
      const hit = await p.pointAt(input.x, input.y, HOVER_BUDGET_MS).catch(() => null)
      if (session !== s || s.dragging) return
      const c = hit?.control ?? null
      const reply: OverlayPointHit = {
        x: at.x,
        y: at.y,
        control: c ? { rect: inputToDip(info, c), label: label(c) } : null
      }
      send('computer-overlay:point-hit', reply)
    } finally {
      looking = false
      const next = wanted
      wanted = null
      if (next) void look(next)
    }
  }

  const finish = async (mark: OverlayPointMark) => {
    const s = session
    if (!s || s.finishing) return
    s.finishing = true
    saving = true
    const { info, all } = displayInfo(s.display)
    const display = s.display
    const p = o.platform
    // The overlay goes first, so the capture shows the screen as the user saw it.
    end(s)
    try {
      const at = mark.rect
        ? {
            x: mark.rect.x + mark.rect.width / 2,
            y: mark.rect.y + mark.rect.height / 2
          }
        : mark.point
      const inputAt = dipToInput(info, { ...at, width: 0, height: 0 })
      const picking = p?.pointAt ? p.pointAt(inputAt.x, inputAt.y, FINISH_BUDGET_MS).catch(() => null) : Promise.resolve(null)
      await sleep(headless ? 0 : 160)
      const [shot, found] = await Promise.all([
        capture(display).then(
          (b) => ({ ok: true as const, b }),
          (e: unknown) => ({ ok: false as const, e })
        ),
        picking
      ])
      // A box is about the area: the window under it, not one control.
      const hit: PointHit | null = found && mark.rect ? { ...found, control: null } : found
      const control = hit?.control ? inputToDip(info, hit.control) : null
      const area = cropFor({ point: mark.point, rect: mark.rect }, control, info.bounds)
      const name = `point-${stamp()}`
      const out: Attachment[] = []
      let error: string | undefined
      if (shot.ok) {
        const k = shot.b.width / info.bounds.width
        const part = crop(shot.b, {
          x: area.x * k,
          y: area.y * k,
          width: area.width * k,
          height: area.height * k
        })
        const local = (r: { x: number; y: number; width: number; height: number }) => ({
          x: (r.x - area.x) * k,
          y: (r.y - area.y) * k,
          width: r.width * k,
          height: r.height * k
        })
        drawMark(
          part.bgra,
          part.width,
          part.height,
          {
            box: mark.rect ? local(mark.rect) : control ? local(control) : null,
            point: mark.rect
              ? null
              : {
                  x: (mark.point.x - area.x) * k,
                  y: (mark.point.y - area.y) * k
                }
          },
          k
        )
        const png = nativeImage
          .createFromBitmap(Buffer.from(part.bgra.buffer, part.bgra.byteOffset, part.bgra.byteLength), { width: part.width, height: part.height })
          .toPNG()
        out.push(
          await o.attach({
            name: `${name}.png`,
            mime: 'image/png',
            data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
          })
        )
      } else error = `Couldn't capture the screen, so only the coordinates were added: ${shot.e instanceof Error ? shot.e.message : String(shot.e)}`
      const note = describePoint({
        image: shot.ok ? `${name}.png` : 'No image',
        platform: p?.name ?? 'windows',
        display: info,
        all,
        point: dipToInput(info, { ...mark.point, width: 0, height: 0 }),
        rect: mark.rect ? dipToInput(info, mark.rect) : null,
        crop: dipToInput(info, area),
        hit
      })
      out.push(
        await o.attach({
          name: `${name}.md`,
          mime: 'text/markdown',
          data: new TextEncoder().encode(note).buffer as ArrayBuffer
        })
      )
      o.tell({ active: false, attachments: out, ...(error ? { error } : {}) })
    } catch (e) {
      o.tell({
        active: false,
        attachments: [],
        error: `Couldn't add the mark: ${e instanceof Error ? e.message : String(e)}`
      })
    } finally {
      saving = false
      restore(s, true)
    }
  }

  ipcMain.on('computer-overlay:point-hover', (e, at: { x: number; y: number }) => {
    if (!fromOverlay(e.sender) || !session || typeof at?.x !== 'number' || typeof at?.y !== 'number') return
    void look({ x: at.x, y: at.y })
  })
  ipcMain.on('computer-overlay:point-dragging', (e, on: boolean) => {
    if (fromOverlay(e.sender) && session) session.dragging = on === true
  })
  ipcMain.on('computer-overlay:point-done', (e, mark: OverlayPointMark) => {
    if (!fromOverlay(e.sender) || !session) return
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    if (!mark || !n(mark.point?.x) || !n(mark.point?.y)) return
    const r = mark.rect
    const rect = r && n(r.x) && n(r.y) && n(r.width) && n(r.height) && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    void finish({ point: { x: mark.point.x, y: mark.point.y }, rect })
  })
  ipcMain.on('computer-overlay:point-cancel', (e) => {
    if (fromOverlay(e.sender)) cancel()
  })
  o.overlay.onPointPress(() => {
    try {
      start('overlay')
    } catch (e) {
      o.tell({
        active: false,
        attachments: [],
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })
  // The chat's Point button and shortcut. Answered as the app's other calls are (IpcResult).
  ipcMain.handle('computer:point', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: toggle('chat') }
    } catch (e) {
      return {
        ok: false,
        error: {
          tag: 'PointError',
          message: e instanceof Error ? e.message : String(e)
        }
      }
    }
  })

  return {
    start,
    cancel,
    active: () => session !== null,
    dispose: () => {
      if (session) end(session)
      ipcMain.removeAllListeners('computer-overlay:point-hover')
      ipcMain.removeAllListeners('computer-overlay:point-dragging')
      ipcMain.removeAllListeners('computer-overlay:point-done')
      ipcMain.removeAllListeners('computer-overlay:point-cancel')
      ipcMain.removeHandler('computer:point')
    }
  }
}

export type Pointer = ReturnType<typeof makePointer>
