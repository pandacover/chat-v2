// The daily reconciler's tables in chat.db (see reconciler.ts): a row per run, and which finished
// jobs it has read (and as of when, so a job reopened and finished again is read again). Also what a
// run reads: the jobs, with their archive summary, notes and the end of their thread. Kept out of
// Db.ts so that file only gains the migration and one line.
import type { SQLInputValue } from 'node:sqlite'
import { summarizeSteps } from '@shared/steps'
import type { PathNode, ReconcilerRun, Session } from '@shared/types'
import type { ReconcileJob } from '../reconciler'

/** Appended to Db's MIGRATIONS: never edit it once released, add a migration instead. */
export const RECONCILER_MIGRATION = `create table reconciler_runs (
    id integer primary key autoincrement,
    started_at integer not null,
    finished_at integer,
    trigger text not null,
    outcome text not null default 'running',
    rev integer,
    model text,
    jobs integer not null default 0,
    changes text not null default '[]',
    dropped integer not null default 0,
    detail text
  );
  create table reconciled_jobs (
    job_id text primary key references jobs(id) on delete cascade,
    job_updated_at integer not null,
    run_id integer not null
  );`

/** Of a job's thread, the reconciler reads this many of the last messages, */
const TURNS = 16
/** what the user wrote up to this many characters (corrections are there), */
const USER_CHARS = 800
/** and the start of each reply. */
const REPLY_CHARS = 300

interface RunRow {
  id: number
  started_at: number
  finished_at: number | null
  trigger: string
  outcome: string
  rev: number | null
  model: string | null
  jobs: number
  changes: string
  dropped: number
  detail: string | null
}

const toRun = (r: RunRow): ReconcilerRun => ({
  id: r.id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  trigger: r.trigger === 'manual' ? 'manual' : 'idle',
  outcome: r.outcome as ReconcilerRun['outcome'],
  rev: r.rev,
  model: r.model,
  jobs: r.jobs,
  changes: (() => {
    try {
      return JSON.parse(r.changes) as string[]
    } catch {
      return []
    }
  })(),
  dropped: r.dropped,
  detail: r.detail
})

export interface ReconcilerDbDeps {
  all: <T>(sql: string, ...params: SQLInputValue[]) => T[]
  one: <T>(sql: string, ...params: SQLInputValue[]) => T | undefined
  run: (sql: string, ...params: SQLInputValue[]) => unknown
  transaction: <A>(f: () => A) => A
  getSession: (id: string) => Session | undefined
  activePath: (session: Session) => PathNode[]
}

// Finished jobs it hasn't read since they last changed.
const PENDING = `from jobs j where j.status = 'done'
    and not exists (select 1 from reconciled_jobs r where r.job_id = j.id and r.job_updated_at >= j.updated_at)
    and exists (select 1 from sessions s join messages m on m.session_id = s.id where s.job_id = j.id and m.role = 'user')`

const clip = (text: string, n: number) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

