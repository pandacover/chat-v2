// Mood boards: the model writes shots as JSON inside <artifact type="moodboard">,
// and the app lays them out on a canvas the user can edit by hand.

export interface ShotSpec {
  id: string
  title: string
  /** What the sketch shows: composition, framing, subject, light. Never text. */
  sketch: string
  /** How to get the shot, in order. */
  steps: string[]
}

export interface MoodboardSpec {
  /** Look shared by every sketch, e.g. "neon noir, rain, high contrast". */
  style: string
  shots: ShotSpec[]
  /** Loose notes that belong to no shot (palette, references, mood words). */
  notes: string[]
}

export interface ShotItem {
  kind: 'shot'
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  sketch: string
  /** Bumped by "Redraw" so the sketch is generated again. */
  variant: number
}

export interface NoteItem {
  kind: 'note'
  id: string
  x: number
  y: number
  w: number
  text: string
  /** Steps point at their shot with an arrow; free notes have none. */
  shotId: string | null
}

export type BoardItem = ShotItem | NoteItem

/** The editable canvas. Items draw in array order; a shot's steps are numbered in that order too. */
export interface BoardDoc {
  version: 1
  style: string
  items: BoardItem[]
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : [])

/** Reads the model's JSON leniently; null when there is no usable shot. */
export const parseMoodboard = (json: string): MoodboardSpec | null => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(raw) ? raw : Array.isArray(obj.shots) ? obj.shots : []
  const seen = new Set<string>()
  const shots: ShotSpec[] = []
  list.forEach((s, i) => {
    const shot = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
    const sketch = text(shot.sketch) || text(shot.description) || text(shot.prompt)
    const title = text(shot.title) || text(shot.name)
    if (!sketch && !title) return
    let id = text(shot.id) || `shot-${i + 1}`
    while (seen.has(id)) id = `${id}-${i + 1}`
    seen.add(id)
    shots.push({ id, title: title || `Shot ${shots.length + 1}`, sketch: sketch || title, steps: texts(shot.steps) })
  })
  if (shots.length === 0) return null
  return { style: text(obj.style), shots, notes: texts(obj.notes) }
}

/** Board → the JSON format the model writes, so it sees the user's edits in later turns. */
export const docToSpec = (doc: BoardDoc): MoodboardSpec => {
  const shots = doc.items.filter((i): i is ShotItem => i.kind === 'shot')
  const notes = doc.items.filter((i): i is NoteItem => i.kind === 'note')
  return {
    style: doc.style,
    shots: shots.map((s) => ({
      id: s.id,
      title: s.title,
      sketch: s.sketch,
      steps: notes.filter((n) => n.shotId === s.id).map((n) => n.text)
    })),
    notes: notes.filter((n) => n.shotId === null || !shots.some((s) => s.id === n.shotId)).map((n) => n.text)
  }
}

export const specToJson = (spec: MoodboardSpec): string => JSON.stringify(spec, null, 2)

// Layout, in canvas units. Sketches are 16:9.
export const SHOT_W = 480
export const SHOT_H = 270
export const NOTE_W = 300
/** Space above a shot's frame for its title. */
export const TITLE_SPACE = 44
const ARROW_GAP = 120
const NOTE_GAP = 26
const COL_GAP = 150
const ROW_GAP = 130

/** A rough height for a note before the renderer has measured it. */
export const estimateNoteHeight = (text: string, w = NOTE_W) => {
  const perLine = Math.max(8, Math.floor(w / 10.5))
  const lines = text.split('\n').reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0)
  return lines * 28 + 8
}

let counter = 0
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** Columns that let the grid fill a viewport of this width/height ratio at the largest zoom. */
const bestColumns = (count: number, aspect: number) => {
  const cellW = SHOT_W + ARROW_GAP + NOTE_W + COL_GAP
  const cellH = TITLE_SPACE + SHOT_H + ROW_GAP
  let best = 1
  let bestScale = 0
  for (let c = 1; c <= Math.min(4, count); c++) {
    const w = c * cellW - COL_GAP
    const h = Math.ceil(count / c) * cellH - ROW_GAP
    const scale = Math.min(aspect / w, 1 / h)
    // Ties go to fewer columns, which read top to bottom like a shot list.
    if (scale > bestScale * 1.05) {
      best = c
      bestScale = scale
    }
  }
  return best
}

/**
 * Places each shot in a grid with its steps stacked to its right, under a row of free notes.
 * Shots and steps that existed on `previous` keep their positions there.
 * `aspect` is the viewport's width/height, used to pick the number of columns.
 */
