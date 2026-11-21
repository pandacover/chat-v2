import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Db, makeDb } from '../src/main/services/Db'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-db-'))
  dirs.push(dir)
  const file = join(dir, 'chat.db')
  return { db: makeDb(file), file }
}

const reply = (db: ReturnType<typeof makeDb>) => {
  const session = db.createSession({ title: 'Lines', model: null, systemPrompt: null, forkedFromSessionId: null })
  const user = db.insertMessage({ sessionId: session.id, parentId: session.rootId, role: 'user', content: 'Hi', status: 'complete' })
  return db.insertMessage({ sessionId: session.id, parentId: user.id, role: 'assistant', content: '', status: 'streaming' })
}

describe('streamed lines', () => {
  test('read back whole while streaming, and folded into the message when it stops', () => {
    const { db } = open()
    const m = reply(db)
    expect(db.appendLine(m.id, 'one')).toBe(0)
    expect(db.appendLine(m.id, 'two')).toBe(1)
    expect(db.getMessage(m.id)).toMatchObject({ content: 'one\ntwo', lineCount: 2 })
    db.setStatus(m.id, 'complete')
    expect(db.getMessage(m.id)).toMatchObject({ content: 'one\ntwo', lineCount: 2, status: 'complete' })
    expect(db.appendLine(m.id, 'three')).toBe(2)
    db.setStatus(m.id, 'complete')
    expect(db.getMessage(m.id)!.content).toBe('one\ntwo\nthree')
  })

  test('a reply continued after a partial line joins it', () => {
    const { db } = open()
    const m = reply(db)
    db.appendLine(m.id, 'whole line')
    db.appendLine(m.id, 'half a li')
    db.setStatus(m.id, 'interrupted', null, true)
    expect(db.reopenTail(m.id)).toBe('half a li')
    db.setStatus(m.id, 'streaming')
    db.appendLine(m.id, 'half a line, finished')
    expect(db.getMessage(m.id)).toMatchObject({ content: 'whole line\nhalf a line, finished', lineCount: 2 })
  })

  test('a reply cut off by a crash keeps its lines', () => {
    const { db, file } = open()
    const m = reply(db)
    db.appendLine(m.id, 'kept')
    db.close()
    const again = makeDb(file)
    expect(again.markInterrupted()).toBe(1)
    expect(again.getMessage(m.id)).toMatchObject({ content: 'kept', status: 'interrupted' })
    again.close()
  })

  test('lines since an index: while streaming, once folded, and when part is folded', () => {
    const { db } = open()
    const m = reply(db)
    for (const l of ['a', 'b', 'c']) db.appendLine(m.id, l)
    expect(db.linesSince(m.id, 0)).toEqual({ lines: ['a', 'b', 'c'], status: 'streaming' })
    expect(db.linesSince(m.id, 2)).toEqual({ lines: ['c'], status: 'streaming' })
    expect(db.linesSince(m.id, 3)).toEqual({ lines: [], status: 'streaming' })
    expect(db.linesSince(m.id, 9)).toEqual({ lines: [], status: 'streaming' })
    // Stopped, then continued: the first lines are in content, the new one still streamed.
    db.setStatus(m.id, 'stopped')
    expect(db.linesSince(m.id, 1)).toEqual({ lines: ['b', 'c'], status: 'stopped' })
    db.setStatus(m.id, 'streaming')
    db.appendLine(m.id, 'd')
    expect(db.linesSince(m.id, 1)).toEqual({ lines: ['b', 'c', 'd'], status: 'streaming' })
    expect(db.linesSince(m.id, 3)).toEqual({ lines: ['d'], status: 'streaming' })
    expect(db.linesSince('missing', 0)).toBeUndefined()
  })
})

describe('active path', () => {
  test('follows the active branch, with each message among its siblings', () => {
    const { db } = open()
    const s = db.createSession({ title: 'Branches', model: null, systemPrompt: null, forkedFromSessionId: null })
    const u1 = db.insertMessage({ sessionId: s.id, parentId: s.rootId, role: 'user', content: 'first', status: 'complete' })
    const a1 = db.insertMessage({ sessionId: s.id, parentId: u1.id, role: 'assistant', content: 'one', status: 'complete' })
    const a2 = db.insertMessage({ sessionId: s.id, parentId: u1.id, role: 'assistant', content: 'two', status: 'complete' })
    db.insertMessage({ sessionId: s.id, parentId: a2.id, role: 'user', content: 'next', status: 'complete' })
    const path = () => db.activePath(db.getSession(s.id)!).map((n) => [n.message.content, n.siblingIds.length, n.siblingIndex])
    expect(path()).toEqual([
      ['first', 1, 0],
      ['two', 2, 1],
      ['next', 1, 0]
    ])
    db.activate(a1.id)
    expect(path()).toEqual([
      ['first', 1, 0],
      ['one', 2, 0]
    ])
    expect(db.activePath(db.getSession(s.id)!)[1]!.siblingIds).toEqual([a1.id, a2.id])
  })

  test('an empty chat has no path', () => {
    const { db } = open()
    const s = db.createSession({ title: 'Empty', model: null, systemPrompt: null, forkedFromSessionId: null })
    expect(db.activePath(s)).toEqual([])
  })
})

describe('attachment blocks', () => {
  test('encoded once and kept, until the attachment is discarded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-att-'))
    dirs.push(dir)
    let shrunk = 0
    const shrink = (data: Buffer, mime: string) => {
      shrunk++
      return { data: data.subarray(0, 2), mime }
    }
    const paths = AppPaths.layer(dir)
    const runtime = ManagedRuntime.make(Attachments.layerWith(shrink).pipe(Layer.provideMerge(Layer.mergeAll(Db.layer(join(dir, 'chat.db')), paths))))
    const run = <A, E>(effect: Effect.Effect<A, E, Attachments | Db>) => runtime.runPromise(effect)
    try {
      const added = await run(Attachments.use((a) => a.add({ name: 'shot.png', mime: 'image/png', data: new Uint8Array([137, 80, 78, 71]).buffer })))
      const stored = (await run(Db.use((db) => db.use((d) => d.getAttachment(added.id)))))!
      const first = await run(Attachments.use((a) => a.toBlocks([stored])))
      expect(first).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVA=' } }])
      // The file is gone, but the block was kept: nothing is read or encoded again.
      rmSync(stored.path)
      expect(await run(Attachments.use((a) => a.toBlocks([stored])))).toEqual(first)
      expect(shrunk).toBe(1)
      await run(Attachments.use((a) => a.discard(added.id)))
      expect(await run(Effect.flip(Attachments.use((a) => a.toBlocks([stored]))))).toMatchObject({ _tag: 'FileError' })
    } finally {
      await runtime.dispose()
    }
  })
})
