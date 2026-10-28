// Marks as pen strokes: each shape becomes a line or two of pressure ink (see pen.ts), seeded by
// the mark's id so it holds still between frames. A shape is drawn the way a sure hand draws it: a
// ring in one stroke that closes with a small overlap, a box as one rounded stroke whose ends meet,
// a single underline, an arrow's shaft and then its head. The wobble is slow, a drift and never a
// jitter. Lines rather than canvas shapes let the overlay's cursor draw a mark gradually, the way
// a person sketches. Labels aren't drawn by hand: the overlay shows them as tags beside the marks.
import type { Mark, MarkColor, Rect } from '@shared/computer'
import { rng } from '@/lib/sketchy'
import { type InkPt, type Nib, type Pt, dist, press, resample } from './pen'

export type { Pt }

export interface Stroke {
  /** The line every couple of px, with the pen's width at each point and its distance along. */
  pts: InkPt[]
  len: number
  /** Highlighter: a wide translucent band with squarer ends. */
  marker?: boolean
}

export interface Inked {
  id: string
  kind: Mark['kind']
  color: MarkColor
  strokes: Stroke[]
  /** The mark's label (or the mark itself, for text), shown in a tag beside it. */
  label?: string
  /** Where the cursor may park after drawing, best first: just off the mark, pointing at it. */
  rests: Pt[]
  /** What the mark covers, ink and what it marks, for keeping labels beside it rather than on it (for text, its point). */
  box: Rect
  /** An arrow's ends: its label goes off the tail, away from what it points at. */
  arrow?: { from: Pt; to: Pt }
}

/**
 * Pens that read on light and dark screens alike without an outline: clear, a little deep, none
 * neon. Black is a soft ink rather than pure black; the overlay lifts it off dark screens.
 */
export const PENS: Record<MarkColor, string> = { red: '#e5484d', blue: '#2f7ae5', green: '#2b9a66', yellow: '#f1aa0b', black: '#1f2125' }
/** Highlighter inks, laid down translucent at MARKER_ALPHA. */
export const MARKERS: Record<MarkColor, string> = { red: '#ff6f73', blue: '#5aa7ff', green: '#4fcf8a', yellow: '#ffd43b', black: '#9aa0a8' }
export const MARKER_ALPHA: Record<MarkColor, number> = { red: 0.3, blue: 0.3, green: 0.3, yellow: 0.42, black: 0.32 }

type Rand = () => number

/** The pen: fine, a little slimmer on straights, tapering where it lands and further where it lifts. */
const PEN: Nib = { size: 2.9, thinning: 0.14, start: 16, end: 30, swell: 0.05 }
/** Points along the ink this far apart. */
const STEP = 2

const inked = (pts: Pt[], r: Rand, nib: Nib = PEN): Stroke => {
  const line = press(resample(pts, STEP), nib, r)
  return { pts: line, len: line[line.length - 1]?.s ?? 0 }
}

/** A slow drift in [-1, 1] along a line (0 to 1): two long waves with seeded phases, never a jitter. */
const drift = (r: Rand) => {
  const p1 = r() * Math.PI
  const p2 = r() * Math.PI
  const f2 = 2 + Math.abs(r())
  return (u: number) => Math.sin(u * Math.PI + p1) * 0.6 + Math.sin(u * Math.PI * f2 + p2) * 0.4
}

/** A line from a to b as a steady hand draws one: bowed a little to one side, drifting gently, its ends exact. */
const line = (a: Pt, b: Pt, r: Rand, bow: number, wander = 0.6): Pt[] => {
  const len = dist(a, b) || 1
  const nx = -(b.y - a.y) / len
  const ny = (b.x - a.x) / len
  const off = Math.min(len * bow, 22) * (0.6 + 0.4 * Math.abs(r())) * (r() < 0 ? -1 : 1)
  const d = drift(r)
  const amp = Math.min(wander, len / 120)
  const n = Math.max(2, Math.ceil(len / 3))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const k = 4 * t * (1 - t) * off + d(t) * amp * Math.sin(Math.PI * t)
    out.push({ x: a.x + (b.x - a.x) * t + nx * k, y: a.y + (b.y - a.y) * t + ny * k })
  }
  return out
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * A ring in one stroke, tilted a touch: round once from about ten o'clock and on a little past
 * the start, easing outward at the end so the two ends lie side by side rather than on each other.
 */
