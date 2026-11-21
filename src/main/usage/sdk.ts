// The one file that knows how the Agent SDK reports account usage. The usage meter comes from
// `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (SDKControlGetUsageResponse),
// which is experimental and may change; rate-limit events (SDKRateLimitInfo) are the fallback.
// When the SDK changes either, this file changes and nothing else does.
import type { Options, Query, SDKControlGetUsageResponse, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ExtraUsage, LimitSignal, WindowId } from '@shared/usage'
import type { QueryFn } from '../agent/driver'

/** What Anthropic's usage meter says about the account. */
export interface AccountReading {
  /** Plan limits apply (a Claude sign-in); false for API keys and cloud providers. */
  available: boolean
  plan: string | null
  windows: Array<{ id: WindowId; percent: number | null; resetsAt: number | null }>
  extra: ExtraUsage | null
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** Minor units (cents) per major unit of a currency: 100 for USD, 1 for JPY. */
const minorPer = (currency: string) => {
  try {
    return 10 ** (new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2)
  } catch {
    return 100
  }
}

const FIXED = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const

/** The usage control reply, as Tomo keeps it. Windows Anthropic sent nothing for are left out. */
export const readingFrom = (r: SDKControlGetUsageResponse): AccountReading => {
  const limits = r.rate_limits
  const windows: AccountReading['windows'] = []
  for (const id of FIXED) {
    const w = limits?.[id]
    if (w && w.utilization !== null) windows.push({ id, percent: w.utilization, resetsAt: time(w.resets_at) })
  }
  for (const m of limits?.model_scoped ?? []) {
    if (m.utilization !== null) windows.push({ id: `model:${m.display_name}`, percent: m.utilization, resetsAt: time(m.resets_at) })
  }
  const e = limits?.extra_usage
  const currency = (e?.currency ?? 'USD').toUpperCase()
  const per = minorPer(currency)
  const extra: ExtraUsage | null = e
    ? {
        enabled: e.is_enabled,
        // Anthropic sends these in minor units of the currency (cents for USD).
        monthlyLimit: e.monthly_limit === null ? null : e.monthly_limit / per,
        usedCredits: e.used_credits === null ? null : e.used_credits / per,
        percent: e.utilization,
        currency
      }
    : null
  return { available: r.rate_limits_available, plan: r.subscription_type, windows, extra }
}

/** Seconds or milliseconds since the epoch, as milliseconds. */
const ms = (t: number | undefined) => (t === undefined || !Number.isFinite(t) ? null : t < 1e12 ? t * 1000 : t)

const WINDOW_OF: Record<NonNullable<SDKRateLimitInfo['rateLimitType']>, WindowId> = {
  five_hour: 'five_hour',
  seven_day: 'seven_day',
  seven_day_opus: 'seven_day_opus',
  seven_day_sonnet: 'seven_day_sonnet',
  seven_day_overage_included: 'seven_day',
  overage: 'overage'
}

/** A rate-limit event, as Tomo keeps it. `info` is the SDK's SDKRateLimitInfo. */
export const signalFrom = (info: unknown, now = Date.now()): LimitSignal | null => {
  const i = info as Partial<SDKRateLimitInfo> | null
  if (!i || (i.status !== 'allowed' && i.status !== 'allowed_warning' && i.status !== 'rejected')) return null
  // The utilization in these events is a fraction (the response header's 0.82); the meter's is 0-100.
  const u = typeof i.utilization === 'number' && Number.isFinite(i.utilization) ? (i.utilization <= 1.5 ? i.utilization * 100 : i.utilization) : null
  const window = i.rateLimitType ? (WINDOW_OF[i.rateLimitType] ?? i.rateLimitType) : null
  return {
    status: i.status,
    window,
    percent: u,
    resetsAt: ms(window === 'overage' ? (i.overageResetsAt ?? i.resetsAt) : i.resetsAt),
    usingOverage: i.isUsingOverage === true,
    overageStatus: i.overageStatus ?? null,
    at: now
  }
}

/** A message from the reply's query that carries a rate-limit event: its SDKRateLimitInfo. */
export const rateLimitOf = (m: SDKMessage): unknown => (m.type === 'rate_limit_event' ? m.rate_limit_info : undefined)

/** What a reply that failed on a rate limit, with no event saying more, is treated as. */
export const REJECTED: Pick<SDKRateLimitInfo, 'status'> = { status: 'rejected' }

const withTimeout = <A>(p: Promise<A>, ms: number) =>
  new Promise<A>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Claude Code took too long to report usage.')), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e))
    )
  })

/**
 * Reads the account's usage meter. A query is started that never sends a message, so no model
 * is called and nothing is spent: the usage control request is answered by Claude Code, which
 * asks Anthropic's usage endpoint. Then the query is closed.
 */
export const probeAccount = async (query: QueryFn, options: Options, timeoutMs = 20_000): Promise<AccountReading> => {
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  const abort = new AbortController()
  // A prompt that stays open (streaming input, which control requests need) and never yields.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await held
  })()
  const q = query({ prompt, options: { ...options, abortController: abort, persistSession: false, tools: [], maxTurns: 1 } }) as AsyncIterable<SDKMessage> &
    Partial<Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' | 'close'>>
  const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  // Messages are read as they come, so nothing backs up while the request is answered.
  const drain = (async () => {
    try {
      for await (const _ of q) void _
    } catch {
      // Closed.
    }
  })()
  try {
    if (typeof read !== 'function') throw new Error("This version of Claude Code can't report usage.")
    return readingFrom(await withTimeout(read.call(q, { skipBehaviors: true }), timeoutMs))
  } finally {
    release()
    abort.abort()
    try {
      q.close?.()
    } catch {
      // Already closed.
    }
    void drain
  }
}
