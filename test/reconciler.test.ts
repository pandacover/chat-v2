// The daily reconciler: planning from the model's reply (grounding, scopes, one change per record),
// the conflict rule, when a run is due, a whole run against a real chat.db with a fake model (one
// revision by 'reconciler', versions with their source job, playbooks, restore, purge), and the
// playbook reaching the bot's prompt.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRecord } from '../src/shared/types'
import {
  DAY_MS,
  IDLE_MS,
  MAX_CHANGES,
  RETRY_MS,
  STARTUP_GRACE_MS,
  type ReconcileInput,
  type ReconcileJob,
  datedCorrection,
  dueToRun,
  parseReconcileReply,
  playbookBlock,
  reconcilePrompt,
  resolveConflict
} from '../src/main/reconciler'
import { makeDb } from '../src/main/services/Db'
import { reconcileOnce } from '../src/main/services/Reconciler'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})
const openDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-reconciler-'))
  dirs.push(dir)
  return makeDb(join(dir, 'chat.db'))
}

const NOW = Date.UTC(2026, 10, 22, 12)

const record = (id: number, body: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id,
  type: 'preference',
  title: '',
  aliases: [],
  scope: 'profile',
  scopeId: null,
  body,
  links: [],
  versions: 1,
  writer: 'extractor',
  createdAt: NOW - DAY_MS * 10,
  updatedAt: NOW - DAY_MS * 10,
  ...over
})

const job = (id: string, over: Partial<ReconcileJob> = {}): ReconcileJob => ({
  id,
  title: 'Fix the invoice script',
  botId: 'tomo',
  botName: 'Tomo',
  threadId: `thread-${id}`,
  finishedAt: NOW - 60_000,
  summary: 'Rewrote the invoice script in Python; the user wanted no comments in the code.',
  notes: [{ kind: 'decision', title: 'Language', body: 'Python, as the user asked.' }],
  turns: [
    { role: 'user', text: 'Rewrite my invoice script.' },
    { role: 'assistant', text: 'Here it is, with comments on every line.' },
    { role: 'user', text: 'No, please never add comments to code. I use Python 3.12 at Acme.' }
  ],
  ...over
})

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  now: NOW,
  jobs: [job('j1')],
  profile: [record(1, 'Prefers detailed answers.'), record(2, 'Likes cats.'), record(3, 'Has a cat.')],
  playbooks: [{ botId: 'tomo', botName: 'Tomo', records: [record(10, 'Add a comment to every line of code.', { scope: 'bot', scopeId: 'tomo', type: 'procedure', updatedAt: NOW - DAY_MS })] }],
  ...over
})

const reply = (...changes: unknown[]) => JSON.stringify({ changes })

