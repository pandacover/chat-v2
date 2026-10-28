// The computer-use overlay: a transparent window over the screen that shows what the assistant
// is doing. A sketched cursor keeps the user company while computer mode is on, following their
// pointer; when the assistant acts, it glides off to each target, draws the marks itself and
// carries a tag saying what it's doing. The window ignores the mouse except over the status bar,
// and screen captures leave it out.
import '../fonts.css'
import './overlay.css'
// Sets --font-ui and --font-reading from the user's Appearance settings, and follows changes.
import '@/lib/appearance.svelte'
import type { Mark, MarkColor, OverlayCommand, OverlayEvent } from '@shared/computer'
import { rng } from '@/lib/sketchy'
import { type Inked, MARKER_ALPHA, MARKERS, PENS, POINTER, type Pt, ink } from './ink'
import { cut, outline } from './pen'

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
/** The cursor's tag: a deeper shade of the accent, so white text on it reads (4.6:1). */
const TAG_FILL = '#cc4a0b'
/** Matches the main process's glide, so the ripple lands as the real click does. */
const GLIDE_MS = 250
/** A drag takes about as long as the helper takes to move through it. */
const DRAG_MS = 400
/** Per mark, as in ANNOTATE_MS / ANNOTATE_MAX_MS in Computer.ts, less a little to finish first. */
const MARK_MS = 1100
const MARKS_MAX_MS = 7600
/** The pause between one mark and the next; a batch's marks share what the pauses leave of MARKS_MAX_MS. */
const BEAT_MS = 80
/** How long a click's ring takes to spread and fade. */
const RING_MS = 480
/** How long a mark's label takes to settle beside it. */
const CHIP_MS = 260
/** How long cleared marks take to fade. */
const FADE_MS = 260
/** Where the sketch cursor sits beside the user's pointer while it follows. */
const BESIDE = { x: 16, y: 18 }
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

