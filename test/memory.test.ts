import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askedQuestion, grounded, isSensitive, memoryPrompt, memorySource, parseMemoryReply, profileBlock } from '../src/main/memory'
import { makeDb } from '../src/main/services/Db'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const openDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-memory-'))
  dirs.push(dir)
  return makeDb(join(dir, 'chat.db'))
}

const facts = [
  { id: 1, body: 'Lives in Lisbon.' },
  { id: 2, body: 'Works as a nurse.' }
]

describe('memory gate', () => {
  test('reads what the user says about themselves, not what they pasted', () => {
    expect(memorySource("I'm a nurse in Lisbon")).toBe("I'm a nurse in Lisbon")
    expect(memorySource('Call me Sam, and keep answers short')).toContain('Call me Sam')
    // No first person, or only first person inside code and quotes: nothing to read.
    expect(memorySource('What is the capital of Peru?')).toBeNull()
    expect(memorySource('Fix this:\n```js\nconst my = 1 // I am\n```')).toBeNull()
    expect(memorySource('> I live in Paris\nWhat does this line mean?')).toBeNull()
    expect(memorySource('ok')).toBeNull()
    expect(memorySource(`My name is Ada. ${'x'.repeat(5000)}`)!.length).toBe(2000)
  })

  test('requests and how-to questions are not about the user', () => {
    expect(memorySource('Can you help me fix this bug?')).toBeNull()
    expect(memorySource('Show us an example')).toBeNull()
    expect(memorySource('How do I center a div?')).toBeNull()
    expect(memorySource('Should we use Postgres or SQLite here?')).toBeNull()
    // Said in passing on the way to a question, it still counts.
    expect(memorySource("I'm building a Svelte app; how do I add routing?")).not.toBeNull()
    expect(memorySource('Our team uses Postgres. Can I index a JSON column?')).not.toBeNull()
  })

  test('a bare answer to a question the assistant asked is read too', () => {
    expect(memorySource('Berlin')).toBeNull()
    expect(askedQuestion('Happy to help with the move. Which city are you in?')).toBe(true)
    expect(askedQuestion('Here is the plan.')).toBe(false)
    expect(memorySource('Berlin', true)).toBe('Berlin')
    // "Want me to add tests?" "Yes please": nothing about the user.
    expect(memorySource('Yes please!', true)).toBeNull()
    expect(memorySource('ok, go ahead', true)).toBeNull()
    expect(memoryPrompt([], 'Berlin', 'Which city are you in?')).toBe(
      'Profile so far:\n(empty)\n\n<assistant>\n…Which city are you in?\n</assistant>\n\n<message>\nBerlin\n</message>'
    )
  })

  test('never keeps secrets', () => {
    expect(isSensitive('Card number is 4111 1111 1111 1111.')).toBe(true)
    expect(isSensitive('Their OpenAI key is sk-proj-abcdefghijklmnop.')).toBe(true)
    expect(isSensitive('Uses the password hunter2.')).toBe(true)
    expect(isSensitive('Has two cats, Miso and Tofu.')).toBe(false)
    expect(isSensitive('Was born in 1990.')).toBe(false)
  })
})

describe('memory replies', () => {
  test('reads JSON leniently and drops ids it does not know', () => {
    const said = 'I have a dog named Rex, I speak Portuguese, and I am a doctor now'
    expect(parseMemoryReply('{}', facts, said)).toEqual({ change: null, dropped: [] })
    // No JSON at all is reported separately, so Settings can say the reply was unreadable.
    expect(parseMemoryReply('Nothing to add.', facts, said)).toBeNull()
    expect(
      parseMemoryReply(
        'Sure!\n```json\n{"add": ["Has a dog named Rex", {"fact": "Speaks Portuguese."}], "update": [{"id": "2", "fact": "Works as a doctor."}, {"id": 9, "fact": "x"}], "remove": [1, 7]}\n```',
        facts,
        said
      )
    ).toEqual({
      change: {
        add: ['Has a dog named Rex.', 'Speaks Portuguese.'],
        update: [{ id: 2, fact: 'Works as a doctor.' }],
        remove: [1]
      },
      dropped: []
    })
    expect(parseMemoryReply('{"add": ["Their PIN code is 1234."]}', facts, 'my PIN code is 1234')!.change).toBeNull()
    // "The user …" phrasing is turned into the same style as everything else.
    expect(parseMemoryReply('{"add": ["The user\'s name is Luv", "the user is a software engineer."]}', [], 'I am Luv, a software engineer')!.change!.add).toEqual([
      'Name is Luv.',
      'Is a software engineer.'
    ])
  })

  test('drops names, places and numbers the message never mentioned', () => {
    // A real reply: the model kept the facts but also copied an example place into the profile.
    const said = 'Hey, I am Luv. I am a software engineer and currently working on a procedural memory and thinking of applying to YC'
    const reply = '{"add": ["Name is Luv.", "Works as a software engineer.", "Lives in Lisbon.", "Is considering applying to YC."]}'
    expect(parseMemoryReply(reply, [], said)).toEqual({
      change: { add: ['Name is Luv.', 'Works as a software engineer.', 'Is considering applying to YC.'], update: [], remove: [] },
      dropped: ['Lives in Lisbon.']
    })
    // What they're working on, mentioned in passing, is kept when the model returns it.
    expect(parseMemoryReply('{"add": ["Is working on a procedural memory project."]}', [], said)!.change!.add).toEqual([
      'Is working on a procedural memory project.'
    ])
    expect(grounded('Was born in 1990.', 'I was born in 1991')).toBe(false)
    expect(grounded("Luv's partner is Ana.", 'my partner Ana and I')).toBe(true)
    // Lowercase words can be paraphrased freely.
    expect(grounded('Prefers short answers.', 'keep it brief please')).toBe(true)
  })

  test('the profile block lists facts, and is empty without any', () => {
    expect(profileBlock([])).toBe('')
    expect(profileBlock(facts)).toContain('- Lives in Lisbon.\n- Works as a nurse.')
  })
})

