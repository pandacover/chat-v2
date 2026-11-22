// The data behind long-running replies (agent/watch.ts), part of the Db repository: the progress
// notes checkpoints write, kept as the job's notes (kind progress, in memoryStore), and the record
// of every pause for being stuck, with what tuning the thresholds reads from it. Kept out of Db.ts
// so that file only gains the migration and one line.
import type { SQLInputValue } from 'node:sqlite'
import type { Signal } from '../agent/stuck'
import type { Closer, Pause, ProgressNote } from '../agent/watch'

export interface StuckPause extends Pause {
  id: number
  sessionId: string
  messageId: string
  createdAt: number
  /** When Continue resumed it; null if it never was. */
  resumedAt: number | null
}

interface PauseRow {
  id: number
  session_id: string
  message_id: string
  signal: string
  step: number
  reason: string
  created_at: number
  resumed_at: number | null
}

// A checkpoint's note is a job note of kind progress that any bot on the job, and the primary,
// reads as written: "Checkpoint at step 30" over "Done: … | Left: … | getting closer; judged
// progressing (95% sure)". The same text is read back for the next checkpoint's judge.

/** How checkpoint notes are titled; the step follows. */
export const CHECKPOINT_PREFIX = 'Checkpoint at step '
/** Checkpoint notes a job keeps in its notes; older ones are hidden (they stay in the history). */
export const CHECKPOINT_KEEP = 5
/** The revision note a checkpoint note is saved with, naming its reply. */
const REPLY_NOTE = 'Checkpoint on reply '

const CLOSER_WORDS: Record<Closer, string> = { closer: 'getting closer', same: 'no closer', further: 'further away' }

export const checkpointTitle = (step: number) => `${CHECKPOINT_PREFIX}${step}`
export const checkpointBody = (n: Pick<ProgressNote, 'done' | 'left' | 'closer' | 'verdict' | 'confidence'>) =>
  `Done: ${n.done} | Left: ${n.left} | ${CLOSER_WORDS[n.closer]}; judged ${n.verdict} (${Math.round(n.confidence * 100)}% sure)`

const BODY = /^Done: ([\s\S]*) \| Left: ([\s\S]*) \| (getting closer|no closer|further away); judged (progressing|unclear|stuck) \((\d+)% sure\)$/

/** A checkpoint note read back; a body edited out of shape is kept whole as what was done. */
export const readCheckpoint = (r: { title: string; body: string; sessionId: string; note: string | null; createdAt: number }): ProgressNote => {
  const step = Number(/(\d+)/.exec(r.title.slice(CHECKPOINT_PREFIX.length))?.[1] ?? 0)
  const messageId = r.note?.startsWith(REPLY_NOTE) ? r.note.slice(REPLY_NOTE.length) : ''
  const m = BODY.exec(r.body)
  const closer = (Object.keys(CLOSER_WORDS) as Closer[]).find((c) => CLOSER_WORDS[c] === m?.[3]) ?? 'same'
  return m
    ? { sessionId: r.sessionId, messageId, step, done: m[1]!, left: m[2]!, closer, verdict: m[4] as ProgressNote['verdict'], confidence: Number(m[5]) / 100, createdAt: r.createdAt }
    : { sessionId: r.sessionId, messageId, step, done: r.body, left: '', closer: 'same', verdict: 'unclear', confidence: 0, createdAt: r.createdAt }
}

/**
 * Moves the progress notes of phase 4's first cut (a table by chat) into the notes of each chat's
 * job, as checkpoint notes written then, one revision each; notes of a chat with no job go. Then
 * drops the table. Appended to Db's MIGRATIONS: never edit it once released.
 */
export const PROGRESS_NOTES_MIGRATION = `
  create temp table moved_notes as
    select p.*, s.job_id,
           (select coalesce(max(id), 0) from memory_records) + row_number() over (order by p.id) as record_id,
           (select coalesce(max(rev), 0) from memory_revisions) + row_number() over (order by p.id) as rev
      from progress_notes p join sessions s on s.id = p.session_id join jobs j on j.id = s.job_id;
  insert into memory_revisions (rev, kind, writer, session_id, note, created_at)
    select rev, 'noted', 'bot', session_id, '${REPLY_NOTE}' || message_id, created_at from moved_notes order by rev;
  insert into memory_records (id, type, title, aliases, scope, scope_id, created_at)
    select record_id, 'progress', '${CHECKPOINT_PREFIX}' || step, '[]', 'job', job_id, created_at from moved_notes order by record_id;
  insert into memory_versions (record_id, body, added_rev, removed_rev, writer, source_job_id, source_session_id, created_at)
    select record_id,
           'Done: ' || done || ' | Left: ' || left_to_do || ' | ' ||
             case closer when 'closer' then 'getting closer' when 'further' then 'further away' else 'no closer' end ||
             '; judged ' || verdict || ' (' || cast(round(confidence * 100) as integer) || '% sure)',
           rev, null, 'bot', job_id, session_id, created_at
      from moved_notes order by record_id;
  drop table moved_notes;
  drop table progress_notes;`

