// Point: the user marks a spot or a box on screen for their next message. This is the part with
// no Electron in it: where the computer tools' screenshot would put the mark (so the model can act
// on it), the note the model reads, the crop around the mark and the mark drawn into it.
import { SHOT_WIDTH } from './control'
import type { PointHit, ScreenRect } from './platform/types'

export interface Pt {
  x: number
  y: number
}

/** A display, in DIPs (`bounds`) and in the platform's input space (`input`). */
export interface PointDisplay {
  bounds: ScreenRect
  input: ScreenRect
  scaleFactor: number
  primary: boolean
  /** 1-based, left to right, then top to bottom. */
  index: number
  count: number
}

/**
 * What the user marked, in DIPs relative to the display: a click (`rect` null; `control` is the
 * control under it, if one was picked) or a dragged box.
 */
export interface PointMark {
  point: Pt
  rect: ScreenRect | null
}

/** The screenshot frame of look_at_screen: the screen rect it covers (input space) and the image size. */
export interface ShotFrame {
  screen: ScreenRect
  imageWidth: number
  imageHeight: number
}

const fit = (screen: ScreenRect, pixelWidth = screen.width): ShotFrame => {
  const imageWidth = Math.min(SHOT_WIDTH, pixelWidth)
  return {
    screen,
    imageWidth,
    imageHeight: Math.round((screen.height * imageWidth) / screen.width)
  }
}

/**
 * The frame look_at_screen would capture with this display in it, or null when it never shows it.
 * Windows: the monitor of the window being worked in, scaled down to 1024 px wide. macOS: the main
 * display only (screencapture -m), resampled to 1024 px from its pixels. Linux: the whole X
 * screen, every monitor.
 */
export const frameFor = (platform: 'windows' | 'macos' | 'linux', d: PointDisplay, all: ReadonlyArray<PointDisplay>): ShotFrame | null => {
  if (platform === 'windows') return fit(d.input)
  if (platform === 'macos')
    return d.primary ? fit({ x: 0, y: 0, width: d.input.width, height: d.input.height }, Math.round(d.input.width * d.scaleFactor)) : null
  const right = Math.max(...all.map((o) => o.input.x + o.input.width))
  const bottom = Math.max(...all.map((o) => o.input.y + o.input.height))
  return fit({ x: 0, y: 0, width: right, height: bottom })
}

/** Input space to the frame's image pixels, as Control.rectToImage maps them. */
export const toImage = (f: ShotFrame, r: ScreenRect): ScreenRect => {
  const k = f.imageWidth / f.screen.width
  const ky = f.imageHeight / f.screen.height
  return {
    x: Math.round((r.x - f.screen.x) * k),
    y: Math.round((r.y - f.screen.y) * ky),
    width: Math.round(r.width * k),
    height: Math.round(r.height * ky)
  }
}

/** DIPs relative to the display, to input space. */
export const dipToInput = (d: PointDisplay, r: ScreenRect): ScreenRect => {
  const kx = d.input.width / d.bounds.width
  const ky = d.input.height / d.bounds.height
  return {
    x: Math.round(d.input.x + r.x * kx),
    y: Math.round(d.input.y + r.y * ky),
    width: Math.round(r.width * kx),
    height: Math.round(r.height * ky)
  }
}

/** Input space to DIPs relative to the display. */
export const inputToDip = (d: PointDisplay, r: ScreenRect): ScreenRect => {
  const kx = d.bounds.width / d.input.width
  const ky = d.bounds.height / d.input.height
  return {
    x: (r.x - d.input.x) * kx,
    y: (r.y - d.input.y) * ky,
    width: r.width * kx,
    height: r.height * ky
  }
}

const clampRect = (r: ScreenRect, w: number, h: number): ScreenRect => {
  const x = Math.max(0, Math.min(r.x, w))
  const y = Math.max(0, Math.min(r.y, h))
  return {
    x,
    y,
    width: Math.max(1, Math.min(r.x + r.width, w) - x),
    height: Math.max(1, Math.min(r.y + r.height, h) - y)
  }
}

/**
 * The part of the display the attached image shows (DIPs): the box or the picked control with
 * room around it, or an area around a plain click; never less than 360x220 where the display
 * allows, and kept on the display.
 */
