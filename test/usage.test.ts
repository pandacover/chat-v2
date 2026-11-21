import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { StreamEvent } from '../src/shared/types'
import type { UsageEvent } from '../src/shared/usage'
import { extraLine, formatMoney, fullest, limitName, noticeText, resetPhrase, shareLabel, tone, whenPhrase } from '../src/shared/usage'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Broadcaster, Chat } from '../src/main/services/Chat'
import { Db } from '../src/main/services/Db'
import { Browser } from '../src/main/services/Browser'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { Agent } from '../src/main/agent/driver'
import { ComputerUse, noOverlay } from '../src/main/computer'
import { Usage } from '../src/main/usage/Usage'
import { readingFrom, signalFrom } from '../src/main/usage/sdk'
import { countsToward, shareOf, splitWindow, type Run, type Sample } from '../src/main/usage/share'
import {
  MIN_PAUSE_MS,
  RESUME_MARGIN_MS,
  UNKNOWN_RESET_PAUSE_MS,
  costRanges,
  currentWindows,
  noticeFor,
  onTimer,
  overageWarning,
  refreshDue,
  resumeAt,
  shouldPause
} from '../src/main/usage/decide'
import { type Script, fakeQuery } from './fakeQuery'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0)
const sample = (window: string, at: number, percent: number, resetsAt: number | null = T0 + 5 * H): Sample => ({ window, at, percent, resetsAt })
const run = (key: string, start: number, end: number, cost: number, model: string | null = 'claude-sonnet-5-5'): Run => ({ key, start, end, cost, model })

