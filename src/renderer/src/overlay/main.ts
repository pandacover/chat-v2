// The computer-use overlay: a transparent window over the screen that shows what the assistant
// is doing. A sketched cursor keeps the user company while computer mode is on, following their
// pointer; when the assistant acts, it glides off to each target, draws the marks itself and
// carries a tag saying what it's doing. The window ignores the mouse except over the status bar,
// and screen captures leave it out.
import '../fonts.css'
import './overlay.css'
// Sets --font-ui and --font-reading from the user's Appearance settings, and follows changes.
import '@/lib/appearance.svelte'
import type { Mark, OverlayCommand, OverlayEvent } from '@shared/computer'
import { rng } from '@/lib/sketchy'
import { type Inked, POINTER, type Pt, ink, polyLength } from './ink'

interface Bridge {
  onEvent(listener: (event: OverlayEvent) => void): void
  setInteractive(on: boolean): void
  follow(on: boolean): void
  command(command: OverlayCommand): void
}
const bridge = (window as unknown as { overlay: Bridge }).overlay

const canvas = document.getElementById('ink') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const pill = document.getElementById('pill') as HTMLDivElement
const pillTitle = pill.querySelector('.title') as HTMLSpanElement
const pillSub = pill.querySelector('.sub') as HTMLSpanElement

const ACCENT = '#e8590c'
/** Matches the main process's glide, so the ripple lands as the real click does. */
const GLIDE_MS = 250
/** A drag takes about as long as the helper takes to move through it. */
const DRAG_MS = 400
/** Per mark, as in ANNOTATE_MS / ANNOTATE_MAX_MS in Computer.ts, less a little to finish first. */
const MARK_MS = 1100
const MARKS_MAX_MS = 7600
/** Where the sketch cursor sits beside the user's pointer while it follows. */
const BESIDE = { x: 16, y: 18 }
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

/** The user's fonts, read when drawing so a change in Settings shows on the next frame. */
const font = () => getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif'
const loadFonts = () => void document.fonts.load(`600 13px ${font()}`).then(() => {
  layouts.clear()
  wake()
})
addEventListener('storage', () => {
  layouts.clear()
  loadFonts()
  wake()
})

/**
 * Where the window sits on the display (main sends it once shown): drawing is in display
 * coordinates, and tags stay inside the part of the display the window covers.
 */
const view = { dx: 0, dy: 0, w: innerWidth, h: innerHeight }
/** The visible area, in display coordinates, with a margin. */
const visible = (margin = 8) => ({
  x0: Math.max(0, view.dx) + margin,
  y0: Math.max(0, view.dy) + margin,
  x1: Math.min(view.w, view.dx + innerWidth) - margin,
  y1: Math.min(view.h, view.dy + innerHeight) - margin
})

let dpr = 1
const resize = () => {
  dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(innerWidth * dpr)
  canvas.height = Math.round(innerHeight * dpr)
  canvas.style.width = `${innerWidth}px`
  canvas.style.height = `${innerHeight}px`
  wake()
}
addEventListener('resize', resize)

// --- State ---------------------------------------------------------------------------------

type Action = Extract<OverlayEvent, { type: 'cursor' }>['action']
type State = 'off' | 'idle' | 'working' | 'done'

let state: State = 'off'
/** Computer mode: the cursor follows the user's pointer whenever the assistant isn't driving it. */
let follow = false
let pointer: Pt | null = null
/** True once the assistant moves the cursor in this run; until then it stays by the user's pointer. */
let driven = false
/** What the cursor's tag says while working (the step), and while idle (a hint). */
let workLabel = ''
let hint = ''
/**
 * What the tag says, beside a spinner, while the model decides the next step; null otherwise. The
 * cursor waits where it is meanwhile. The next status, hint, glide or mark clears it.
 */
let thinking: string | null = null

const cursor = {
  x: -100,
  y: -100,
  alpha: 0,
  from: { x: 0, y: 0 },
  to: { x: 0, y: 0 },
  /** Bend of the glide, so it travels in an arc as a hand does. */
  bend: { x: 0, y: 0 },
  t0: 0,
  dur: 0,
  action: undefined as Action
}
let trail: Array<{ x: number; y: number; t: number }> = []
let ripples: Array<{ x: number; y: number; t: number; color: string }> = []
let dragFrom: Pt | null = null

