// Memory records: the migration from memory_facts, stable ids and versions with sources, purge,
// [[links]], FTS5 recall, job notes and the archive, and the recall and note tool modules.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Step } from '../src/shared/steps'
import { parseMemoryReply, profileBlock } from '../src/main/memory'
import { MIGRATIONS, makeDb } from '../src/main/services/Db'
import { MEMORY_RECORDS_MIGRATION, ftsQuery, linkNames } from '../src/main/services/memoryStore'
import { type RunContext, type ToolModule, inProcess } from '../src/main/agent/module'
import { describeHits, recallModule } from '../src/main/agent/recall'
import { jobNotesBlock, noteModule } from '../src/main/agent/notes'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-records-'))
  dirs.push(dir)
  return join(dir, 'chat.db')
}

const openDb = () => makeDb(tempFile())

const add = (db: ReturnType<typeof makeDb>, ...facts: Parameters<ReturnType<typeof makeDb>['changeMemory']>[0]['add']) =>
  db.changeMemory({ add: facts, update: [], remove: [] }, { kind: 'edited' })

describe('migration from memory facts', () => {
  /** A database as the app left it before records: facts, revisions and a chat pinned to one. */
  const oldDb = () => {
    const file = tempFile()
    const raw = new DatabaseSync(file)
    const before = MIGRATIONS.indexOf(MEMORY_RECORDS_MIGRATION)
    expect(before).toBeGreaterThan(0)
    for (const sql of MIGRATIONS.slice(0, before)) raw.exec(sql)
    raw.exec(`pragma user_version = ${before}`)
    raw.exec(`
      insert into sessions (id, title, root_id, created_at, updated_at, memory_rev) values ('s1', 'Moving house', 'r1', 1, 1, 2);
      insert into memory_revisions (rev, kind, session_id, note, created_at) values
        (1, 'learned', 's1', null, 100), (2, 'edited', null, null, 200), (3, 'cleared', null, null, 300), (4, 'restored', null, 'Restored version 1', 400);
      insert into memory_facts (id, fact, added_rev, removed_rev, created_at) values
        (1, 'Lives in Lisbon.', 1, 2, 100), (2, 'Works as a nurse.', 1, 3, 100), (3, 'Lives in Porto.', 2, 3, 200),
        (4, 'Lives in Lisbon.', 4, null, 400), (5, 'Works as a nurse.', 4, null, 400);`)
    raw.close()
    return file
  }

  test('every fact becomes a record with one version, under its own id, and the history reads as before', () => {
    const file = oldDb()
    const db = makeDb(file)
    expect(db.profile().map((r) => [r.id, r.body, r.scope, r.versions])).toEqual([
      [4, 'Lives in Lisbon.', 'profile', 1],
      [5, 'Works as a nurse.', 'profile', 1]
    ])
    // Earlier profiles, and the chat that still sees one of them.
    expect(db.profile(2).map((r) => r.body)).toEqual(['Works as a nurse.', 'Lives in Porto.'])
    expect(db.profile(db.sessionMemoryRev('s1')).map((r) => r.id)).toEqual([2, 3])
    const history = db.memoryHistory()
    expect(history.map((r) => [r.rev, r.kind, r.writer, r.added, r.removed])).toEqual([
      [4, 'restored', 'user', ['Lives in Lisbon.', 'Works as a nurse.'], []],
      [3, 'cleared', 'user', [], ['Works as a nurse.', 'Lives in Porto.']],
      [2, 'edited', 'user', ['Lives in Porto.'], ['Lives in Lisbon.']],
      [1, 'learned', 'extractor', ['Lives in Lisbon.', 'Works as a nurse.'], []]
    ])
    // A learned fact keeps the chat it came from.
    expect(db.recordVersions(1)).toMatchObject([{ body: 'Lives in Lisbon.', writer: 'extractor', sourceSessionId: 's1', sourceTitle: 'Moving house', addedRev: 1, removedRev: 2 }])
    // Restoring an old version still works, under the old ids.
    db.restoreMemory(2)
    expect(db.profile().map((r) => [r.id, r.body])).toEqual([
      [2, 'Works as a nurse.'],
      [3, 'Lives in Porto.']
    ])
    // Live records are searchable; hidden ones aren't. New records number on from the old ids.
    expect(db.recall('porto').map((h) => h.id)).toEqual([3])
    expect(db.recall('lisbon')).toEqual([])
    add(db, 'Has a cat.')
    expect(db.profile().at(-1)!.id).toBe(6)
    db.close()
    const raw = new DatabaseSync(file)
    expect(raw.prepare(`select name from sqlite_master where name = 'memory_facts'`).all()).toEqual([])
    raw.close()
  })

  test('a fact from before the migration, purged, leaves no copy in the file', () => {
    const file = oldDb()
    const raw = new DatabaseSync(file)
    raw.exec(`insert into memory_revisions (rev, kind, created_at) values (5, 'edited', 500);
      insert into memory_facts (id, fact, added_rev, created_at) values (6, 'Keeps a diary called Quillwhistle.', 5, 500);`)
    raw.close()
    const db = makeDb(file)
    db.changeMemory({ add: [], update: [{ id: 6, fact: 'Keeps a Quillwhistle diary, in green ink.' }], remove: [] }, { kind: 'edited' })
    expect(db.recall('quillwhistle').map((h) => h.id)).toEqual([6])
    db.purgeRecord(6)
    db.close()
    for (const f of [file, `${file}-wal`]) if (existsSync(f)) expect(readFileSync(f).includes('Quillwhistle')).toBe(false)
  })
})