describe('share estimate', () => {
  test('splits each rise across the runs in it, by cost', () => {
    // The 5-hour window began at T0; nothing before the first reading but our two chats.
    const samples = [sample('five_hour', T0 + H, 10), sample('five_hour', T0 + 2 * H, 40)]
    const runs = [run('a', T0 + 10 * 60_000, T0 + 20 * 60_000, 1), run('b', T0 + 70 * 60_000, T0 + 80 * 60_000, 3), run('a', T0 + 90 * 60_000, T0 + 100 * 60_000, 1)]
    const s = splitWindow('five_hour', samples, runs)
    expect(s.total).toBe(40)
    expect(s.periodStart).toBe(T0)
    // 0 → 10 while only a ran; 10 → 40 split 3:1 between b and a.
    expect(s.byKey.get('a')).toBeCloseTo(10 + 7.5)
    expect(s.byKey.get('b')).toBeCloseTo(22.5)
    expect(s.unattributed).toBe(0)
    expect(shareOf(s, ['a', 'b', 'a'])).toBeCloseTo(40)
  })

  test('a rise while nothing of ours ran is nobody’s', () => {
    const samples = [sample('five_hour', T0 + H, 10), sample('five_hour', T0 + 2 * H, 25)]
    const s = splitWindow('five_hour', samples, [run('a', T0 + 10 * 60_000, T0 + 20 * 60_000, 1)])
    expect(s.byKey.get('a')).toBeCloseTo(10)
    expect(s.unattributed).toBeCloseTo(15)
  })

  test('a run across two readings is split by the time in each', () => {
    const samples = [sample('five_hour', T0 + H, 0), sample('five_hour', T0 + 2 * H, 8), sample('five_hour', T0 + 3 * H, 12)]
    const runs = [run('a', T0 + 90 * 60_000, T0 + 150 * 60_000, 2), run('b', T0 + 150 * 60_000, T0 + 160 * 60_000, 2)]
    const s = splitWindow('five_hour', samples, runs)
    // First rise (8): only a's first half ran. Second (4): a's second half ($1) and b ($2).
    expect(s.byKey.get('a')).toBeCloseTo(8 + 4 / 3)
    expect(s.byKey.get('b')).toBeCloseTo(8 / 3)
  })

  test('only the current period counts, after a reset', () => {
    const old = T0 + 5 * H
    const next = T0 + 10 * H
    const samples = [sample('five_hour', T0 + H, 50, old), sample('five_hour', T0 + 4 * H, 90, old), sample('five_hour', T0 + 7 * H, 20, next)]
    const runs = [run('old', T0 + 2 * H, T0 + 3 * H, 5), run('new', T0 + 6 * H, T0 + 6.5 * H, 1)]
    const s = splitWindow('five_hour', samples, runs)
    expect(s.periodStart).toBe(T0 + 5 * H)
    expect(s.total).toBe(20)
    expect(s.byKey.get('new')).toBeCloseTo(20)
    expect(s.byKey.has('old')).toBe(false)
    // Asked after that period's reset too, nothing is left.
    expect(splitWindow('five_hour', samples, runs, next + 1).byKey.size).toBe(0)
  })

  test('a reset seen only as a drop starts the period after the last reading before it', () => {
    // Reset times that don't agree with the drop: the drop decides, and the old period's run is out.
    const samples = [sample('five_hour', T0 + H, 80, T0 + 5 * H), sample('five_hour', T0 + 2 * H, 10, T0 + 5 * H), sample('five_hour', T0 + 3 * H, 16, T0 + 5 * H)]
    const runs = [run('old', T0 + 0.5 * H, T0 + 0.9 * H, 5), run('new', T0 + 1.5 * H, T0 + 1.6 * H, 1), run('later', T0 + 2.5 * H, T0 + 2.6 * H, 1)]
    const s = splitWindow('five_hour', samples, runs)
    expect(s.periodStart).toBe(T0 + H)
    expect(s.byKey.has('old')).toBe(false)
    expect(s.byKey.get('new')).toBeCloseTo(10)
    expect(s.byKey.get('later')).toBeCloseTo(6)
  })

  test('without reset times, the first reading is the base', () => {
    const samples = [sample('five_hour', T0, 30, null), sample('five_hour', T0 + H, 36, null)]
    const s = splitWindow('five_hour', samples, [run('a', T0 + 10 * 60_000, T0 + 20 * 60_000, 1)])
    expect(s.byKey.get('a')).toBeCloseTo(6)
    expect(s.unattributed).toBe(30)
  })

  test('failed runs with no cost split by time; a per-model window counts its model only', () => {
    const w = T0 + 7 * 24 * H
    const samples = [sample('seven_day_opus', T0 + H, 0, w), sample('seven_day_opus', T0 + 2 * H, 6, w)]
    const runs = [
      run('a', T0 + 70 * 60_000, T0 + 80 * 60_000, 0, 'claude-opus-5-5'),
      run('b', T0 + 80 * 60_000, T0 + 100 * 60_000, 0, 'claude-opus-5-5'),
      run('c', T0 + 70 * 60_000, T0 + 100 * 60_000, 9, 'claude-sonnet-5-5')
    ]
    const s = splitWindow('seven_day_opus', samples, runs)
    expect(s.byKey.get('a')).toBeCloseTo(2)
    expect(s.byKey.get('b')).toBeCloseTo(4)
    expect(s.byKey.has('c')).toBe(false)
    expect(countsToward('model:Fable', 'claude-fable-5-2')).toBe(true)
    expect(countsToward('model:Fable', 'claude-opus-5-5')).toBe(false)
    expect(countsToward('seven_day', 'anything')).toBe(true)
  })

  test('no readings, no share', () => {
    const s = splitWindow('seven_day', [], [run('a', T0, T0 + 1, 1)])
    expect(s.total).toBeNull()
    expect(shareOf(s, ['a'])).toBe(0)
  })
})