export const layoutBoard = (spec: MoodboardSpec, previous: BoardDoc | null = null, aspect = 1.6): BoardDoc => {
  const prevShots = new Map<string, ShotItem>()
  const prevSteps = new Map<string, NoteItem[]>()
  for (const item of previous?.items ?? []) {
    if (item.kind === 'shot') prevShots.set(item.id, item)
    else if (item.shotId) prevSteps.set(item.shotId, [...(prevSteps.get(item.shotId) ?? []), item])
  }

  const cols = bestColumns(spec.shots.length, aspect)
  const cellW = SHOT_W + ARROW_GAP + NOTE_W + COL_GAP
  const gridW = Math.max(cellW - COL_GAP, cols * cellW - COL_GAP)
  const items: BoardItem[] = []

  // Free notes (palette, mood words) sit in a row above the shots.
  const stickyW = NOTE_W - 40
  let nx = 0
  let ny = 0
  let lineH = 0
  for (const t of spec.notes) {
    if (nx > 0 && nx + stickyW > gridW) {
      nx = 0
      ny += lineH + 30
      lineH = 0
    }
    items.push({ kind: 'note', id: newId('note'), x: nx, y: ny, w: stickyW, text: t, shotId: null })
    lineH = Math.max(lineH, estimateNoteHeight(t, stickyW) + 24)
    nx += stickyW + 40
  }

  let rowTop = spec.notes.length > 0 ? ny + lineH + 70 : 0
  for (let start = 0; start < spec.shots.length; start += cols) {
    const row = spec.shots.slice(start, start + cols)
    const stepHeights = row.map((s) => s.steps.reduce((h, t) => h + estimateNoteHeight(t) + NOTE_GAP, -NOTE_GAP))
    const rowH = Math.max(TITLE_SPACE + SHOT_H, ...stepHeights.map((h) => h + 20))
    row.forEach((shot, c) => {
      const old = prevShots.get(shot.id)
      const x = old?.x ?? c * cellW
      const y = old?.y ?? rowTop + TITLE_SPACE
      const w = old?.w ?? SHOT_W
      const h = old?.h ?? SHOT_H
      items.push({ kind: 'shot', id: shot.id, x, y, w, h, title: shot.title, sketch: shot.sketch, variant: old?.sketch === shot.sketch ? old.variant : 0 })
      const oldSteps = prevSteps.get(shot.id) ?? []
      let sy = y + h / 2 - stepHeights[c]! / 2
      shot.steps.forEach((t, i) => {
        const kept = oldSteps[i]
        items.push({ kind: 'note', id: newId('step'), x: kept?.x ?? x + w + ARROW_GAP, y: kept?.y ?? sy, w: kept?.w ?? NOTE_W, text: t, shotId: shot.id })
        sy += estimateNoteHeight(t) + NOTE_GAP
      })
    })
    rowTop += rowH + ROW_GAP
  }
  return { version: 1, style: spec.style, items }
}

/** Reads a saved board, dropping anything malformed. */
export const parseBoardDoc = (raw: unknown): BoardDoc | null => {
  const obj = (raw && typeof raw === 'object' ? raw : null) as Partial<BoardDoc> | null
  if (!obj || obj.version !== 1 || !Array.isArray(obj.items)) return null
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  const items = obj.items.filter(
    (i): i is BoardItem =>
      !!i &&
      typeof i.id === 'string' &&
      num(i.x) &&
      num(i.y) &&
      num(i.w) &&
      ((i.kind === 'shot' && num(i.h) && typeof i.title === 'string' && typeof i.sketch === 'string') ||
        (i.kind === 'note' && typeof i.text === 'string'))
  )
  return { version: 1, style: typeof obj.style === 'string' ? obj.style : '', items }
}

/**
 * The image prompt for one shot. Small image models draw text badly, so the
 * sketch carries no words; titles and steps are drawn on the canvas instead.
 */
export const sketchPrompt = (sketch: string, style: string) =>
  [
    'Rough storyboard sketch drawn in graphite pencil on plain off-white paper.',
    'Loose, confident lines, light cross-hatching for shadows, monochrome, no color.',
    `Shot: ${sketch}`,
    style ? `Mood and look: ${style}.` : '',
    'Absolutely no text, letters, numbers, captions, labels, arrows, borders or panel frames anywhere in the image.'
  ]
    .filter(Boolean)
    .join(' ')

export const MOODBOARD_INSTRUCTIONS = `You can also make a mood board: a canvas of shots for a film, music video, ad or photo shoot. The app draws a pencil sketch for each shot and connects it with hand-drawn arrows to the steps for getting that shot. Use it when the user asks for a mood board, storyboard or shot list they want to see.

Format: JSON inside an artifact tag with type="moodboard", outside any code fence:
<artifact type="moodboard" identifier="kebab-case-id" title="Short title">
{
  "style": "the look every sketch shares, e.g. moody dusk light, long shadows, 35mm",
  "shots": [
    {
      "id": "opening-wide",
      "title": "Opening wide",
      "sketch": "wide shot, lone figure on a rooftop edge at dusk, city skyline behind, low angle, figure small in the lower third",
      "steps": ["Lock off the camera on a low tripod", "Expose for the sky and let the figure fall to silhouette", "Hold for 8 bars, cut on the downbeat at 0:24"]
    }
  ],
  "notes": ["Palette: rust, teal, sodium orange"]
}
</artifact>

Rules:
- "sketch" describes only what a still frame shows: framing, angle, subject, pose, setting and light. An image model draws it, so never ask for words, labels or arrows in it.
- "steps" are short imperative lines (under 15 words) in shooting order: camera, lens, movement, lighting, blocking, timing. Two to five per shot.
- Keep shot ids stable when you update a board, and emit the whole board again with the same identifier.
- The user may have edited the board by hand. The board you see in the conversation is its current state; build on it.`