describe('records', () => {
  test('the extractor names people and projects, typed; names the message never said are dropped', () => {
    const said = 'My partner Ana and I just started building Tomo, a chat app'
    const reading = parseMemoryReply(
      '{"add": [{"fact": "Partner is Ana.", "type": "person", "title": "Ana"}, {"fact": "Is building Tomo.", "type": "project", "title": "Tomo", "aliases": ["chat app", "Lumen"]}, {"fact": "Started building something.", "type": "nonsense"}]}',
      [],
      said
    )!
    expect(reading.change!.add).toEqual([
      { fact: 'Partner is Ana.', type: 'person', title: 'Ana' },
      { fact: 'Is building Tomo.', type: 'project', title: 'Tomo', aliases: ['chat app'] },
      'Started building something.'
    ])
    const db = openDb()
    db.changeMemory(reading.change!, { kind: 'learned', sessionId: 's1' })
    expect(db.profile().map((r) => [r.type, r.title, r.aliases, r.writer])).toEqual([
      ['person', 'Ana', [], 'extractor'],
      ['project', 'Tomo', ['chat app'], 'extractor'],
      ['person', '', [], 'extractor']
    ])
    db.close()
  })

  test('[[links]] point at the records they name, whichever is written first, and read as plain names in the prompt', () => {
    const db = openDb()
    add(db, 'Lives with [[Ana]] and [[Miso]].')
    add(db, { fact: 'Partner is Ana.', type: 'person', title: 'Ana' })
    add(db, { fact: 'Has a cat.', type: 'person', title: 'Mittens', aliases: ['Miso'] })
    const [lives, ana, cat] = db.profile()
    expect(lives!.links).toEqual([
      { id: ana!.id, title: 'Ana' },
      { id: cat!.id, title: 'Mittens' }
    ])
    expect(linkNames('See [[ Ana ]] and [[]]')).toEqual(['Ana'])
    expect(profileBlock(db.profile())).toContain('- Lives with Ana and Miso.')
    // Purging a record takes its links with it.
    db.purgeRecord(ana!.id)
    expect(db.getRecord(lives!.id)!.links.map((l) => l.title)).toEqual(['Mittens'])
    db.close()
  })

  test('a fact learned again after it was removed comes back under its old id', () => {
    const db = openDb()
    add(db, 'Likes tea.')
    const id = db.profile()[0]!.id
    db.changeMemory({ add: [], update: [], remove: [id] }, { kind: 'edited' })
    expect(db.getRecord(id)).toBeUndefined()
    db.changeMemory({ add: ['likes tea'], update: [], remove: [] }, { kind: 'learned' })
    expect(db.profile().map((r) => [r.id, r.versions])).toEqual([[id, 2]])
    db.close()
  })

  test('a version from a bot, as computer use saves one, says so', () => {
    const db = openDb()
    db.changeMemory({ add: ['Prefers Firefox.'], update: [], remove: [] }, { kind: 'learned', writer: 'bot', sessionId: 's9' })
    expect(db.recordVersions(db.profile()[0]!.id)).toMatchObject([{ writer: 'bot', sourceSessionId: 's9', sourceTitle: null }])
    db.close()
  })
})