describe('pause and resume decisions', () => {
  const now = T0
  const rejected = { status: 'rejected' as const, window: 'five_hour', percent: 100, resetsAt: now + 2 * H, usingOverage: false, overageStatus: null, at: now }

  test('a reply pauses on a limit extra usage did not cover', () => {
    expect(shouldPause(rejected)).toBe(true)
    expect(shouldPause({ ...rejected, usingOverage: true })).toBe(false)
    expect(shouldPause({ ...rejected, status: 'allowed_warning' })).toBe(false)
    expect(shouldPause(null)).toBe(false)
  })

  test('it continues just after the reset, never at once', () => {
    expect(resumeAt(rejected, now)).toBe(now + 2 * H + RESUME_MARGIN_MS)
    expect(resumeAt({ ...rejected, resetsAt: now - 5000 }, now)).toBe(now + MIN_PAUSE_MS)
    expect(resumeAt({ ...rejected, resetsAt: null }, now)).toBe(now + UNKNOWN_RESET_PAUSE_MS)
    expect(resumeAt(null, now)).toBe(now + UNKNOWN_RESET_PAUSE_MS)
    expect(resumeAt({ ...rejected, resetsAt: now + 100 }, now, { marginMs: 0, minPauseMs: 0, unknownResetMs: 0 })).toBe(now + 100)
  })

  test('a timer resumes, waits on, or finds the pause cancelled', () => {
    expect(onTimer(null, now)).toBe('gone')
    expect(onTimer({ resumeAt: now + 60_000 }, now)).toBe('wait')
    expect(onTimer({ resumeAt: now + 500 }, now)).toBe('resume')
    expect(onTimer({ resumeAt: now - 1 }, now)).toBe('resume')
  })

  test('the meter is read at most once a minute after replies, sooner on opening it', () => {
    expect(refreshDue(null, now, false)).toBe(true)
    expect(refreshDue(now - 30_000, now, false)).toBe(false)
    expect(refreshDue(now - 30_000, now, true)).toBe(true)
    expect(refreshDue(now - 61_000, now, false)).toBe(true)
  })
})