const ring = (cx: number, cy: number, rx: number, ry: number, r: Rand): Pt[] => {
  const tilt = r() * 0.05
  const start = -Math.PI * 0.7 + r() * 0.25
  const sweep = Math.PI * 2 + 0.3 + Math.abs(r()) * 0.14
  const d = drift(r)
  const n = Math.max(48, Math.ceil(((rx + ry) * sweep) / 4))
  const [cos, sin] = [Math.cos(tilt), Math.sin(tilt)]
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const a = start + u * sweep
    const k = (0.988 + 0.05 * smoothstep(0.8, 1, u)) * (1 + d(u) * 0.016)
    const x = Math.cos(a) * rx * k
    const y = Math.sin(a) * ry * k
    out.push({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos })
  }
  return out
}

/**
 * A box in one stroke: along the top from its left corner, round all four corners, and on along
 * the top a little past where it began. The sides bow very slightly, as drawn sides do.
 */
const roundBox = (x: number, y: number, w: number, h: number, r: Rand): Pt[] => {
  const rad = Math.max(3, Math.min(9, w / 4, h / 3))
  const bow = (len: number) => Math.min(2, len * 0.008) * (0.5 + 0.5 * Math.abs(r())) * (r() < 0 ? -1 : 1)
  const sides = [w - rad * 2, h - rad * 2, w - rad * 2, h - rad * 2]
  const bows = sides.map(bow)
  const out: Pt[] = []
  // Each side runs from a corner to the next, the way round, with its outward normal.
  const runs = [
    { from: { x: x + rad, y }, to: { x: x + w - rad, y }, n: { x: 0, y: -1 } },
    { from: { x: x + w, y: y + rad }, to: { x: x + w, y: y + h - rad }, n: { x: 1, y: 0 } },
    { from: { x: x + w - rad, y: y + h }, to: { x: x + rad, y: y + h }, n: { x: 0, y: 1 } },
    { from: { x, y: y + h - rad }, to: { x, y: y + rad }, n: { x: -1, y: 0 } }
  ]
  const corners = [
    { x: x + w - rad, y: y + rad, a: -Math.PI / 2 },
    { x: x + w - rad, y: y + h - rad, a: 0 },
    { x: x + rad, y: y + h - rad, a: Math.PI / 2 },
    { x: x + rad, y: y + rad, a: Math.PI }
  ]
  runs.forEach((run, i) => {
    const steps = Math.max(2, Math.ceil(sides[i]! / 3))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const k = Math.sin(Math.PI * t) * bows[i]!
      out.push({ x: run.from.x + (run.to.x - run.from.x) * t + run.n.x * k, y: run.from.y + (run.to.y - run.from.y) * t + run.n.y * k })
    }
    const c = corners[i]!
    for (let s = 1; s < 8; s++) {
      const a = c.a + (s / 8) * (Math.PI / 2)
      out.push({ x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad })
    }
  })
  // On past the start, lifting a hair, so the ends overlap without quite retracing.
  const over = Math.min(14, sides[0]! * 0.2)
  for (let s = 0; s <= 5; s++) out.push({ x: x + rad + (over * s) / 5, y: y - 0.7 * (s / 5) })
  // The whole box turned a hair, as a hand never draws quite level.
  const turn = r() * 0.008
  const [cx, cy] = [x + w / 2, y + h / 2]
  return out.map((p) => ({ x: cx + (p.x - cx) - (p.y - cy) * turn, y: cy + (p.y - cy) + (p.x - cx) * turn }))
}

/** A smooth curve through the model's points (centripetal Catmull-Rom, which neither loops nor overshoots). */
const through = (pts: Pt[]): Pt[] => {
  const n = pts.length
  const ext = [{ x: pts[0]!.x * 2 - pts[1]!.x, y: pts[0]!.y * 2 - pts[1]!.y }, ...pts, { x: pts[n - 1]!.x * 2 - pts[n - 2]!.x, y: pts[n - 1]!.y * 2 - pts[n - 2]!.y }]
  const knot = (a: Pt, b: Pt) => Math.max(0.01, Math.sqrt(dist(a, b)))
  const lerp = (a: Pt, b: Pt, ta: number, tb: number, t: number) => {
    const k = (t - ta) / (tb - ta)
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
  }
  const out: Pt[] = [pts[0]!]
  for (let i = 1; i < ext.length - 2; i++) {
    const [p0, p1, p2, p3] = [ext[i - 1]!, ext[i]!, ext[i + 1]!, ext[i + 2]!]
    const t1 = knot(p0, p1)
    const t2 = t1 + knot(p1, p2)
    const t3 = t2 + knot(p2, p3)
    const steps = Math.max(2, Math.ceil(dist(p1, p2) / 3))
    for (let s = 1; s <= steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps
      const a1 = lerp(p0, p1, 0, t1, t)
      const a2 = lerp(p1, p2, t1, t2, t)
      const a3 = lerp(p2, p3, t2, t3, t)
      out.push(lerp(lerp(a1, a2, 0, t2, t), lerp(a2, a3, t1, t3, t), t1, t2, t))
    }
  }
  return out
}

