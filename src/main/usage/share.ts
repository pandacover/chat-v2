// Estimates how much of a usage window each piece of work used. Anthropic reports usage per
// account, not per request, so this is an estimate: each rise of a window between two readings is
// split across the replies that ran in that time, in proportion to their API-equivalent cost.
// A rise while nothing of Tomo's ran (claude.ai, another device) is nobody's here.
//
// Pure, so a later phase can call it per job: key the runs by job id instead of session id.

/** A reply's run: who it was for (`key`), when it ran, and what it would have cost on the API. */
export interface Run {
  key: string
  start: number
  end: number
  cost: number
  model?: string | null
}

/** A reading of a window: how full it was at `at`, and when it was due to reset. */
export interface Sample {
  window: string
  at: number
  percent: number
  resetsAt: number | null
}

export interface Split {
  window: string
  /** When the window's current period began, as far as the samples tell. */
  periodStart: number | null
  resetsAt: number | null
  /** How full the window is, by the newest sample; null with none. */
  total: number | null
  /** Percentage points of the window each key used. */
  byKey: Map<string, number>
  /** Points no run of ours explains. */
  unattributed: number
}

const HOUR = 3_600_000
/** How long each window lasts, so a period's start follows from its reset. */
export const windowLength = (window: string): number | null =>
  window === 'five_hour' ? 5 * HOUR : window.startsWith('seven_day') || window.startsWith('model:') ? 7 * 24 * HOUR : null

/** Whether a reply on `model` counts toward `window`: a per-model window counts only its model's work. */
export const countsToward = (window: string, model: string | null | undefined) => {
  const m = (model ?? '').toLowerCase()
  if (window === 'seven_day_opus') return m.includes('opus')
  if (window === 'seven_day_sonnet') return m.includes('sonnet')
  if (window.startsWith('model:')) return m.includes(window.slice(6).toLowerCase())
  return true
}

/** Readings of one window a reset apart: a later reset (by more than this) starts a new period. */
const RESET_SLACK = 30 * 60_000
/** A drop bigger than this (in points) means the window reset, even without reset times. */
const DROP = 5

const newPeriod = (a: Sample, b: Sample) =>
  (a.resetsAt !== null && b.resetsAt !== null && b.resetsAt > a.resetsAt + RESET_SLACK) ||
  (a.resetsAt !== null && b.at >= a.resetsAt) ||
  b.percent < a.percent - DROP

/**
 * Splits the current period of `window` across `runs`. With `now`, a period whose reset has
 * passed is over, and the split is empty.
 */
export const splitWindow = (window: string, samples: readonly Sample[], runs: readonly Run[], now?: number): Split => {
  const all = samples.filter((s) => s.window === window).sort((a, b) => a.at - b.at)
  const empty = (total: number | null, resetsAt: number | null, periodStart: number | null): Split => ({
    window,
    periodStart,
    resetsAt,
    total,
    byKey: new Map(),
    unattributed: total ?? 0
  })
  const last = all.at(-1)
  if (!last) return empty(null, null, null)
  if (now !== undefined && last.resetsAt !== null && last.resetsAt <= now) return empty(0, null, last.resetsAt)
  // The current period: back from the newest sample while no reset falls between.
  let first = all.length - 1
  while (first > 0 && !newPeriod(all[first - 1]!, all[first]!)) first--
  const period = all.slice(first)
  const length = windowLength(window)
  const periodStart = last.resetsAt !== null && length !== null ? last.resetsAt - length : null
  // The window was empty when the period began, if that is known; else the first reading is the base.
  const points: Sample[] = periodStart !== null && periodStart <= period[0]!.at ? [{ window, at: periodStart, percent: 0, resetsAt: last.resetsAt }, ...period] : period
  const counted = runs.filter((r) => countsToward(window, r.model))
  const byKey = new Map<string, number>()
  let unattributed = points === period ? period[0]!.percent : 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const rise = b.percent - a.percent
    if (rise <= 0) continue
    // Each run's cost is taken as spread evenly over its time; the part inside (a, b] weighs.
    const shares = counted.flatMap((r) => {
      const start = Math.min(r.start, r.end)
      const overlap = Math.min(r.end, b.at) - Math.max(start, a.at)
      // A run that took no time at all counts where it happened.
      const instant = r.end === start && start > a.at && start <= b.at
      if (overlap <= 0 && !instant) return []
      const part = instant ? 1 : overlap / Math.max(1, r.end - start)
      return [{ key: r.key, cost: Math.max(0, r.cost) * part, time: instant ? 1 : overlap }]
    })
    if (shares.length === 0) {
      unattributed += rise
      continue
    }
    // Without costs (failed replies), time decides.
    const byCost = shares.some((s) => s.cost > 0)
    const sum = shares.reduce((t, s) => t + (byCost ? s.cost : s.time), 0)
    for (const s of shares) byKey.set(s.key, (byKey.get(s.key) ?? 0) + (rise * (byCost ? s.cost : s.time)) / sum)
  }
  return { window, periodStart: periodStart ?? period[0]!.at, resetsAt: last.resetsAt, total: last.percent, byKey, unattributed }
}

/** The points of a window the given keys used together (a job's sessions, say). */
export const shareOf = (split: Split, keys: Iterable<string>) => {
  let sum = 0
  for (const k of new Set(keys)) sum += split.byKey.get(k) ?? 0
  return sum
}