describe('warnings', () => {
  const extra = { enabled: true, monthlyLimit: 50, usedCredits: 12.4, percent: 25, currency: 'USD' }
  const win = (id: string, percent: number | null) => ({ id, label: id, percent, resetsAt: T0 + H, at: T0 })
  const quiet = { status: 'allowed' as const, window: null, percent: null, resetsAt: null, usingOverage: false, overageStatus: null, at: T0 }

  test('warns before work moves onto extra usage, not after', () => {
    expect(overageWarning([win('five_hour', 92), win('seven_day', 40)], extra, quiet)).toEqual({ window: 'five_hour', percent: 92, resetsAt: T0 + H, extra })
    expect(overageWarning([win('five_hour', 92)], extra, { ...quiet, usingOverage: true })).toBeNull()
    expect(overageWarning([win('five_hour', 70)], extra, quiet)).toBeNull()
    expect(overageWarning([win('five_hour', 95)], { ...extra, enabled: false }, quiet)).toBeNull()
    expect(overageWarning([win('five_hour', 95)], null, quiet)).toBeNull()
    // A limit already hit, and extra usage didn't take over: too late to warn.
    expect(overageWarning([win('five_hour', 100)], extra, quiet)).toBeNull()
    expect(overageWarning([win('five_hour', 95)], extra, { ...quiet, status: 'rejected' })).toBeNull()
    // Extra usage already spent to its limit: nothing would move onto it.
    expect(overageWarning([win('five_hour', 95)], { ...extra, usedCredits: 50 }, quiet)).toBeNull()
    // A warning event with extra usage allowed past it says so before the meter does.
    const warned = { ...quiet, status: 'allowed_warning' as const, window: 'seven_day', percent: 85, resetsAt: T0 + 3 * H, overageStatus: 'allowed' as const }
    expect(overageWarning([win('five_hour', 10)], extra, warned)?.window).toBe('seven_day')
  })

  test('each notice is shown once per window period', () => {
    const seen = new Set<string>()
    const warning = { ...quiet, status: 'allowed_warning' as const, window: 'five_hour', percent: 82, resetsAt: T0 + H }
    expect(noticeFor(warning, null, seen)?.kind).toBe('warning')
    expect(noticeFor({ ...warning, percent: 86 }, null, seen)).toBeNull()
    expect(noticeFor({ ...warning, resetsAt: T0 + 6 * H }, null, seen)?.kind).toBe('warning')
    const over = overageWarning([win('five_hour', 92)], extra, quiet)
    expect(noticeFor(quiet, over, seen)?.kind).toBe('overage')
    expect(noticeFor(quiet, over, seen)).toBeNull()
    expect(noticeFor(quiet, null, seen)).toBeNull()
  })

  test('notices and labels read as sentences', () => {
    const now = T0
    expect(noticeText({ kind: 'warning', window: 'five_hour', percent: 82, resetsAt: now + 30 * 60_000, extra: null }, now)).toBe('82% of your 5-hour limit, resets in 30 min.')
    expect(noticeText({ kind: 'overage', window: 'seven_day', percent: 91, resetsAt: null, extra }, now)).toBe(
      '91% of your weekly limit. Past it, work moves onto extra usage ($12.40 of $50.00 this month).'
    )
    expect(limitName('model:Fable')).toBe('Weekly Fable limit')
    expect(limitName(null)).toBe('usage limit')
    expect(shareLabel({ window: 'seven_day', percent: 12.3 })).toBe('about 12% of this week')
    expect(shareLabel({ window: 'five_hour', percent: 0.2 })).toBe('under 1% of this 5-hour window')
    expect(shareLabel({ window: 'seven_day', percent: 0 })).toBe('none of this week yet')
    expect(resetPhrase(now + 5 * 60_000, now)).toBe('resets in 5 min')
    expect(resetPhrase(now - 1, now)).toBe('reset')
    expect(whenPhrase(now + 3 * 86_400_000, now)).toMatch(/^[A-Z][a-z]{2} /)
    expect(formatMoney(0.25)).toBe('$0.25')
    expect(formatMoney(0.0042)).toBe('$0.004')
    expect(formatMoney(1234.5)).toBe('$1,234.50')
    expect(extraLine({ ...extra, usedCredits: null, monthlyLimit: null })).toBe('No monthly limit')
    expect(tone(79)).toBe('ok')
    expect(tone(80)).toBe('near')
    expect(tone(100)).toBe('full')
    expect(fullest([win('five_hour', 20), win('seven_day', 64), win('model:Fable', null)])?.id).toBe('seven_day')
    expect(fullest([])).toBeNull()
  })

  test('windows show their newest reading, empty once their reset has passed', () => {
    const now = T0 + 2 * H
    const ws = currentWindows(
      [
        sample('seven_day', T0, 30, T0 + 100 * H),
        sample('five_hour', T0, 50, T0 + H),
        sample('five_hour', T0 - H, 40, T0 + H),
        sample('model:Fable', T0, 10, T0 + 100 * H),
        sample('overage', T0, 5, null),
        sample('seven_day_opus', T0 - 9 * 24 * H, 70, T0 + 100 * H)
      ],
      now
    )
    expect(ws.map((w) => [w.id, w.percent, w.resetsAt])).toEqual([
      ['five_hour', 0, null],
      ['seven_day', 30, T0 + 100 * H],
      ['model:Fable', 10, T0 + 100 * H]
    ])
    expect(ws[2]!.label).toBe('Weekly Fable')
  })

  test('dollars are summed from the start of today, 7 days back, and the month', () => {
    const now = new Date(2026, 10, 22, 15, 30).getTime()
    const r = costRanges(now)
    expect(r.today).toBe(new Date(2026, 10, 22).getTime())
    expect(r.week).toBe(new Date(2026, 10, 16).getTime())
    expect(r.month).toBe(new Date(2026, 10, 1).getTime())
  })
})

