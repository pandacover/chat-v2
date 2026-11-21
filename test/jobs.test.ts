import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { Job, StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Broadcaster, Chat } from '../src/main/services/Chat'
import { Db, MIGRATIONS, makeDb } from '../src/main/services/Db'
import { BOTS_AND_JOBS_MIGRATION } from '../src/main/services/jobsDb'
import { Jobs } from '../src/main/services/Jobs'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { Agent } from '../src/main/agent/driver'
import { ComputerUse, noOverlay } from '../src/main/computer'
import { Browser } from '../src/main/services/Browser'
import { ROUTER_INSTRUCTIONS, SUMMARY_INSTRUCTIONS, candidates, cleanSummary, jobsBlock, parseRoute, routerPrompt } from '../src/main/jobs'
import { type Call, type Script, fakeQuery } from './fakeQuery'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-jobs-'))
  dirs.push(dir)
  return dir
}

const job = (over: Partial<Job> & { id: string }): Job => ({
  title: over.id,
  status: 'open',
  ownerBotId: 'tomo',
  parentJobId: null,
  summary: null,
  usage: null,
  createdAt: 0,
  updatedAt: 0,
  threadId: `t-${over.id}`,
  ...over
})

describe('the migration to bots and jobs', () => {
  /** A chat.db as the app left it before bots: every migration up to (not including) this one. */
  const oldDb = (file: string) => {
    const at = MIGRATIONS.indexOf(BOTS_AND_JOBS_MIGRATION)
    expect(at).toBeGreaterThan(0)
    const raw = new DatabaseSync(file)
    raw.exec('pragma foreign_keys = on')
    for (const [i, sql] of MIGRATIONS.slice(0, at).entries()) {
      raw.exec(sql)
      raw.exec(`pragma user_version = ${i + 1}`)
    }
    const chat = (id: string, title: string, at: number, extra = '') => {
      raw.exec(`insert into sessions (id, title, model, system_prompt, root_id, forked_from_session_id, created_at, updated_at, pinned_at, browser_enabled)
                values ('${id}', '${title}', null, ${extra ? `'${extra}'` : 'null'}, '${id}-root', null, ${at}, ${at}, null, 0)`)
      raw.exec(`insert into messages (id, session_id, parent_id, role, content, status, created_at) values ('${id}-root', '${id}', null, 'root', '', 'complete', ${at})`)
      raw.exec(`insert into messages (id, session_id, parent_id, role, content, status, created_at) values ('${id}-u', '${id}', '${id}-root', 'user', 'Hello from ${title}', 'complete', ${at})`)
      raw.exec(`insert into messages (id, session_id, parent_id, role, content, status, created_at, usage)
                values ('${id}-a', '${id}', '${id}-u', 'assistant', 'Hi', 'complete', ${at + 1}, '{"cost":0.25,"totalTokens":100}')`)
      raw.exec(`update messages set active_child_id = '${id}-u' where id = '${id}-root'`)
      raw.exec(`update messages set active_child_id = '${id}-a' where id = '${id}-u'`)
    }
    chat('c1', 'Printer trouble', 1000, 'Talk like a pirate')
    chat('c2', 'Trip to Lisbon', 2000)
    chat('c3', 'Lisbon (fork)', 3000)
    raw.exec(`update sessions set forked_from_session_id = 'c2', pinned_at = 5 where id = 'c3'`)
    // A fork whose source was deleted since.
    chat('c4', 'Orphan fork', 4000)
    raw.exec(`update sessions set forked_from_session_id = 'gone' where id = 'c4'`)
    raw.close()
  }

  test('keeps every chat, as a finished job with one thread owned by the primary bot', () => {
    const file = join(tempDir(), 'chat.db')
    oldDb(file)
    const db = makeDb(file)

    const bots = db.listBots()
    expect(bots).toHaveLength(1)
    expect(bots[0]).toMatchObject({ id: 'tomo', name: 'Tomo', avatar: 'mascot', isPrimary: true, instructions: null, modules: ['browser', 'computer'] })

    const jobs = db.listJobs()
    expect(jobs.map((j) => [j.id, j.title, j.status, j.threadId, j.ownerBotId])).toEqual([
      ['c4', 'Orphan fork', 'done', 'c4', 'tomo'],
      ['c3', 'Lisbon (fork)', 'done', 'c3', 'tomo'],
      ['c2', 'Trip to Lisbon', 'done', 'c2', 'tomo'],
      ['c1', 'Printer trouble', 'done', 'c1', 'tomo']
    ])
    expect(jobs.find((j) => j.id === 'c3')!.parentJobId).toBe('c2')
    expect(jobs.find((j) => j.id === 'c4')!.parentJobId).toBeNull()
    expect(jobs[0]!.usage).toEqual({ cost: 0.25, tokens: 100, replies: 1 })
    expect(jobs[0]!.updatedAt).toBe(4000)

    // The chats themselves are untouched, now threads of their jobs.
    const c1 = db.getSession('c1')!
    expect(c1).toMatchObject({ title: 'Printer trouble', systemPrompt: 'Talk like a pirate', botId: 'tomo', jobId: 'c1', kind: 'shared' })
    expect(db.getSession('c3')!.pinnedAt).toBe(5)
    expect(db.activePath(c1).map((n) => [n.message.role, n.message.content, n.message.authorBotId])).toEqual([
      ['user', 'Hello from Printer trouble', null],
      ['assistant', 'Hi', 'tomo']
    ])
    expect(db.listSessions()).toHaveLength(4)

    // The primary's conversation is there and empty, and the startup clean-up leaves it alone.
    const primary = db.primarySession()
    expect(primary).toMatchObject({ title: 'Tomo', kind: 'primary', botId: 'tomo', jobId: null })
    expect(db.primaryPath(primary.id)).toEqual([])
    expect(db.pruneEmptySessions()).toBe(0)
    expect(db.primarySession().id).toBe(primary.id)
    db.close()
  })

  test('the primary takes its instructions, model and effort from Settings once', () => {
    const db = makeDb(join(tempDir(), 'chat.db'))
    expect(db.seedPrimary({ systemPrompt: 'Be brief.', defaultModel: 'claude-opus-5-5', effort: 'high' })).toBe(true)
    expect(db.primaryBot()).toMatchObject({ instructions: 'Be brief.', model: 'claude-opus-5-5', effort: 'high' })
    db.updateBot('tomo', { instructions: 'Be kind.' })
    expect(db.seedPrimary({ systemPrompt: 'Be brief.', defaultModel: 'claude-opus-5-5', effort: 'high' })).toBe(false)
    expect(db.primaryBot().instructions).toBe('Be kind.')
    db.close()
  })

  test('a job follows its thread: title, time, reopening, and forks as child jobs', () => {
    const db = makeDb(join(tempDir(), 'chat.db'))
    const { job: j, thread } = db.createJob({ title: 'New chat', botId: 'tomo' })
    expect(j.status).toBe('open')
    const u = db.insertMessage({ sessionId: thread.id, parentId: thread.rootId, role: 'user', content: 'hi', status: 'complete' })
    const a = db.insertMessage({ sessionId: thread.id, parentId: u.id, role: 'assistant', content: 'yo', status: 'complete' })
    expect(a.authorBotId).toBe('tomo')
    expect(db.getJob(j.id)!.updatedAt).toBe(db.getSession(thread.id)!.updatedAt)
    db.retitle(thread.id, 'New chat', 'Greetings')
    expect(db.getJob(j.id)!.title).toBe('Greetings')
    db.renameJob(j.id, 'Hellos')
    expect(db.getSession(thread.id)!.title).toBe('Hellos')
    db.setJobStatus(j.id, 'done')
    db.insertMessage({ sessionId: thread.id, parentId: a.id, role: 'user', content: 'again', status: 'complete' })
    expect(db.getJob(j.id)!.status).toBe('open')

    const fork = db.forkThread(thread.id, a.id)
    expect(fork).toMatchObject({ kind: 'shared', botId: 'tomo', forkedFromSessionId: thread.id })
    const forked = db.getJob(fork.jobId!)!
    expect(forked).toMatchObject({ title: 'Hellos (fork)', parentJobId: j.id, status: 'open', threadId: fork.id })
    expect(db.activePath(fork).at(-1)!.message.authorBotId).toBe('tomo')

    db.deleteJob(j.id)
    expect(db.getSession(thread.id)).toBeUndefined()
    expect(db.getJob(forked.id)!.parentJobId).toBeNull()
    db.close()
  })

  test('taking a turn out of its thread leaves the thread as it was before it', () => {
    const db = makeDb(join(tempDir(), 'chat.db'))
    const { thread } = db.createJob({ title: 'x', botId: 'tomo' })
    const u1 = db.insertMessage({ sessionId: thread.id, parentId: thread.rootId, role: 'user', content: 'one', status: 'complete' })
    const a1 = db.insertMessage({ sessionId: thread.id, parentId: u1.id, role: 'assistant', content: 'One', status: 'complete' })
    const u2 = db.insertMessage({ sessionId: thread.id, parentId: a1.id, role: 'user', content: 'two', status: 'complete' })
    db.insertMessage({ sessionId: thread.id, parentId: u2.id, role: 'assistant', content: 'Two', status: 'complete' })
    db.removeTurn(u2.id)
    expect(db.activePath(db.getSession(thread.id)!).map((n) => n.message.content)).toEqual(['one', 'One'])
    expect(db.getMessage(a1.id)!.activeChildId).toBeNull()
    db.removeTurn(u1.id)
    expect(db.threadEmpty(thread.id)).toBe(true)
    db.close()
  })
})