describe('reading the reply', () => {
  test('keeps changes that cite a job and say only what it says', () => {
    const r = parseReconcileReply(
      reply(
        { op: 'add', to: 'profile', text: 'Uses Python 3.12 at Acme', type: 'procedure', jobs: [1] },
        { op: 'add', to: 'profile', text: 'Lives in Lisbon.', jobs: [1] },
        { op: 'add', to: 'profile', text: 'Writes Python.', jobs: [] },
        { op: 'add', to: 'profile', text: 'Writes Python.', jobs: [7] }
      ),
      input()
    )!
    expect(r.plan.changes).toHaveLength(1)
    expect(r.plan.changes[0]!.puts).toEqual([
      { body: 'Uses Python 3.12 at Acme.', type: 'procedure', scope: 'profile', scopeId: null, jobId: 'j1', sessionId: 'thread-j1' }
    ])
    expect(r.dropped).toHaveLength(3)
    expect(r.dropped.join(' ')).toContain("naming things its jobs don't mention")
    // The reasons never quote the text, which could be sensitive.
    expect(r.dropped.join(' ')).not.toContain('Lisbon')
  })

  test('reads JSON wrapped in prose or a code fence, and returns null without any', () => {
    expect(parseReconcileReply('Sure:\n```json\n{"changes": []}\n```', input())).toEqual({ plan: { changes: [] }, dropped: [] })
    expect(parseReconcileReply('Nothing to change today.', input())).toBeNull()
    expect(parseReconcileReply('{not json}', input())).toBeNull()
  })

  test('a playbook lesson goes to the bot whose jobs it cites, and only one bot', () => {
    const two = input({ jobs: [job('j1'), job('j2', { botId: 'scout', botName: 'Scout' })] })
    const r = parseReconcileReply(
      reply(
        { op: 'add', to: 'playbook', text: 'Never add comments to code.', jobs: [1] },
        { op: 'add', to: 'playbook', text: 'Ask before rewriting a script.', jobs: [1, 2] }
      ),
      two
    )!
    expect(r.plan.changes.map((c) => c.puts[0]!.scopeId)).toEqual(['tomo'])
    expect(r.plan.changes[0]!.puts[0]).toMatchObject({ scope: 'bot', type: 'procedure', body: 'Never add comments to code.' })
    expect(r.dropped).toEqual(['A playbook lesson citing jobs of more than one bot, or of none'])
  })

  test('drops secrets, repeats of what memory has, and changes to records it was not shown', () => {
    const r = parseReconcileReply(
      reply(
        { op: 'add', to: 'profile', text: 'Has the api key sk-ant-abcdefgh12345', jobs: [1] },
        { op: 'add', to: 'profile', text: 'likes cats', jobs: [1] },
        { op: 'update', id: 99, text: 'Prefers short answers.', jobs: [1] },
        { op: 'remove', id: 500, reason: 'stale', jobs: [1] }
      ),
      input()
    )!
    expect(r.plan.changes).toEqual([])
    expect(r.dropped).toHaveLength(4)
  })

  test('a correction is a dated new version of the same record; a record changes once per run', () => {
    const r = parseReconcileReply(
      reply(
        { op: 'update', id: 10, text: 'Never add comments to code.', correction: true, jobs: [1] },
        { op: 'remove', id: 10, reason: 'superseded', jobs: [1] }
      ),
      input()
    )!
    expect(r.plan.changes).toHaveLength(1)
    expect(r.plan.changes[0]!.puts[0]).toMatchObject({ id: 10, base: 'Add a comment to every line of code.', body: 'Never add comments to code (corrected 2026-11-22).', scope: 'bot', scopeId: 'tomo' })
    expect(r.dropped).toHaveLength(1)
    // Corrected again later, it carries one date, the new one.
    expect(datedCorrection('Never add comments to code', NOW + DAY_MS)).toBe('Never add comments to code (corrected 2026-11-23).')
  })

  test('merging condenses examples into one trait under the oldest id; the rest are hidden', () => {
    const r = parseReconcileReply(reply({ op: 'merge', ids: [3, 2], text: 'Loves cats and has one.', jobs: [1] }), input())!
    expect(r.plan.changes).toEqual([
      {
        what: 'Merged 2 records in the profile into one',
        puts: [{ id: 2, base: 'Likes cats.', body: 'Loves cats and has one.', scope: 'profile', scopeId: null, jobId: 'j1', sessionId: 'thread-j1' }],
        closes: [{ id: 3, base: 'Has a cat.' }]
      }
    ])
    // Across the profile and a playbook it is a conflict, not a merge.
    expect(parseReconcileReply(reply({ op: 'merge', ids: [1, 10], text: 'Prefers detailed answers.', jobs: [1] }), input())!.plan.changes).toEqual([])
  })

  test('removing a duplicate needs the record it duplicates', () => {
    const r = parseReconcileReply(
      reply({ op: 'remove', id: 3, reason: 'duplicate', jobs: [1] }, { op: 'remove', id: 3, reason: 'duplicate', of: 2, jobs: [1] }),
      input()
    )!
    expect(r.plan.changes).toEqual([{ what: 'Removed a duplicate record from the profile', puts: [], closes: [{ id: 3, base: 'Has a cat.' }] }])
  })

  test('stops at the most changes one run may make', () => {
    const many = Array.from({ length: MAX_CHANGES + 5 }, (_, i) => ({ op: 'add', to: 'playbook', text: `Use python step ${i}`, jobs: [1] }))
    const r = parseReconcileReply(reply(...many), input({ jobs: [job('j1', { summary: Array.from({ length: 40 }, (_, i) => String(i)).join(' ') })] }))!
    expect(r.plan.changes.length).toBeLessThanOrEqual(MAX_CHANGES)
  })
})

