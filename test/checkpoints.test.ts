// Checkpoints, phase 4's second half: progress notes as job notes (and the move of the old
// progress_notes table into them), the primary bot as judge with the small model to fall back on,
// and the read of stuck_pauses that tuning the thresholds starts from.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, makeDb } from '../src/main/services/Db'
import {
  CHECKPOINT_KEEP,
  PROGRESS_NOTES_MIGRATION,
  checkpointBody,
  pauseTuning,
  readCheckpoint
} from '../src/main/services/stuckStore'
import { JUDGE_INSTRUCTIONS, type PrimaryContext, judgeModel, primaryJudge, primaryJudgeInstructions, primaryJudgePrompt, smallModelJudge } from '../src/main/agent/judge'
import { jobNotesBlock } from '../src/main/agent/notes'
import type { JudgeInput, ProgressNote } from '../src/main/agent/watch'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomo-checkpoints-'))
  dirs.push(dir)
  return join(dir, 'chat.db')
}

const note = (over: Partial<ProgressNote> = {}): ProgressNote => ({
  sessionId: 's1',
  messageId: 'm1',
  step: 30,
  done: 'Read the first 30 pages',
  left: 'Read the rest and sum up',
  closer: 'closer',
  verdict: 'progressing',
  confidence: 0.95,
  createdAt: 1000,
  ...over
})

describe('progress notes as job notes', () => {
  test('a checkpoint lands in the job’s notes as a progress note any bot on the job reads, and in recall', () => {
    const db = makeDb(tempFile())
    const { job, thread } = db.createJob({ title: 'Read the report', botId: db.primaryBot().id })
    db.addProgressNote(job.id, note({ sessionId: thread.id }))
    const [n] = db.jobNotes(job.id)
    expect(n).toMatchObject({
      type: 'progress',
      scope: 'job',
      scopeId: job.id,
      writer: 'bot',
      title: 'Checkpoint at step 30',
      body: 'Done: Read the first 30 pages | Left: Read the rest and sum up | getting closer; judged progressing (95% sure)'
    })
    const day = new Date(n!.updatedAt).toISOString().slice(0, 10)
    expect(jobNotesBlock(db.jobNotes(job.id))).toContain(`Progress:\n- (${day}) Checkpoint at step 30: Done: Read the first 30 pages`)
    expect(db.recall('pages report', { jobId: job.id }).map((h) => h.title)).toEqual(['Checkpoint at step 30'])
    // Read back for the next checkpoint, as written, with its thread and reply.
    expect(db.progressNotes(job.id, thread.id, 3)).toEqual([note({ sessionId: thread.id, createdAt: n!.updatedAt })])
    // Another thread's checkpoints on the job aren't this reply's earlier notes.
    expect(db.progressNotes(job.id, 'another-thread', 3)).toEqual([])
    db.close()
  })

  test('only the latest checkpoints stay in the notes; the older ones stay in the history; other notes are untouched', () => {
    const db = makeDb(tempFile())
    const { job, thread } = db.createJob({ title: 'Long job', botId: db.primaryBot().id })
    db.writeNote(job.id, { kind: 'progress', text: 'The bot’s own progress note', title: 'Halfway' }, { sessionId: thread.id })
    for (let step = 30; step <= 100; step += 10) db.addProgressNote(job.id, note({ sessionId: thread.id, step }))
    const notes = db.jobNotes(job.id)
    expect(notes.map((n) => n.title)).toEqual(['Halfway', ...[60, 70, 80, 90, 100].map((s) => `Checkpoint at step ${s}`)])
    expect(notes.filter((n) => n.title.startsWith('Checkpoint'))).toHaveLength(CHECKPOINT_KEEP)
    expect(db.progressNotes(job.id, thread.id, 3).map((n) => n.step)).toEqual([80, 90, 100])
    // The hidden ones (steps 30 to 50, the records after "Halfway") are closed by a later revision, not deleted.
    const first = notes[0]!.id + 1
    expect(db.getRecord(first)).toBeUndefined()
    expect(db.recordVersions(first)).toMatchObject([{ body: expect.stringContaining('Done: Read the first 30 pages'), removedRev: expect.any(Number) }])
    db.close()
  })

  test('a note edited out of shape is still read, whole, as what was done', () => {
    expect(readCheckpoint({ title: 'Checkpoint at step 45', body: 'Got through half', sessionId: 's', note: null, createdAt: 5 })).toEqual({
      sessionId: 's',
      messageId: '',
      step: 45,
      done: 'Got through half',
      left: '',
      closer: 'same',
      verdict: 'unclear',
      confidence: 0,
      createdAt: 5
    })
    for (const closer of ['closer', 'same', 'further'] as const)
      expect(readCheckpoint({ title: 'Checkpoint at step 9', body: checkpointBody(note({ closer, verdict: 'stuck', confidence: 0.912 })), sessionId: 's1', note: 'Checkpoint on reply m1', createdAt: 1000 })).toEqual(
        note({ step: 9, closer, verdict: 'stuck', confidence: 0.91 })
      )
  })
})