describe('memory versions', () => {
  test('every change is a revision; earlier profiles can be read back and restored', () => {
    const db = openDb()
    const first = db.changeMemory({ add: ['Lives in Lisbon.', 'Works as a nurse.'], update: [], remove: [] }, { kind: 'learned', sessionId: 's1' })
    expect(first).toEqual({ rev: 1, added: ['Lives in Lisbon.', 'Works as a nurse.'], removed: [] })
    // Repeats (in any case, with or without the full stop) are not added again.
    expect(db.changeMemory({ add: ['lives in lisbon'], update: [], remove: [] }, { kind: 'learned' })).toBeNull()

    const lisbon = db.profile().find((f) => f.body === 'Lives in Lisbon.')!
    const moved = db.changeMemory({ add: [], update: [{ id: lisbon.id, fact: 'Lives in Porto.' }], remove: [] }, { kind: 'learned' })
    expect(moved).toEqual({ rev: 2, added: ['Lives in Porto.'], removed: ['Lives in Lisbon.'] })
    // An update is a new version of the same record.
    expect(db.getRecord(lisbon.id)).toMatchObject({ body: 'Lives in Porto.', versions: 2, writer: 'extractor' })
    expect(db.clearMemory()!.removed).toEqual(['Lives in Porto.', 'Works as a nurse.'])
    expect(db.profile()).toEqual([])

    // The profile at each version is still there.
    expect(db.profile(1).map((f) => f.body)).toEqual(['Lives in Lisbon.', 'Works as a nurse.'])
    expect(db.profile(2).map((f) => f.body)).toEqual(['Lives in Porto.', 'Works as a nurse.'])

    const restored = db.restoreMemory(1)!
    expect(restored.rev).toBe(4)
    expect(db.profile().map((f) => [f.id, f.body])).toEqual([
      [lisbon.id, 'Lives in Lisbon.'],
      [lisbon.id + 1, 'Works as a nurse.']
    ])
    // Restoring keeps the ids, and the source of the version brought back.
    expect(db.recordVersions(lisbon.id).map((v) => [v.body, v.writer, v.sourceSessionId])).toEqual([
      ['Lives in Lisbon.', 'user', 's1'],
      ['Lives in Porto.', 'extractor', null],
      ['Lives in Lisbon.', 'extractor', 's1']
    ])
    const history = db.memoryHistory()
    expect(history.map((r) => [r.rev, r.kind])).toEqual([
      [4, 'restored'],
      [3, 'cleared'],
      [2, 'learned'],
      [1, 'learned']
    ])
    expect(history[0]!.note).toBe('Restored version 1')
    expect(history[1]!.removed).toEqual(['Lives in Porto.', 'Works as a nurse.'])
    expect(history.map((r) => r.writer)).toEqual(['user', 'user', 'extractor', 'extractor'])
    expect(history[3]!.sessionId).toBe('s1')
    db.close()
  })

  test('a chat keeps the memory version it started with', () => {
    const db = openDb()
    const a = db.createSession({ title: 'A', model: null, systemPrompt: null, forkedFromSessionId: null })
    db.changeMemory({ add: ['Likes tea.'], update: [], remove: [] }, { kind: 'edited' })
    expect(db.sessionMemoryRev(a.id)).toBe(1)
    db.changeMemory({ add: ['Has a cat.'], update: [], remove: [] }, { kind: 'edited' })
    expect(db.sessionMemoryRev(a.id)).toBe(1)
    const b = db.createSession({ title: 'B', model: null, systemPrompt: null, forkedFromSessionId: null })
    expect(db.sessionMemoryRev(b.id)).toBe(2)
    db.close()
  })
})

describe('sessions', () => {
  test('pinning neither moves a chat between days nor changes when it was pinned', async () => {
    const db = openDb()
    const s = db.createSession({ title: 'A', model: null, systemPrompt: null, forkedFromSessionId: null })
    db.insertMessage({ sessionId: s.id, parentId: s.rootId, role: 'user', content: 'hi', status: 'complete' })
    const before = db.getSession(s.id)!
    expect(before.pinnedAt).toBeNull()
    db.updateSession(s.id, { pinned: true })
    const pinned = db.getSession(s.id)!
    expect(pinned.pinnedAt).toBeNumber()
    expect(pinned.updatedAt).toBe(before.updatedAt)
    await new Promise((r) => setTimeout(r, 5))
    db.updateSession(s.id, { pinned: true })
    expect(db.getSession(s.id)!.pinnedAt).toBe(pinned.pinnedAt)
    db.updateSession(s.id, { pinned: false })
    expect(db.getSession(s.id)!.pinnedAt).toBeNull()
    db.close()
  })

  test('chats that never got a message are cleared out', () => {
    const db = openDb()
    const empty = db.createSession({ title: 'New chat', model: null, systemPrompt: null, forkedFromSessionId: null })
    const used = db.createSession({ title: 'Used', model: null, systemPrompt: null, forkedFromSessionId: null })
    db.insertMessage({ sessionId: used.id, parentId: used.rootId, role: 'user', content: 'hi', status: 'complete' })
    expect(db.pruneEmptySessions()).toBe(1)
    expect(db.listSessions().map((s) => s.id)).toEqual([used.id])
    expect(db.getSession(empty.id)).toBeUndefined()
    db.close()
  })
})