/** The user's fonts, read when drawing so a change in Settings shows on the next frame. */
const font = () => getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif'
const loadFonts = () => void document.fonts.load(`600 13px ${font()}`).then(() => {
  fontsChanged()
  wake()
})
addEventListener('storage', () => {
  fontsChanged()
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
/**
 * The screen-wide canvas is full size only while something is drawn on it (marks, ripples, a
 * drag), and empty otherwise. Most of computer mode it has nothing on it, the cursor following
 * the pointer on canvases of its own, and full size it holds a buffer as big as the screen (8 MB
 * at 1080p, 33 MB at 4K). Resizing clears it and resets the context.
 */
const fitCanvas = (inked: boolean) => {
  const w = inked ? Math.round(innerWidth * dpr) : 0
  const h = inked ? Math.round(innerHeight * dpr) : 0
  if (canvas.width === w && canvas.height === h) return
  canvas.width = w
  canvas.height = h
}
const resize = () => {
  dpr = window.devicePixelRatio || 1
  fitCanvas(canvas.width > 0)
  canvas.style.width = `${innerWidth}px`
  canvas.style.height = `${innerHeight}px`
  paintArrow()
  tagKey = ''
  // Labels keep to the visible area, which may have changed.
  for (const d of drawn) d.chip = null
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
/** What the assistant is saying, shown in the cursor's tag above what it's doing (see the `say` event). */
let speech = ''

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

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Drawn {
  ink: Inked
  /** The share of the batch's time this mark gets. */
  budget: number
  /** Planned when the cursor reaches this mark, from wherever it is then. */
  plan: Seg[] | null
  start: number
  /** Where the cursor parks when it is done: clear of the mark and of its label. */
  rest: Pt
  /** Whether the cursor has been put at the end of its route, however the frames fell. */
  landed: boolean
  /** When its last stroke is down: its label goes up beside it then, as the cursor moves off. */
  inked: number
  end: number
  fadeAt: number | null
  /** Where its label sits, worked out once as the cursor sets off to draw it, so it never shifts. */
  chip: Rect | null
  /** Where the label comes from as it goes up (the cursor's tag, when that showed it), and when (0: not yet). */
  chipFrom: Pt | null
  chipAt: number
  /** Its ink as one shape, once whole (see inkPath). */
  path: Path2D | null
}
let drawn: Drawn[] = []

let last = performance.now()
const now = () => performance.now()
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
const easeOut = (t: number) => 1 - (1 - t) ** 3
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
  const color = e.action === 'right' ? PENS.blue : ACCENT
  if (e.action === 'click' || e.action === 'right' || e.action === 'double') ripples.push({ x: e.x, y: e.y, t: t + cursor.dur, color })
  if (e.action === 'double') ripples.push({ x: e.x, y: e.y, t: t + cursor.dur + 130, color })
  wake()
}

const setMarks = (marks: Mark[]) => {
  const keep = new Set(marks.map((m) => m.id))
  const t = now()
  for (const d of drawn) if (!keep.has(d.ink.id) && d.fadeAt === null) d.fadeAt = t
  const known = new Set(drawn.map((d) => d.ink.id))
  const fresh = marks.filter((m) => !known.has(m.id))
  const budget = Math.min(MARK_MS, (MARKS_MAX_MS - BEAT_MS * Math.max(0, fresh.length - 1)) / Math.max(1, fresh.length))
  for (const m of fresh) {
    const inked = ink(m, { w: view.w, h: view.h })
    drawn.push({ ink: inked, budget, plan: null, start: 0, rest: inked.rests[0]!, landed: false, inked: 0, end: 0, fadeAt: null, chip: null, chipFrom: null, chipAt: 0, path: null })
  }
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
const drawnFrom = () => `${state}|${follow}|${driven}|${workLabel}|${hint}|${thinking}|${speech}|${pointer ? `${pointer.x},${pointer.y}` : '-'}`

bridge.onEvent((e) => {
  // The same status or hint again, or the mode as it was, draws nothing new: no frame for it.
  const maybeSame = e.type === 'status' || e.type === 'hint' || e.type === 'mode' || e.type === 'pointer' || e.type === 'say'
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
  else if (e.type === 'frame') {
    Object.assign(view, { dx: e.dx, dy: e.dy, w: e.w, h: e.h })
    for (const d of drawn) d.chip = null
  } else if (e.type === 'hint') hint = e.label
  else if (e.type === 'say') speech = e.text
  else if (e.type === 'pointer') pointer = e.x === null ? null : { x: e.x, y: e.y }
  else if (e.type === 'status' && e.state !== 'off') setStatus(e.state, e.label)
  askForPointer()
  // The user's pointer moves only the cursor, an element of its own: the canvas stays as it is.
  if (e.type === 'pointer') nudge()
  else if (!maybeSame || drawnFrom() !== before) wake()
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

/** The cursor's route over one mark: to each stroke, along it, then to where it rests (or on to the next mark). */
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
    segs.push({ dur: 70 + s.len * 0.85, from: at, to: s.pts[s.pts.length - 1]!, bend: { x: 0, y: 0 }, stroke: i })
    at = s.pts[s.pts.length - 1]!
  })
  // Straight on to the next mark when one is waiting, as a hand would; after the last, off to rest.
  if (!drawn.some((o) => o !== d && o.fadeAt === null && !o.plan)) travel(d.rest)
  // Fit the batch's share of time, so the drawing is done when the main process moves on.
  const total = segs.reduce((sum, s) => sum + s.dur, 0)
  const k = reduced ? 0 : total > d.budget ? d.budget / total : 1
  for (const s of segs) s.dur = Math.max(reduced ? 0 : 16, s.dur * k)
  return segs
}

/** Where the pen is in a mark's plan at `t`: the stroke under it, how much of that is down, and the pen's point. */
const penAt = (d: Drawn, t: number) => {
  let elapsed = t - d.start
  let upTo = -1
  let part = 1
  let at: Pt = d.plan![0]?.from ?? d.rest
  for (const s of d.plan!) {
    if (elapsed >= s.dur) {
      elapsed -= s.dur
      if (s.stroke !== null) {
        upTo = s.stroke
        part = 1
      }
      at = s.to
      continue
    }
    const k = s.dur ? elapsed / s.dur : 1
    if (s.stroke !== null) {
      upTo = s.stroke
      part = easeSine(k)
      const stroke = d.ink.strokes[s.stroke]!
      const pts = cut(stroke.pts, stroke.len * part)
      at = pts[pts.length - 1]!
    } else at = along(s.from, s.to, s.bend, ease(k))
    break
  }
  return { upTo, part, at }
}

/** Adds a closed outline to a path, smoothed through the middles of its edges. */
const trace = (path: Path2D, pts: Pt[]) => {
  const n = pts.length
  if (n < 3) return
  const start = { x: (pts[n - 1]!.x + pts[0]!.x) / 2, y: (pts[n - 1]!.y + pts[0]!.y) / 2 }
  path.moveTo(start.x, start.y)
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % n]!
    path.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2)
  }
  path.closePath()
}

/** A highlighter's ends are squarer than a pen's. */
const MARKER_FLAT = 0.45

/**
 * A mark's ink as one shape: the strokes before the pen whole, the one under it up to `part`.
 * As one shape, where its strokes cross (an arrowhead on its shaft) the ink and its shadow go
 * down once, and a highlighter's rows don't darken where they overlap.
 */
const inkPath = (d: Drawn, upTo: number, part: number): Path2D => {
  const path = new Path2D()
  d.ink.strokes.forEach((s, i) => {
    if (i > upTo) return
    trace(path, outline(i === upTo && part < 1 ? cut(s.pts, s.len * part) : s.pts, s.marker ? MARKER_FLAT : 1))
  })
  return path
}