/** One move of the pen: travelling with it lifted, or drawing a stroke. */
interface Seg {
  dur: number
  from: Pt
  to: Pt
  bend: Pt
  stroke: number | null
}

interface Drawn {
  ink: Inked
  /** The share of the batch's time this mark gets. */
  budget: number
  /** Planned when the cursor reaches this mark, from wherever it is then. */
  plan: Seg[] | null
  start: number
  end: number
  fadeAt: number | null
  /** How far its tag hangs below the rest point: under the cursor's tail while it's there, close to the mark once it leaves. */
  drop: number
}
let drawn: Drawn[] = []

let last = performance.now()
const now = () => performance.now()
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/** A gentle sideways bow for a move from a to b, seeded so it holds still. */
const arc = (a: Pt, b: Pt, seed: string, amount = 0.14): Pt => {
  const len = dist(a, b)
  if (len < 2) return { x: 0, y: 0 }
  const r = rng(seed)
  const k = Math.min(amount, 30 / len) * len * (r() < 0 ? -1 : 1)
  return { x: (-(b.y - a.y) / len) * k, y: ((b.x - a.x) / len) * k }
}
const along = (a: Pt, b: Pt, bend: Pt, e: number): Pt => {
  const mid = { x: (a.x + b.x) / 2 + bend.x, y: (a.y + b.y) / 2 + bend.y }
  const u = 1 - e
  return { x: u * u * a.x + 2 * u * e * mid.x + e * e * b.x, y: u * u * a.y + 2 * u * e * mid.y + e * e * b.y }
}

// --- The status bar ------------------------------------------------------------------------

const setPill = () => {
  const show = state === 'working' || state === 'done'
  if (!show && !pill.hidden) bridge.setInteractive(false)
  pill.hidden = !show
  pill.dataset.state = state
  if (state === 'working') {
    pillTitle.textContent = 'Using your computer'
    pillSub.textContent = 'You can keep using your mouse'
  } else if (state === 'done') {
    const marked = drawn.some((d) => d.fadeAt === null)
    pillTitle.textContent = 'Done'
    pillSub.textContent = marked ? 'The marks stay until you clear them' : ''
  }
}

/** Keeps the bar out of the way of where the cursor is about to work. */
const dodge = (at: Pt) => {
  if (pill.hidden) return
  // The bar is placed in the window, the point on the display.
  const p = { x: at.x - view.dx, y: at.y - view.dy }
  const r = pill.getBoundingClientRect()
  const near = (y0: number, y1: number) => p.x > r.left - 60 && p.x < r.right + 60 && p.y > y0 - 60 && p.y < y1 + 60
  if (!pill.classList.contains('low') && near(r.top, r.bottom)) pill.classList.add('low')
  else if (pill.classList.contains('low') && near(r.top, r.bottom)) pill.classList.remove('low')
}

// --- Events --------------------------------------------------------------------------------

const moveCursor = (e: Extract<OverlayEvent, { type: 'cursor' }>) => {
  const t = now()
  if (cursor.alpha < 0.05) {
    // From nowhere, it appears a little short of its target and sweeps in.
    cursor.x = e.x - 60
    cursor.y = e.y - 40
  }
  driven = true
  dodge(e)
  if (e.action === 'drag' && !dragFrom) dragFrom = { x: cursor.x, y: cursor.y }
  if (e.action !== 'drag') dragFrom = null
  cursor.from = { x: cursor.x, y: cursor.y }
  cursor.to = { x: e.x, y: e.y }
  const len = dist(cursor.from, cursor.to)
  cursor.bend = arc(cursor.from, cursor.to, `${e.x},${e.y},${t}`, 0.18)
  cursor.t0 = t
  // Long enough to follow by eye; short hops a little quicker. The real input fires after GLIDE_MS.
  cursor.dur = reduced || len < 2 ? 1 : e.action === 'drag' ? DRAG_MS : Math.min(GLIDE_MS, 120 + len * 0.4)
  cursor.action = e.action
  workLabel = e.label
  const color = e.action === 'right' ? '#1c7ed6' : ACCENT
  if (e.action === 'click' || e.action === 'right' || e.action === 'double') ripples.push({ x: e.x, y: e.y, t: t + cursor.dur, color })
  if (e.action === 'double') ripples.push({ x: e.x, y: e.y, t: t + cursor.dur + 140, color })
  wake()
}