describe('conflicts between the profile and a playbook', () => {
  const a = { id: 1, updatedAt: 100 }
  const b = { id: 2, updatedAt: 200 }

  test('an outright contradiction: the newer wins, the older is corrected', () => {
    expect(resolveConflict(a, b, { contradiction: true, keep: 'a' })).toEqual({ winner: b, loser: a, action: 'correct' })
    expect(resolveConflict(b, a, { contradiction: true, keep: null })).toEqual({ winner: b, loser: a, action: 'correct' })
    // Written at the same moment, the later record (higher id) is the newer.
    expect(resolveConflict({ id: 5, updatedAt: 1 }, { id: 4, updatedAt: 1 }, { contradiction: true, keep: null })!.winner.id).toBe(5)
  })

  test('a disagreement keeps the more useful one and prunes the other', () => {
    expect(resolveConflict(a, b, { contradiction: false, keep: 'a' })).toEqual({ winner: a, loser: b, action: 'prune' })
    expect(resolveConflict(a, b, { contradiction: false, keep: null })).toBeNull()
  })

  test('in a plan: the older playbook lesson gets a dated correction, whatever the model said to keep', () => {
    const lesson = record(10, 'Write detailed explanations.', { scope: 'bot', scopeId: 'tomo', updatedAt: NOW - DAY_MS * 20 })
    const fact = record(1, 'Prefers short answers.', { updatedAt: NOW - DAY_MS })
    const i = input({ profile: [fact], playbooks: [{ botId: 'tomo', botName: 'Tomo', records: [lesson] }] })
    const r = parseReconcileReply(reply({ op: 'conflict', profile: 1, playbook: 10, contradiction: true, keep: 'playbook', jobs: [1] }), i)!
    expect(r.plan.changes[0]!.puts).toEqual([
      { id: 10, base: 'Write detailed explanations.', body: 'Prefers short answers (corrected 2026-11-22).', scope: 'bot', scopeId: 'tomo', jobId: 'j1', sessionId: 'thread-j1' }
    ])
    const given = parseReconcileReply(reply({ op: 'conflict', profile: 1, playbook: 10, contradiction: true, correction: 'Keep explanations short.', jobs: [1] }), i)!
    expect(given.plan.changes[0]!.puts[0]!.body).toBe('Keep explanations short (corrected 2026-11-22).')
    const keepPlaybook = parseReconcileReply(reply({ op: 'conflict', profile: 1, playbook: 10, contradiction: false, keep: 'playbook', jobs: [1] }), i)!
    expect(keepPlaybook.plan.changes[0]).toMatchObject({ puts: [], closes: [{ id: 1, base: 'Prefers short answers.' }] })
  })
})

