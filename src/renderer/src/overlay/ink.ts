// Marks as pen strokes: each shape becomes a few wobbly polylines, seeded by the mark's id so it
// holds still between frames. Polylines (rather than canvas curves) let the overlay's cursor draw a
// mark gradually, the way a person sketches. Labels aren't drawn by hand: the overlay shows them as
// tags under the cursor, which parks at the mark's `rest` point when it's done.
import type { Mark, MarkColor } from '@shared/computer'
import { rng } from '@/lib/sketchy'

export interface Pt {
  x: number
  y: number
}

export interface Stroke {
  pts: Pt[]
  width: number
  color: string
  /** Highlighter: wide and translucent. */
  marker?: boolean
}

export interface Inked {
  id: string
  color: MarkColor
  strokes: Stroke[]
  /** The mark's label (or the mark itself, for text), shown in a tag. */
  label?: string
  /** Where the cursor parks after drawing, pointing at the mark, with the label hanging below it. */
  rest: Pt
}

/** Pens that read on light and dark screens alike (each is drawn over a white halo). */
export const PENS: Record<MarkColor, string> = { red: '#f03e3e', blue: '#1c7ed6', green: '#2f9e44', yellow: '#f59f00', black: '#212529' }
const MARKERS: Record<MarkColor, string> = { red: '#ff8787', blue: '#74c0fc', green: '#8ce99a', yellow: '#ffe066', black: '#adb5bd' }

type Rand = () => number

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
export const polyLength = (pts: Pt[]) => pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1]!, p) : 0), 0)

/** A pencil line from a to b: bowed a little to one side, ends jittered, sampled as points. */
export const bowed = (a: Pt, b: Pt, r: Rand, bow = 0.025): Pt[] => {
  const len = dist(a, b) || 1
  const nx = -(b.y - a.y) / len
  const ny = (b.x - a.x) / len
  const off = len * bow * (0.5 + Math.abs(r())) * (r() < 0 ? -1 : 1)
  const j = Math.min(2.5, len / 60)
  const p0 = { x: a.x + r() * j, y: a.y + r() * j }
  const p2 = { x: b.x + r() * j, y: b.y + r() * j }
  const c = { x: (a.x + b.x) / 2 + nx * off, y: (a.y + b.y) / 2 + ny * off }
  const n = Math.max(6, Math.ceil(len / 10))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x + r() * 0.35, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y + r() * 0.35 })
  }
  return out
}

/** A loop drawn in one go: a little more than a full turn, so the ends cross like a pen circle does. */
const loop = (cx: number, cy: number, rx: number, ry: number, r: Rand): Pt[] => {
  const start = -Math.PI / 2 + r() * 0.8
  const turns = 1.1 + Math.abs(r()) * 0.08
  const phase = r() * Math.PI
  const n = Math.max(36, Math.ceil(((rx + ry) * Math.PI) / 8))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = start + t * turns * Math.PI * 2
    // Slightly wider on the way round, so the second pass doesn't sit on the first.
    const grow = 1 + t * 0.07
    const wob = 1 + Math.sin(a * 2 + phase) * 0.035
    out.push({ x: cx + Math.cos(a) * rx * grow * wob, y: cy + Math.sin(a) * ry * grow * wob })
  }
  return out
}

/** Catmull-Rom through the model's points, so a freehand path is smooth rather than jagged. */
const smooth = (pts: Pt[], r: Rand): Pt[] => {
  if (pts.length < 3) return pts.length === 2 ? bowed(pts[0]!, pts[1]!, r, 0.01) : pts
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!
    const steps = Math.max(3, Math.ceil(dist(p1, p2) / 8))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x) + r() * 0.4, y: f(p0.y, p1.y, p2.y, p3.y) + r() * 0.4 })
    }
  }
  out.push(pts[pts.length - 1]!)
  return out
}

/** Pen width for outlines. */
const W = 3.2

