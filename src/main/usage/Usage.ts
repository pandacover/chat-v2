// Account usage for the app: the meter Anthropic reports for a Claude sign-in (or dollars for an
// API key), replies paused at a limit until it resets, and each chat's estimated share of a window.
// Tomo asks for no budgets: Anthropic's plan limits and API spend limits already ration usage.
//
// The meter is read after replies (debounced, at most once a minute), when a view of it opens, and
// after rate-limit events; never on a timer. Readings and reply runs are kept in chat.db, so the
// meter shows at once on launch and shares can be estimated later (see share.ts).
import { Context, Effect, Layer } from 'effect'
import type { LimitSignal, UsageEvent, UsagePause, UsageShare, UsageView } from '@shared/usage'
import { windowLabel } from '@shared/usage'
import { errorMessage } from '../errors'
import { Agent } from '../agent/driver'
import { Db, type DbApi } from '../services/Db'
import { SettingsStore } from '../services/SettingsStore'
import type { AccountReading } from './sdk'
import { signalFrom } from './sdk'
import { costRanges, currentWindows, noticeFor, onTimer, overageWarning, PAUSE_TIMING, type PauseTiming, refreshDue, REFRESH_DELAY_MS, resumeAt } from './decide'
import { shareOf, splitWindow, windowLength } from './share'

export interface ReplyRun {
  sessionId: string
  messageId: string
  model: string | null
  startedAt: number
  endedAt: number
  /** API-equivalent dollars; null when the reply reported none (it failed or was stopped). */
  cost: number | null
}

export interface UsageApi {
  readonly view: Effect.Effect<UsageView>
  /** Reads the meter if it is due (`opened`: a view of it just opened, so a little sooner). */
  readonly refresh: (opened: boolean) => Effect.Effect<UsageView>
  /** A rate-limit event of a reply (the SDK's SDKRateLimitInfo), kept and shown; returns it as Tomo reads it. */
  readonly signal: (info: unknown) => LimitSignal | null
  /** A reply ended (however it ended): its run is kept for the dollars and the shares. */
  readonly replyEnded: (run: ReplyRun) => void
  /** Pauses a reply that hit a limit; it continues by itself after the reset. */
  readonly pause: (input: { sessionId: string; messageId: string; signal: LimitSignal | null }) => UsagePause
  /** A paused reply runs again (continued by hand, or retried): its pause goes. */
  readonly clearPause: (messageId: string) => void
  /** The user cancelled a pause: the reply stays stopped, to continue by hand. */
  readonly cancelPause: (messageId: string) => Effect.Effect<UsageView>
  /** How a paused reply is continued (Chat registers this once it is built). */
  readonly onResume: (resume: (pause: UsagePause) => Promise<void>) => void
  /**
   * The estimated share of `window` (default: the weekly one) used by work keyed by `keys`: chat
   * ids for now; a later phase keys runs by job.
   */
  readonly share: (input: { keys: readonly string[]; window?: string }) => Effect.Effect<UsageShare>
}

export class Usage extends Context.Service<Usage, UsageApi>()('chat-v2/Usage') {
  /** `send` tells open windows (the usage:event channel); tests shorten the pauses with `timing`. */
  static readonly layer = (send: (event: UsageEvent) => void, timing: Partial<PauseTiming> & { refreshDelayMs?: number } = {}) =>
    Layer.effect(
      Usage,
      Effect.gen(function* () {
        const db = yield* Db
        const settingsStore = yield* SettingsStore
        const agent = yield* Agent

        const sync = <A>(f: (d: DbApi) => A, fallback: A): A => Effect.runSync(db.use(f).pipe(Effect.orElseSucceed(() => fallback)))
        const authNow = () => Effect.runSync(settingsStore.get.pipe(Effect.map((s) => s.auth), Effect.orElseSucceed(() => 'login' as const)))

        let reading: AccountReading | null = null
        let checkedAt: number | null = null
        let error: string | null = null
        let inflight: Promise<void> | null = null
        let signal: LimitSignal | null = null
        const seen = new Set<string>()
        const pauseTiming = { ...PAUSE_TIMING, ...timing }
        let resume: ((p: UsagePause) => Promise<void>) | null = null
        const timers = new Map<string, ReturnType<typeof setTimeout>>()
        let refreshTimer: ReturnType<typeof setTimeout> | undefined
        let closed = false
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true
            clearTimeout(refreshTimer)
            for (const t of timers.values()) clearTimeout(t)
            timers.clear()
          })
        )

        // Readings older than five weeks tell nothing about any window now.
        sync((d) => d.pruneUsageSamples(Date.now() - 35 * 86_400_000), undefined)

