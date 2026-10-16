// Hand-drawn strokes for the mood board canvas. Every wobble comes from a
// generator seeded by the item's id, so a shape looks the same on every frame.

import { type BoardDoc, type NoteItem, type ShotItem, TITLE_SPACE } from '@shared/moodboard'

export const HAND = 'Caveat, "Comic Sans MS", cursive'
export const NOTE_FONT = `22px ${HAND}`
export const TITLE_FONT = `700 27px ${HAND}`
export const LINE_H = 27
/** Steps are indented past their numbered circle. */
export const STEP_INDENT = 34

export interface Palette {
  paper: string
  dots: string
  ink: string
  muted: string
  accent: string
  sticky: string
  placeholder: string
}

/** Colours from the app theme, read at draw time so a theme switch shows on the next frame. */
export const themePalette = (el: Element): Palette => {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim()
  const dark = document.documentElement.dataset.theme === 'dark'
  return {
    paper: v('--surface'),
    dots: v('--line'),
    ink: v('--fg'),
    muted: v('--muted'),
    accent: v('--accent'),
    sticky: dark ? '#3b351f' : '#fbf0bf',
    placeholder: v('--hover')
  }
}

/** Exports always print on light paper, whatever the app theme. */
export const PRINT_PALETTE: Palette = {
  paper: '#fdfcf9',
  dots: '#ece7dc',
  ink: '#1d1b18',
  muted: '#69625a',
  accent: '#b9502a',
  sticky: '#fbf0bf',
  placeholder: '#e9e5dc'
}

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** mulberry32: small, fast, good enough for wobble. Returns values in [-1, 1). */
export const rng = (seed: string) => {
  let a = hash(seed)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

type Rand = () => number

/** One pencil stroke: a slightly bowed curve with jittered ends, drawn twice like a quick sketch. */
export const roughLine = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, r: Rand, bow = 0.015) => {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  const nx = -(y2 - y1) / len
  const ny = (x2 - x1) / len
  const j = Math.min(2.2, len / 40)
  for (let pass = 0; pass < 2; pass++) {
    const off = len * bow * (1 + r() * 0.8)
    const mx = (x1 + x2) / 2 + nx * off + r() * j
    const my = (y1 + y2) / 2 + ny * off + r() * j
    ctx.beginPath()
    ctx.moveTo(x1 + r() * j, y1 + r() * j)
    ctx.quadraticCurveTo(mx, my, x2 + r() * j, y2 + r() * j)
    ctx.stroke()
  }
}

/** A box whose sides overshoot the corners a little, as a hand-drawn frame does. */
export const roughRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: Rand) => {
  const o = () => 3 + r() * 3
  roughLine(ctx, x - o(), y, x + w + o(), y, r, 0.006)
  roughLine(ctx, x + w, y - o(), x + w, y + h + o(), r, 0.006)
  roughLine(ctx, x + w + o(), y + h, x - o(), y + h, r, 0.006)
  roughLine(ctx, x, y + h + o(), x, y - o(), r, 0.006)
}

export const roughCircle = (ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, r: Rand) => {
  ctx.beginPath()
  const start = r() * Math.PI
  // A little more than a full turn, so the ends cross like a pen loop.
  for (let i = 0; i <= 26; i++) {
    const a = start + (i / 24) * Math.PI * 2
    const rr = radius * (1 + r() * 0.06)
    const px = cx + Math.cos(a) * rr
    const py = cy + Math.sin(a) * rr
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
}

/** A bowed arrow with a two-stroke head at `to`. */
export const roughArrow = (ctx: CanvasRenderingContext2D, from: Point, to: Point, r: Rand) => {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  if (len < 8) return
  const bow = 0.08 + r() * 0.04
  const nx = -(to.y - from.y) / len
  const ny = (to.x - from.x) / len
  const cx = (from.x + to.x) / 2 + nx * len * bow
  const cy = (from.y + to.y) / 2 + ny * len * bow
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath()
    ctx.moveTo(from.x + r() * 1.5, from.y + r() * 1.5)
    ctx.quadraticCurveTo(cx + r() * 3, cy + r() * 3, to.x, to.y)
    ctx.stroke()
  }
  // The head follows the curve's direction where it arrives.
  const angle = Math.atan2(to.y - cy, to.x - cx)
  const head = Math.min(18, len / 3)
  for (const side of [-1, 1]) {
    const a = angle + Math.PI + side * (0.45 + r() * 0.08)
    roughLine(ctx, to.x, to.y, to.x + Math.cos(a) * head, to.y + Math.sin(a) * head, r, 0.04)
  }
}

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Where a ray from the rect's centre towards `toward` leaves the rect, pushed out by `pad`. */
export const edgePoint = (rect: Rect, toward: Point, pad = 0): Point => {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = rect.w / 2 + pad
  const hh = rect.h / 2 + pad
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy))
  return { x: cx + dx * t, y: cy + dy * t }
}

const wrapCache = new Map<string, string[]>()

