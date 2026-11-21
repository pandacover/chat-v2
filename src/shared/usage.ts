// Account usage, as the main process reports it to the renderer (src/main/usage). Tomo sets no
// budgets of its own: it shows what Anthropic reports (a Claude plan's windows, or an API key's
// dollars), pauses a reply at a limit until it resets, and warns before work moves onto extra usage.

/**
 * A usage window: 'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet',
 * 'seven_day_oauth_apps', 'model:<name>' for a per-model weekly window the server names, or
 * 'overage' (extra usage).
 */
export type WindowId = string

export interface UsageWindow {
  id: WindowId
  label: string
  /** Share of the window used, 0-100; null when Anthropic didn't say. */
  percent: number | null
  /** When the window resets (ms since the epoch). */
  resetsAt: number | null
  /** When this was last heard. */
  at: number
}

/** Extra usage (Anthropic's overage): spend past the plan's limits, up to a monthly limit. */
export interface ExtraUsage {
  enabled: boolean
  /** In the currency's major units (dollars); null when there is no limit. */
  monthlyLimit: number | null
  usedCredits: number | null
  /** Share of the monthly limit used, 0-100. */
  percent: number | null
  currency: string
}

/** What the latest rate-limit event said. */
export interface LimitSignal {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  window: WindowId | null
  percent: number | null
  resetsAt: number | null
  /** Work is running on extra usage now. */
  usingOverage: boolean
  overageStatus: 'allowed' | 'allowed_warning' | 'rejected' | null
  at: number
}

/** A reply paused at a limit, which continues by itself at `resumeAt`. */
export interface UsagePause {
  messageId: string
  sessionId: string
  window: WindowId | null
  resetsAt: number | null
  resumeAt: number
  createdAt: number
}

/** Extra usage is on and a window nears its limit: work past it moves onto extra usage. */
export interface OverageWarning {
  window: WindowId
  percent: number | null
  resetsAt: number | null
  extra: ExtraUsage
}

/** API-equivalent dollars of the replies run with an API key. */
export interface CostSummary {
  today: number
  week: number
  month: number
}

export interface UsageView {
  auth: 'login' | 'apiKey'
  /** Anthropic reports plan limits for this sign-in; null until it has been asked. */
  limits: boolean | null
  /** 'pro', 'max', 'team', 'enterprise'. */
  plan: string | null
  windows: UsageWindow[]
  extra: ExtraUsage | null
  signal: LimitSignal | null
  warning: OverageWarning | null
  pauses: UsagePause[]
  cost: CostSummary
  /** When Anthropic's usage meter was last read. */
  checkedAt: number | null
  /** Why the last read failed. */
  error: string | null
  refreshing: boolean
}

/** Something worth a quiet word once: a window nears its limit, or work is about to move onto extra usage. */
export interface UsageNotice {
  kind: 'warning' | 'overage'
  window: WindowId | null
  percent: number | null
  resetsAt: number | null
  extra: ExtraUsage | null
}

export type UsageEvent =
  | { type: 'view'; view: UsageView; notice?: UsageNotice }
  /** A paused reply continued by itself: a window showing its chat reloads it. */
  | { type: 'resumed'; sessionId: string; messageId: string; view: UsageView }

/** A job's (for now: a chat's) estimated share of a window. */
export interface UsageShare {
  window: WindowId
  label: string
  /** Percentage points of the window this work used, estimated. */
  percent: number
  /** How full the window is now. */
  total: number | null
  resetsAt: number | null
  /** Always true: Anthropic reports usage per account, not per request. */
  estimate: true
}

const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_oauth_apps: 'Weekly apps',
  seven_day_overage_included: 'Weekly',
  overage: 'Extra usage'
}

export const windowLabel = (id: WindowId) => (id.startsWith('model:') ? `Weekly ${id.slice(6)}` : (LABELS[id] ?? id))

/** "5-hour limit", "weekly limit": the window as a sentence names it. */
export const limitName = (id: WindowId | null) => {
  if (!id) return 'usage limit'
  if (id === 'overage') return 'extra usage limit'
  const label = windowLabel(id)
  return `${label === 'Weekly' ? 'weekly' : label} limit`
}