describe('purge', () => {
  test('deletes a record and every version, out of the history, the search index and the file', () => {
    const file = tempFile()
    const db = makeDb(file)
    add(db, 'Keeps a diary called Zebraquill.')
    const id = db.profile()[0]!.id
    db.changeMemory({ add: [], update: [{ id, fact: 'Keeps a diary called Zebraquill, in green ink.' }], remove: [] }, { kind: 'edited' })
    add(db, 'Likes tea.')
    expect(db.recall('zebraquill').map((h) => h.id)).toEqual([id])

    expect(db.purgeRecord(id)).toBe(true)
    expect(db.purgeRecord(id)).toBe(false)
    expect(db.getRecord(id)).toBeUndefined()
    expect(db.recordVersions(id)).toEqual([])
    expect(db.recall('zebraquill')).toEqual([])
    // Not in any earlier profile either, so a restore can't bring it back.
    expect(db.profile(1)).toEqual([])
    db.restoreMemory(2)
    expect(db.profile().map((r) => r.body)).toEqual([])
    const history = db.memoryHistory()
    expect(history[1]).toMatchObject({ kind: 'purged', writer: 'user', note: 'Deleted a record and its history', added: [], removed: [] })
    expect(JSON.stringify(history)).not.toContain('Zebraquill')
    // Nor anywhere in the database's files.
    for (const f of [file, `${file}-wal`]) if (existsSync(f)) expect(readFileSync(f).includes('Zebraquill')).toBe(false)
    db.close()
  })
})

describe('recall', () => {
  test('matches titles, aliases and current text, ignoring case, accents and word endings, best match first', () => {
    const db = openDb()
    add(
      db,
      { fact: 'Is building a chat app on the Agent SDK.', type: 'project', title: 'Tomo', aliases: ['chat-v2'] },
      'Drinks café au lait every morning.',
      'Has two cats.',
      { fact: 'Sister lives in Pune.', type: 'person', title: 'Priya' }
    )
    expect(db.recall('tomo').map((h) => h.title)).toEqual(['Tomo'])
    expect(db.recall('chat-v2 progress')[0]!.title).toBe('Tomo')
    expect(db.recall('CAFE')[0]!.body).toBe('Drinks café au lait every morning.')
    expect(db.recall('cat')[0]!.body).toBe('Has two cats.')
    // A name in the title outranks the same word in another record's text.
    add(db, 'Visited Priya last spring.')
    expect(db.recall('priya').map((h) => h.title)).toEqual(['Priya', ''])
    // Words that mean something to FTS5 are only words here.
    expect(db.recall('"tomo" AND (NOT* NEAR')[0]!.title).toBe('Tomo')
    expect(db.recall('  ?! ')).toEqual([])
    expect(ftsQuery('Ana, the cat')).toBe('"ana"* OR "the"* OR "cat"*')
    expect(db.recall('cats', { limit: 1 })).toHaveLength(1)
    db.close()
  })

  test("searches the archive, a job's notes only for that job, and a playbook only for its bot", () => {
    const db = openDb()
    db.archiveJob('job-1', 'Planned a week in Kyoto: ryokan booked, temples listed.', { title: 'Kyoto trip', aliases: ['Japan holiday'] })
    db.writeNote('job-2', { kind: 'state', text: 'Kyoto hotel shortlist is in hotels.md.' })
    expect(db.recall('japan').map((h) => [h.scope, h.scopeId, h.type])).toEqual([['archive', 'job-1', 'job']])
    expect(db.recall('kyoto').map((h) => h.scope)).toEqual(['archive'])
    expect(db.recall('kyoto', { jobId: 'job-2' }).map((h) => h.scope).sort()).toEqual(['archive', 'job'])
    expect(db.recall('kyoto', { jobId: 'job-3' }).map((h) => h.scope)).toEqual(['archive'])
    db.close()
  })
})