/**
 * Ink reads on light and dark screens alike without an outline round it: a soft, tight shadow
 * lifts it off a light screen, and black ink, which a dark screen would swallow, has a fine light
 * edge underneath instead, like a line pressed into the screen (on a light one it disappears). A
 * highlighter's band is translucent and casts nothing.
 */
const paintInk = (d: Drawn, path: Path2D) => {
  ctx.save()
  if (d.ink.strokes[0]?.marker) {
    ctx.globalAlpha *= MARKER_ALPHA[d.ink.color]
    ctx.fillStyle = MARKERS[d.ink.color]
  } else if (d.ink.color === 'black') {
    ctx.shadowColor = 'rgba(255,255,255,0.7)'
    ctx.shadowBlur = 1 * dpr
    ctx.shadowOffsetY = 1 * dpr
    ctx.fillStyle = PENS.black
  } else {
    ctx.shadowColor = 'rgba(0,0,0,0.24)'
    ctx.shadowBlur = 2.5 * dpr
    ctx.shadowOffsetY = 1 * dpr
    ctx.fillStyle = PENS[d.ink.color]
  }
  ctx.fill(path)
  ctx.restore()
}

// --- Tags ----------------------------------------------------------------------------------

interface Layout {
  lines: string[]
  w: number
  h: number
  /** What the assistant is saying, above `lines` (the cursor's tag only). */
  say?: string[]
}

const TAG = { size: 13, line: 17, padX: 10, padY: 6.5, maxW: 300 }
/** What the assistant says: in its own words, so plainer than the step under it, and its latest lines only. */
const SAY = { size: 13.5, line: 19, maxW: 360, lines: 4, gap: 5 }
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

/** The latest speech, wrapped: one at a time, since it changes as it streams. */
let sayLayout = { key: '', lines: [] as string[], w: 0 }

/** Wraps what the assistant says to SAY.lines, keeping its end: that's what it is saying now. */
const layoutSay = (text: string) => {
  if (sayLayout.key === text) return sayLayout
  ctx.font = `500 ${SAY.size}px ${font()}`
  const room = SAY.maxW - TAG.padX * 2
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
  const kept = lines.slice(-SAY.lines)
  if (lines.length > SAY.lines && !kept[0]!.startsWith('…')) {
    // The ellipsis takes room at the start: words go from the front, so the line still runs into the next.
    let first = kept[0]!
    while (ctx.measureText(`…${first}`).width > room && first.includes(' ')) first = first.slice(first.indexOf(' ') + 1)
    kept[0] = `…${first}`
  }
  for (let i = 0; i < kept.length; i++) {
    while (ctx.measureText(kept[i]!).width > room && kept[i]!.length > 2) kept[i] = `${kept[i]!.slice(0, -2)}…`
  }
  const w = kept.length ? Math.max(...kept.map((l) => ctx.measureText(l).width)) : 0
  sayLayout = { key: text, lines: kept, w }
  return sayLayout
}

/** The cursor's tag: what the assistant says, if anything, over what it's doing (`action`, beside a spinner while `deciding`). */
const cursorLayout = (said: string, action: string, deciding: boolean): Layout => {
  const act = action ? layoutTag(action) : { lines: [], w: 0, h: 0 }
  const actW = act.lines.length ? act.w + (deciding ? SPIN_W : 0) : 0
  if (!said) return { ...act, w: actW }
  const say = layoutSay(said)
  const sayH = say.lines.length * SAY.line
  return {
    lines: act.lines,
    say: say.lines,
    w: Math.ceil(Math.max(actW, say.w + TAG.padX * 2)),
    h: Math.ceil(TAG.padY * 2 + sayH + (act.lines.length ? SAY.gap + act.lines.length * TAG.line : 0))
  }
}

/** Room a mark's colour dot takes at the start of its label. */
const DOT_W = 13
/** How far a label keeps from its mark. */
const GAP = 6

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/** The pointer's body, resting with its tip at a point. */
const pointerAt = (p: Pt): Rect => ({ x: p.x - 2, y: p.y - 2, w: 18, h: 21 })

/**
 * Where a mark's label goes: snug under the mark's left edge, else further along under it, else
 * above it, else beside it, whichever first stays on screen clear of the other labels and marks.
 * An arrow's label sits off its tail; a text mark is its label, at its point.
 */
