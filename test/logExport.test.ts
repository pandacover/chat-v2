import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { makeDb } from '../src/main/services/Db'
import { makeAgent } from '../src/main/agent/driver'
import { collectLog, crc32, exportLog, readTranscript, replyActivity, writeZip } from '../src/main/logExport'
import { stepLine } from '../src/shared/steps'

const dirs: string[] = []
const open: Array<{ close(): void }> = []
afterEach(() => {
  for (const db of open.splice(0)) db.close()
  // Windows may hold the database file a moment longer (as in db.test.ts).
  for (const d of dirs.splice(0))
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomo-log-'))
  dirs.push(dir)
  return dir
}

/** Reads a zip back: every entry's name and bytes, checking each one's CRC. */
const unzip = (file: string): Map<string, Buffer> => {
  const buf = readFileSync(file)
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const packed = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const offset = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
    const body = buf.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 46 + nameLen
  }
  return out
}

const line = (e: object) => JSON.stringify(e)

/**
 * A Claude Code session as it writes them: a prompt; a call that worked; two in parallel (their
 * results both hang off the first), one failing; an api-request-blob repeating a result (to be
 * ignored); then Continue's prompt, an API error, and a call after it.
 */
const sessionFile = (session: string) =>
  [
    line({ type: 'custom-title', customTitle: 'Tomo' }),
    line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-11-26T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Open the page' }] } }),
    line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-26T10:00:01Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__browser__open', input: { url: 'https://example.com' } }] } }),
    line({ type: 'user', uuid: 'r1', parentUuid: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Opened' }] } }),
    // A hook's additions sit in the chain too.
    line({ type: 'attachment', uuid: 'h1', parentUuid: 'r1', attachment: { type: 'hook_additional_context' } }),
    line({ type: 'assistant', uuid: 'a2', parentUuid: 'h1', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'mcp__browser__click', input: { text: 'Buy' } }] } }),
    line({ type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls /nope' } }] } }),
    // A third call of the same model call, off the chain the reply goes on along.
    line({ type: 'assistant', uuid: 'a3b', parentUuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 't3b', name: 'WebSearch', input: { query: 'q' } }] } }),
    line({ type: 'user', uuid: 'r3b', parentUuid: 'a3b', message: { content: [{ type: 'tool_result', tool_use_id: 't3b', content: 'found' }] } }),
    line({ type: 'user', uuid: 'r2', parentUuid: 'a2', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'Clicked' }, { type: 'image', source: {} }] }] } }),
    line({ type: 'user', uuid: 'r3', parentUuid: 'a3', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: '<tool_use_error>ls: /nope: No such file</tool_use_error>' }] } }),
    line({ type: 'api-request-blob', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'decoy' }] } }),
    line({ type: 'user', uuid: 'u2', parentUuid: 'r3', message: { content: 'Your reply was cut off. What you had written ends with: …' } }),
    line({ type: 'assistant', uuid: 'a4', parentUuid: 'u2', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 500 Internal server error' }] } }),
    line({ type: 'assistant', uuid: 'a5', parentUuid: 'a4', message: { content: [{ type: 'tool_use', id: 't4', name: 'mcp__browser__read', input: {} }] } }),
    // No result: the reply was stopped while it ran.
    'not json {',
    line({ type: 'user', uuid: 'u3', parentUuid: 'a5', message: { content: [{ type: 'text', text: 'Next question' }] } }),
    line({ type: 'assistant', uuid: 'a6', parentUuid: 'u3', message: { content: [{ type: 'tool_use', id: 't5', name: 'mcp__memory__recall', input: { q: 'x' } }] } })
  ].join('\n') + `\n${line({ type: 'last-prompt', sessionId: session })}\n`

describe('transcripts', () => {
  test("a reply's tool calls: back from its checkpoint to its prompt, through Continue, with results matched by id", () => {
    const t = readTranscript(sessionFile('s'))
    const { calls, apiErrors } = replyActivity(t, 'a5')
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2', 't3', 't3b', 't4'])
    expect(calls[0]).toMatchObject({ name: 'mcp__browser__open', result: 'Opened', failed: false, at: '2026-11-26T10:00:01Z' })
    expect(calls[1]).toMatchObject({ result: 'Clicked\n[image]', failed: false })
    expect(calls[2]).toMatchObject({ name: 'Bash', failed: true, result: '<tool_use_error>ls: /nope: No such file</tool_use_error>' })
    expect(calls[3]).toMatchObject({ name: 'WebSearch', result: 'found' })
    expect(calls[4]).toMatchObject({ result: null, failed: false })
    expect(apiErrors).toEqual(['API Error: 500 Internal server error'])
    // The next turn's reply has only its own call.
    expect(replyActivity(t, 'a6').calls.map((c) => c.id)).toEqual(['t5'])
    // An unknown checkpoint has nothing.
    expect(replyActivity(t, 'zz').calls).toEqual([])
  })
})

describe('zip', () => {
  test('stored and deflated entries read back whole, names in UTF-8', async () => {
    const dir = temp()
    const file = join(dir, 'x.zip')
    const text = Buffer.from('hello '.repeat(1000))
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await writeZip(file, [
      { name: 'a.md', data: text },
      { name: 'attachments/ünï.png', data: png },
      { name: 'empty.txt', data: Buffer.alloc(0) }
    ])
    const got = unzip(file)
    expect([...got.keys()]).toEqual(['a.md', 'attachments/ünï.png', 'empty.txt'])
    expect(got.get('a.md')!.equals(text)).toBe(true)
    expect(got.get('attachments/ünï.png')!.equals(png)).toBe(true)
    expect(got.get('empty.txt')!.length).toBe(0)
    expect(readFileSync(file).length).toBeLessThan(text.length)
    expect(existsSync(`${file}.part`)).toBe(false)
  })

  test('a failure leaves no file behind', async () => {
    const dir = temp()
    const file = join(dir, 'x.zip')
    const entries = (async function* () {
      yield { name: 'a', data: Buffer.from('a') }
      throw new Error('boom')
    })()
    await expect(writeZip(file, entries)).rejects.toThrow('boom')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.part`)).toBe(false)
  })
})

describe('export log', () => {
  const setup = () => {
    const dir = temp()
    const db = makeDb(join(dir, 'chat.db'))
    open.push(db)
    const configDir = join(dir, 'claude')
    const agent = makeAgent({ query: (() => { throw new Error('no') }) as never, configDir, cwd: dir, clientApp: 'tomo/test' })
    const projects = join(configDir, 'projects', 'C--data')
    mkdirSync(join(projects, 'sess-1', 'subagents'), { recursive: true })
    writeFileSync(join(projects, 'sess-1.jsonl'), sessionFile('sess-1'))
    writeFileSync(join(projects, 'sess-1', 'subagents', 'agent-x.jsonl'), '{"type":"user"}\n')

    const primary = db.primaryBot()
    const worker = db.createBot({ name: 'Scout' })
    const conversation = db.primarySession()
    // The user asks the primary; its reply starts the job.
    const ask = db.insertMessage({ sessionId: conversation.id, parentId: conversation.rootId, role: 'user', content: 'Buy the thing', status: 'complete' })
    db.markVia(ask.id, conversation.id)
    const starter = db.insertMessage({ sessionId: conversation.id, parentId: ask.id, role: 'assistant', content: `On it.\n${stepLine({ tool: 'team_start_job', label: 'Handed “Buy” to Scout', ok: true })}`, status: 'complete' })
    // The primary's session: this reply, then a turn about something else entirely.
    writeFileSync(
      join(projects, 'sess-p.jsonl'),
      [
        line({ type: 'user', uuid: 'p1', parentUuid: null, message: { content: 'Buy the thing' } }),
        line({ type: 'assistant', uuid: 'pa1', parentUuid: 'p1', message: { content: [{ type: 'tool_use', id: 'tp1', name: 'mcp__team__start_job', input: { bot: 'Scout' } }] } }),
        line({ type: 'user', uuid: 'pr1', parentUuid: 'pa1', message: { content: [{ type: 'tool_result', tool_use_id: 'tp1', content: 'Opened the job' }] } }),
        line({ type: 'assistant', uuid: 'pa2', parentUuid: 'pr1', message: { content: [{ type: 'text', text: 'On it.' }] } }),
        line({ type: 'user', uuid: 'p2', parentUuid: 'pa2', message: { content: 'My secret plans' } }),
        line({ type: 'assistant', uuid: 'pa3', parentUuid: 'p2', message: { content: [{ type: 'tool_use', id: 'tp2', name: 'mcp__browser__open', input: { url: 'https://private.example' } }] } })
      ].join('\n') + '\n'
    )
    db.claimAgentSession(starter.id, 'sess-p')
    db.checkpoint(starter.id, 'pa2')
    const { job, thread } = db.createJob({ title: 'Buy: the thing', botId: worker.id, threadBotId: primary.id })
    db.appendPost({ threadId: thread.id, authorBotId: primary.id, text: 'Buy the thing', post: { kind: 'task', to: worker.id, state: null } })
    const own = db.workerThread(job.id, worker.id, true)!

    // In the worker's thread: the task, a reply that failed and its regeneration.
    const turn = db.insertMessage({ sessionId: own.id, parentId: own.rootId, role: 'user', content: 'Buy the thing', status: 'complete', authorBotId: primary.id })
    const failed = db.insertMessage({ sessionId: own.id, parentId: turn.id, role: 'assistant', content: '', status: 'streaming' })
    db.appendLine(failed.id, 'Trying')
    db.appendLine(failed.id, stepLine({ tool: 'Bash', label: 'Ran a command', ok: false, detail: 'ls: /nope: No such file' }))
    db.setStatus(failed.id, 'error', "Claude's API had a server error (500).")
    db.claimAgentSession(failed.id, 'sess-1')
    db.checkpoint(failed.id, 'a5')
    const again = db.insertMessage({ sessionId: own.id, parentId: turn.id, role: 'assistant', content: 'Bought it', status: 'complete' })

    // Files: one on disk, one whose file is gone, one sent twice (an edit copies the row, not the file).
    const shot = join(dir, 'shot.png')
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]))
    const a = db.insertAttachment({ name: 'shot.png', mime: 'image/png', size: 6, kind: 'image', path: shot })
    const b = db.insertAttachment({ name: 'gone.txt', mime: 'text/plain', size: 3, kind: 'text', path: join(dir, 'gone.txt') })
    db.bindAttachments([a.id, b.id], turn.id)
    db.bindAttachments([a.id], again.id)

    // The worker's report comes back to the primary, which answers it; another job's report stays out.
    db.appendPost({ threadId: thread.id, authorBotId: worker.id, text: 'Done: bought it', post: { kind: 'report', to: primary.id, state: null } })
    const report = db.insertMessage({ sessionId: conversation.id, parentId: starter.id, role: 'user', content: 'Done: bought it', status: 'complete', authorBotId: worker.id, post: { kind: 'report', to: primary.id, state: null } })
    db.markVia(report.id, conversation.id)
    const answer = db.insertMessage({ sessionId: conversation.id, parentId: report.id, role: 'assistant', content: 'Scout bought it.', status: 'complete' })
    const other = db.createJob({ title: 'Other', botId: worker.id, threadBotId: primary.id })
    db.appendPost({ threadId: other.thread.id, authorBotId: worker.id, text: 'Other done', post: { kind: 'report', to: primary.id, state: null } })
    const otherReport = db.insertMessage({ sessionId: conversation.id, parentId: answer.id, role: 'user', content: 'Other done', status: 'complete', authorBotId: worker.id, post: { kind: 'report', to: primary.id, state: null } })
    db.markVia(otherReport.id, conversation.id)

    return { dir, db, agent, job, thread, own, ask, starter, report, answer, otherReport, failed, again }
  }

  const about = { version: '0.1.0', platform: 'win32', arch: 'x64', os: 'Windows_NT 10', electron: '44' }

  test('from either of its threads: the whole job, the primary turns about it, and nothing of another job', () => {
    const s = setup()
    for (const from of [s.thread.id, s.own.id]) {
      const data = collectLog(s.db, from)!
      expect(data.job?.id).toBe(s.job.id)
      expect(data.threads.map((t) => t.session.id)).toEqual([s.thread.id, s.own.id])
      expect(data.primary.map((m) => m.id)).toEqual([s.ask.id, s.starter.id, s.report.id, s.answer.id])
      const own = data.threads[1]!
      // Both branches, the shown one marked.
      expect(own.messages.map((m) => m.id)).toContain(s.failed.id)
      expect(own.shown).toContain(s.again.id)
      expect(own.shown).not.toContain(s.failed.id)
      expect(own.messages.find((m) => m.id === s.failed.id)).toMatchObject({ agentSession: 'sess-1', agentUuid: 'a5', status: 'error' })
    }
    expect(collectLog(s.db, 'nope')).toBeUndefined()
  })

  test('writes a zip with the readable log, the data, the transcripts and the files', async () => {
    const s = setup()
    const file = join(s.dir, 'out.zip')
    const result = await exportLog(collectLog(s.db, s.own.id)!, file, { transcripts: s.agent.transcripts, about, settings: null, now: Date.UTC(2026, 10, 26) })
    expect(result).toMatchObject({ path: file, skipped: 1, transcripts: 3, attachments: 1 })
    const got = unzip(file)
    const shotName = [...got.keys()].find((k) => k.startsWith('attachments/'))!
    expect([...got.keys()].sort()).toEqual(
      [shotName, 'log.json', 'log.md', 'transcripts/sess-1.jsonl', 'transcripts/sess-1/subagents/agent-x.jsonl', 'transcripts/sess-p.excerpt.jsonl'].sort()
    )
    expect(got.get('transcripts/sess-1.jsonl')!.toString()).toBe(sessionFile('sess-1'))
    // Of the primary's session, only the reply that started the job: its prompt, call, result and text.
    const primaryLines = got.get('transcripts/sess-p.excerpt.jsonl')!.toString().trim().split('\n').map((l) => JSON.parse(l).uuid)
    expect(primaryLines).toEqual(['p1', 'pa1', 'pr1', 'pa2'])
    const attachment = [...got.entries()].find(([k]) => k.startsWith('attachments/'))!
    expect(attachment[0]).toEndWith('-shot.png')
    expect(attachment[1].equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]))).toBe(true)

    const md = got.get('log.md')!.toString()
    expect(md).toContain('# Tomo log: Buy: the thing')
    expect(md).toContain("Scout's own thread")
    expect(md).toContain('not on the branch shown')
    expect(md).toContain("**Error:** Claude's API had a server error (500).")
    expect(md).toContain('[✗ Bash] Ran a command · ls: /nope: No such file')
    expect(md).toContain('Tool calls: 5, 1 failed')
    expect(md).toContain('- ✗ failed `Bash`')
    expect(md).toContain('ls: /nope: No such file</tool_use_error>')
    expect(md).toContain('- … no result `mcp__browser__read`')
    expect(md).toContain('**API error:** API Error: 500 Internal server error')
    expect(md).toContain('gone.txt (text, text/plain, 3 B): left out: its file is gone')
    expect(md).toContain("Tomo's conversation, about this job")
    expect(md).toContain('Scout bought it.')
    expect(md).not.toContain('Other done')
    // The call from the session's later turn, which no reply here claims.
    expect(md).toContain('## Other tool calls in `transcripts/sess-1.jsonl`')
    expect(md).toContain('`mcp__memory__recall`')
    // The primary's start_job call, under its reply; its other turn's call nowhere.
    expect(md).toContain('Claude Code session: `transcripts/sess-p.excerpt.jsonl`')
    expect(md).toContain('- ✓ `mcp__team__start_job`')
    expect(md).not.toContain('private.example')
    expect(got.get('log.json')!.toString()).not.toContain('private.example')

    const data = JSON.parse(got.get('log.json')!.toString())
    const failed = data.threads[1].messages.find((m: { id: string }) => m.id === s.failed.id)
    expect(failed.toolCalls.map((c: { id: string; failed: boolean }) => [c.id, c.failed])).toEqual([['t1', false], ['t2', false], ['t3', true], ['t3b', false], ['t4', false]])
    // No paths on this machine in the data.
    expect(got.get('log.json')!.toString()).not.toContain(s.dir.replace(/\\/g, '\\\\'))
    const turnFiles = data.threads[1].messages[0].files
    expect(turnFiles.map((f: { name: string; file?: string; skipped?: string }) => [f.name, !!f.file, f.skipped ?? null])).toEqual([['shot.png', true, null], ['gone.txt', false, 'its file is gone']])
  })

  test("the primary's conversation exports on its own", async () => {
    const s = setup()
    const data = collectLog(s.db, s.db.primarySession().id)!
    expect(data.job).toBeNull()
    expect(data.primary).toEqual([])
    expect(data.threads[0]!.messages.map((m) => m.id)).toContain(s.otherReport.id)
    const file = join(s.dir, 'p.zip')
    await exportLog(data, file, { transcripts: s.agent.transcripts, about, settings: null })
    expect(unzip(file).get('log.md')!.toString()).toContain("the primary's conversation")
  })
})