describe('job notes', () => {
  test('state, left and files are rewritten in place; decisions and progress pile up', () => {
    const db = openDb()
    const first = db.writeNote('job-1', { kind: 'state', text: 'Draft written.' }, { sessionId: 's1' })
    const again = db.writeNote('job-1', { kind: 'state', text: 'Draft reviewed.' }, { sessionId: 's2' })
    expect(again).toEqual({ id: first.id, rev: again.rev, replaced: true })
    expect(db.writeNote('job-1', { kind: 'state', text: 'Draft reviewed.' }).rev).toBeNull()
    db.writeNote('job-1', { kind: 'decision', text: 'Use SQLite, not git.', title: 'Storage' })
    db.writeNote('job-1', { kind: 'decision', text: 'Keep the extractor.' })
    db.writeNote('job-2', { kind: 'state', text: 'Elsewhere.' })
    const notes = db.jobNotes('job-1')
    expect(notes.map((n) => [n.type, n.title, n.body, n.versions, n.writer])).toEqual([
      ['state', '', 'Draft reviewed.', 2, 'bot'],
      ['decision', 'Storage', 'Use SQLite, not git.', 1, 'bot'],
      ['decision', '', 'Keep the extractor.', 1, 'bot']
    ])
    expect(db.recordVersions(first.id).map((v) => [v.body, v.sourceJobId, v.sourceSessionId])).toEqual([
      ['Draft reviewed.', 'job-1', 's2'],
      ['Draft written.', 'job-1', 's1']
    ])
    const block = jobNotesBlock(notes)
    expect(block).toContain('Where things stand:\nDraft reviewed.')
    expect(block).toMatch(/Decisions:\n- \(\d{4}-\d\d-\d\d\) Storage: Use SQLite, not git\.\n- \(\d{4}-\d\d-\d\d\) Keep the extractor\./)
    expect(jobNotesBlock([])).toBe('')
    // Notes aren't the profile: not in it, and not in its history.
    expect(db.profile()).toEqual([])
    expect(db.memoryHistory()).toEqual([])
    db.close()
  })

  test('the archive keeps one record per job, versioned; forgetting a job deletes its notes and archive', () => {
    const db = openDb()
    const a = db.archiveJob('job-1', 'Half done.', { title: 'Report', sessionId: 's1' })
    expect(db.archiveJob('job-1', 'Half done.', { title: 'Report' }).rev).toBeNull()
    const b = db.archiveJob('job-1', 'Done: report sent.', { title: 'Quarterly report' })
    expect(b.id).toBe(a.id)
    expect(db.getRecord(a.id)).toMatchObject({ scope: 'archive', scopeId: 'job-1', type: 'job', title: 'Quarterly report', body: 'Done: report sent.', versions: 2, writer: 'archiver' })
    expect(db.recordVersions(a.id).map((v) => [v.sourceJobId, v.sourceSessionId])).toEqual([
      ['job-1', null],
      ['job-1', 's1']
    ])
    const c = db.archiveConversation('s7', 'Talked through a sourdough starter.', { title: 'Sourdough' })
    expect(db.getRecord(c.id)).toMatchObject({ scope: 'archive', scopeId: 's7', type: 'conversation' })
    expect(db.recall('sourdough')[0]!.sourceSessionId).toBe('s7')
    db.writeNote('job-1', { kind: 'left', text: 'Nothing.' })
    expect(db.forgetJob('job-1')).toBe(2)
    expect(db.recall('report')).toEqual([])
    expect(db.jobNotes('job-1')).toEqual([])
    expect(db.getRecord(c.id)).toBeDefined()
    db.close()
  })
})