const placeChip = (d: Drawn): Rect => {
  const v = visible()
  const layout = layoutTag(d.ink.label ?? '')
  const [w, h] = [layout.w + DOT_W, layout.h]
  const b = d.ink.box
  const fit = (x: number, y: number): Rect => ({ x: Math.max(v.x0, Math.min(x, v.x1 - w)), y: Math.max(v.y0, Math.min(y, v.y1 - h)), w, h })
  const blocks: Rect[] = []
  // Its own mark too: pushed back on screen at an edge, a label mustn't land on what it labels.
  for (const o of drawn) {
    if (o.fadeAt !== null) continue
    if (o.chip && o !== d) blocks.push(o.chip)
    // What an arrow points at matters; the empty corners of its box don't.
    if (o.ink.arrow) blocks.push({ x: o.ink.arrow.to.x - 12, y: o.ink.arrow.to.y - 12, w: 24, h: 24 })
    // A box's edges take in the pen's width and wobble: a label may graze them.
    else if (o.ink.kind !== 'text') blocks.push({ x: o.ink.box.x + 2, y: o.ink.box.y + 2, w: o.ink.box.w - 4, h: o.ink.box.h - 4 })
  }
  let tries: Rect[]
  if (d.ink.kind === 'text') tries = [fit(b.x, b.y)]
  else if (d.ink.arrow) {
    const { from: at, to } = d.ink.arrow
    const len = dist(at, to) || 1
    const away = { x: (at.x - to.x) / len, y: (at.y - to.y) / len }
    // Its middle off the tail, as far out as half the label is long that way, plus a gap.
    const reach = (Math.abs(away.x) * w) / 2 + (Math.abs(away.y) * h) / 2 + GAP
    tries = [fit(at.x + away.x * reach - w / 2, at.y + away.y * reach - h / 2), fit(at.x - w / 2, at.y + GAP + 4), fit(at.x - w / 2, at.y - h - GAP - 4)]
  } else {
    // A ring curves away from its box's corners, so its label starts a little in, under the ring.
    const x = d.ink.kind === 'circle' ? b.x + b.w * 0.16 : b.x
    const [below, above] = [b.y + b.h + GAP, b.y - h - GAP]
    // Under its left edge; else slid along to just past a neighbouring label, while still under it.
    const slid = (y: number) => [x, ...blocks.filter((o) => o.y < y + h && o.y + o.h > y).map((o) => o.x + o.w + GAP).filter((v) => v > x && v <= b.x + b.w * 0.6)]
    tries = [...slid(below).map((v) => fit(v, below)), ...slid(above).map((v) => fit(v, above)), fit(b.x + b.w + GAP, b.y + b.h / 2 - h / 2), fit(b.x - w - GAP, b.y + b.h / 2 - h / 2)]
  }
  let best = tries[0]!
  let least = Infinity
  for (const r of tries) {
    const cost = blocks.reduce((sum, o) => sum + overlap(r, o), 0)
    if (cost < least) {
      best = r
      least = cost
    }
    if (!cost) break
  }
  return best
}

/** Which corner of the cursor's tag sits by the pointer: that corner is tucked in, as on a speech bubble. */
type Corner = 'tl' | 'tr' | 'bl' | 'br'
/** Where the cursor's tag hangs off the pointer's tip, below and right, clear of the arrowhead. */
const TAG_AT = { x: 11, y: 18 }

/**
 * The cursor's tag hangs off the pointer below and to the right, as a collaborator's name does
 * in a design tool, or on whichever other side keeps it on screen and clear of the marks' labels.
 */
const placeCursorTag = (at: Pt, size: { w: number; h: number }, taken: Rect[]): { rect: Rect; corner: Corner } => {
  const v = visible()
  const tries: Array<{ x: number; y: number; corner: Corner }> = [
    { x: at.x + TAG_AT.x, y: at.y + TAG_AT.y, corner: 'tl' },
    { x: at.x - size.w - 4, y: at.y + TAG_AT.y - 6, corner: 'tr' },
    { x: at.x + TAG_AT.x, y: at.y - size.h - 6, corner: 'bl' },
    { x: at.x - size.w - 4, y: at.y - size.h - 6, corner: 'br' }
  ]
  const rect = (p: { x: number; y: number }): Rect => ({ x: p.x, y: p.y, w: size.w, h: size.h })
  const inside = (r: Rect) => r.x >= v.x0 && r.y >= v.y0 && r.x + r.w <= v.x1 && r.y + r.h <= v.y1
  const pick = tries.find((p) => inside(rect(p)) && !taken.some((o) => overlap(rect(p), o) > 0)) ?? tries.find((p) => inside(rect(p))) ?? tries[0]!
  // Last, whatever happened above: wholly on screen. A tag wider than the screen starts at its left.
  const r = rect(pick)
  r.x = Math.max(v.x0, Math.min(r.x, v.x1 - r.w))
  r.y = Math.max(v.y0, Math.min(r.y, v.y1 - r.h))
  return { rect: r, corner: pick.corner }
}

/** Room a spinner takes at the start of a tag. */
const SPIN_W = 18

/** A small spinning arc, for the tag while the model decides. */
const drawSpinner = (c: CanvasRenderingContext2D, cx: number, cy: number, t: number) => {
  c.save()
  c.lineCap = 'round'
  c.lineWidth = 2
  c.strokeStyle = 'rgba(255,255,255,0.3)'
  c.beginPath()
  c.arc(cx, cy, 5.5, 0, Math.PI * 2)
  c.stroke()
  const a = reduced ? 0 : (t / 900) * Math.PI * 2
  c.strokeStyle = '#ffffff'
  c.beginPath()
  c.arc(cx, cy, 5.5, a, a + Math.PI * 0.6)
  c.stroke()
  c.restore()
}