/**
 * A freehand line split where it turns sharply, so each corner gets round ends that overlap
 * rather than an outline that pinches. Only its very start and end taper.
 */
const freehand = (pts: Pt[], r: Rand): Stroke[] => {
  const all = press(resample(pts, STEP), PEN, r)
  const reach = 3
  const turns = all.map((p, i) => {
    if (i < reach || i >= all.length - reach) return 0
    const a = all[i - reach]!
    const b = all[i + reach]!
    const d = Math.abs(Math.atan2(b.y - p.y, b.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x))
    return d > Math.PI ? Math.PI * 2 - d : d
  })
  // A corner: a turn of more than about 65°, cut where it is sharpest.
  const cuts: number[] = []
  for (let i = reach; i < all.length - reach; i++) {
    const d = turns[i]!
    if (d > 1.15 && turns.slice(i - reach, i + reach + 1).every((v) => v <= d) && (!cuts.length || i - cuts[cuts.length - 1]! > reach)) cuts.push(i)
  }
  const strokes: Stroke[] = []
  let from = 0
  for (const at of [...cuts, all.length - 1]) {
    const piece = all.slice(from, at + 1)
    if (piece.length > 1) {
      const s0 = piece[0]!.s
      strokes.push({ pts: piece.map((p) => ({ ...p, s: p.s - s0 })), len: piece[piece.length - 1]!.s - s0 })
    }
    from = at
  }
  return strokes
}

const bounds = (strokes: Stroke[]): Rect => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const s of strokes) {
    for (const p of s.pts) {
      const r = p.w / 2
      x0 = Math.min(x0, p.x - r)
      y0 = Math.min(y0, p.y - r)
      x1 = Math.max(x1, p.x + r)
      y1 = Math.max(y1, p.y + r)
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 }
}

/** The ink's bounds, taking in what it marks too: the words over an underline, say. */
const covers = (box: Rect, mark: Mark): Rect => {
  if (!('w' in mark)) return box
  const [x0, y0] = [Math.min(box.x, mark.x), Math.min(box.y, mark.y)]
  return { x: x0, y: y0, w: Math.max(box.x + box.w, mark.x + mark.w) - x0, h: Math.max(box.y + box.h, mark.y + mark.h) - y0 }
}