/** How often pauses of one signal were resumed, and how often right away (a likely false alarm). */
export interface SignalTuning {
  signal: Signal
  pauses: number
  /** Continued at all. */
  resumed: number
  /** Continued within the quick window of the pause. */
  resumedQuickly: number
  /** resumedQuickly / pauses: the share of this signal's pauses that were likely false alarms. */
  falseAlarmRate: number
}

/** A pause resumed within this long was likely a false alarm: the user saw nothing wrong. */
export const QUICK_RESUME_MS = 30_000

/**
 * Per signal, how many pauses there were and how many were resumed right away: the numbers to
 * tune stuck.ts's thresholds by. Most pauses first.
 */
export const pauseTuning = (pauses: readonly Pick<StuckPause, 'signal' | 'createdAt' | 'resumedAt'>[], quickMs = QUICK_RESUME_MS): SignalTuning[] => {
  const by = new Map<Signal, SignalTuning>()
  for (const p of pauses) {
    const t = by.get(p.signal) ?? { signal: p.signal, pauses: 0, resumed: 0, resumedQuickly: 0, falseAlarmRate: 0 }
    t.pauses++
    if (p.resumedAt !== null) {
      t.resumed++
      if (p.resumedAt - p.createdAt <= quickMs) t.resumedQuickly++
    }
    by.set(p.signal, t)
  }
  return [...by.values()]
    .map((t) => ({ ...t, falseAlarmRate: t.resumedQuickly / t.pauses }))
    .sort((a, b) => b.pauses - a.pauses || a.signal.localeCompare(b.signal))
}

type Run = (sql: string, ...params: SQLInputValue[]) => unknown
type All = <T>(sql: string, ...params: SQLInputValue[]) => T[]
/** memoryStore.writeCheckpointNote. */
type WriteCheckpoint = (
  jobId: string,
  note: { title: string; text: string },
  origin: { sessionId: string | null; note: string | null },
  opts: { prefix: string; keep: number }
) => unknown

export const stuckStore = (run: Run, all: All, writeCheckpoint: WriteCheckpoint) => {
  const stuckPauses = (limit = 500): StuckPause[] =>
    all<PauseRow>('select * from stuck_pauses order by id desc limit ?', limit).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      messageId: r.message_id,
      signal: r.signal as Signal,
      step: r.step,
      reason: r.reason,
      createdAt: r.created_at,
      resumedAt: r.resumed_at
    }))
  return {
    /** A checkpoint's note, into the notes of the reply's job. */
    addProgressNote: (jobId: string, n: ProgressNote) => {
      writeCheckpoint(
        jobId,
        { title: checkpointTitle(n.step), text: checkpointBody(n) },
        { sessionId: n.sessionId, note: `${REPLY_NOTE}${n.messageId}` },
        { prefix: CHECKPOINT_PREFIX, keep: CHECKPOINT_KEEP }
      )
    },
    /** The latest checkpoint notes a thread of the job wrote (of those the job still shows), oldest first. */
    progressNotes: (jobId: string, sessionId: string, limit: number): ProgressNote[] =>
      all<{ title: string; body: string; source_session_id: string; note: string | null; updated_at: number }>(
        `select c.title, c.body, c.source_session_id, r.note, c.updated_at
           from memory_current c join memory_versions v on v.id = c.version_id left join memory_revisions r on r.rev = v.added_rev
          where c.scope = 'job' and c.scope_id = ? and c.type = 'progress' and substr(c.title, 1, ?) = ? and c.source_session_id = ?
          order by c.id desc limit ?`,
        jobId,
        CHECKPOINT_PREFIX.length,
        CHECKPOINT_PREFIX,
        sessionId,
        limit
      )
        .reverse()
        .map((r) => readCheckpoint({ title: r.title, body: r.body, sessionId: r.source_session_id, note: r.note, createdAt: r.updated_at })),
    recordPause: (p: Pause & { sessionId: string; messageId: string }, at: number) => {
      run(
        'insert into stuck_pauses (session_id, message_id, signal, step, reason, created_at) values (?, ?, ?, ?, ?, ?)',
        p.sessionId,
        p.messageId,
        p.signal,
        p.step,
        p.reason,
        at
      )
    },
    /** Continue was pressed on a paused reply: its latest pause was resumed. */
    resumePause: (messageId: string, at: number) => {
      run(
        `update stuck_pauses set resumed_at = ?
         where id = (select id from stuck_pauses where message_id = ? and resumed_at is null order by id desc limit 1)`,
        at,
        messageId
      )
    },
    /** Every pause, newest first: what tuning the thresholds reads. */
    stuckPauses,
    /** pauseTuning over every recorded pause. */
    stuckTuning: (quickMs = QUICK_RESUME_MS): SignalTuning[] => pauseTuning(stuckPauses(100_000), quickMs)
  }
}
