// The tables behind long-running replies (agent/watch.ts), part of the Db repository: progress
// notes by chat, and the record of every pause for being stuck. Kept out of Db.ts so that file
// only gains the migration and one line.
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

interface NoteRow {
  session_id: string
  message_id: string
  step: number
  done: string
  left_to_do: string
  closer: string
  verdict: string
  confidence: number
  created_at: number
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

type Run = (sql: string, ...params: SQLInputValue[]) => unknown
type All = <T>(sql: string, ...params: SQLInputValue[]) => T[]

export const stuckStore = (run: Run, all: All) => ({
  addProgressNote: (n: ProgressNote) => {
    run(
      `insert into progress_notes (session_id, message_id, step, done, left_to_do, closer, verdict, confidence, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      n.sessionId,
      n.messageId,
      n.step,
      n.done,
      n.left,
      n.closer,
      n.verdict,
      n.confidence,
      n.createdAt
    )
  },
  /** A chat's latest progress notes, oldest first. */
  progressNotes: (sessionId: string, limit: number): ProgressNote[] =>
    all<NoteRow>('select * from progress_notes where session_id = ? order by id desc limit ?', sessionId, limit)
      .reverse()
      .map((r) => ({
        sessionId: r.session_id,
        messageId: r.message_id,
        step: r.step,
        done: r.done,
        left: r.left_to_do,
        closer: r.closer as Closer,
        verdict: r.verdict as ProgressNote['verdict'],
        confidence: r.confidence,
        createdAt: r.created_at
      })),
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
  stuckPauses: (limit = 500): StuckPause[] =>
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
})