/** A rounded rectangle with one corner tucked in, that corner pointing at whatever the tag belongs to. */
const bubble = (c: CanvasRenderingContext2D, r: Rect, radius: number, tucked?: Corner) => {
  const t = 3.5
  c.beginPath()
  c.roundRect(r.x, r.y, r.w, r.h, [tucked === 'tl' ? t : radius, tucked === 'tr' ? t : radius, tucked === 'br' ? t : radius, tucked === 'bl' ? t : radius])
}

/**
 * The cursor's tag: the accent, solid, with crisp white text, so it reads over any app and is
 * plainly the assistant's. With `spin`, a spinner leads the text.
 */
const drawCursorTag = (c: CanvasRenderingContext2D, rect: Rect, layout: Layout, corner: Corner, spin?: number) => {
  c.save()
  c.shadowColor = 'rgba(0,0,0,0.26)'
  c.shadowBlur = 12 * dpr
  c.shadowOffsetY = 3 * dpr
  c.fillStyle = TAG_FILL
  bubble(c, rect, 10, corner)
  c.fill()
  c.shadowColor = 'transparent'
  // A hairline of light along the inside, as on a pressed button.
  c.strokeStyle = 'rgba(255,255,255,0.16)'
  c.lineWidth = 1
  bubble(c, { x: rect.x + 0.5, y: rect.y + 0.5, w: rect.w - 1, h: rect.h - 1 }, 9.5, corner)
  c.stroke()
  c.textAlign = 'left'
  c.textBaseline = 'middle'
  let top = rect.y + TAG.padY
  if (layout.say?.length) {
    c.font = `500 ${SAY.size}px ${font()}`
    c.fillStyle = '#ffffff'
    layout.say.forEach((l, i) => c.fillText(l, rect.x + TAG.padX, top + SAY.line * (i + 0.5) + 0.5))
    top += layout.say.length * SAY.line + SAY.gap
  }
  if (spin !== undefined && layout.lines.length) drawSpinner(c, rect.x + TAG.padX + 5.5, top + TAG.line / 2, spin)
  const tx = rect.x + TAG.padX + (spin !== undefined ? SPIN_W : 0)
  c.font = `600 ${TAG.size}px ${font()}`
  // Under what it says, what it's doing is the smaller news.
  c.fillStyle = layout.say?.length ? 'rgba(255,255,255,0.74)' : '#ffffff'
  layout.lines.forEach((l, i) => c.fillText(l, tx, top + TAG.line * (i + 0.5) + 0.5))
  c.restore()
}

/** A mark's label: a quiet dark tag, led by a dot of the mark's colour so it reads as that mark's. */
const drawChip = (c: CanvasRenderingContext2D, rect: Rect, layout: Layout, color: MarkColor, alpha: number) => {
  if (alpha <= 0.01) return
  c.save()
  c.globalAlpha = alpha
  c.shadowColor = 'rgba(0,0,0,0.22)'
  c.shadowBlur = 10 * dpr
  c.shadowOffsetY = 2 * dpr
  c.fillStyle = 'rgba(28,28,31,0.94)'
  bubble(c, rect, 7)
  c.fill()
  c.shadowColor = 'transparent'
  c.strokeStyle = 'rgba(255,255,255,0.1)'
  c.lineWidth = 1
  bubble(c, { x: rect.x + 0.5, y: rect.y + 0.5, w: rect.w - 1, h: rect.h - 1 }, 6.5)
  c.stroke()
  const dot = { x: rect.x + TAG.padX + 3.5, y: rect.y + TAG.padY + TAG.line / 2 }
  c.beginPath()
  c.arc(dot.x, dot.y, 3.5, 0, Math.PI * 2)
  c.fillStyle = PENS[color]
  c.fill()
  if (color === 'black') {
    // Black ink on a dark tag: a fine light ring shows the dot.
    c.strokeStyle = 'rgba(255,255,255,0.6)'
    c.lineWidth = 1
    c.stroke()
  }
  c.textAlign = 'left'
  c.textBaseline = 'middle'
  c.font = `600 ${TAG.size}px ${font()}`
  c.fillStyle = '#fafaf9'
  layout.lines.forEach((l, i) => c.fillText(l, rect.x + TAG.padX + DOT_W, rect.y + TAG.padY + TAG.line * (i + 0.5) + 0.5))
  c.restore()
}

// --- The pointer ---------------------------------------------------------------------------