const setMarks = (marks: Mark[]) => {
  const keep = new Set(marks.map((m) => m.id))
  const t = now()
  for (const d of drawn) if (!keep.has(d.ink.id) && d.fadeAt === null) d.fadeAt = t
  const known = new Set(drawn.map((d) => d.ink.id))
  const fresh = marks.filter((m) => !known.has(m.id))
  const budget = Math.min(MARK_MS, MARKS_MAX_MS / Math.max(1, fresh.length))
  for (const m of fresh) drawn.push({ ink: ink(m, { w: view.w, h: view.h }), budget, plan: null, start: 0, end: 0, fadeAt: null, drop: TAIL })
  if (fresh.length) {
    driven = true
    // The tags say what's marked; "Drawing on the screen" would only crowd them.
    workLabel = ''
    dodge(fresh[0]!.kind === 'arrow' ? fresh[0]!.from : fresh[0]!.kind === 'path' ? fresh[0]!.points[0]! : fresh[0]!)
  }
  wake()
}

const clearMarks = () => {
  const t = now()
  for (const d of drawn) if (d.fadeAt === null) d.fadeAt = t
  wake()
}

const setStatus = (next: Exclude<State, 'off'>, label: string) => {
  const was = state
  state = next
  if (next === 'working') {
    if (was !== 'working') {
      driven = false
      pill.classList.remove('low')
    }
    if (label) workLabel = label
  } else {
    // Between tasks the cursor comes back to the user.
    driven = false
    workLabel = ''
    dragFrom = null
  }
  setPill()
}

/** What a frame is drawn from, of what the events below may well leave as it was. */
const drawnFrom = () => `${state}|${follow}|${driven}|${workLabel}|${hint}|${thinking}|${pointer ? `${pointer.x},${pointer.y}` : '-'}`

bridge.onEvent((e) => {
  // The same status or hint again, or the mode as it was, draws nothing new: no frame for it.
  const maybeSame = e.type === 'status' || e.type === 'hint' || e.type === 'mode' || e.type === 'pointer'
  const before = maybeSame ? drawnFrom() : ''
  // A busy status or hint brings up the spinner; whatever comes next takes it down.
  if (e.type === 'status' || e.type === 'hint') thinking = e.busy ? e.label : null
  else if (e.type === 'cursor' || e.type === 'marks') thinking = null
  if (e.type === 'status' && e.busy) {
    // Thinking keeps the step's label for when it's done, and the cursor where the step left it.
    if (state !== 'working') setStatus('working', '')
  } else if (e.type === 'hint' && e.busy) {
    // The idle hint stays as it was.
  } else if (e.type === 'cursor') moveCursor(e)
  else if (e.type === 'marks') setMarks(e.marks)
  else if (e.type === 'clear') clearMarks()
  else if (e.type === 'mode') follow = e.follow
  else if (e.type === 'frame') Object.assign(view, { dx: e.dx, dy: e.dy, w: e.w, h: e.h })
  else if (e.type === 'hint') hint = e.label
  else if (e.type === 'pointer') pointer = e.x === null ? null : { x: e.x, y: e.y }
  else if (e.type === 'status' && e.state !== 'off') setStatus(e.state, e.label)
  askForPointer()
  if (!maybeSame || drawnFrom() !== before) wake()
})

/** Whether the main process is sending the user's pointer (see askForPointer). */
let pointerAsked = false
/**
 * The pointer is polled in the main process, so it is asked for only while the cursor may follow
 * it: while the assistant isn't driving the cursor, in computer mode or while it works.
 */
const askForPointer = () => {
  const want = !driven && (follow || state === 'working')
  if (want === pointerAsked) return
  pointerAsked = want
  // Whatever it was is out of date by the time it's asked for again.
  if (!want) pointer = null
  bridge.follow(want)
}

// The bar takes clicks only while the pointer is over it; everywhere else, clicks fall through.
pill.addEventListener('pointerenter', () => bridge.setInteractive(true))
pill.addEventListener('pointerleave', () => bridge.setInteractive(false))
pill.addEventListener('click', (e) => {
  const command = (e.target as HTMLElement).closest('button')?.dataset.command as OverlayCommand | undefined
  if (command) bridge.command(command)
})

// --- The pen -------------------------------------------------------------------------------