/** Breaks text into lines that fit `width` in `font`. */
export const wrap = (ctx: CanvasRenderingContext2D, text: string, width: number, font: string): string[] => {
  const key = `${font}|${width}|${text}`
  const hit = wrapCache.get(key)
  if (hit) return hit
  ctx.save()
  ctx.font = font
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > width) {
        lines.push(line)
        line = word
      } else line = next
    }
    lines.push(line)
  }
  ctx.restore()
  if (wrapCache.size > 2000) wrapCache.clear()
  wrapCache.set(key, lines)
  return lines
}

export const textWidth = (note: NoteItem) => note.w - (note.shotId ? STEP_INDENT : 24)

export const noteRect = (ctx: CanvasRenderingContext2D, note: NoteItem): Rect => {
  const lines = wrap(ctx, note.text || ' ', textWidth(note), NOTE_FONT)
  const pad = note.shotId ? 0 : 12
  return { x: note.x, y: note.y, w: note.w, h: lines.length * LINE_H + 8 + pad * 2 }
}

/** The whole shot, title included. */
export const shotRect = (shot: ShotItem): Rect => ({ x: shot.x, y: shot.y - TITLE_SPACE, w: shot.w, h: shot.h + TITLE_SPACE })

export const itemRect = (ctx: CanvasRenderingContext2D, item: ShotItem | NoteItem): Rect =>
  item.kind === 'shot' ? shotRect(item) : noteRect(ctx, item)

export const boardBounds = (ctx: CanvasRenderingContext2D, doc: BoardDoc): Rect | null => {
  if (doc.items.length === 0) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const item of doc.items) {
    const r = itemRect(ctx, item)
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export type SketchState = { status: 'loading' } | { status: 'ready'; image: HTMLImageElement } | { status: 'error'; message: string }

export interface Scene {
  doc: BoardDoc
  palette: Palette
  sketch: (shot: ShotItem) => SketchState | undefined
  selected: string | null
  /** Items hidden while their text is edited in the overlay. */
  hidden: string | null
  /** Canvas units per screen pixel, so strokes keep their weight when zoomed out. */
  scale: number
}

/** Draws the board in world coordinates; the caller sets the transform. */
export const drawScene = (ctx: CanvasRenderingContext2D, scene: Scene) => {
  const { doc, palette: p } = scene
  const shots = new Map<string, ShotItem>()
  const stepNo = new Map<string, number>()
  const counts = new Map<string, number>()
  let shotNo = 0
  const shotNumber = new Map<string, number>()
  for (const item of doc.items) {
    if (item.kind === 'shot') {
      shots.set(item.id, item)
      shotNumber.set(item.id, ++shotNo)
    } else if (item.shotId) {
      const n = (counts.get(item.shotId) ?? 0) + 1
      counts.set(item.shotId, n)
      stepNo.set(item.id, n)
    }
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const weight = (px: number) => Math.max(px, px * 0.6 * scene.scale)

  // Arrows first, so frames and text sit on top of their ends.
  ctx.strokeStyle = p.ink
  ctx.lineWidth = weight(1.6)
  for (const item of doc.items) {
    if (item.kind !== 'note' || !item.shotId) continue
    const shot = shots.get(item.shotId)
    if (!shot) continue
    const frame = { x: shot.x, y: shot.y, w: shot.w, h: shot.h }
    const box = noteRect(ctx, item)
    const target = { x: box.x, y: box.y + Math.min(box.h / 2, LINE_H / 2 + 4) }
    // Arrow lands just left of the step's number circle.
    const end = { x: target.x - 8, y: target.y }
    const start = edgePoint(frame, end, 10)
    roughArrow(ctx, start, end, rng(`${item.id}:arrow`))
  }

  for (const item of doc.items) {
    if (item.kind === 'shot') drawShot(ctx, item, shotNumber.get(item.id) ?? 0, scene, weight)
    else drawNote(ctx, item, stepNo.get(item.id) ?? 0, scene, weight)
  }
}

const drawShot = (ctx: CanvasRenderingContext2D, shot: ShotItem, n: number, scene: Scene, weight: (px: number) => number) => {
  const p = scene.palette
  const r = rng(shot.id)
  const state = scene.sketch(shot)
  ctx.save()
  if (state?.status === 'ready') {
    // Cover the frame, cropping the image's longer side.
    const img = state.image
    const s = Math.max(shot.w / img.naturalWidth, shot.h / img.naturalHeight)
    const sw = shot.w / s
    const sh = shot.h / s
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, shot.x, shot.y, shot.w, shot.h)
  } else {
    ctx.fillStyle = p.placeholder
    ctx.fillRect(shot.x, shot.y, shot.w, shot.h)
    ctx.strokeStyle = p.dots
    ctx.lineWidth = weight(1)
    ctx.beginPath()
    ctx.rect(shot.x, shot.y, shot.w, shot.h)
    ctx.clip()
    for (let d = -shot.h; d < shot.w; d += 22) roughLine(ctx, shot.x + d, shot.y + shot.h, shot.x + d + shot.h, shot.y, r, 0.004)
    ctx.restore()
    ctx.save()
    ctx.fillStyle = state?.status === 'error' ? p.accent : p.muted
    ctx.font = NOTE_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const message =
      state?.status === 'error' ? `Couldn't sketch: ${state.message}` : state ? 'Sketching…' : 'Double-click to describe this shot'
    const lines = wrap(ctx, message, shot.w - 60, NOTE_FONT).slice(0, 4)
    lines.forEach((line, i) => ctx.fillText(line, shot.x + shot.w / 2, shot.y + shot.h / 2 + (i - (lines.length - 1) / 2) * LINE_H))
  }
  ctx.restore()

  ctx.strokeStyle = p.ink
  ctx.lineWidth = weight(2)
  roughRect(ctx, shot.x, shot.y, shot.w, shot.h, r)

  if (scene.hidden !== `${shot.id}:title`) {
    // Numbered circle, then the title, sitting on the frame like a caption.
    const cy = shot.y - TITLE_SPACE / 2 - 2
    ctx.strokeStyle = p.accent
    ctx.lineWidth = weight(1.6)
    roughCircle(ctx, shot.x + 14, cy, 14, r)
    ctx.fillStyle = p.accent
    ctx.font = TITLE_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), shot.x + 14, cy + 1)
    ctx.fillStyle = p.ink
    ctx.textAlign = 'left'
    const title = wrap(ctx, shot.title, Number.MAX_SAFE_INTEGER, TITLE_FONT)[0] ?? ''
    ctx.fillText(fit(ctx, title, shot.w - 40), shot.x + 38, cy + 1)
  }
  if (scene.selected === shot.id) drawSelection(ctx, shotRect(shot), scene, true)
}