describe('routing, summaries and the job list', () => {
  const jobs = [job({ id: 'a', title: 'Printer', updatedAt: 3 }), job({ id: 'b', title: 'Lisbon', updatedAt: 2, summary: 'Booked flights' }), job({ id: 'c', title: 'Old', status: 'done', updatedAt: 1 })]

  test('candidates: open jobs, then the latest finished, and the current one always', () => {
    expect(candidates(jobs, null).map((j) => j.id)).toEqual(['a', 'b', 'c'])
    const many = Array.from({ length: 20 }, (_, i) => job({ id: `o${i}`, updatedAt: 100 - i }))
    const old = job({ id: 'old', status: 'done', updatedAt: -5 })
    const list = candidates([...many, ...Array.from({ length: 6 }, (_, i) => job({ id: `d${i}`, status: 'done', updatedAt: 10 - i })), old], 'old')
    expect(list[0]!.id).toBe('old')
    expect(list.filter((j) => j.status === 'open')).toHaveLength(12)
    expect(list.filter((j) => j.status === 'done').map((j) => j.id)).toEqual(['old', 'd0', 'd1', 'd2', 'd3'])
  })

  test('the router sees numbered jobs, the current one marked, the last exchange and the message', () => {
    const prompt = routerPrompt(jobs, 'b', { user: 'Find flights', reply: 'Found two.\n::step {"tool":"search","label":"Searched","ok":true}' }, 'the cheaper one')
    expect(prompt).toContain('1. [open] Printer\n2. [open] Lisbon — Booked flights (current)\n3. [finished] Old')
    expect(prompt).toContain('<last_exchange>\n<user>\nFind flights\n</user>')
    expect(prompt).toEndWith('<message>\nthe cheaper one\n</message>')
    expect(ROUTER_INSTRUCTIONS).toContain('{"job": "new"')
  })

  test('router replies are read leniently', () => {
    expect(parseRoute('{"job": 2}', jobs)).toEqual({ kind: 'job', jobId: 'b' })
    expect(parseRoute('```json\n{"job": "3"}\n```', jobs)).toEqual({ kind: 'job', jobId: 'c' })
    expect(parseRoute('1', jobs)).toEqual({ kind: 'job', jobId: 'a' })
    expect(parseRoute('{"job": "new", "title": "Birthday cake"}', jobs)).toEqual({ kind: 'new', title: 'Birthday cake' })
    expect(parseRoute('{"job": "NEW"}', jobs)).toEqual({ kind: 'new', title: null })
    expect(parseRoute('{"job": 9}', jobs)).toBeNull()
    expect(parseRoute('I think it is about printers', jobs)).toBeNull()
  })

  test('summaries are one tidy line', () => {
    expect(cleanSummary('Status: "Drivers reinstalled; waiting for a test print."\n\nmore')).toBe('Drivers reinstalled; waiting for a test print.')
    expect(cleanSummary('  \n')).toBeNull()
    expect(cleanSummary('x'.repeat(400))!.length).toBe(200)
  })

  test('the job list the bot sees: this job, then the others', () => {
    expect(jobsBlock(jobs[1]!, jobs)).toBe('<jobs>\nThis job: Lisbon — Booked flights\nOther jobs:\n- [open] Printer\n- [finished] Old\n</jobs>')
    expect(jobsBlock(null, [])).toBe('')
  })
})