/** The cursor's route over one mark: to each stroke, along it, then to where it rests. */
const planMark = (d: Drawn, from: Pt): Seg[] => {
  const segs: Seg[] = []
  let at = from
  const travel = (to: Pt) => {
    const len = dist(at, to)
    if (len < 2) return
    segs.push({ dur: Math.min(360, 90 + len * 0.45), from: at, to, bend: arc(at, to, `${d.ink.id}${segs.length}`, 0.12), stroke: null })
    at = to
  }
  d.ink.strokes.forEach((s, i) => {
    travel(s.pts[0]!)
    segs.push({ dur: 70 + polyLength(s.pts) * 0.85, from: at, to: s.pts[s.pts.length - 1]!, bend: { x: 0, y: 0 }, stroke: i })
    at = s.pts[s.pts.length - 1]!
  })
  travel(d.ink.rest)
  // Fit the batch's share of time, so the drawing is done when the main process moves on.
  const total = segs.reduce((sum, s) => sum + s.dur, 0)
  const k = reduced ? 0 : total > d.budget ? d.budget / total : 1
  for (const s of segs) s.dur = Math.max(reduced ? 0 : 16, s.dur * k)
  return segs
}

/** The first `part` of a polyline, by length. */
const portion = (pts: Pt[], part: number): Pt[] => {
  if (part >= 1) return pts
  const total = polyLength(pts)
  let left = total * part
  const out: Pt[] = [pts[0]!]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (seg >= left) {
      const t = seg ? left / seg : 0
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      return out
    }
    out.push(b)
    left -= seg
  }
  return out
}

/** Strokes go down over a white halo with a soft shadow, so the pen reads on light and dark screens. */
const strokePath = (pts: Pt[], width: number, color: string, halo = true) => {
  if (pts.length < 2) return
  const trace = () => {
    ctx.beginPath()
    ctx.moveTo(pts[0]!.x, pts[0]!.y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
    ctx.stroke()
  }
  if (halo) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = 4
    ctx.shadowOffsetY = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.lineWidth = width + 3.5
    trace()
    ctx.restore()
  }
  ctx.strokeStyle = color
  ctx.lineWidth = width
  trace()
}

/** Draws a mark's strokes: the finished ones whole, the one under the pen up to `part`. */
const drawStrokes = (d: Drawn, upTo: number, part: number) => {
  d.ink.strokes.forEach((s, i) => {
    if (i > upTo) return
    const pts = i === upTo ? portion(s.pts, part) : s.pts
    if (s.marker) {
      ctx.save()
      ctx.globalAlpha *= 0.45
      strokePath(pts, s.width, s.color, false)
      ctx.restore()
    } else strokePath(pts, s.width, s.color)
  })
}

// --- Tags ----------------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface Layout {
  lines: string[]
  w: number
  h: number
}

const TAG = { size: 13, line: 17, padX: 10, padY: 6.5, maxW: 300 }
const layouts = new Map<string, Layout>()

/** Wraps a tag's text to at most three lines, measured once per text. */
const layoutTag = (text: string): Layout => {
  const known = layouts.get(text)
  if (known) return known
  ctx.font = `600 ${TAG.size}px ${font()}`
  const room = TAG.maxW - TAG.padX * 2
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= room || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length > 3) {
    lines.length = 3
    lines[2] = `${lines[2]}…`
  }
  for (let i = 0; i < lines.length; i++) {
    while (ctx.measureText(lines[i]!).width > room && lines[i]!.length > 2) lines[i] = `${lines[i]!.slice(0, -2)}…`
  }
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const out = { lines, w: Math.ceil(textW + TAG.padX * 2), h: Math.ceil(lines.length * TAG.line + TAG.padY * 2) }
  layouts.set(text, out)
  return out
}

/** Below the cursor's tip, a tag clears the arrowhead; alone, it sits close under its mark. */
const TAIL = 30
const SNUG = 10

/** Where a tag hangs: `drop` under a point, kept on screen and clear of tags already placed. */
const placeTag = (at: Pt, size: Layout, taken: Rect[], drop = TAIL): Rect => {
  const v = visible()
  // Below the point, or above it when there's no room below.
  const below = at.y + drop + size.h <= v.y1
  const rect = { x: at.x + 4, y: below ? at.y + drop : at.y - size.h - 10, w: size.w, h: size.h }
  for (let i = 0; i < 6; i++) {
    const hit = taken.find((r) => rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y)
    if (!hit) break
    rect.y = below ? hit.y + hit.h + 5 : hit.y - rect.h - 5
  }
  // Last, whatever happened above: wholly on screen. A tag wider than the screen starts at its left.
  rect.x = Math.max(v.x0, Math.min(rect.x, v.x1 - rect.w))
  rect.y = Math.max(v.y0, Math.min(rect.y, v.y1 - rect.h))
  return rect
}