export const cropFor = (mark: PointMark, control: ScreenRect | null, size: { width: number; height: number }): ScreenRect => {
  const target = mark.rect ?? control
  const pad = target ? Math.max(32, Math.round(Math.max(target.width, target.height) * 0.25)) : 0
  let r = target
    ? {
        x: target.x - pad,
        y: target.y - pad,
        width: target.width + pad * 2,
        height: target.height + pad * 2
      }
    : { x: mark.point.x - 240, y: mark.point.y - 150, width: 480, height: 300 }
  const minW = Math.min(360, size.width)
  const minH = Math.min(220, size.height)
  if (r.width < minW) r = { ...r, x: r.x - (minW - r.width) / 2, width: minW }
  if (r.height < minH) r = { ...r, y: r.y - (minH - r.height) / 2, height: minH }
  // Slide back onto the display before trimming, so a mark near an edge keeps its room.
  r = {
    ...r,
    x: Math.max(0, Math.min(r.x, size.width - r.width)),
    y: Math.max(0, Math.min(r.y, size.height - r.height))
  }
  const c = clampRect(r, size.width, size.height)
  return {
    x: Math.round(c.x),
    y: Math.round(c.y),
    width: Math.round(c.width),
    height: Math.round(c.height)
  }
}

/** The mark's colour: the app's accent (app.css, light theme), as BGRA. */
export const MARK_BGRA = [0x2a, 0x50, 0xb9, 0xff] as const

/** The light edge under the mark, so it reads on dark and on orange-ish screens too. */
const HALO_BGRA = [0xf9, 0xfc, 0xfd, 0xff] as const

/**
 * Draws the mark into a BGRA bitmap, antialiased, over a thin light edge: a rounded box outline
 * for a box or a picked control, and a dot where the user clicked, with a ring around it when no
 * control was picked. Coordinates are bitmap pixels; `unit` is pixels per DIP, so lines keep
 * their weight on any display.
 */
export const drawMark = (bgra: Uint8Array, width: number, height: number, shape: { box: ScreenRect | null; point: Pt | null }, unit: number) => {
  let color: readonly number[] = MARK_BGRA
  const blend = (x: number, y: number, a: number) => {
    if (a <= 0 || x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    const t = Math.min(1, a)
    for (let c = 0; c < 3; c++) bgra[i + c] = Math.round(bgra[i + c]! * (1 - t) + color[c]! * t)
    bgra[i + 3] = 255
  }
  // Coverage of a band of half-width `hw` around distance 0 of a signed distance field.
  const band = (d: number, hw: number) => Math.max(0, Math.min(1, hw + 0.5 - Math.abs(d)))
  const each = (x0: number, y0: number, x1: number, y1: number, f: (x: number, y: number) => number) => {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(height - 1, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(width - 1, Math.ceil(x1)); x++) blend(x, y, f(x + 0.5, y + 0.5))
  }
  const shapes = (grow: number) => {
    const line = 2 * unit + grow * 2
    if (shape.box) {
      const b = shape.box
      const rad = Math.min(6 * unit, b.width / 2, b.height / 2)
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const hx = b.width / 2 - rad
      const hy = b.height / 2 - rad
      // Rounded-rectangle distance field; the outline sits on the box edge.
      const sdf = (x: number, y: number) => {
        const qx = Math.abs(x - cx) - hx
        const qy = Math.abs(y - cy) - hy
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad
      }
      const m = line + 2
      each(b.x - m, b.y - m, b.x + b.width + m, b.y + b.height + m, (x, y) => band(sdf(x, y), line / 2))
    }
    if (shape.point) {
      const p = shape.point
      // Inside a picked control the box says enough; the dot gives the exact spot.
      const ring = shape.box ? 0 : 12 * unit
      const m = ring + line + 2
      const dot = 2.5 * unit + grow
      each(p.x - m, p.y - m, p.x + m, p.y + m, (x, y) => {
        const d = Math.hypot(x - p.x, y - p.y)
        return Math.max(ring ? band(d - ring, line / 2) : 0, Math.max(0, Math.min(1, dot + 0.5 - d)))
      })
    }
  }
  // Twice: the light edge a pixel wider, then the mark.
  for (const [c, grow] of [
    [HALO_BGRA, unit],
    [MARK_BGRA, 0]
  ] as const) {
    color = c
    shapes(grow)
  }
}

const xy = (p: Pt) => `${Math.round(p.x)}, ${Math.round(p.y)}`
const box = (r: ScreenRect) => `${xy(r)} to ${xy({ x: r.x + r.width, y: r.y + r.height })}`
const centre = (r: ScreenRect): Pt => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2
})
const quote = (s: string) => `"${s.replace(/\s+/g, ' ').trim().slice(0, 80)}"`