describe('when a run is due', () => {
  const base = { now: NOW, startedAt: NOW - STARTUP_GRACE_MS * 2, memoryOn: true, busy: false, lastActivityAt: NOW - IDLE_MS - 1, lastRun: null, pending: 3 }

  test('idle, memory on, something new, and no run today', () => {
    expect(dueToRun(base)).toEqual({ due: true })
    expect(dueToRun({ ...base, lastRun: { startedAt: NOW - DAY_MS - 1, outcome: 'changed' } })).toEqual({ due: true })
    expect(dueToRun({ ...base, lastActivityAt: null })).toEqual({ due: true })
  })

  test('not while memory is off, busy, just started, in use, done today, or with nothing new', () => {
    expect(dueToRun({ ...base, memoryOn: false })).toEqual({ due: false, why: 'memory is off' })
    expect(dueToRun({ ...base, busy: true })).toEqual({ due: false, why: 'busy' })
    expect(dueToRun({ ...base, startedAt: NOW - 1000 })).toEqual({ due: false, why: 'just started' })
    expect(dueToRun({ ...base, lastActivityAt: NOW - IDLE_MS + 1000 })).toEqual({ due: false, why: 'not idle' })
    expect(dueToRun({ ...base, lastRun: { startedAt: NOW - DAY_MS + 1000, outcome: 'nothing' } })).toEqual({ due: false, why: 'ran today' })
    expect(dueToRun({ ...base, pending: 0 })).toEqual({ due: false, why: 'nothing new' })
  })

  test('after a failure it tries again sooner than a day', () => {
    expect(dueToRun({ ...base, lastRun: { startedAt: NOW - RETRY_MS + 1000, outcome: 'error' } })).toEqual({ due: false, why: 'retrying later' })
    expect(dueToRun({ ...base, lastRun: { startedAt: NOW - RETRY_MS - 1, outcome: 'unreadable' } })).toEqual({ due: true })
  })
})

describe('the prompt', () => {
  test('lists records by id and jobs by number, with the user side of each thread', () => {
    const p = reconcilePrompt(input())
    expect(p).toContain('Today is 2026-11-22.')
    expect(p).toContain('1. [preference] Prefers detailed answers.')
    expect(p).toContain('Playbook of Tomo:\n10. [procedure] Add a comment to every line of code.')
    expect(p).toContain('<job n="1" bot="Tomo"')
    expect(p).toContain('User: No, please never add comments to code.')
  })

  test('a playbook for the bot reads as its lessons; an empty one is nothing', () => {
    expect(playbookBlock([])).toBe('')
    expect(playbookBlock([{ title: '', body: 'Never add comments to [[code]].' }])).toContain('- Never add comments to code.')
  })
})

/** A finished job in chat.db with a thread, a note and an archive record. */
const seedJob = (db: ReturnType<typeof makeDb>, title: string, said: string[]) => {
  const { job, thread } = db.createJob({ title, botId: 'tomo' })
  let parent = thread.rootId
  for (const text of said) {
    const user = db.insertMessage({ sessionId: thread.id, parentId: parent, role: 'user', content: text, status: 'complete' })
    const bot = db.insertMessage({ sessionId: thread.id, parentId: user.id, role: 'assistant', content: `Done: ${text}`, status: 'complete' })
    parent = bot.id
  }
  db.writeNote(job.id, { kind: 'decision', text: 'Kept it in Python.' }, { sessionId: thread.id })
  db.setJobStatus(job.id, 'done')
  db.archiveJob(job.id, `${title}: finished.`, { title, sessionId: thread.id })
  return { job, thread }
}