export const makeReconcilerDb = ({ all, one, run, transaction, getSession, activePath }: ReconcilerDbDeps) => ({
  startReconcilerRun: (trigger: 'idle' | 'manual', model: string, now = Date.now()): number =>
    Number(
      (run(`insert into reconciler_runs (started_at, trigger, model) values (?, ?, ?)`, now, trigger, model) as { lastInsertRowid: number | bigint })
        .lastInsertRowid
    ),

  /** Ends a run; jobs read (with the time each had changed) are marked so the next run skips them. */
  finishReconcilerRun: (
    id: number,
    end: { outcome: Exclude<ReconcilerRun['outcome'], 'running'>; rev: number | null; jobs: Array<{ id: string; updatedAt: number }>; read: boolean; changes: string[]; dropped: number; detail: string | null },
    now = Date.now()
  ) =>
    transaction(() => {
      run(
        `update reconciler_runs set finished_at = ?, outcome = ?, rev = ?, jobs = ?, changes = ?, dropped = ?, detail = ? where id = ?`,
        now,
        end.outcome,
        end.rev,
        end.jobs.length,
        JSON.stringify(end.changes),
        end.dropped,
        end.detail,
        id
      )
      if (end.read)
        for (const j of end.jobs)
          run(
            `insert into reconciled_jobs (job_id, job_updated_at, run_id) values (?, ?, ?)
             on conflict(job_id) do update set job_updated_at = excluded.job_updated_at, run_id = excluded.run_id`,
            j.id,
            j.updatedAt,
            id
          )
    }),

  lastReconcilerRun: (): ReconcilerRun | null => {
    const row = one<RunRow>('select * from reconciler_runs order by id desc limit 1')
    return row ? toRun(row) : null
  },

  /** Runs the app quit in the middle of: over, unfinished. */
  endStaleReconcilerRuns: (now = Date.now()): number =>
    Number(
      (run(`update reconciler_runs set finished_at = ?, outcome = 'error', detail = 'Cut off when the app quit.' where outcome = 'running'`, now) as { changes: number | bigint })
        .changes
    ),

  pendingReconcileCount: (): number => one<{ n: number }>(`select count(*) as n ${PENDING}`)?.n ?? 0,

  /** When anything was last written in any thread: the app counts as idle a while after. */
  lastActivityAt: (): number | null => one<{ at: number | null }>(`select max(created_at) as at from messages where role != 'root'`)?.at ?? null,

  anyStreaming: (): boolean => !!one(`select 1 from messages where status = 'streaming' limit 1`),

  /**
   * The finished jobs a run reads, newest first, as reconciler.ts takes them. Messages from before
   * the last purge are left out: what the user had deleted for good isn't read back from the thread.
   */
  jobsToReconcile: (limit: number): Array<ReconcileJob & { updatedAt: number }> => {
    const purgedAt = one<{ at: number | null }>(`select max(created_at) as at from memory_revisions where kind = 'purged'`)?.at ?? 0
    const jobs = all<{ id: string; title: string; summary: string | null; owner_bot_id: string | null; bot_name: string | null; updated_at: number }>(
      `select j.id, j.title, j.summary, j.owner_bot_id, b.name as bot_name, j.updated_at ${PENDING.replace('from jobs j', 'from jobs j left join bots b on b.id = j.owner_bot_id')}
        order by j.updated_at desc limit ?`,
      limit
    )
    return jobs.map((j) => {
      const thread = one<{ id: string }>(`select id from sessions where job_id = ? and kind = 'shared' order by created_at, rowid limit 1`, j.id)
      const session = thread ? getSession(thread.id) : undefined
      const archived = one<{ body: string }>(`select body from memory_current where scope = 'archive' and type = 'job' and scope_id = ?`, j.id)
      const notes = all<{ type: string; title: string; body: string }>(`select type, title, body from memory_current where scope = 'job' and scope_id = ? order by id`, j.id)
      const path = session ? activePath(session).filter((n) => n.message.role !== 'root' && n.message.createdAt > purgedAt) : []
      const turns = path.slice(-TURNS).flatMap((n) => {
        const m = n.message
        const text = m.role === 'user' ? clip(m.content, USER_CHARS) : clip(summarizeSteps(m.content), REPLY_CHARS)
        return text && (m.role === 'user' || m.role === 'assistant') ? [{ role: m.role, text }] : []
      })
      return {
        id: j.id,
        title: j.title,
        botId: j.owner_bot_id,
        botName: j.bot_name ?? 'Tomo',
        threadId: session?.id ?? null,
        finishedAt: j.updated_at,
        updatedAt: j.updated_at,
        summary: archived?.body ?? j.summary,
        notes: notes.map((n) => ({ kind: n.type, title: n.title, body: n.body })),
        turns
      }
    })
  },

  /** Every bot, the primary first, for its playbook. */
  playbookBots: (): Array<{ id: string; name: string; avatar: string | null }> =>
    all<{ id: string; name: string; avatar: string | null }>('select id, name, avatar from bots order by is_primary desc, created_at')
})