export const ink = (mark: Mark, screen: { w: number; h: number }): Inked => {
  const r = rng(mark.id)
  const strokes: Stroke[] = []
  let rests: Pt[]

  switch (mark.kind) {
    case 'circle': {
      // Wide enough to take in the corners of what it rings, without hugging it.
      const rx = (mark.w / 2) * 1.1 + 9
      const ry = (mark.h / 2) * 1.25 + 8
      const [cx, cy] = [mark.x + mark.w / 2, mark.y + mark.h / 2]
      strokes.push(inked(ring(cx, cy, rx, ry, r), r))
      // Just outside the ring at its lower right, the pointer touching it from outside; else off one end.
      rests = [{ x: cx + rx * 0.72 + 2, y: cy + ry * 0.7 + 2 }, { x: cx + rx + 3, y: cy - 4 }, { x: cx - rx - 17, y: cy - 8 }]
      break
    }
    case 'box': {
      const pad = 5
      const [x, y, w, h] = [mark.x - pad, mark.y - pad, mark.w + pad * 2, mark.h + pad * 2]
      strokes.push(inked(roundBox(x, y, w, h, r), r))
      // Off its lower right corner, else its upper right, else its left side (in a screen's corner).
      rests = [{ x: x + w + 2, y: y + h + 2 }, { x: x + w + 3, y: y + 1 }, { x: x - 17, y: y + h / 2 - 8 }]
      break
    }
    case 'underline': {
      const y = mark.y + mark.h + 4
      const a = { x: mark.x - 2, y: y + r() * 0.8 }
      const b = { x: mark.x + mark.w + 3, y: y - 1 + r() * 0.8 }
      strokes.push(inked(line(a, b, r, 0.012), r, { ...PEN, start: 8, end: 30 }))
      rests = [{ x: b.x + 4, y: b.y + 2 }, { x: b.x + 4, y: b.y - 16 }, { x: a.x - 17, y: a.y - 8 }]
      break
    }
    case 'highlight': {
      const rows = Math.max(1, Math.round(mark.h / 22))
      const band = mark.h / rows
      for (let i = 0; i < rows; i++) {
        const y = mark.y + band * (i + 0.5)
        const pts = line({ x: mark.x - 2, y: y + r() * 0.6 }, { x: mark.x + mark.w + 2, y: y + r() * 0.6 }, r, 0.002, 0.3)
        strokes.push({ ...inked(pts, r, { size: band * 0.96, thinning: 0, start: 0, end: 0, swell: 0.025 }), marker: true })
      }
      rests = [{ x: mark.x + mark.w + 4, y: mark.y + mark.h + 2 }, { x: mark.x + mark.w + 5, y: mark.y }, { x: mark.x - 19, y: mark.y + mark.h / 2 - 8 }]
      break
    }
    case 'arrow': {
      const shaft = line(mark.from, mark.to, r, 0.07)
      strokes.push(inked(shaft, r, { ...PEN, end: 0 }))
      // The head sits square on the end of the shaft's curve, not on the line from tail to tip.
      const back = shaft[Math.max(0, shaft.length - 4)]!
      const angle = Math.atan2(mark.to.y - back.y, mark.to.x - back.x)
      const head = Math.min(16, Math.max(9, dist(mark.from, mark.to) * 0.2))
      const spread = 0.47 + r() * 0.03
      const wing = (side: number) => ({ x: mark.to.x + Math.cos(angle + Math.PI + side * spread) * head, y: mark.to.y + Math.sin(angle + Math.PI + side * spread) * head })
      // The head is one motion, out to the tip and back: two strokes meeting in round ends there.
      strokes.push(inked(line(wing(-1), mark.to, r, 0.02, 0), r, { ...PEN, start: 7, end: 0 }))
      strokes.push(inked(line(mark.to, wing(1), r, 0.02, 0), r, { ...PEN, start: 0, end: 9 }))
      // The cursor rests clear of what the arrow points at: just behind its tail, else beside the
      // tail, else beside the middle of the shaft (whichever leaves the label clear; see main.ts).
      const len = dist(mark.from, mark.to) || 1
      const away = { x: (mark.from.x - mark.to.x) / len, y: (mark.from.y - mark.to.y) / len }
      const mid = shaft[Math.floor(shaft.length / 2)]!
      rests = [{ x: mark.from.x + away.x * 6, y: mark.from.y + away.y * 6 }]
      for (const side of [1, -1]) rests.push({ x: mark.from.x - away.y * side * 16, y: mark.from.y + away.x * side * 16 })
      for (const side of [1, -1]) rests.push({ x: mid.x - away.y * side * 14, y: mid.y + away.x * side * 14 })
      break
    }
    case 'path': {
      const pts = mark.points.length > 2 ? through(mark.points) : line(mark.points[0]!, mark.points[mark.points.length - 1]!, r, 0.01)
      strokes.push(...freehand(pts, r))
      const end = mark.points[mark.points.length - 1]!
      rests = [{ x: end.x + 3, y: end.y + 3 }]
      break
    }
    case 'text':
      // The pointer rests at the tag's lower left, as if it had just written it (placed again once the tag is).
      rests = [{ x: mark.x - 2, y: mark.y + 30 }]
      break
  }
  const label = mark.kind === 'text' ? mark.text : mark.label
  const keepIn = (v: number, size: number) => Math.min(size - 4, Math.max(4, v))
  return {
    id: mark.id,
    kind: mark.kind,
    color: mark.color,
    strokes,
    ...(label ? { label } : {}),
    rests: rests.map((p) => ({ x: keepIn(p.x, screen.w), y: keepIn(p.y, screen.h) })),
    box: mark.kind === 'text' ? { x: mark.x, y: mark.y, w: 0, h: 0 } : covers(bounds(strokes), mark),
    ...(mark.kind === 'arrow' ? { arrow: { from: { ...mark.from }, to: { ...mark.to } } } : {})
  }
}

/**
 * The assistant's pointer: an arrowhead with its tip at 0,0, even on both sides of its axis (15
 * long, 14 across the back, notched 4 deep), turned 28° from upright as a pointer leans.
 */
export const POINTER: Pt[] = [
  { x: 0, y: 0 },
  { x: 0.9, y: 16.4 },
  { x: 5.2, y: 9.7 },
  { x: 13.1, y: 10 }
]