describe('the move of progress_notes into job notes', () => {
  test('each note of a chat on a job becomes a checkpoint note of that job, as written then; the table goes', () => {
    const file = tempFile()
    const raw = new DatabaseSync(file)
    const at = MIGRATIONS.indexOf(PROGRESS_NOTES_MIGRATION)
    // Every migration before it has run; later ones (workers) run when the app opens the file.
    expect(at).toBeGreaterThan(0)
    for (const [i, sql] of MIGRATIONS.slice(0, at).entries()) {
      raw.exec(sql)
      raw.exec(`pragma user_version = ${i + 1}`)
    }
    raw.exec(`
      insert into jobs (id, title, status, owner_bot_id, created_at, updated_at) values ('j1', 'Tidy the photos', 'open', 'tomo', 1, 1);
      insert into sessions (id, title, root_id, created_at, updated_at, bot_id, job_id, kind) values ('s1', 'Tidy the photos', 'r1', 1, 1, 'tomo', 'j1', 'shared');
      insert into sessions (id, title, root_id, created_at, updated_at, bot_id, job_id, kind) values ('p', 'Tomo', 'rp', 1, 1, 'tomo', null, 'primary');
      insert into memory_revisions (kind, writer, session_id, note, created_at) values ('edited', 'user', null, null, 50);
      insert into memory_records (type, title, aliases, scope, scope_id, created_at) values ('person', '', '[]', 'profile', null, 50);
      insert into memory_versions (record_id, body, added_rev, writer, created_at) values (1, 'Likes tea.', 1, 'user', 50);
      insert into progress_notes (session_id, message_id, step, done, left_to_do, closer, verdict, confidence, created_at) values
        ('s1', 'm1', 30, 'Sorted 2019', '2020 to 2024', 'closer', 'progressing', 0.95, 100),
        ('p', 'm2', 30, 'Lost', 'Everything', 'same', 'unclear', 0.4, 150),
        ('s1', 'm1', 45, 'Sorted 2020', '2021 to 2024', 'further', 'unclear', 0.555, 200);`)
    raw.close()

    const db = makeDb(file)
    expect(db.jobNotes('j1').map((n) => [n.type, n.title, n.body, n.writer, n.updatedAt])).toEqual([
      ['progress', 'Checkpoint at step 30', 'Done: Sorted 2019 | Left: 2020 to 2024 | getting closer; judged progressing (95% sure)', 'bot', 100],
      ['progress', 'Checkpoint at step 45', 'Done: Sorted 2020 | Left: 2021 to 2024 | further away; judged unclear (56% sure)', 'bot', 200]
    ])
    // They read back as the notes they were.
    expect(db.progressNotes('j1', 's1', 3)).toEqual([
      { sessionId: 's1', messageId: 'm1', step: 30, done: 'Sorted 2019', left: '2020 to 2024', closer: 'closer', verdict: 'progressing', confidence: 0.95, createdAt: 100 },
      { sessionId: 's1', messageId: 'm1', step: 45, done: 'Sorted 2020', left: '2021 to 2024', closer: 'further', verdict: 'unclear', confidence: 0.56, createdAt: 200 }
    ])
    // The profile and its revision are as they were; the moved notes are revisions after it.
    expect(db.profile().map((r) => r.body)).toEqual(['Likes tea.'])
    expect(db.memoryRev()).toBe(3)
    expect(db.recall('sorted', { jobId: 'j1' })).toHaveLength(2)
    // New notes and records carry on after the moved ones.
    db.addProgressNote('j1', note({ sessionId: 's1', step: 60 }))
    expect(db.jobNotes('j1').map((n) => n.title)).toEqual(['Checkpoint at step 30', 'Checkpoint at step 45', 'Checkpoint at step 60'])
    db.close()
    const check = new DatabaseSync(file, { readOnly: true })
    expect(check.prepare(`select count(*) as n from sqlite_master where name = 'progress_notes'`).get()).toEqual({ n: 0 })
    check.close()
  })
})

