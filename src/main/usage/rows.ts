// The usage tables of chat.db (see the migration in services/Db.ts): reply runs, window readings,
// and paused replies. Spread into the Db API.
import type { SQLInputValue } from 'node:sqlite'
import type { UsagePause } from '@shared/usage'
import type { Run, Sample } from './share'

interface Queries {
  all: <T>(sql: string, ...params: SQLInputValue[]) => T[]
  one: <T>(sql: string, ...params: SQLInputValue[]) => T | undefined
  run: (sql: string, ...params: SQLInputValue[]) => unknown
}

export interface NewRun {
  sessionId: string
  messageId: string | null
  auth: 'login' | 'apiKey' | null
  model: string | null
  startedAt: number
  endedAt: number
  cost: number
}

type PauseRow = { message_id: string; session_id: string; win: string | null; resets_at: number | null; resume_at: number; created_at: number }
const toPause = (r: PauseRow): UsagePause => ({
  messageId: r.message_id,
  sessionId: r.session_id,
  window: r.win,
  resetsAt: r.resets_at,
  resumeAt: r.resume_at,
  createdAt: r.created_at
})

export const usageRows = ({ all, one, run }: Queries) => ({
  addUsageRun: (r: NewRun) => {
    run(
      'insert into usage_runs (session_id, message_id, auth, model, started_at, ended_at, cost) values (?, ?, ?, ?, ?, ?, ?)',
      r.sessionId,
      r.messageId,
      r.auth,
      r.model,
      r.startedAt,
      r.endedAt,
      Number.isFinite(r.cost) ? r.cost : 0
    )
  },
  /** Runs that ended at or after `since`, keyed by their chat. */
  usageRuns: (since: number): Run[] =>
    all<{ session_id: string; started_at: number; ended_at: number; cost: number; model: string | null }>(
      'select session_id, started_at, ended_at, cost, model from usage_runs where ended_at >= ? order by started_at',
      since
    ).map((r) => ({ key: r.session_id, start: r.started_at, end: r.ended_at, cost: r.cost, model: r.model })),
  /** A job's threads: the sessions its replies ran in, which its usage runs are keyed by. */
  jobThreadIds: (jobId: string): string[] => all<{ id: string }>('select id from sessions where job_id = ?', jobId).map((r) => r.id),
  /** Dollars of runs since `since`, leaving out runs with `notAuth` (a plan's replies aren't billed by the dollar). */
  usageCost: (since: number, notAuth: string): number =>
    one<{ c: number | null }>("select sum(cost) as c from usage_runs where ended_at >= ? and coalesce(auth, '') != ?", since, notAuth)?.c ?? 0,
  addUsageSample: (s: Sample & { source: string }) => {
    run('insert into usage_samples (win, percent, resets_at, at, source) values (?, ?, ?, ?, ?)', s.window, s.percent, s.resetsAt, s.at, s.source)
  },
  usageSamples: (since: number): Sample[] =>
    all<{ win: string; percent: number; resets_at: number | null; at: number }>(
      'select win, percent, resets_at, at from usage_samples where at >= ? order by at',
      since
    ).map((r) => ({ window: r.win, percent: r.percent, resetsAt: r.resets_at, at: r.at })),
  /** The newest reading of each window. */
  latestUsageSamples: (): Array<Sample & { source: string }> =>
    all<{ win: string; percent: number; resets_at: number | null; at: number; source: string }>(
      `select win, percent, resets_at, at, source from usage_samples s
        where id = (select id from usage_samples t where t.win = s.win order by at desc, id desc limit 1)`
    ).map((r) => ({ window: r.win, percent: r.percent, resetsAt: r.resets_at, at: r.at, source: r.source })),
  pruneUsageSamples: (before: number) => {
    run('delete from usage_samples where at < ?', before)
  },
  setUsagePause: (p: UsagePause) => {
    run(
      `insert into usage_pauses (message_id, session_id, win, resets_at, resume_at, created_at) values (?, ?, ?, ?, ?, ?)
       on conflict(message_id) do update set win = excluded.win, resets_at = excluded.resets_at, resume_at = excluded.resume_at, created_at = excluded.created_at`,
      p.messageId,
      p.sessionId,
      p.window,
      p.resetsAt,
      p.resumeAt,
      p.createdAt
    )
  },
  usagePause: (messageId: string): UsagePause | null => {
    const r = one<PauseRow>('select * from usage_pauses where message_id = ?', messageId)
    return r ? toPause(r) : null
  },
  usagePauses: (): UsagePause[] => all<PauseRow>('select * from usage_pauses order by resume_at').map(toPause),
  /** Removes a pause; true when there was one. */
  deleteUsagePause: (messageId: string): boolean =>
    Number((run('delete from usage_pauses where message_id = ?', messageId) as { changes: number | bigint }).changes) > 0
})
