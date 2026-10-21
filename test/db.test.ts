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
})

describe('attachment parts', () => {
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
      const first = await run(Attachments.use((a) => a.toParts([stored])))
      expect(first.parts).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVA=' } }])
      // The file is gone, but the part was kept: nothing is read or encoded again.
      rmSync(stored.path)
      expect((await run(Attachments.use((a) => a.toParts([stored])))).parts).toEqual(first.parts)
      expect(shrunk).toBe(1)
      await run(Attachments.use((a) => a.discard(added.id)))
      expect(await run(Effect.flip(Attachments.use((a) => a.toParts([stored]))))).toMatchObject({ _tag: 'FileError' })
    } finally {
      await runtime.dispose()
    }
  })
})