describe('the SDK, as Tomo reads it', () => {
  test('the usage reply becomes windows and extra usage in dollars', () => {
    const r = readingFrom({
      session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: '2026-11-22T15:00:00Z' },
        seven_day: { utilization: 18.5, resets_at: '2026-11-25T09:00:00Z' },
        seven_day_opus: { utilization: null, resets_at: null },
        seven_day_sonnet: null,
        model_scoped: [{ display_name: 'Fable', utilization: 7, resets_at: '2026-11-25T09:00:00Z' }],
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'usd' }
      },
      behaviors: null
    } as never)
    expect(r.available).toBe(true)
    expect(r.plan).toBe('max')
    expect(r.windows).toEqual([
      { id: 'five_hour', percent: 42, resetsAt: Date.parse('2026-11-22T15:00:00Z') },
      { id: 'seven_day', percent: 18.5, resetsAt: Date.parse('2026-11-25T09:00:00Z') },
      { id: 'model:Fable', percent: 7, resetsAt: Date.parse('2026-11-25T09:00:00Z') }
    ])
    expect(r.extra).toEqual({ enabled: true, monthlyLimit: 50, usedCredits: 12.4, percent: 24.8, currency: 'USD' })
    expect(readingFrom({ subscription_type: null, rate_limits_available: false, rate_limits: null } as never)).toEqual({ available: false, plan: null, windows: [], extra: null })
  })

  test('rate-limit events: fractions become percent, seconds milliseconds', () => {
    expect(signalFrom({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: 1_800_000_000 }, 5)).toEqual({
      status: 'allowed_warning',
      window: 'five_hour',
      percent: 82,
      resetsAt: 1_800_000_000_000,
      usingOverage: false,
      overageStatus: null,
      at: 5
    })
    const over = signalFrom({ status: 'rejected', rateLimitType: 'overage', resetsAt: 1, overageResetsAt: 1_900_000_000, isUsingOverage: true, overageStatus: 'rejected' }, 0)!
    expect([over.window, over.resetsAt, over.usingOverage, over.percent]).toEqual(['overage', 1_900_000_000_000, true, null])
    expect(signalFrom({ status: 'rejected' })!.window).toBeNull()
    expect(signalFrom({ status: 'nope' })).toBeNull()
    expect(signalFrom(null)).toBeNull()
  })
})

// Chat and Usage together, on a scripted model.
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const setup = (script: Script, opts: { usage?: () => unknown; config?: Record<string, unknown> } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-usage-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '', ...opts.config }))
  const events: StreamEvent[] = []
  const usageEvents: UsageEvent[] = []
  const fake = fakeQuery(script, opts.usage ? { usage: opts.usage } : {})
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const agent = Agent.layer({ query: fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
  const computerUse = ComputerUse.layer({ platform: null, overlay: noOverlay, remember: async () => {} })
  const providers = Layer.mergeAll(agent, Attachments.layer, computerUse).pipe(Layer.provideMerge(base))
  const usage = Usage.layer((e) => usageEvents.push(e), { minPauseMs: 0, marginMs: 0, unknownResetMs: 200, refreshDelayMs: 0 }).pipe(Layer.provide(providers))
  const browser = Layer.succeed(Browser, {} as never)
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Chat.layer.pipe(Layer.provide(Layer.mergeAll(providers, usage, browser)), Layer.provide(Layer.succeed(Broadcaster, Broadcaster.of({ send: (e) => events.push(e) })))),
      providers,
      usage
    )
  )
  const run = <A, E>(eff: Effect.Effect<A, E, Chat | Db | Usage>) => runtime.runPromise(eff)
  return { runtime, run, events, usageEvents, fake }
}