/** A module's MCP server with a client, as the CLI would call it. */
const connect = async (mod: ToolModule) => {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await inProcess(mod).connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
    return { text: res.content.map((c) => c.text).join(''), isError: res.isError === true }
  }
}

const context = (steps: Step[], jobId?: string): RunContext => ({
  sessionId: 's1',
  messageId: 'm1',
  ...(jobId ? { jobId } : {}),
  step: async (s) => void steps.push(s),
  attach: async () => {},
  signal: new AbortController().signal
})

describe('tool modules', () => {
  test('recall searches through the run scope and leaves a step', async () => {
    const db = openDb()
    db.archiveJob('job-1', 'Booked the [[Kyoto]] ryokan.', { title: 'Kyoto trip' })
    const seen: unknown[] = []
    const steps: Step[] = []
    const mod = recallModule(
      async (q, scope) => (seen.push(scope), db.recall(q, scope)),
      () => ({ botId: 'b1' })
    )(context(steps))
    expect(mod.name).toBe('memory')
    const call = await connect(mod)
    const found = await call('recall', { query: 'kyoto' })
    expect(found.text).toMatch(/^1 record for "kyoto", best first:\n\n\[\d+\] Finished job: Kyoto trip \(\d{4}-\d\d-\d\d\)\nBooked the Kyoto ryokan\.$/)
    expect(seen).toEqual([{ botId: 'b1', limit: 8 }])
    expect((await call('recall', { query: 'paris', limit: 2 })).text).toContain('Nothing in memory matches "paris"')
    expect(steps).toEqual([
      { tool: 'memory_recall', label: 'Recalled “kyoto”', ok: true, detail: '1 found' },
      { tool: 'memory_recall', label: 'Recalled “paris”', ok: true, detail: 'Nothing found' }
    ])
    expect(describeHits('x', [{ id: 1, scope: 'profile', scopeId: null, type: 'person', title: 'Ana', aliases: ['Annie'], body: 'Partner is Ana.', updatedAt: 0, sourceSessionId: null }])).toContain(
      '[1] About the user: Ana / Annie (1970-01-01)\nPartner is Ana.'
    )
    db.close()
  })

  test('note writes to the job in the run context, and refuses without one', async () => {
    const db = openDb()
    const steps: Step[] = []
    const write = async (jobId: string, note: Parameters<typeof db.writeNote>[1], origin: { sessionId: string }) => db.writeNote(jobId, note, origin)
    const none = await connect(noteModule(write)(context(steps)))
    expect(await none('note', { kind: 'state', text: 'x' })).toEqual({ text: "Error: This chat isn't working on a job, so there is no job to keep notes on.", isError: true })
    const call = await connect(noteModule(write)(context(steps, 'job-1')))
    expect((await call('note', { kind: 'decision', text: 'Ship Friday.', title: 'Date' })).text).toMatch(/^Saved as note \d+\.$/)
    expect((await call('note', { kind: 'state', text: 'Testing.' })).text).toMatch(/^Saved as note \d+\.$/)
    expect((await call('note', { kind: 'state', text: 'Shipped.' })).text).toBe('Replaced the state note.')
    expect((await call('note', { kind: 'state', text: '   ' })).isError).toBe(true)
    expect(db.jobNotes('job-1').map((n) => [n.type, n.body])).toEqual([
      ['decision', 'Ship Friday.'],
      ['state', 'Shipped.']
    ])
    expect(db.recordVersions(db.jobNotes('job-1')[1]!.id)[0]).toMatchObject({ sourceJobId: 'job-1', sourceSessionId: 's1', writer: 'bot' })
    expect(steps.map((s) => [s.label, s.ok])).toEqual([
      ["Couldn't write a note", false],
      ['Noted decisions', true],
      ['Noted where things stand', true],
      ['Noted where things stand', true],
      ["Couldn't write a note", false]
    ])
    db.close()
  })
})
