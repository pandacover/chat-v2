// Pressure ink: a pen line drawn as a filled outline whose width follows a hand. It runs a little
// slimmer on straight stretches, where a pen moves fast, swells where it slows into a turn, and
// tapers where it lands and where it lifts. The same idea as perfect-freehand, kept small for the
// overlay's marks, whose lines are made up rather than traced from a stylus.

export interface Pt {
  x: number
  y: number
}

/** A point on an inked line: where it is, how wide the line is there, and how far along it lies. */
export interface InkPt extends Pt {
  w: number
  s: number
}

export interface Nib {
  /** The width where the pen presses fully. */
  size: number
  /** How much slimmer the line runs on straight stretches, from 0 (not at all) to 1. */
  thinning: number
  /** How far the taper runs where the pen lands, and where it lifts (px); 0 leaves a round end. */
  start: number
  end: number
  /** How much the width swells and eases along the line, as pressure does (a share of the size). */
  swell: number
}

type Rand = () => number

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/** Points every `step` px along a polyline, so widths and outlines come out even. */
export const resample = (pts: Pt[], step: number): Pt[] => {
  if (pts.length < 2) return pts.slice()
  const out: Pt[] = [pts[0]!]
  // How far past the last point placed the walk has gone.
  let gone = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const seg = dist(a, b)
    let at = step - gone
    while (at <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * at) / seg, y: a.y + ((b.y - a.y) * at) / seg })
      at += step
    }
    gone = seg - (at - step)
  }
  const end = pts[pts.length - 1]!
  // The very end always ends the line: added when it is far enough on, else in place of the last point.
  if (dist(out[out.length - 1]!, end) > step * 0.35) out.push(end)
  else if (out.length > 1) out[out.length - 1] = end
  return out
}

const easeOutQuad = (t: number) => t * (2 - t)
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/**
 * Widths along a line, from the pressure a hand would give it: lighter where the line runs
 * straight, heavier into turns, swelling slowly, tapered where the pen lands and lifts.
 */
export const press = (pts: Pt[], nib: Nib, r: Rand): InkPt[] => {
  const n = pts.length
  const s = [0]
  for (let i = 1; i < n; i++) s.push(s[i - 1]! + dist(pts[i - 1]!, pts[i]!))
  const total = s[n - 1] || 1
  // How sharply the line turns at each point, in radians per px, over a few px either side.
  const turn = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 2)]!
    const b = pts[Math.min(n - 1, i + 2)]!
    if (a === p || b === p) return 0
    let d = Math.abs(Math.atan2(b.y - p.y, b.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x))
    if (d > Math.PI) d = Math.PI * 2 - d
    return d / Math.max(1, (s[Math.min(n - 1, i + 2)]! - s[Math.max(0, i - 2)]!) / 2)
  })
  // Pressure changes smoothly: each point takes the average turn around it.
  const slow = turn.map((_, i) => {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) {
      sum += turn[j]!
      count++
    }
    // A turn as tight as a 14 px circle, or tighter, slows the pen fully.
    return Math.min(1, (sum / count) * 14)
  })
  const phase = r() * Math.PI * 2
  const period = 110 + Math.abs(r()) * 90
  const lands = nib.start ? Math.min(nib.start, total * 0.35) : 0
  const lifts = nib.end ? Math.min(nib.end, total * 0.45) : 0
  return pts.map((p, i) => {
    const pressure = 1 - nib.thinning * (1 - slow[i]!)
    const swell = 1 + nib.swell * Math.sin((s[i]! / period) * Math.PI * 2 + phase)
    const landing = lands ? 0.2 + 0.8 * easeOutQuad(Math.min(1, s[i]! / lands)) : 1
    const lifting = lifts ? 0.08 + 0.92 * easeOutCubic(Math.min(1, (total - s[i]!) / lifts)) : 1
    return { x: p.x, y: p.y, s: s[i]!, w: nib.size * pressure * swell * landing * lifting }
  })
}

/** The first `len` px of an inked line, ending exactly there: the line as far as the pen has got. */
export const cut = (pts: InkPt[], len: number): InkPt[] => {
  const last = pts[pts.length - 1]
  if (!last || len >= last.s) return pts
  if (len <= 0) return pts.slice(0, 1)
  let lo = 0
  let hi = pts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid]!.s <= len) lo = mid
    else hi = mid
  }
  const a = pts[lo]!
  const b = pts[hi]!
  const t = b.s > a.s ? (len - a.s) / (b.s - a.s) : 0
  const out = pts.slice(0, lo + 1)
  out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, s: len })
  return out
}

/** Points round one end of a line, from its left side over its tip to its right side. */
const capAround = (out: Pt[], p: InkPt, tx: number, ty: number, flat: number) => {
  const r = p.w / 2
  const steps = Math.max(4, Math.min(14, Math.ceil(r * 2.5)))
  for (let k = 1; k < steps; k++) {
    const a = (k / steps) * Math.PI
    const across = Math.cos(a)
    const ahead = Math.sin(a) * flat
    out.push({ x: p.x + (-ty * across + tx * ahead) * r, y: p.y + (tx * across + ty * ahead) * r })
  }
}

/**
 * The outline of an inked line as a closed polygon: along its left side, round its end, back along
 * its right side and round its start. Every outline winds the same way whichever way its line
 * runs, so several filled as one shape join where they cross. `flat` squashes the round ends
 * (1: half circles), for a highlighter's squarer ones.
 */
export const outline = (pts: InkPt[], flat = 1): Pt[] => {
  const n = pts.length
  const first = pts[0]
  if (!first) return []
  if (n === 1 || pts[n - 1]!.s < 0.01) {
    // A dot: the pen touched down and no more.
    const out: Pt[] = []
    const r = Math.max(0.5, first.w / 2)
    for (let k = 0; k < 12; k++) out.push({ x: first.x + Math.cos((k / 12) * Math.PI * 2) * r, y: first.y + Math.sin((k / 12) * Math.PI * 2) * r })
    return out
  }
  const left: Pt[] = []
  const right: Pt[] = []
  const dir = (a: Pt, b: Pt) => {
    const len = dist(a, b) || 1
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const t = dir(pts[Math.max(0, i - 1)]!, pts[Math.min(n - 1, i + 1)]!)
    const r = p.w / 2
    left.push({ x: p.x - t.y * r, y: p.y + t.x * r })
    right.push({ x: p.x + t.y * r, y: p.y - t.x * r })
  }
  // The ends face the way the line runs over its last few px, not just its last step.
  const head = dir(pts[Math.max(0, n - 4)]!, pts[n - 1]!)
  const tail = dir(pts[Math.min(n - 1, 3)]!, first)
  const out = left
  capAround(out, pts[n - 1]!, head.x, head.y, flat)
  for (let i = n - 1; i >= 0; i--) out.push(right[i]!)
  capAround(out, first, tail.x, tail.y, flat)
  return out
}