// The service, end to end against a fake Claude Code.
const isAsk = (c: Call) => c.options.persistSession === false
const systemOf = (c: Call) => (c.options.systemPrompt as { prompt: string }).prompt
const promptText = (c: Call) => c.prompt.map((b) => b.text ?? `[${b.type}]`).join('\n---\n')

/** Asks answered by kind; replies echo the message. `route` answers the router, in order. */
const script = (route: string[]): Script =>
  async function* (t) {
    if (isAsk(t.call)) {
      const system = systemOf(t.call)
      const text = system === ROUTER_INSTRUCTIONS ? (route.shift() ?? '{}') : system === SUMMARY_INSTRUCTIONS ? `Summary of: ${promptText(t.call).split('<user>\n')[1]?.split('\n')[0]}` : 'Named job'
      yield* t.text(text)
      yield t.result()
      return
    }
    yield* t.text(`Reply to ${promptText(t.call).split('\n---\n').at(-1)}`)
    yield t.result()
  }

const setup = (route: string[], config: Record<string, unknown> = { titleModel: 'claude-haiku-5-5', memoryModel: '', systemPrompt: 'Be a fox.' }) => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const events: StreamEvent[] = []
  const fake = fakeQuery(script(route))
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const agent = Agent.layer({ query: fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
  const computer = ComputerUse.layer({ platform: null, overlay: noOverlay, remember: async () => {} })
  const providers = Layer.mergeAll(agent, Attachments.layer, computer).pipe(Layer.provideMerge(base))
  const broadcaster = Layer.succeed(Broadcaster, Broadcaster.of({ send: (e) => void events.push(e) }))
  const browser = Layer.succeed(Browser, {} as never)
  const chat = Chat.layer.pipe(Layer.provide(providers), Layer.provide(broadcaster), Layer.provide(browser))
  const jobs = Jobs.layer.pipe(Layer.provideMerge(chat), Layer.provide(providers), Layer.provide(broadcaster))
  const runtime = ManagedRuntime.make(Layer.mergeAll(jobs, providers))
  const run = <A, E>(eff: Effect.Effect<A, E, Jobs | Chat | Db>) => runtime.runPromise(eff)
  const settle = async (ok: () => boolean) => {
    for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    expect(ok()).toBe(true)
  }
  const doneCount = () => events.filter((e) => e.type === 'done').length
  return { runtime, run, calls: fake.calls, events, settle, doneCount }
}

const send = (text: string, target: 'auto' | 'new' | { jobId: string } = 'auto') => Jobs.use((j) => j.send({ text, attachmentIds: [], target }))
const listJobs = Db.use((db) => db.use((d) => d.listJobs()))

describe('talking to the primary bot', () => {
  test('routes each message to a job, keeps the conversation in order, and moves a wrong guess', async () => {
    const t = setup(['{"job": 1}', '{"job": "new", "title": "Trip to Lisbon"}'])
    // The first message ever: nothing to route to, so a job is made without asking.
    let view = await t.run(send('My printer is jammed'))
    await t.settle(() => t.doneCount() >= 1)
    expect(t.calls.filter((c) => systemOf(c) === ROUTER_INSTRUCTIONS)).toHaveLength(0)
    expect(view.session.kind).toBe('primary')
    // It is named by the title model, and its summary written after the reply.
    await t.settle(() => t.calls.filter(isAsk).length >= 2)
    await t.settle(() => t.events.filter((e) => e.type === 'jobs').length >= 3)
    let jobs = await t.run(listJobs)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ title: 'Named job', status: 'open', summary: 'Summary of: My printer is jammed' })

    // The reply ran as the primary bot, in the job's thread, seeing where the job stands.
    const first = t.calls.find((c) => !isAsk(c))!
    expect(systemOf(first)).toStartWith('Be a fox.')
    expect(systemOf(first)).toContain('You are Tomo')

    // A follow-up: the router says it continues the current job.
    view = await t.run(send('It still jams'))
    await t.settle(() => t.doneCount() >= 2)
    const router = t.calls.find((c) => systemOf(c) === ROUTER_INSTRUCTIONS)!
    expect(promptText(router)).toContain('1. [open] Named job — Summary of: My printer is jammed (current)')
    expect(promptText(router)).toContain('<message>\nIt still jams\n</message>')
    const second = t.calls.filter((c) => !isAsk(c))[1]!
    expect(promptText(second)).toStartWith('<jobs>\nThis job: Named job — Summary of: My printer is jammed\n</jobs>')
    // Resumed in the job's own Claude Code session.
    expect(second.options.resume).toBe(first.session)
    jobs = await t.run(listJobs)
    expect(jobs).toHaveLength(1)

    // Something else: a new job, named by the router.
    view = await t.run(send('Flights to Lisbon in May?'))
    await t.settle(() => t.doneCount() >= 3)
    jobs = await t.run(listJobs)
    expect(jobs.map((j) => j.title).sort()).toEqual(['Named job', 'Trip to Lisbon'])
    const lisbon = jobs.find((j) => j.title === 'Trip to Lisbon')!

    // The primary's conversation: every turn, in order, each in its job's thread.
    view = await t.run(Jobs.use((j) => j.primary))
    expect(view.path.map((n) => [n.message.role, n.message.content.split('\n')[0]])).toEqual([
      ['user', 'My printer is jammed'],
      ['assistant', 'Reply to My printer is jammed'],
      ['user', 'It still jams'],
      ['assistant', 'Reply to It still jams'],
      ['user', 'Flights to Lisbon in May?'],
      ['assistant', 'Reply to Flights to Lisbon in May?']
    ])
    expect(view.path[4]!.message.sessionId).toBe(lisbon.threadId!)
    expect(view.path[5]!.message.authorBotId).toBe('tomo')

    // A wrong guess, put right: the last message moves to the printer job, and the job made for it goes.
    const printer = jobs.find((j) => j.title === 'Named job')!
    const last = view.path[4]!.message
    view = await t.run(Jobs.use((j) => j.move({ messageId: last.id, target: { jobId: printer.id } })))
    await t.settle(() => t.doneCount() >= 4)
    jobs = await t.run(listJobs)
    expect(jobs.map((j) => j.title)).toEqual(['Named job'])
    expect(view.path.map((n) => n.message.sessionId)).toEqual(Array(6).fill(printer.threadId))
    expect(view.path[4]!.message.content).toBe('Flights to Lisbon in May?')
    // Only the newest turn can move.
    await expect(t.run(Jobs.use((j) => j.move({ messageId: view.path[0]!.message.id, target: 'new' })))).rejects.toThrow('Only the last message')
    await t.runtime.dispose()
  })

  test('the chip picks the job, and writing in a finished job reopens it', async () => {
    const t = setup([], { titleModel: '', memoryModel: '' })
    await t.run(send('First topic'))
    await t.settle(() => t.doneCount() >= 1)
    await t.run(send('Second topic', 'new'))
    await t.settle(() => t.doneCount() >= 2)
    let jobs = await t.run(listJobs)
    expect(jobs).toHaveLength(2)
    const firstJob = jobs.find((j) => j.title === 'First topic')!
    await t.run(Jobs.use((j) => j.setStatus(firstJob.id, 'done')))
    // Without a small model, a message stays with the current job.
    await t.run(send('More on the second'))
    await t.settle(() => t.doneCount() >= 3)
    jobs = await t.run(listJobs)
    expect(jobs).toHaveLength(2)
    expect(jobs.find((j) => j.id === firstJob.id)!.status).toBe('done')
    // Sent to the finished job on purpose: it opens again.
    await t.run(send('Back to the first', { jobId: firstJob.id }))
    await t.settle(() => t.doneCount() >= 4)
    jobs = await t.run(listJobs)
    expect(jobs.find((j) => j.id === firstJob.id)!.status).toBe('open')
    // Deleting a job takes its thread with it.
    await t.run(Jobs.use((j) => j.remove(firstJob.id)))
    expect((await t.run(listJobs)).map((j) => j.title)).toEqual(['Second topic'])
    await t.runtime.dispose()
  })
})