/**
 * The note the model reads beside the image: where the mark is in the computer tools' own pixels,
 * and in screen coordinates, the control and window under it, and how to use them.
 */
export const describePoint = (o: {
  image: string
  platform: 'windows' | 'macos' | 'linux'
  display: PointDisplay
  all: ReadonlyArray<PointDisplay>
  /** The mark in input space. */
  point: Pt
  rect: ScreenRect | null
  /** The crop the image shows, in input space. */
  crop: ScreenRect
  hit: PointHit | null
}): string => {
  const frame = frameFor(o.platform, o.display, o.all)
  const what = o.rect ? 'marked a box on their screen' : o.hit?.control ? 'pointed at a control on their screen' : 'pointed at a spot on their screen'
  const lines = [`The user ${what} for you. ${o.image} shows it, with their mark drawn in orange.`, '']
  const c = o.hit?.control ?? null
  if (frame) {
    const at = (r: ScreenRect) => toImage(frame, r)
    const p = at({ ...o.point, width: 0, height: 0 })
    lines.push(
      `Coordinates below are pixels in a look_at_screen screenshot of this display (${frame.imageWidth}x${frame.imageHeight}), the same pixels click, scroll, drag and teach_step take.`
    )
    if (o.rect) {
      const r = at(o.rect)
      lines.push(`- Box: ${box(r)} (centre ${xy(centre(r))}, ${r.width}x${r.height})`)
    } else lines.push(`- Point: ${xy(p)}`)
    if (c) {
      const r = at(c)
      lines.push(`- Control there: ${c.type || 'Control'}${c.name ? ` ${quote(c.name)}` : ''}, ${box(r)} (centre ${xy(centre(r))})`)
    }
    lines.push(`- The image shows ${box(at(o.crop))} of that screenshot.`)
  } else {
    lines.push(
      `- The mark is on a display look_at_screen doesn't capture (it shows the main display only). Ask the user to move the window to the main display, or work from the image.`
    )
    if (c) lines.push(`- Control there: ${c.type || 'Control'}${c.name ? ` ${quote(c.name)}` : ''}`)
  }
  if (o.hit?.window.title || o.hit?.window.process)
    lines.push(`- Window: ${quote(o.hit.window.title || o.hit.window.process)}${o.hit.window.process ? ` (${o.hit.window.process})` : ''}`)
  const scale = Math.round(o.display.scaleFactor * 100)
  const d = o.display.input
  const units = o.platform === 'windows' ? 'physical pixels' : o.platform === 'macos' ? 'points' : 'pixels'
  lines.push(
    `- Screen: display ${o.display.index} of ${o.display.count}${o.display.primary ? ' (main)' : ''}, ${d.width}x${d.height} ${units} at ${scale}%, ${box(d)} in screen coordinates; the ${o.rect ? `box is ${box(o.rect)}` : `point is ${xy(o.point)}`} there.`
  )
  lines.push('')
  if (frame && o.platform === 'windows') {
    lines.push(
      `look_at_screen shows the display of the window being worked in. Take one before acting: if it is ${frame.imageWidth}x${frame.imageHeight} and shows this display, use these pixels. If it shows another display${o.hit?.window.title ? `, focus_window ${quote(o.hit.window.title)} first` : ', bring the window there to the front first'}, or find the spot again from the image.`
    )
  } else if (frame) {
    lines.push('Take a look_at_screen before acting and check the spot is still there; if the screen has changed, find it again from the image.')
  }
  return `${lines.join('\n')}\n`
}