export const ink = (mark: Mark, screen: { w: number; h: number }): Inked => {
  const r = rng(mark.id)
  const pen = PENS[mark.color]
  const strokes: Stroke[] = []
  let rest: Pt

  switch (mark.kind) {
    case 'circle': {
      const pad = 8
      const rx = mark.w / 2 + pad
      const ry = mark.h / 2 + pad
      strokes.push({ pts: loop(mark.x + mark.w / 2, mark.y + mark.h / 2, rx, ry, r), width: W, color: pen })
      // The lower right of the loop: the pointer touches the ring and the tag hangs clear of what's inside.
      rest = { x: mark.x + mark.w / 2 + rx * 0.5, y: mark.y + mark.h / 2 + ry * 0.9 }
      break
    }
    case 'box': {
      const pad = 6
      const [x, y, w, h] = [mark.x - pad, mark.y - pad, mark.w + pad * 2, mark.h + pad * 2]
      const o = () => 4 + Math.abs(r()) * 4
      strokes.push({ pts: bowed({ x: x - o(), y }, { x: x + w + o(), y }, r, 0.008), width: W, color: pen })
      strokes.push({ pts: bowed({ x: x + w, y: y - o() }, { x: x + w, y: y + h + o() }, r, 0.01), width: W, color: pen })
      strokes.push({ pts: bowed({ x: x + w + o(), y: y + h }, { x: x - o(), y: y + h }, r, 0.008), width: W, color: pen })
      strokes.push({ pts: bowed({ x, y: y + h + o() }, { x, y: y - o() }, r, 0.01), width: W, color: pen })
      rest = { x: x + w * 0.6, y: y + h + 1 }
      break
    }
    case 'underline': {
      const y = mark.y + mark.h + 5
      strokes.push({ pts: bowed({ x: mark.x - 4, y: y + r() * 2 }, { x: mark.x + mark.w + 6, y: y - 2 + r() * 2 }, r, 0.012), width: W, color: pen })
      // A quick second pass, shorter, as when underlining for emphasis.
      strokes.push({ pts: bowed({ x: mark.x + mark.w * 0.08, y: y + 5 }, { x: mark.x + mark.w * 0.9, y: y + 4 }, r, 0.015), width: 2.4, color: pen })
      rest = { x: mark.x + mark.w * 0.9, y: y + 6 }
      break
    }
    case 'highlight': {
      const rows = Math.max(1, Math.round(mark.h / 22))
      const band = mark.h / rows
      for (let i = 0; i < rows; i++) {
        const y = mark.y + band * (i + 0.5)
        strokes.push({ pts: bowed({ x: mark.x - 4, y: y + r() * 1.5 }, { x: mark.x + mark.w + 4, y: y + r() * 1.5 }, r, 0.004), width: band * 1.05, color: MARKERS[mark.color], marker: true })
      }
      rest = { x: mark.x + mark.w * 0.6, y: mark.y + mark.h + 2 }
      break
    }
    case 'arrow': {
      const shaft = bowed(mark.from, mark.to, r, 0.1)
      strokes.push({ pts: shaft, width: W, color: pen })
      const tail = shaft[shaft.length - 4] ?? mark.from
      const angle = Math.atan2(mark.to.y - tail.y, mark.to.x - tail.x)
      const head = Math.min(22, dist(mark.from, mark.to) / 3)
      for (const side of [-1, 1]) {
        const a = angle + Math.PI + side * (0.48 + r() * 0.08)
        strokes.push({ pts: bowed(mark.to, { x: mark.to.x + Math.cos(a) * head, y: mark.to.y + Math.sin(a) * head }, r, 0.05), width: W, color: pen })
      }
      // The label goes at the tail, away from what the arrow points at.
      rest = { ...mark.from }
      break
    }
    case 'path': {
      strokes.push({ pts: smooth(mark.points, r), width: W, color: pen })
      rest = { ...mark.points[mark.points.length - 1]! }
      break
    }
    case 'text':
      rest = { x: mark.x, y: mark.y }
      break
  }
  const label = mark.kind === 'text' ? mark.text : mark.label
  const keepIn = (v: number, size: number) => Math.min(size - 4, Math.max(4, v))
  return { id: mark.id, color: mark.color, strokes, ...(label ? { label } : {}), rest: { x: keepIn(rest.x, screen.w), y: keepIn(rest.y, screen.h) } }
}

/**
 * The assistant's pointer: a small arrowhead with its tip at 0,0, even on both sides of its axis
 * (13 long, 12 across the back, notched 3.5 deep), turned 28° from upright as a pointer leans.
 */
export const POINTER: Pt[] = [
  { x: 0, y: 0 },
  { x: 0.8, y: 14.3 },
  { x: 4.5, y: 8.4 },
  { x: 11.4, y: 8.7 }
]