describe('a run', () => {
  test('saves one revision by the reconciler, each version with its job, and reads each job once', async () => {
    const db = openDb()
    db.changeMemory({ add: ['Likes cats.', 'Has a cat.', 'Prefers detailed answers.'], update: [], remove: [] }, { kind: 'edited' })
    const [cats, cat] = db.profile()
    const { job, thread } = seedJob(db, 'Invoice script', ['Rewrite my invoice script.', 'No comments in code, ever. I use Python 3.12.'])
    let prompt = ''
    const result = await reconcileOnce({
      db,
      modelName: 'claude-haiku-5-5',
      trigger: 'manual',
      now: () => NOW,
      model: async (req) => {
        prompt = req.prompt
        return reply(
          { op: 'merge', ids: [cats!.id, cat!.id], text: 'Loves cats and has one.', jobs: [1] },
          { op: 'add', to: 'playbook', text: 'Never add comments to code.', jobs: [1] },
          { op: 'add', to: 'profile', text: 'Uses Python 3.12.', type: 'procedure', jobs: [1] },
          { op: 'add', to: 'profile', text: 'Lives in Lisbon.', jobs: [1] }
        )
      }
    })
    expect(prompt).toContain('User: No comments in code, ever. I use Python 3.12.')
    expect(prompt).toContain('- decision: Kept it in Python.')
    expect(prompt).toContain('Summary: Invoice script: finished.')
    expect(result.run).toMatchObject({ outcome: 'changed', trigger: 'manual', jobs: 1, dropped: 1, model: 'claude-haiku-5-5' })
    expect(result.run.changes).toEqual(['Merged 2 records in the profile into one', "Added to Tomo's playbook", 'Added to the profile'])

    const rev = db.memoryHistory()[0]!
    expect(rev).toMatchObject({ rev: result.run.rev, kind: 'reconciled', writer: 'reconciler', note: 'Review run from Settings of 1 finished job' })
    expect(rev.added).toEqual(['Loves cats and has one.', 'Uses Python 3.12.', 'Tomo’s playbook: Never add comments to code.'])
    expect(rev.removed).toEqual(['Likes cats.', 'Has a cat.'])

    const lesson = db.playbooks().get('tomo')![0]!
    expect(lesson).toMatchObject({ scope: 'bot', scopeId: 'tomo', type: 'procedure', writer: 'reconciler', body: 'Never add comments to code.' })
    expect(db.recordVersions(lesson.id)[0]).toMatchObject({ writer: 'reconciler', sourceJobId: job.id, sourceSessionId: thread.id, sourceTitle: 'Invoice script' })
    expect(db.recordVersions(cats!.id).map((v) => [v.writer, v.body])).toEqual([
      ['reconciler', 'Loves cats and has one.'],
      ['user', 'Likes cats.']
    ])

    // Read once: the next run has nothing new, and makes no revision.
    expect(db.pendingReconcileCount()).toBe(0)
    const again = await reconcileOnce({ db, modelName: 'm', trigger: 'idle', model: async () => reply() })
    expect(again.run).toMatchObject({ outcome: 'nothing', jobs: 0, rev: null })
    expect(db.memoryHistory()[0]!.rev).toBe(rev.rev)
  })

  test('restoring the revision before a run takes back its profile and playbook changes', async () => {
    const db = openDb()
    db.changeMemory({ add: ['Prefers detailed answers.'], update: [], remove: [] }, { kind: 'edited' })
    const before = db.memoryRev()
    seedJob(db, 'Report', ['Keep it short from now on, I prefer short answers.'])
    const fact = db.profile()[0]!
    await reconcileOnce({
      db,
      modelName: 'm',
      trigger: 'idle',
      model: async () =>
        reply(
          { op: 'update', id: fact.id, text: 'Prefers short answers.', correction: true, jobs: [1] },
          { op: 'add', to: 'playbook', text: 'Keep answers short.', jobs: [1] }
        )
    })
    expect(db.profile()[0]!.body).toMatch(/^Prefers short answers \(corrected \d{4}-\d{2}-\d{2}\)\.$/)
    expect(db.playbooks().get('tomo')).toHaveLength(1)
    db.restoreMemory(before)
    expect(db.profile().map((r) => [r.id, r.body])).toEqual([[fact.id, 'Prefers detailed answers.']])
    expect(db.playbooks().get('tomo')).toBeUndefined()
    // And forward again, to the run's revision.
    db.restoreMemory(db.memoryHistory().find((r) => r.kind === 'reconciled')!.rev)
    expect(db.playbooks().get('tomo')).toHaveLength(1)
  })

  test('never touches what was purged or edited while the model was thinking', async () => {
    const db = openDb()
    db.changeMemory({ add: ['Likes tea.', 'Likes coffee.', 'Walks daily.'], update: [], remove: [] }, { kind: 'edited' })
    const [tea, coffee, walks] = db.profile()
    seedJob(db, 'Breakfast', ['I drink tea and coffee, and I walk daily.'])
    const result = await reconcileOnce({
      db,
      modelName: 'm',
      trigger: 'idle',
      model: async () => {
        db.purgeRecord(tea!.id)
        db.changeMemory({ add: [], update: [{ id: walks!.id, fact: 'Walks every morning.' }], remove: [] }, { kind: 'edited' })
        return reply(
          { op: 'merge', ids: [tea!.id, coffee!.id], text: 'Drinks tea and coffee.', jobs: [1] },
          { op: 'remove', id: walks!.id, reason: 'stale', jobs: [1] }
        )
      }
    })
    expect(result.run).toMatchObject({ outcome: 'nothing', dropped: 2 })
    expect(db.profile().map((r) => r.body)).toEqual(['Likes coffee.', 'Walks every morning.'])
    expect(db.recordVersions(tea!.id)).toEqual([])
  })

  test("doesn't read a thread's messages from before the last purge", async () => {
    const db = openDb()
    seedJob(db, 'Old talk', ['My bank is Monzo.'])
    db.changeMemory({ add: ['Banks with Monzo.'], update: [], remove: [] }, { kind: 'edited' })
    db.purgeRecord(db.profile()[0]!.id)
    let prompt = ''
    await reconcileOnce({ db, modelName: 'm', trigger: 'idle', model: async (r) => ((prompt = r.prompt), reply()) })
    expect(prompt).toContain('Title: Old talk')
    expect(prompt).not.toContain('My bank is Monzo.')
  })

  test('a failed or unreadable reply is logged, and its jobs are read again next time', async () => {
    const db = openDb()
    seedJob(db, 'Trip', ['Plan my trip.'])
    const failed = await reconcileOnce({ db, modelName: 'm', trigger: 'idle', model: async () => Promise.reject(new Error('Overloaded')) })
    expect(failed.run).toMatchObject({ outcome: 'error', detail: 'Overloaded', jobs: 1 })
    expect(db.pendingReconcileCount()).toBe(1)
    const unreadable = await reconcileOnce({ db, modelName: 'm', trigger: 'idle', model: async () => 'I would merge some things.' })
    expect(unreadable.run.outcome).toBe('unreadable')
    expect(unreadable.run.detail).not.toContain('merge')
    expect(db.pendingReconcileCount()).toBe(1)
    expect(db.lastReconcilerRun()!.id).toBe(unreadable.run.id)
  })

  test('a run cut off by quitting is ended at the next start', () => {
    const db = openDb()
    db.startReconcilerRun('idle', 'm')
    expect(db.lastReconcilerRun()!.outcome).toBe('running')
    expect(db.endStaleReconcilerRuns()).toBe(1)
    expect(db.lastReconcilerRun()).toMatchObject({ outcome: 'error', detail: 'Cut off when the app quit.' })
  })

  test('a reopened job is read again once it finishes again', async () => {
    const db = openDb()
    const { job, thread } = seedJob(db, 'Garden', ['Plant tomatoes.'])
    await reconcileOnce({ db, modelName: 'm', trigger: 'idle', model: async () => reply() })
    expect(db.pendingReconcileCount()).toBe(0)
    await new Promise((r) => setTimeout(r, 5))
    const last = db.activePath(db.getSession(thread.id)!).at(-1)!.message
    db.insertMessage({ sessionId: thread.id, parentId: last.id, role: 'user', content: 'And basil.', status: 'complete' })
    expect(db.getJob(job.id)!.status).toBe('open')
    expect(db.pendingReconcileCount()).toBe(0)
    db.setJobStatus(job.id, 'done')
    expect(db.pendingReconcileCount()).toBe(1)
  })

  test('purging a playbook lesson is a revision, so the history says something went', () => {
    const db = openDb()
    const { job, thread } = seedJob(db, 'X', ['Hello there.'])
    db.reconcile(
      { changes: [{ what: 'Added', closes: [], puts: [{ body: 'Say hello.', scope: 'bot', scopeId: 'tomo', type: 'procedure', jobId: job.id, sessionId: thread.id }] }] },
      'Daily review'
    )
    const id = db.playbooks().get('tomo')![0]!.id
    expect(db.purgeRecord(id)).toBe(true)
    expect(db.memoryHistory()[0]).toMatchObject({ kind: 'purged', added: [], removed: [] })
    expect(db.playbooks().size).toBe(0)
  })
})