const until = async (ok: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const start = (t: ReturnType<typeof setup>, text: string) =>
  t.run(
    Effect.gen(function* () {
      const db = yield* Db
      const session = yield* db.use((d) => d.createSession({ title: 'New chat', model: null, systemPrompt: null, forkedFromSessionId: null }))
      const view = yield* (yield* Chat).send({ sessionId: session.id, parentId: session.rootId, text, attachmentIds: [] })
      return { session, assistant: view.path.at(-1)!.message }
    })
  )

const message = (t: ReturnType<typeof setup>, id: string) => t.run(Db.use((db) => db.use((d) => d.getMessage(id)!)))
const done = (t: ReturnType<typeof setup>, id: string, n = 1) => t.events.filter((e) => e.type === 'done' && e.messageId === id).length >= n

describe('a reply at a usage limit', () => {
  test('pauses with its work saved, then continues by itself after the reset', async () => {
    let calls = 0
    const t = setup(async function* (turn) {
      calls++
      if (calls === 1) {
        yield turn.rateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: Math.floor(Date.now() / 1000) + 3600 })
        yield* turn.text('First part.\n')
        // The limit is hit mid-reply: an event, then the API error Claude Code reports.
        yield turn.rateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Date.now() + 300 })
        yield* turn.apiError('rate_limit', "You've hit your limit")
        return
      }
      yield* turn.text('The rest.')
      yield turn.result({ cost: 0.01 })
    })
    const { session, assistant } = await start(t, 'Write a long thing')
    await until(() => done(t, assistant.id))
    const paused = await message(t, assistant.id)
    expect(paused.status).toBe('stopped')
    expect(paused.error).toBe('Paused at your 5-hour limit.')
    expect(paused.content).toContain('First part.')
    const pauses = await t.run(Usage.use((u) => u.view)).then((v) => v.pauses)
    expect(pauses.map((p) => [p.messageId, p.sessionId, p.window])).toEqual([[assistant.id, session.id, 'five_hour']])
    // The warning came first, quietly.
    expect(t.usageEvents.some((e) => e.type === 'view' && e.notice?.kind === 'warning')).toBe(true)
    // At the reset it runs again, as Continue would, and finishes.
    await until(() => done(t, assistant.id, 2))
    const resumed = await message(t, assistant.id)
    expect(resumed.status).toBe('complete')
    expect(resumed.content).toContain('First part.')
    expect(resumed.content).toContain('The rest.')
    expect(t.usageEvents.some((e) => e.type === 'resumed' && e.messageId === assistant.id)).toBe(true)
    // It went through Continue's path as a stopped reply: asked once for the rest, never told it looked stuck.
    const resumedPrompt = t.fake.calls.at(-1)!.prompt.map((b) => b.text ?? '').join(' | ')
    expect(resumedPrompt.match(/Continue it from exactly where it stopped/g)).toHaveLength(1)
    expect(resumedPrompt).not.toContain('seemed stuck')
    expect((await t.run(Usage.use((u) => u.view))).pauses).toEqual([])
    // Readings kept for the meter: the warning's 90 and the rejection's 100.
    const latest = await t.run(Db.use((db) => db.use((d) => d.latestUsageSamples())))
    expect(latest.find((s) => s.window === 'five_hour')?.percent).toBe(100)
    await t.runtime.dispose()
  })

  test('a failure on a rate limit with no event pauses too; cancelling keeps it stopped', async () => {
    let calls = 0
    const t = setup(async function* (turn) {
      calls++
      yield* turn.apiError('rate_limit', 'Rate limited')
    })
    const { assistant } = await start(t, 'Hi')
    await until(() => done(t, assistant.id))
    expect((await message(t, assistant.id)).status).toBe('stopped')
    const view = await t.run(Usage.use((u) => u.cancelPause(assistant.id)))
    expect(view.pauses).toEqual([])
    await new Promise((r) => setTimeout(r, 400))
    expect(calls).toBe(1)
    expect((await message(t, assistant.id)).status).toBe('stopped')
    await t.runtime.dispose()
  })

  test('a reply on extra usage goes on; other failures are errors as before', async () => {
    const t = setup(async function* (turn) {
      const prompt = turn.call.prompt.at(-1)?.text ?? ''
      if (prompt === 'overage') {
        yield turn.rateLimit({ status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true, overageStatus: 'allowed' })
        yield* turn.text('Done on extra usage.')
        yield turn.result({ cost: 0.02 })
        return
      }
      yield* turn.apiError('overloaded', 'Overloaded')
    })
    const a = await start(t, 'overage')
    await until(() => done(t, a.assistant.id))
    expect((await message(t, a.assistant.id)).status).toBe('complete')
    const b = await start(t, 'other')
    await until(() => done(t, b.assistant.id))
    expect((await message(t, b.assistant.id)).status).toBe('error')
    expect((await t.run(Usage.use((u) => u.view))).pauses).toEqual([])
    await t.runtime.dispose()
  })

  test('a pause outlives a restart', async () => {
    const t = setup(async function* (turn) {
      yield turn.rateLimit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: Date.now() + 60 * 60_000 })
      yield* turn.apiError('rate_limit', 'Limit')
    })
    const { assistant } = await start(t, 'Hi')
    await until(() => done(t, assistant.id))
    const before = (await t.run(Usage.use((u) => u.view))).pauses
    expect(before).toHaveLength(1)
    expect(before[0]!.resumeAt).toBeGreaterThan(Date.now() + 50 * 60_000)
    // The same database, opened again: the pause is still there, waiting for its reset.
    const again = await t.run(Db.use((db) => db.use((d) => d.usagePauses())))
    expect(again).toEqual(before)
    await t.runtime.dispose()
  })
})