/** How a share of a window reads in a sentence: "this 5-hour window", "this week". */
export const windowPhrase = (id: WindowId) => (id === 'five_hour' ? 'this 5-hour window' : id === 'overage' ? 'extra usage this month' : 'this week')

export const formatPercent = (p: number | null) => (p === null ? '–' : p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`)

/** "about 12% of this week", for a job's estimated share. */
export const shareLabel = (s: Pick<UsageShare, 'window' | 'percent'>) =>
  s.percent <= 0
    ? `none of ${windowPhrase(s.window)} yet`
    : `${s.percent < 1 ? 'under 1' : `about ${Math.round(s.percent)}`}% of ${windowPhrase(s.window)}`

export const formatMoney = (amount: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: amount !== 0 && Math.abs(amount) < 1 ? 3 : 2 }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** When something happens, as a person says it: "in 12 min", "at 4:30 PM", "tomorrow 9:00 AM", "Tue 9:00 AM". */
export const whenPhrase = (at: number, now = Date.now()) => {
  const mins = Math.round((at - now) / 60_000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins} min`
  const d = new Date(at)
  const n = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay(d, n)) return `at ${time}`
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1)
  if (sameDay(d, tomorrow)) return `tomorrow ${time}`
  if (at - now < 6 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Thousands as "12.4k", millions as "1.2M". */
const count = (v: number) =>
  v < 1000 ? String(Math.round(v)) : v < 1_000_000 ? `${(v / 1000).toFixed(v < 100_000 ? 1 : 0).replace(/\.0$/, '')}k` : `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`

/** What a job's replies used: "12.4k tokens · $0.42" (API-equivalent dollars). */
export const jobUsageLine = (u: { tokens: number; cost: number }) => `${count(u.tokens)} tokens · ${formatMoney(u.cost)}`

/** A job's shares in a phrase: "about 6% of this 5-hour window, about 1% of this week". */
export const sharesLine = (shares: readonly Pick<UsageShare, 'window' | 'percent'>[]) => shares.map(shareLabel).join(', ')

/** "resets in 12 min", "resets Tue 9:00 AM". */
export const resetPhrase = (at: number | null, now = Date.now()) => (at === null ? '' : at <= now ? 'reset' : `resets ${whenPhrase(at, now)}`)

/** How full a window looks: past 80% it nears its limit, at 100% it's there. */
export const tone = (percent: number | null): 'ok' | 'near' | 'full' => (percent === null ? 'ok' : percent >= 100 ? 'full' : percent >= 80 ? 'near' : 'ok')

/** The window a compact meter shows: the fullest, the 5-hour one on a tie. */
export const fullest = (windows: readonly UsageWindow[]): UsageWindow | null =>
  windows.reduce<UsageWindow | null>((best, w) => (w.percent !== null && (best === null || (best.percent ?? -1) < w.percent) ? w : best), null)

/** Extra usage spent so far: "$12.40 of $50 this month". */
export const extraLine = (e: ExtraUsage) =>
  e.usedCredits === null
    ? e.monthlyLimit === null
      ? 'No monthly limit'
      : `${formatMoney(e.monthlyLimit, e.currency)} monthly limit`
    : `${formatMoney(e.usedCredits, e.currency)}${e.monthlyLimit === null ? '' : ` of ${formatMoney(e.monthlyLimit, e.currency)}`} this month`

/** The words of a notice. */
export const noticeText = (n: UsageNotice, now = Date.now()) => {
  const reset = n.resetsAt ? `, ${resetPhrase(n.resetsAt, now)}` : ''
  const used = n.percent === null ? 'Nearly at' : `${formatPercent(n.percent)} of`
  if (n.kind === 'overage')
    return `${used} your ${limitName(n.window)}${reset}. Past it, work moves onto extra usage${n.extra ? ` (${extraLine(n.extra)})` : ''}.`
  return `${used} your ${limitName(n.window)}${reset}.`
}