/** Room a spinner takes at the start of a tag. */
const SPIN_W = 18

/** A small spinning arc, for the tag while the model decides. */
const drawSpinner = (cx: number, cy: number, t: number) => {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(250,250,249,0.25)'
  ctx.beginPath()
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2)
  ctx.stroke()
  const a = reduced ? 0 : (t / 900) * Math.PI * 2
  ctx.strokeStyle = ACCENT
  ctx.beginPath()
  ctx.arc(cx, cy, 5.5, a, a + Math.PI * 0.6)
  ctx.stroke()
  ctx.restore()
}

/** A tag: dark, solid and crisp, so it reads over any app. With `spin`, a spinner leads the text. */
const drawTag = (rect: Rect, layout: Layout, alpha: number, spin?: number) => {
  if (alpha <= 0.01) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.shadowColor = 'rgba(0,0,0,0.32)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 4
  ctx.fillStyle = 'rgba(24,24,27,0.95)'
  ctx.beginPath()
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 7.5)
  ctx.stroke()
  if (spin !== undefined) drawSpinner(rect.x + TAG.padX + 5.5, rect.y + rect.h / 2, spin)
  const tx = rect.x + TAG.padX + (spin !== undefined ? SPIN_W : 0)
  ctx.font = `600 ${TAG.size}px ${font()}`
  ctx.fillStyle = '#fafaf9'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  layout.lines.forEach((l, i) => ctx.fillText(l, tx, rect.y + TAG.padY + TAG.line * (i + 0.5) + 0.5))
  ctx.restore()
}

// --- The pointer ---------------------------------------------------------------------------

/** The assistant's pointer: a plain arrowhead in the accent colour, outlined in white so it shows on anything. */
const drawPointer = (x: number, y: number) => {
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x + POINTER[0]!.x, y + POINTER[0]!.y)
  for (const p of POINTER.slice(1)) ctx.lineTo(x + p.x, y + p.y)
  ctx.closePath()
  ctx.lineJoin = 'round'
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 2
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.shadowColor = 'transparent'
  ctx.fillStyle = ACCENT
  ctx.fill()
  ctx.restore()
}

// --- Frames --------------------------------------------------------------------------------

/**
 * A turning spinner is the one thing that animates for whole model calls, so on its own it gets
 * about 15 frames a second, and each of those repaints only the box it turns in.
 */
const SPIN_FRAME_MS = 66
/** Half the side of the box a spinner frame repaints: the arc's radius plus its stroke and some room. */
const SPIN_BOX = 9