/** The assistant's pointer: a crisp arrowhead in the accent, edged in white and lifted by a soft shadow, so it shows on anything. */
const drawPointer = (c: CanvasRenderingContext2D, x: number, y: number) => {
  c.save()
  c.beginPath()
  c.moveTo(x + POINTER[0]!.x, y + POINTER[0]!.y)
  for (const p of POINTER.slice(1)) c.lineTo(x + p.x, y + p.y)
  c.closePath()
  c.lineJoin = 'round'
  c.shadowColor = 'rgba(0,0,0,0.3)'
  c.shadowBlur = 4 * dpr
  c.shadowOffsetY = 1.5 * dpr
  c.strokeStyle = '#ffffff'
  c.lineWidth = 2.5
  c.stroke()
  c.shadowColor = 'transparent'
  c.fillStyle = ACCENT
  c.fill()
  c.restore()
}

// --- The cursor's elements ---------------------------------------------------------------

/**
 * The cursor and its tag are small canvases of their own, moved with a CSS transform. Following
 * the user's pointer then moves two layers in the compositor rather than repainting a canvas the
 * size of the screen, which every frame of the cursor cost while it was drawn on that canvas.
 */
const element = () => {
  const el = document.createElement('canvas')
  el.className = 'cursor'
  el.hidden = true
  document.body.insertBefore(el, pill)
  return el
}
const arrow = element()
const tagEl = element()
const arrowCtx = arrow.getContext('2d')!
const tagCtx = tagEl.getContext('2d')!
/** Room around the arrowhead and a tag for their outline and shadow. */
const ARROW_PAD = 9
const ARROW_BOX = { w: 14 + ARROW_PAD * 2, h: 17 + ARROW_PAD * 2 }
const TAG_PAD = 20

function paintArrow() {
  arrow.width = Math.round(ARROW_BOX.w * dpr)
  arrow.height = Math.round(ARROW_BOX.h * dpr)
  arrow.style.width = `${ARROW_BOX.w}px`
  arrow.style.height = `${ARROW_BOX.h}px`
  arrowCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawPointer(arrowCtx, ARROW_PAD, ARROW_PAD)
}

/** What the tag canvas shows, so it is painted again only when that changes. */
let tagKey = ''
function fontsChanged() {
  layouts.clear()
  tagKey = ''
  // Labels are measured in the font, so they're placed again.
  for (const d of drawn) d.chip = null
}

const paintTag = (layout: Layout, text: string, corner: Corner, spin: number | undefined) => {
  const key = `${text}|${layout.say?.join('\n') ?? ''}|${layout.w}x${layout.h}|${corner}|${spin ?? ''}`
  if (key === tagKey) return
  tagKey = key
  const w = layout.w + TAG_PAD * 2
  const h = layout.h + TAG_PAD * 2
  if (tagEl.width !== Math.round(w * dpr) || tagEl.height !== Math.round(h * dpr)) {
    tagEl.width = Math.round(w * dpr)
    tagEl.height = Math.round(h * dpr)
    tagEl.style.width = `${w}px`
    tagEl.style.height = `${h}px`
  }
  tagCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  tagCtx.clearRect(0, 0, w, h)
  drawCursorTag(tagCtx, { x: TAG_PAD, y: TAG_PAD, w: layout.w, h: layout.h }, layout, corner, spin)
}

/** Writes a style only when it changes, so a still cursor costs no style work. */
const styled = new WeakMap<HTMLElement, { transform: string; opacity: string; hidden: boolean }>()
const place = (el: HTMLCanvasElement, x: number, y: number, alpha: number) => {
  const was = styled.get(el) ?? { transform: '', opacity: '', hidden: true }
  const hidden = alpha <= 0.01
  if (hidden !== was.hidden) el.hidden = hidden
  if (hidden) return styled.set(el, { ...was, hidden })
  // On whole device pixels, so the tag's text stays crisp.
  const px = (v: number) => Math.round(v * dpr) / dpr
  const transform = `translate(${px(x - view.dx)}px, ${px(y - view.dy)}px)`
  const opacity = alpha >= 0.99 ? '1' : alpha.toFixed(3)
  if (transform !== was.transform) el.style.transform = transform
  if (opacity !== was.opacity) el.style.opacity = opacity
  styled.set(el, { transform, opacity, hidden })
}

// --- Frames --------------------------------------------------------------------------------

/**
 * A turning spinner is the one thing that animates for whole model calls, so on its own it gets
 * about 15 frames a second, each repainting only the tag it sits in.
 */
const SPIN_FRAME_MS = 66

let frame = 0
/** Whether the next frame repaints the screen-wide canvas (see wake), not only moves the cursor (see nudge). */
let sceneDirty = true
let spinTimer: ReturnType<typeof setTimeout> | 0 = 0
/** Where the finished marks' labels sat in the last repaint, so the cursor's tag keeps clear of them between repaints. */
let chipRects: Rect[] = []
/** What the cursor's tag showed last frame, and where: a mark's label goes up from there when the mark is done. */
let lastTag: { text: string; at: Pt } | null = null

