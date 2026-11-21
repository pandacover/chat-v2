// The decisions behind Tomo's handling of usage limits, kept pure so they can be tested: when a
// reply pauses and when it continues, which windows to show, and when to say something.
import type { ExtraUsage, LimitSignal, OverageWarning, UsageNotice, UsageWindow } from '@shared/usage'
import { windowLabel } from '@shared/usage'
import type { Sample } from './share'

/** A reply continues this long after its limit resets, so the reset has surely happened. */
export const RESUME_MARGIN_MS = 15_000
/** Never sooner than this after it paused, so a limit that won't lift doesn't loop. */
export const MIN_PAUSE_MS = 60_000
/** With no reset time given, a paused reply tries again after this. */
export const UNKNOWN_RESET_PAUSE_MS = 5 * 60_000
/** A window this full, with extra usage on, gets the warning that work will move onto it. */
export const OVERAGE_WARN_PERCENT = 90

/** Whether a reply that failed should pause instead: it hit a limit that extra usage didn't cover. */
export const shouldPause = (signal: LimitSignal | null) => signal !== null && signal.status === 'rejected' && !signal.usingOverage

export interface PauseTiming {
  marginMs: number
  minPauseMs: number
  unknownResetMs: number
}
export const PAUSE_TIMING: PauseTiming = { marginMs: RESUME_MARGIN_MS, minPauseMs: MIN_PAUSE_MS, unknownResetMs: UNKNOWN_RESET_PAUSE_MS }

/** When a reply paused at `signal` continues by itself. */
export const resumeAt = (signal: LimitSignal | null, now: number, t: PauseTiming = PAUSE_TIMING) => {
  const reset = signal?.resetsAt ?? null
  const at = reset === null ? now + t.unknownResetMs : reset + t.marginMs
  return Math.max(now + t.minPauseMs, at)
}

/** What a paused timer does when it fires: continue the reply, wait more, or nothing (cancelled). */
export const onTimer = (pause: { resumeAt: number } | null, now: number): 'resume' | 'wait' | 'gone' =>
  pause === null ? 'gone' : now + 1000 < pause.resumeAt ? 'wait' : 'resume'

/**
 * The windows to show: the newest reading of each, from the meter or a rate-limit event. A
 * window whose reset has passed shows as empty until it is read again.
 */
export const currentWindows = (latest: readonly Sample[], now: number, at = new Map<string, number>()): UsageWindow[] => {
  const newest = new Map<string, Sample>()
  for (const s of latest) {
    if (s.window === 'overage') continue
    const prev = newest.get(s.window)
    if (!prev || prev.at <= s.at) newest.set(s.window, s)
  }
  const order = (id: string) => (id === 'five_hour' ? 0 : id === 'seven_day' ? 1 : id.startsWith('model:') ? 3 : 2)
  return [...newest.values()]
    // A window not heard from for a full week tells nothing now.
    .filter((s) => now - s.at < 8 * 86_400_000)
    .map((s) => {
      const over = s.resetsAt !== null && s.resetsAt <= now
      return { id: s.window, label: windowLabel(s.window), percent: over ? 0 : s.percent, resetsAt: over ? null : s.resetsAt, at: at.get(s.window) ?? s.at }
    })
    .sort((a, b) => order(a.id) - order(b.id) || a.label.localeCompare(b.label))
}

/**
 * Extra usage is on and a window nears its limit, but work isn't on extra usage yet: the user is
 * told before it moves there.
 */
export const overageWarning = (windows: readonly UsageWindow[], extra: ExtraUsage | null, signal: LimitSignal | null): OverageWarning | null => {
  // Already on extra usage, or already stopped at a limit it didn't cover: past the point of warning.
  if (!extra?.enabled || signal?.usingOverage || signal?.status === 'rejected') return null
  if (extra.monthlyLimit !== null && extra.usedCredits !== null && extra.usedCredits >= extra.monthlyLimit) return null
  const near = windows
    .filter((w) => w.id !== 'overage' && w.percent !== null && w.percent >= OVERAGE_WARN_PERCENT && w.percent < 100)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0]
  // The event says so too: a warning on a window, with extra usage allowed past it.
  const warned =
    signal && signal.status === 'allowed_warning' && signal.window && signal.window !== 'overage' && signal.overageStatus !== 'rejected'
      ? { window: signal.window, percent: signal.percent, resetsAt: signal.resetsAt }
      : null
  const pick = near ? { window: near.id, percent: near.percent, resetsAt: near.resetsAt } : warned
  return pick ? { ...pick, extra } : null
}

/** The notice to show for a view, or null; `seen` holds the keys of those already shown (and gets this one). */
export const noticeFor = (signal: LimitSignal | null, warning: OverageWarning | null, seen: Set<string>): UsageNotice | null => {
  const once = (key: string, n: UsageNotice) => {
    if (seen.has(key)) return null
    seen.add(key)
    return n
  }
  // The reset in the key, to the hour (the meter's and the events' reset times differ a little), so each period of a window warns once.
  const period = (t: number | null) => (t === null ? 'x' : String(Math.round(t / 3_600_000)))
  if (warning) return once(`overage:${warning.window}:${period(warning.resetsAt)}`, { kind: 'overage', window: warning.window, percent: warning.percent, resetsAt: warning.resetsAt, extra: warning.extra })
  if (signal?.status === 'allowed_warning')
    return once(`warning:${signal.window}:${period(signal.resetsAt)}`, { kind: 'warning', window: signal.window, percent: signal.percent, resetsAt: signal.resetsAt, extra: null })
  return null
}

/** The start of today, of 7 days ago and of this month, in local time: for summing dollars. */
export const costRanges = (now: number) => {
  const d = new Date(now)
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return { today, week: today - 6 * 86_400_000, month: new Date(d.getFullYear(), d.getMonth(), 1).getTime() }
}

/** How often the meter may be read: after a reply, at most this often; on opening the view, a little more. */
export const REFRESH_EVERY_MS = 60_000
export const REFRESH_ON_OPEN_MS = 20_000
/** Debounce after a reply or an event before reading the meter. */
export const REFRESH_DELAY_MS = 3_000

export const refreshDue = (checkedAt: number | null, now: number, opened: boolean) =>
  checkedAt === null || now - checkedAt >= (opened ? REFRESH_ON_OPEN_MS : REFRESH_EVERY_MS)