let frame = 0
/** The box the next frame repaints, or null for the whole screen (see wake and spinLater). */
let clipNext: Rect | null = null
let spinTimer: ReturnType<typeof setTimeout> | 0 = 0
const render = () => {
  frame = 0
  const clip = clipNext
  clipNext = null
  const t = now()
  const dt = Math.min(64, t - last)
  last = t
  let busy = false
  /** Where the spinner turns, when it is up. */
  let spin: Rect | null = null
  // Display coordinates: the window may sit offset from the display's corner.
  ctx.setTransform(dpr, 0, 0, dpr, -view.dx * dpr, -view.dy * dpr)
  // A spinner frame draws everything as usual, but only inside the spinner's box: nothing else
  // has moved since the last frame, or that frame would have been a whole one.
  ctx.save()
  if (clip) {
    ctx.beginPath()
    ctx.rect(clip.x, clip.y, clip.w, clip.h)
    ctx.clip()
    ctx.clearRect(clip.x, clip.y, clip.w, clip.h)
  } else ctx.clearRect(view.dx, view.dy, innerWidth, innerHeight)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Marks, in order: the cursor draws each in turn, then parks at it while its tag drops into place.
  drawn = drawn.filter((d) => d.fadeAt === null || t - d.fadeAt < 260)
  let pen: Pt | null = null
  let penTag: string | null = null
  const chips: Array<{ d: Drawn; alpha: number }> = []
  let ready = t
  for (const d of drawn) {
    if (d.fadeAt === null && !d.plan) {
      // Its turn: plan the route from where the cursor is now.
      if (ready > t) break
      const from = cursor.alpha > 0.05 ? { x: cursor.x, y: cursor.y } : { x: (d.ink.strokes[0]?.pts[0] ?? d.ink.rest).x - 50, y: (d.ink.strokes[0]?.pts[0] ?? d.ink.rest).y - 40 }
      d.plan = planMark(d, from)
      d.start = t
      d.end = t + d.plan.reduce((sum, s) => sum + s.dur, 0)
    }
    if (!d.plan) continue
    ctx.save()
    const fade = d.fadeAt === null ? 1 : Math.max(0, 1 - (t - d.fadeAt) / 260)
    if (fade < 1) busy = true
    ctx.globalAlpha = fade
    if (t >= d.end) {
      drawStrokes(d, d.ink.strokes.length, 1)
      if (d.ink.label) chips.push({ d, alpha: fade })
    } else if (d.fadeAt === null) {
      busy = true
      let elapsed = t - d.start
      // The strokes before the pen are whole; the one under it is drawn up to `part`.
      let upTo = -1
      let part = 1
      for (const s of d.plan) {
        if (elapsed >= s.dur) {
          elapsed -= s.dur
          if (s.stroke !== null) {
            upTo = s.stroke
            part = 1
          }
          pen = s.to
          continue
        }
        const k = s.dur ? elapsed / s.dur : 1
        if (s.stroke !== null) {
          upTo = s.stroke
          part = easeSine(k)
          const pts = portion(d.ink.strokes[s.stroke]!.pts, part)
          pen = pts[pts.length - 1]!
        } else pen = along(s.from, s.to, s.bend, ease(k))
        break
      }
      if (upTo >= 0) drawStrokes(d, upTo, part)
      pen ??= d.plan[0]?.from ?? d.ink.rest
      if (d.ink.label) penTag = d.ink.label
    } else drawStrokes(d, d.ink.strokes.length, 1)
    ctx.restore()
    // The next mark waits for this one, with a beat between them.
    ready = d.fadeAt === null ? d.end + 80 : ready
    if (pen) break
  }
  // Marks still waiting their turn keep the frames coming.
  if (drawn.some((d) => d.fadeAt === null && !d.plan)) busy = true

  // Where the cursor goes: the pen, a glide, beside the user's pointer, or where it was left.
  const following = !driven && pointer !== null && (follow || state === 'working')
  if (pen) {
    cursor.x = pen.x
    cursor.y = pen.y
    cursor.to = { ...pen }
    cursor.dur = 0
  } else if (driven && cursor.dur && t - cursor.t0 < cursor.dur) {
    const k = Math.min(1, (t - cursor.t0) / cursor.dur)
    const p = along(cursor.from, cursor.to, cursor.bend, ease(k))
    cursor.x = p.x
    cursor.y = p.y
    trail.push({ x: p.x, y: p.y, t })
    busy = true
  } else if (driven && cursor.dur) {
    cursor.x = cursor.to.x
    cursor.y = cursor.to.y
    cursor.dur = 0
  } else if (following) {
    // Beside the pointer, on whichever side keeps the arrowhead on screen.
    const v = visible(0)
    const target = {
      x: pointer!.x + BESIDE.x + 22 > v.x1 ? pointer!.x - BESIDE.x - 18 : pointer!.x + BESIDE.x,
      y: pointer!.y + BESIDE.y + 24 > v.y1 ? pointer!.y - BESIDE.y - 22 : pointer!.y + BESIDE.y
    }
    if (cursor.alpha < 0.05) {
      cursor.x = target.x
      cursor.y = target.y
    } else {
      // A light spring: it trails the pointer a moment, like something following along.
      const k = reduced ? 1 : 1 - Math.exp(-dt / 55)
      cursor.x += (target.x - cursor.x) * k
      cursor.y += (target.y - cursor.y) * k
      if (dist(cursor, target) > 0.4) busy = true
    }
  }

  const shown = pen !== null || (state === 'working' && (driven || pointer !== null)) || following
  const goal = shown ? 1 : 0
  if (Math.abs(cursor.alpha - goal) > 0.01) {
    cursor.alpha += (goal - cursor.alpha) * Math.min(1, reduced ? 1 : dt / (goal ? 90 : 160))
    busy = true
  } else cursor.alpha = goal

  trail = trail.filter((p) => t - p.t < 650)
  if (trail.length > 1) {
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]!
      const b = trail[i]!
      ctx.globalAlpha = Math.max(0, 1 - (t - b.t) / 650) * 0.5
      strokePath([a, b], 2, ACCENT, false)
    }
    ctx.globalAlpha = 1
    busy = true
  }
  if (dragFrom && cursor.alpha > 0) {
    ctx.setLineDash([6, 7])
    strokePath([dragFrom, { x: cursor.x, y: cursor.y }], 2, ACCENT, false)
    ctx.setLineDash([])
  }

  // Click ripples: two rough rings spreading out from the point.
  ripples = ripples.filter((p) => t - p.t < 520)
  for (const p of ripples) {
    const k = (t - p.t) / 520
    busy = true
    if (k < 0) continue
    const r = rng(`${p.x}${p.y}${p.t}`)
    ctx.globalAlpha = 1 - k
    for (const [i, size] of [6, 14].entries()) {
      const rad = size + k * (22 + i * 10)
      const pts: Pt[] = []
      for (let a = 0; a <= 26; a++) {
        const ang = (a / 24) * Math.PI * 2
        pts.push({ x: p.x + Math.cos(ang) * rad * (1 + r() * 0.05), y: p.y + Math.sin(ang) * rad * (1 + r() * 0.05) })
      }
      strokePath(pts, 2.2 - i * 0.6, p.color, false)
    }
    ctx.globalAlpha = 1
  }

  // Tags: the finished marks' labels where the cursor left them, then the cursor's own.
  const taken: Rect[] = []
  for (const { d, alpha } of chips) {
    const layout = layoutTag(d.ink.label!)
    // The tag drops with the cursor; once it moves on, the tag settles up against its mark.
    const held = cursor.alpha > 0.05 && dist(cursor, d.ink.rest) < 20
    const goal = held ? TAIL : SNUG
    if (Math.abs(d.drop - goal) > 0.3) {
      d.drop += (goal - d.drop) * (reduced ? 1 : Math.min(1, dt / 90))
      busy = true
    } else d.drop = goal
    const rect = placeTag(d.ink.rest, layout, taken, d.drop)
    taken.push(rect)
    drawTag(rect, layout, alpha)
  }

  if (cursor.alpha > 0.01) {
    ctx.globalAlpha = cursor.alpha
    drawPointer(cursor.x, cursor.y)
    ctx.globalAlpha = 1
    const deciding = penTag === null && thinking !== null && (state === 'working' || !driven)
    const text = penTag ?? (deciding ? thinking : state === 'working' ? workLabel : !driven ? hint : '')
    if (text) {
      const base = layoutTag(text)
      const layout = deciding ? { ...base, w: base.w + SPIN_W } : base
      const rect = placeTag(cursor, layout, taken)
      drawTag(rect, layout, cursor.alpha, deciding ? t : undefined)
      // The spinner turns (drawSpinner's centre, as drawTag places it).
      if (deciding && !reduced) {
        const cx = rect.x + TAG.padX + 5.5
        const cy = rect.y + rect.h / 2
        // On whole device pixels, so clearing and redrawing it leaves no half-cleared edge.
        const x0 = view.dx + Math.floor((cx - SPIN_BOX - view.dx) * dpr) / dpr
        const y0 = view.dy + Math.floor((cy - SPIN_BOX - view.dy) * dpr) / dpr
        const x1 = view.dx + Math.ceil((cx + SPIN_BOX - view.dx) * dpr) / dpr
        const y1 = view.dy + Math.ceil((cy + SPIN_BOX - view.dy) * dpr) / dpr
        spin = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
    }
  }
  ctx.restore()

  if (busy) wake()
  else if (spin) spinLater(spin)
}

/** Draws the whole screen on the next frame. */
function wake() {
  clipNext = null
  if (!frame) frame = requestAnimationFrame(render)
}

/** Turns the spinner in `box` a step, a moment from now, unless a whole frame comes first. */
function spinLater(box: Rect) {
  if (spinTimer) return
  spinTimer = setTimeout(() => {
    spinTimer = 0
    if (frame) return
    clipNext = box
    frame = requestAnimationFrame(render)
  }, SPIN_FRAME_MS)
}

resize()
loadFonts()