describe('the meter', () => {
  const reply: Script = async function* (turn) {
    yield* turn.text('ok')
    yield turn.result({ cost: 0.25 })
  }

  test('a Claude sign-in reads the account meter without calling a model', async () => {
    const t = setup(reply, {
      usage: () => ({
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 12, resets_at: new Date(Date.now() + H).toISOString() }, extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500, utilization: 25, currency: 'USD' } }
      })
    })
    const view = await t.run(Usage.use((u) => u.refresh(true)))
    expect(view.limits).toBe(true)
    expect(view.plan).toBe('pro')
    expect(view.windows.map((w) => [w.id, w.percent])).toEqual([['five_hour', 12]])
    expect(view.extra?.monthlyLimit).toBe(20)
    expect(t.fake.usageReads).toHaveLength(1)
    // The probe asked Claude Code only: no message, no tools, nothing kept.
    expect(t.fake.calls).toHaveLength(0)
    expect(t.fake.usageReads[0]!.persistSession).toBe(false)
    expect(t.fake.usageReads[0]!.tools).toEqual([])
    // Not read again so soon.
    await t.run(Usage.use((u) => u.refresh(false)))
    expect(t.fake.usageReads).toHaveLength(1)
    // A reply ends: its run is kept, and the meter is read after it, if due.
    const { assistant } = await start(t, 'Hi')
    await until(() => done(t, assistant.id))
    const runs = await t.run(Db.use((db) => db.use((d) => d.usageRuns(0))))
    expect(runs.map((r) => r.cost)).toEqual([0.25])
    // Plan replies aren't billed in dollars.
    expect((await t.run(Usage.use((u) => u.view))).cost.month).toBe(0)
    await t.runtime.dispose()
  })

  test('an API key shows dollars, and never asks for plan limits', async () => {
    const t = setup(reply, { config: { auth: 'apiKey' }, usage: () => ({ rate_limits_available: false, rate_limits: null }) })
    await t.run(Effect.gen(function* () {
      const s = yield* SettingsStore
      yield* s.update({ anthropicKey: 'sk-ant-test' })
    }) as never)
    const { assistant } = await start(t, 'Hi')
    await until(() => done(t, assistant.id))
    const view = await t.run(Usage.use((u) => u.refresh(true)))
    expect(view.auth).toBe('apiKey')
    expect(view.limits).toBe(false)
    expect(view.windows).toEqual([])
    expect(view.cost.today).toBeCloseTo(0.25)
    expect(view.cost.month).toBeCloseTo(0.25)
    expect(t.fake.usageReads).toHaveLength(0)
    await t.runtime.dispose()
  })

  test('a chat’s share of the week, estimated from readings around its replies', async () => {
    let n = 0
    const week = Date.now() + 5 * 24 * H
    const t = setup(reply, {
      usage: () => ({ rate_limits_available: true, subscription_type: 'max', rate_limits: { seven_day: { utilization: n++ === 0 ? 20 : 26, resets_at: new Date(week).toISOString() } } })
    })
    await t.run(Usage.use((u) => u.refresh(true)))
    await new Promise((r) => setTimeout(r, 5))
    const { session, assistant } = await start(t, 'Hi')
    await until(() => done(t, assistant.id))
    // Read again after the reply (the debounce is 0 here; a read is due after 20 s, so force it).
    await t.run(Db.use((db) => db.use((d) => d.addUsageSample({ window: 'seven_day', percent: 26, resetsAt: week, at: Date.now() + 1000, source: 'meter' }))))
    const share = await t.run(Usage.use((u) => u.share({ keys: [session.id] })))
    expect(share.window).toBe('seven_day')
    expect(share.estimate).toBe(true)
    expect(share.percent).toBeCloseTo(6)
    expect(share.total).toBe(26)
    expect(shareLabel(share)).toBe('about 6% of this week')
    await t.runtime.dispose()
  })
})