        const build = (now = Date.now()): UsageView => {
          const auth = authNow()
          const latest = sync((d) => d.latestUsageSamples(), [])
          const windows = auth === 'login' ? currentWindows(latest, now) : []
          let extra = auth === 'login' ? (reading?.extra ?? null) : null
          // A newer event on extra usage says how far into it the month is.
          const overage = latest.find((s) => s.window === 'overage')
          if (extra && overage && checkedAt !== null && overage.at > checkedAt) extra = { ...extra, percent: overage.percent }
          const r = costRanges(now)
          const cost = sync((d) => ({ today: d.usageCost(r.today, 'login'), week: d.usageCost(r.week, 'login'), month: d.usageCost(r.month, 'login') }), { today: 0, week: 0, month: 0 })
          const shownSignal = auth === 'login' && signal && (signal.resetsAt === null || signal.resetsAt > now) ? signal : null
          return {
            auth,
            limits: auth === 'apiKey' ? false : reading ? reading.available : latest.length > 0 ? true : null,
            plan: auth === 'login' ? (reading?.plan ?? null) : null,
            windows,
            extra,
            signal: shownSignal,
            warning: auth === 'login' ? overageWarning(windows, extra, shownSignal) : null,
            pauses: sync((d) => d.usagePauses(), []),
            cost,
            checkedAt: auth === 'login' ? checkedAt : null,
            error: auth === 'login' ? error : null,
            refreshing: inflight !== null
          }
        }

        const broadcast = () => {
          if (closed) return
          const view = build()
          const notice = noticeFor(view.signal, view.warning, seen)
          send(notice ? { type: 'view', view, notice } : { type: 'view', view })
        }

        const read = async () => {
          if (authNow() !== 'login') return
          try {
            const r = await agent.readUsage({ kind: 'login' })
            const now = Date.now()
            reading = r
            checkedAt = now
            error = null
            sync((d) => {
              for (const w of r.windows) if (w.percent !== null) d.addUsageSample({ window: w.id, percent: w.percent, resetsAt: w.resetsAt, at: now, source: 'meter' })
            }, undefined)
          } catch (e) {
            checkedAt = Date.now()
            error = errorMessage(e)
          }
        }

        const refreshNow = (opened: boolean) =>
          new Promise<void>((done) => {
            if (inflight) return void inflight.then(done)
            if (authNow() !== 'login' || !refreshDue(checkedAt, Date.now(), opened)) return done()
            inflight = read().finally(() => {
              inflight = null
              broadcast()
            })
            broadcast()
            void inflight.then(done)
          })

        const refreshSoon = () => {
          clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => void refreshNow(false), timing.refreshDelayMs ?? REFRESH_DELAY_MS)
        }

        // Paused replies: a timer each, from the pauses kept in the database (so they outlive a restart).
        const schedule = (p: UsagePause) => {
          clearTimeout(timers.get(p.messageId))
          if (!resume || closed) return
          // setTimeout holds at most ~24.8 days; a longer wait is just checked again then.
          const delay = Math.min(2 ** 31 - 1, Math.max(0, p.resumeAt - Date.now()))
          timers.set(
            p.messageId,
            setTimeout(() => {
              timers.delete(p.messageId)
              const now = sync((d) => d.usagePause(p.messageId), null)
              const what = onTimer(now, Date.now())
              if (what === 'gone') return
              if (what === 'wait') return schedule(now!)
              sync((d) => d.deleteUsagePause(p.messageId), false)
              const view = build()
              send({ type: 'resumed', sessionId: p.sessionId, messageId: p.messageId, view })
              void resume?.(p).catch((e: unknown) => Effect.runFork(Effect.logWarning(`Couldn't continue a paused reply: ${errorMessage(e)}`)))
            }, delay)
          )
        }

        const clearPause = (messageId: string) => {
          clearTimeout(timers.get(messageId))
          timers.delete(messageId)
          if (sync((d) => d.deleteUsagePause(messageId), false)) broadcast()
        }

        return Usage.of({
          view: Effect.sync(() => build()),
          refresh: (opened) => Effect.promise(() => refreshNow(opened)).pipe(Effect.map(() => build())),
          signal: (info) => {
            const s = signalFrom(info)
            if (!s) return null
            signal = s
            if (s.window && s.percent !== null) {
              const sample = { window: s.window, percent: s.percent, resetsAt: s.resetsAt, at: s.at, source: 'event' }
              sync((d) => d.addUsageSample(sample), undefined)
            }
            broadcast()
            refreshSoon()
            return s
          },
          replyEnded: (r) => {
            const auth = authNow()
            sync(
              (d) => d.addUsageRun({ sessionId: r.sessionId, messageId: r.messageId, auth, model: r.model, startedAt: r.startedAt, endedAt: r.endedAt, cost: r.cost ?? 0 }),
              undefined
            )
            broadcast()
            refreshSoon()
          },
          pause: ({ sessionId, messageId, signal: s }) => {
            const now = Date.now()
            const p: UsagePause = { messageId, sessionId, window: s?.window ?? null, resetsAt: s?.resetsAt ?? null, resumeAt: resumeAt(s, now, pauseTiming), createdAt: now }
            sync((d) => d.setUsagePause(p), undefined)
            schedule(p)
            broadcast()
            return p
          },
          clearPause,
          cancelPause: (messageId) => Effect.sync(() => (clearPause(messageId), build())),
          onResume: (f) => {
            resume = f
            for (const p of sync((d) => d.usagePauses(), [])) schedule(p)
          },
          share: ({ keys, window = 'seven_day' }) =>
            Effect.sync(() => {
              const now = Date.now()
              const since = now - (windowLength(window) ?? 7 * 86_400_000) - 86_400_000
              const split = splitWindow(window, sync((d) => d.usageSamples(since), []), sync((d) => d.usageRuns(since), []), now)
              return { window, label: windowLabel(window), percent: shareOf(split, keys), total: split.total, resetsAt: split.resetsAt, estimate: true as const }
            })
        })
      })
    )
}