const render = () => {
  frame = 0
  const t = now()
  const dt = Math.min(64, t - last)
  last = t
  const full = sceneDirty
  sceneDirty = false
  /** More frames to come for the cursor alone; `sceneBusy`, for the canvas as well. */
  let busy = false
  let sceneBusy = false
  let pen: Pt | null = null
  let penTag: string | null = null
  const chips: Array<{ d: Drawn; alpha: number }> = []

  if (full) {
    // Something to draw (marks, or a ring that has started and not yet faded, or a drag): full size (see fitCanvas).
    if (drawn.some((d) => d.fadeAt === null || t - d.fadeAt < FADE_MS) || ripples.some((p) => t >= p.t && t - p.t < RING_MS) || dragFrom) fitCanvas(true)
    // Display coordinates: the window may sit offset from the display's corner.
    ctx.setTransform(dpr, 0, 0, dpr, -view.dx * dpr, -view.dy * dpr)
    ctx.clearRect(view.dx, view.dy, innerWidth, innerHeight)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Marks, in order: the cursor draws each in turn, its label goes up beside it, and the cursor moves off.
    drawn = drawn.filter((d) => d.fadeAt === null || t - d.fadeAt < FADE_MS)
    let ready = t
    for (const d of drawn) {
      if (d.fadeAt === null && !d.plan) {
        // Its turn: plan the route from where the cursor is now.
        if (ready > t) break
        // Its label's place first, then a place to rest that leaves the label clear and the pointer on screen.
        if (d.ink.label) d.chip ??= placeChip(d)
        const chip = d.chip
        // A text mark's pointer rests at its tag's lower left, as if it had just written it, else beside it.
        const rests = d.ink.kind === 'text' && chip ? [{ x: chip.x - 2, y: chip.y + chip.h + 1 }, { x: chip.x - 18, y: chip.y + 2 }, { x: chip.x + chip.w + 4, y: chip.y + 2 }] : d.ink.rests
        const clear = (p: Pt) => !chip || !overlap(pointerAt(p), chip)
        const v = visible(0)
        const seen = (p: Pt) => p.x - 2 >= v.x0 && p.y - 2 >= v.y0 && p.x + 16 <= v.x1 && p.y + 19 <= v.y1
        d.rest = rests.find((p) => clear(p) && seen(p)) ?? rests.find(clear) ?? rests[0]!
        const first = d.ink.strokes[0]?.pts[0] ?? d.rest
        const from = cursor.alpha > 0.05 ? { x: cursor.x, y: cursor.y } : { x: first.x - 50, y: first.y - 40 }
        d.plan = planMark(d, from)
        d.start = t
        d.end = t + d.plan.reduce((sum, s) => sum + s.dur, 0)
        // Up to the end of its last stroke; a text mark, with none, is done when the cursor gets there.
        const lastStroke = d.plan.map((s) => s.stroke !== null).lastIndexOf(true)
        d.inked = lastStroke < 0 ? d.end : t + d.plan.slice(0, lastStroke + 1).reduce((sum, s) => sum + s.dur, 0)
      }
      if (!d.plan) continue
      ctx.save()
      const fade = d.fadeAt === null ? 1 : Math.max(0, 1 - (t - d.fadeAt) / FADE_MS)
      if (fade < 1) sceneBusy = true
      ctx.globalAlpha = fade
      const moving = d.fadeAt === null && t < d.end
      const step = moving ? penAt(d, t) : null
      if (d.fadeAt === null && t < d.inked && step) {
        sceneBusy = true
        if (step.upTo >= 0) paintInk(d, inkPath(d, step.upTo, step.part))
        if (d.ink.label) penTag = d.ink.label
      } else {
        paintInk(d, (d.path ??= inkPath(d, d.ink.strokes.length, 1)))
        if (d.ink.label) chips.push({ d, alpha: fade })
      }
      ctx.restore()
      if (step) {
        sceneBusy = true
        pen = step.at
      } else if (d.fadeAt === null && !d.landed) {
        // Its route is over: the cursor ends exactly where it leads, not where the last frame left it.
        d.landed = true
        pen = d.plan[d.plan.length - 1]?.to ?? d.rest
      }
      // The next mark waits for this one, with a beat between them.
      ready = d.fadeAt === null ? d.end + BEAT_MS : ready
      if (pen) break
    }
    // Marks still waiting their turn keep the frames coming.
    if (drawn.some((d) => d.fadeAt === null && !d.plan)) sceneBusy = true
  }

  // Where the cursor goes: the pen, a glide, beside the user's pointer, or where it was left.
  const following = !driven && pointer !== null && (follow || state === 'working')
  if (pen) {
    cursor.x = pen.x
    cursor.y = pen.y
    cursor.to = { ...pen }
    cursor.dur = 0
  } else if (driven && cursor.dur && t - cursor.t0 < cursor.dur) {
    // A glide moves only the cursor's elements; the canvas stays as it is.
    const k = Math.min(1, (t - cursor.t0) / cursor.dur)
    const p = along(cursor.from, cursor.to, cursor.bend, ease(k))
    cursor.x = p.x
    cursor.y = p.y
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

  if (full) {
    if (dragFrom && cursor.alpha > 0) {
      // A drag leaves a dotted line back to where it began.
      ctx.save()
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 2.2
      ctx.setLineDash([0.1, 6])
      ctx.beginPath()
      ctx.moveTo(dragFrom.x, dragFrom.y)
      ctx.lineTo(cursor.x, cursor.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(dragFrom.x, dragFrom.y, 3.5, 0, Math.PI * 2)
      ctx.fillStyle = ACCENT
      ctx.fill()
      ctx.restore()
      // While the cursor moves, the line follows it frame by frame.
      if (busy) sceneBusy = true
    }

    // Click rings: one clean ring that spreads and fades from the point, two for a double click.
    ripples = ripples.filter((p) => t - p.t < RING_MS)
    for (const p of ripples) {
      const k = (t - p.t) / RING_MS
      sceneBusy = true
      if (k < 0) continue
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.2)'
      ctx.shadowBlur = 2 * dpr
      ctx.shadowOffsetY = 0.5 * dpr
      ctx.strokeStyle = p.color
      ctx.globalAlpha = (1 - k) ** 1.5
      ctx.lineWidth = 2.4 - k * 1.1
      ctx.beginPath()
      ctx.arc(p.x, p.y, reduced ? 14 : 4 + easeOut(k) * 16, 0, Math.PI * 2)
      ctx.stroke()
      // The press itself: a soft dot that's gone before the ring is half out.
      if (k < 0.4) {
        ctx.shadowColor = 'transparent'
        ctx.globalAlpha = 0.32 * (1 - k / 0.4)
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // The finished marks' labels: each goes up once, snug beside its mark, and stays put.
    chipRects = []
    for (const { d, alpha } of chips) {
      const layout = layoutTag(d.ink.label!)
      d.chip ??= placeChip(d)
      if (!d.chipAt) {
        d.chipAt = t
        // From the cursor's tag, when that showed this label and isn't far off.
        d.chipFrom = lastTag && lastTag.text === d.ink.label && dist(lastTag.at, d.chip) < 240 ? lastTag.at : null
      }
      const k = reduced ? 1 : Math.min(1, (t - d.chipAt) / CHIP_MS)
      if (k < 1) sceneBusy = true
      const e = easeOut(k)
      const from = d.chipFrom ?? { x: d.chip.x, y: d.chip.y + 5 }
      const rect = { ...d.chip, x: from.x + (d.chip.x - from.x) * e, y: from.y + (d.chip.y - from.y) * e }
      chipRects.push(d.chip)
      drawChip(ctx, rect, layout, d.ink.color, alpha * (d.chipFrom ? 0.4 + 0.6 * e : e))
    }
    // Nothing on it any more: the canvas lets its buffer go until something is (see fitCanvas).
    if (!drawn.length && !ripples.length && !(dragFrom && cursor.alpha > 0)) fitCanvas(false)
  } else if (ripples.length || dragFrom) {
    // A ring to come, or a drag line to follow the cursor: the canvas changes next frame.
    sceneBusy = true
  }

  // The cursor and its tag.
  place(arrow, cursor.x - ARROW_PAD, cursor.y - ARROW_PAD, cursor.alpha)
  const deciding = penTag === null && thinking !== null && (state === 'working' || !driven)
  const text = cursor.alpha > 0.01 ? (penTag ?? (deciding ? thinking : state === 'working' ? workLabel : !driven ? hint : '')) : ''
  // What the assistant says goes with the cursor wherever it is, a mark it's drawing included.
  const said = cursor.alpha > 0.01 ? speech : ''
  const spinning = !!text && deciding && !reduced
  if (text || said) {
    const layout = cursorLayout(said, text ?? '', deciding)
    const { rect, corner } = placeCursorTag(cursor, layout, chipRects)
    paintTag(layout, text ?? '', corner, deciding ? (spinning ? t : 0) : undefined)
    place(tagEl, rect.x - TAG_PAD, rect.y - TAG_PAD, cursor.alpha)
    lastTag = { text: text ?? '', at: { x: rect.x, y: rect.y } }
  } else {
    place(tagEl, 0, 0, 0)
    lastTag = null
  }

  if (sceneBusy) sceneDirty = true
  if (busy || sceneBusy) schedule()
  else if (spinning) spinLater()
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render)
}

/** Repaints the screen-wide canvas on the next frame. */
function wake() {
  sceneDirty = true
  schedule()
}

/** Moves the cursor on the next frame, leaving the canvas as it is. */
function nudge() {
  schedule()
}

/** Turns the spinner a step, a moment from now, unless a frame comes first. */
function spinLater() {
  if (spinTimer) return
  spinTimer = setTimeout(() => {
    spinTimer = 0
    schedule()
  }, SPIN_FRAME_MS)
}

resize()
loadFonts()