/** Truncates a single line with an ellipsis. */
const fit = (ctx: CanvasRenderingContext2D, text: string, width: number) => {
  if (ctx.measureText(text).width <= width) return text
  let s = text
  while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1)
  return `${s}…`
}

const drawNote = (ctx: CanvasRenderingContext2D, note: NoteItem, n: number, scene: Scene, weight: (px: number) => number) => {
  const p = scene.palette
  const r = rng(note.id)
  const box = noteRect(ctx, note)
  const editing = scene.hidden === note.id
  ctx.save()
  if (!note.shotId) {
    ctx.fillStyle = p.sticky
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.strokeStyle = p.muted
    ctx.lineWidth = weight(1)
    roughRect(ctx, box.x, box.y, box.w, box.h, r)
  } else {
    ctx.strokeStyle = p.accent
    ctx.lineWidth = weight(1.5)
    roughCircle(ctx, note.x + 12, note.y + LINE_H / 2 + 4, 12, r)
    ctx.fillStyle = p.accent
    ctx.font = NOTE_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), note.x + 12, note.y + LINE_H / 2 + 5)
  }
  if (!editing) {
    ctx.fillStyle = p.ink
    ctx.font = NOTE_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const x = note.x + (note.shotId ? STEP_INDENT : 12)
    const y = note.y + (note.shotId ? 0 : 12) + LINE_H / 2 + 4
    wrap(ctx, note.text, textWidth(note), NOTE_FONT).forEach((line, i) => ctx.fillText(line, x, y + i * LINE_H))
  }
  ctx.restore()
  if (scene.selected === note.id) drawSelection(ctx, box, scene, false)
}

export const HANDLE = 12

const drawSelection = (ctx: CanvasRenderingContext2D, rect: Rect, scene: Scene, handle: boolean) => {
  ctx.save()
  ctx.strokeStyle = scene.palette.accent
  ctx.lineWidth = 1.5 * scene.scale
  ctx.setLineDash([6 * scene.scale, 5 * scene.scale])
  const pad = 8 * Math.max(1, scene.scale)
  ctx.strokeRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2)
  if (handle) {
    ctx.setLineDash([])
    ctx.fillStyle = scene.palette.paper
    const s = HANDLE * scene.scale
    ctx.fillRect(rect.x + rect.w + pad - s / 2, rect.y + rect.h + pad - s / 2, s, s)
    ctx.strokeRect(rect.x + rect.w + pad - s / 2, rect.y + rect.h + pad - s / 2, s, s)
  }
  ctx.restore()
}

/** Dot grid behind the board, in screen space so it stays crisp at any zoom. */
export const drawPaper = (ctx: CanvasRenderingContext2D, w: number, h: number, view: { x: number; y: number; scale: number }, p: Palette) => {
  ctx.fillStyle = p.paper
  ctx.fillRect(0, 0, w, h)
  let step = 32 * view.scale
  while (step < 14) step *= 2
  ctx.fillStyle = p.dots
  const ox = ((view.x % step) + step) % step
  const oy = ((view.y % step) + step) % step
  for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) ctx.fillRect(x - 1, y - 1, 2, 2)
}