describe('the primary as judge', () => {
  const ctx = (over: Partial<PrimaryContext> = {}): PrimaryContext => ({
    name: 'Tomo',
    instructions: 'Be brief. Call me Sam.',
    worker: null,
    job: { title: 'Tidy the photos', summary: 'Sorting by year, up to 2020.' },
    notes: [
      { id: 1, type: 'decision', title: 'Folders', aliases: [], scope: 'job', scopeId: 'j1', body: 'One folder per year.', links: [], versions: 1, writer: 'bot', createdAt: 0, updatedAt: 0 }
    ],
    ...over
  })
  const input: JudgeInput = {
    task: 'Sort my photos',
    step: 40,
    trail: ['[39] move {"file":"a.jpg"} → ok'],
    notes: [note({ step: 30 })]
  }
  const REPLY = '{"done":"Sorted 2019","left":"The rest","closer":"same","verdict":"unclear","confidence":0.6,"nudge":"Do one year at a time."}'

  test('it speaks as the primary bot, with its instructions, and reads the job’s title, summary and notes', () => {
    const system = primaryJudgeInstructions(ctx())
    expect(system.startsWith("You are Tomo, the user's primary assistant")).toBe(true)
    expect(system).toContain('You are working through a long job')
    expect(system).toContain('<instructions>\nBe brief. Call me Sam.\n</instructions>')
    expect(system).toContain('"verdict": "progressing" | "unclear" | "stuck"')
    expect(system).toContain('Say stuck only when you are sure')
    // Another bot at work, and a primary without instructions.
    const other = primaryJudgeInstructions(ctx({ worker: 'Scout', instructions: '  ' }))
    expect(other).toContain('Scout, one of the user\'s bots, is working through a long job')
    expect(other).not.toContain('<instructions>')
    const prompt = primaryJudgePrompt(ctx(), input)
    expect(prompt.startsWith('<job>\nTitle: Tidy the photos\n\nWhere it stands: Sorting by year, up to 2020.\n\nNotes on this job so far')).toBe(true)
    expect(prompt).toContain('- (1970-01-01) Folders: One folder per year.')
    expect(prompt).toContain('</job>\n\n<task>\nSort my photos\n</task>')
    expect(prompt).toContain('- At step 30: done: Read the first 30 pages')
    expect(prompt).toContain('[39] move {"file":"a.jpg"} → ok')
    expect(primaryJudgePrompt(ctx({ job: null, notes: [] }), input).startsWith('<job>\nThis reply is not on a job.\n</job>')).toBe(true)
  })

  test('its model: the primary’s own, Sonnet in place of Opus or Fable, none without a Claude model', () => {
    expect(judgeModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(judgeModel('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(judgeModel('claude-opus-5-5')).toBe('claude-sonnet-5-5')
    expect(judgeModel('claude-fable-5-2')).toBe('claude-sonnet-5-5')
    expect(judgeModel('deepseek/deepseek-v4.1-flash')).toBeNull()
    expect(judgeModel(null)).toBeNull()
  })

  /** A judge whose primary and small-model calls are logged and answered by `answer`. */
  const judgeWith = (answer: (model: string, system: string) => string | Error, over: { model?: string | null; context?: () => PrimaryContext | null } = {}) => {
    const asked: Array<{ model: string; system: string; prompt: string }> = []
    const ask = async (model: string, system: string, prompt: string) => {
      asked.push({ model, system, prompt })
      const a = answer(model, system)
      if (a instanceof Error) throw a
      return a
    }
    const judge = primaryJudge({
      model: over.model === undefined ? 'claude-sonnet-5-5' : over.model,
      context: over.context ?? (() => ctx()),
      ask,
      fallback: smallModelJudge((system, prompt) => ask('claude-haiku-5-5', system, prompt))
    })
    return { judge, asked }
  }

  test('its verdict is read as the small model’s was; a nudge to another bot says it is from the primary', async () => {
    const { judge, asked } = judgeWith(() => REPLY)
    expect(await judge.judge(input, new AbortController().signal)).toEqual({
      verdict: 'unclear',
      confidence: 0.6,
      closer: 'same',
      done: 'Sorted 2019',
      left: 'The rest',
      why: undefined,
      nudge: 'Do one year at a time.'
    })
    expect(asked.map((a) => a.model)).toEqual(['claude-sonnet-5-5'])
    const scout = judgeWith(() => REPLY, { context: () => ctx({ worker: 'Scout' }) })
    expect((await scout.judge.judge(input, new AbortController().signal))?.nudge).toBe('Tomo, checking in: Do one year at a time.')
  })

  test('falls back to the small model when the primary’s call fails, replies out of shape, or there is no model or context', async () => {
    const small = (model: string, system: string) => (system === JUDGE_INSTRUCTIONS ? REPLY.replace('unclear', 'progressing') : model === 'claude-sonnet-5-5' ? new Error('overloaded') : 'no')
    for (const [what, t] of [
      ['a failed call', judgeWith(small)],
      ['a reply out of shape', judgeWith((_m, s) => (s === JUDGE_INSTRUCTIONS ? REPLY.replace('unclear', 'progressing') : 'I think it is fine'))],
      ['no Claude model', judgeWith(small, { model: null })],
      ['no context', judgeWith(small, { context: () => null })],
      [
        'a context that throws',
        judgeWith(small, {
          context: () => {
            throw new Error('db closed')
          }
        })
      ]
    ] as const) {
      expect((await t.judge.judge(input, new AbortController().signal))?.verdict, what).toBe('progressing')
      expect(t.asked.at(-1), what).toMatchObject({ model: 'claude-haiku-5-5', system: JUDGE_INSTRUCTIONS })
    }
  })

  test('a cancelled checkpoint asks nobody else', async () => {
    const abort = new AbortController()
    const { judge, asked } = judgeWith(() => {
      abort.abort()
      return new Error('aborted')
    })
    await expect(judge.judge(input, abort.signal)).rejects.toThrow('aborted')
    expect(asked).toHaveLength(1)
  })
})

describe('tuning data from stuck_pauses', () => {
  test('per signal: pauses, resumed, and resumed within 30 s, as a likely false alarm', () => {
    const p = (signal: 'same_result' | 'alternating' | 'no_progress', createdAt: number, resumedAt: number | null) => ({ signal, createdAt, resumedAt })
    expect(
      pauseTuning([
        p('same_result', 0, 5_000),
        p('same_result', 0, 30_000),
        p('same_result', 0, 30_001),
        p('same_result', 0, null),
        p('alternating', 0, 1_000),
        p('no_progress', 100, null)
      ])
    ).toEqual([
      { signal: 'same_result', pauses: 4, resumed: 3, resumedQuickly: 2, falseAlarmRate: 0.5 },
      { signal: 'alternating', pauses: 1, resumed: 1, resumedQuickly: 1, falseAlarmRate: 1 },
      { signal: 'no_progress', pauses: 1, resumed: 0, resumedQuickly: 0, falseAlarmRate: 0 }
    ])
    expect(pauseTuning([])).toEqual([])
    // The window can be set.
    expect(pauseTuning([p('same_result', 0, 5_000)], 1_000)[0]).toMatchObject({ resumed: 1, resumedQuickly: 0 })
  })

  test('read from chat.db: every pause recorded, with when Continue resumed it', () => {
    const db = makeDb(tempFile())
    const s = db.createSession({ title: 'x', model: null, systemPrompt: null, forkedFromSessionId: null })
    db.recordPause({ sessionId: s.id, messageId: 'a', signal: 'same_call', reason: 'r', step: 5 }, 1_000)
    db.recordPause({ sessionId: s.id, messageId: 'b', signal: 'same_call', reason: 'r', step: 5 }, 1_000)
    db.recordPause({ sessionId: s.id, messageId: 'c', signal: 'repeated_text', reason: 'r', step: 2 }, 1_000)
    db.resumePause('a', 11_000)
    db.resumePause('b', 600_000)
    expect(db.stuckTuning()).toEqual([
      { signal: 'same_call', pauses: 2, resumed: 2, resumedQuickly: 1, falseAlarmRate: 0.5 },
      { signal: 'repeated_text', pauses: 1, resumed: 0, resumedQuickly: 0, falseAlarmRate: 0 }
    ])
    db.close()
  })
})
