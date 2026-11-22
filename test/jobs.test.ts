import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { Job, Message, Post, StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { BROWSER_AND_COMPUTER_NOTE, Broadcaster, Chat } from '../src/main/services/Chat'
import { Db, MIGRATIONS, makeDb } from '../src/main/services/Db'
import { BOTS_AND_JOBS_MIGRATION } from '../src/main/services/jobsDb'
import { Jobs } from '../src/main/services/Jobs'
import { Team } from '../src/main/services/Team'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { Agent } from '../src/main/agent/driver'
import { ComputerUse, noOverlay } from '../src/main/computer'
import { Browser } from '../src/main/services/Browser'
import { SUMMARY_INSTRUCTIONS, cleanSummary, jobsBlock, listedJobs } from '../src/main/jobs'
import { isTopicStart, topicStart } from '../src/main/agent/history'
import { describeHits, excerpt } from '../src/main/agent/recall'
import {
  CHAT_SUMMARY_INSTRUCTIONS,
  ROLLOVER_BUDGET,
  ROLLOVER_GAP_MS,
  carryText,
  cleanChatSummary,
  recentExchanges,
  rolloverLimits,
  segmentRecord,
  shouldRollOver,
  summaryIn
} from '../src/main/rollover'
import { type Call, type Script, fakeQuery } from './fakeQuery'
import { fakeOverlay, fakePlatform } from './computer/fakes'

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
    expect(bots[0]).toMatchObject({ id: 'tomo', name: 'Tomo', avatar: 'mascot', isPrimary: true, instructions: null, modules: [] })

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
    expect(db.activePath(db.getSession(thread.id)!)).toEqual([])
    db.close()
  })

  test('a New topic divider goes after the reply on show, before turns still waiting, and only once', () => {
    const db = makeDb(join(tempDir(), 'chat.db'))
    const primary = db.primarySession()
    expect(db.newTopic(primary.id)).toBeNull()
    const u1 = db.insertMessage({ sessionId: primary.id, parentId: primary.rootId, role: 'user', content: 'one', status: 'complete' })
    db.markVia(u1.id, primary.id)
    const a1 = db.insertMessage({ sessionId: primary.id, parentId: u1.id, role: 'assistant', content: 'One', status: 'streaming' })
    // Sent while the reply ran: it waits at the end.
    const u2 = db.insertMessage({ sessionId: primary.id, parentId: a1.id, role: 'user', content: 'two', status: 'complete' })
    db.markVia(u2.id, primary.id)
    const mark = db.newTopic(primary.id)!
    expect(mark).toMatchObject({ role: 'assistant', post: { kind: 'topic', to: null, state: null }, authorBotId: null, parentId: a1.id, content: '' })
    const path = () => db.activePath(db.getSession(primary.id)!).map((n) => (n.message.post?.kind === 'topic' ? '—' : n.message.content))
    expect(path()).toEqual(['one', 'One', '—', 'two'])
    expect(db.getMessage(u2.id)!.parentId).toBe(mark.id)
    // Tomo's conversation shows it in order, though the waiting turn is older than the divider.
    expect(db.primaryPath(primary.id).map((n) => (n.message.post?.kind === 'topic' ? '—' : n.message.content))).toEqual(['one', 'One', '—', 'two'])
    // Nothing to divide again until something is said after it.
    db.setStatus(a1.id, 'complete', null)
    const a2 = db.insertMessage({ sessionId: primary.id, parentId: u2.id, role: 'assistant', content: 'Two', status: 'complete' })
    expect(db.newTopic(primary.id)!.parentId).toBe(a2.id)
    expect(db.newTopic(primary.id)).toBeNull()
    db.close()
  })
})

describe('summaries and the job list', () => {
  const jobs = [job({ id: 'a', title: 'Printer', updatedAt: 3 }), job({ id: 'b', title: 'Lisbon', updatedAt: 2, summary: 'Booked flights' }), job({ id: 'c', title: 'Old', status: 'done', updatedAt: 1 })]

  test('the jobs a list shows: open ones, newest first, then the latest finished', () => {
    expect(listedJobs(jobs).map((j) => j.id)).toEqual(['a', 'b', 'c'])
    const many = Array.from({ length: 20 }, (_, i) => job({ id: `o${i}`, updatedAt: 100 - i }))
    const list = listedJobs([...many, ...Array.from({ length: 6 }, (_, i) => job({ id: `d${i}`, status: 'done', updatedAt: 10 - i }))])
    expect(list.filter((j) => j.status === 'open')).toHaveLength(12)
    expect(list.filter((j) => j.status === 'done').map((j) => j.id)).toEqual(['d0', 'd1', 'd2', 'd3'])
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

  test('a topic divider is where the history a reply may see starts', () => {
    const m = (role: Message['role'], kind: Post['kind'] | null = null) => ({ role, post: kind ? { kind, to: null, state: null } : null })
    expect(topicStart([m('root'), m('user'), m('assistant')])).toBe(-1)
    expect(topicStart([m('root'), m('user'), m('assistant'), m('assistant', 'topic'), m('user'), m('assistant', 'topic'), m('user')])).toBe(5)
    // A bot's report or a post is no divider.
    expect(isTopicStart(m('assistant', 'report'))).toBe(false)
    expect(isTopicStart(m('user', 'topic'))).toBe(false)
  })
})

// The service, end to end against a fake Claude Code.
const isAsk = (c: Call) => c.options.persistSession === false
const systemOf = (c: Call) => (c.options.systemPrompt as { prompt: string }).prompt
const promptText = (c: Call) => c.prompt.map((b) => b.text ?? `[${b.type}]`).join('\n---\n')
const servers = (c: Call) => Object.keys(c.options.mcpServers ?? {})

/** Gates a reply can wait on ("hold: <name>"), opened by the test. */
const gates = new Map<string, { promise: Promise<void>; open: () => void }>()
const gate = (name: string) => {
  let g = gates.get(name)
  if (!g) {
    let open = () => {}
    const promise = new Promise<void>((r) => (open = r))
    gates.set(name, (g = { promise, open }))
  }
  return g
}

const toolText = (r: { permission: { behavior: string; message?: string }; result: { content: Array<{ text?: string }> } | null }) =>
  r.permission.behavior === 'deny' ? `denied: ${r.permission.message}` : (r.result?.content ?? []).map((c) => c.text ?? '').join('')
/** Tomo's own conversation, by the note in its instructions. */
const inChat = (c: Call) => systemOf(c).includes('this is your one continuous chat with the user')
/** Tomo's own thread on a job it handed itself. */
const inOwnThread = (c: Call) => systemOf(c).includes('working on a task you handed yourself')

/** How the small model answers asks for Tomo's running summary: as it should, or failing. */
const summaryAsks = { fail: false }
/**
 * Asks answered by kind; replies echo the message. In Tomo's chat, "do: <task>" hands the task to
 * Tomo itself with start_job; answering a report of its own that says "again", it tries to start
 * the same job again (which it mustn't). Tomo's running summary says how many user turns it read.
 */
const script: Script = async function* (t) {
  if (isAsk(t.call)) {
    const system = systemOf(t.call)
    if (system === CHAT_SUMMARY_INSTRUCTIONS) {
      if (summaryAsks.fail) {
        yield* t.apiError('overloaded', 'Overloaded')
        return
      }
      const text = promptText(t.call)
      const had = /<summary_so_far>\n([\s\S]*?)\n<\/summary_so_far>/.exec(text)?.[1]
      yield* t.text(`RUNNING SUMMARY of ${(text.match(/<user>/g) ?? []).length} user turns${had && had !== '(none)' ? `, after [${had}]` : ''}`)
      yield t.result()
      return
    }
    yield* t.text(system === SUMMARY_INSTRUCTIONS ? `Summary of: ${promptText(t.call).split('<user>\n')[1]?.split('\n')[0]}` : 'Named job')
    yield t.result()
    return
  }
  const last = t.call.prompt.at(-1)?.text ?? ''
  const fromBot = /^<from_bot [^>]*>\n([\s\S]*)\n<\/from_bot>$/.exec(last)
  const said = fromBot?.[1] ?? last
  if (inChat(t.call)) {
    if (fromBot && /kind="report"/.test(last)) {
      if (/again/.test(said)) {
        const r = yield* t.tool('mcp__team__start_job', { bot: 'yourself', task: said, title: 'Again' })
        yield* t.text(`Tried again: ${toolText(r)}`)
      } else yield* t.text(`It's done: ${said.slice(0, 60)}`)
      yield t.result()
      return
    }
    const task = /^do: (.+)$/s.exec(said)?.[1]
    if (task) {
      const r = yield* t.tool('mcp__team__start_job', { bot: 'yourself', task, title: task })
      yield* t.text(`I'm on it. (${toolText(r).slice(0, 40)})`)
      yield t.result()
      return
    }
  }
  // "recall: words" searches memory and says what came back.
  const query = /^recall: (.+)$/.exec(said)?.[1]
  if (query) {
    const found = yield* t.tool('mcp__memory__recall', { query })
    yield* t.text(`Recalled: ${(found.result?.content ?? []).map((c) => c.text ?? '').join('')}`)
    yield t.result()
    return
  }
  // "big: words" is a reply of three model calls whose last one read a big session.
  if (/^big: /.test(said)) {
    yield* t.text(`Reply to ${said}`)
    yield {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '' }], usage: { input_tokens: 5, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 100, output_tokens: 50 } },
      uuid: '00000000-0000-4000-8000-00000000b16b',
      session_id: t.call.session,
      parent_tool_use_id: null
    } as never
    yield t.result({ turns: 3 })
    return
  }
  // "hold: name" waits for the test.
  const hold = /^hold: (\w+)$/.exec(said)?.[1]
  if (hold) {
    yield* t.text('Thinking it over.\n')
    await t.wait(gate(hold).promise)
  }
  yield* t.text(`Reply to ${said}`)
  yield t.result()
}

const setup = (config: Record<string, unknown> = { titleModel: 'claude-haiku-5-5', memoryModel: '', systemPrompt: 'Be a fox.' }, platform: ReturnType<typeof fakePlatform> | null = null) => {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const events: StreamEvent[] = []
  const fake = fakeQuery(script)
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const agent = Agent.layer({ query: fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
  const computer = ComputerUse.layer(platform ? { platform: platform.p, overlay: fakeOverlay().port, remember: async () => {} } : { platform: null, overlay: noOverlay, remember: async () => {} })
  const providers = Layer.mergeAll(agent, Attachments.layer, computer).pipe(Layer.provideMerge(base))
  const broadcaster = Layer.succeed(Broadcaster, Broadcaster.of({ send: (e) => void events.push(e) }))
  const browser = Layer.succeed(Browser, {} as never)
  const chat = Chat.layer.pipe(Layer.provide(providers), Layer.provide(broadcaster), Layer.provide(browser))
  const jobs = Jobs.layer.pipe(Layer.provideMerge(chat), Layer.provide(providers), Layer.provide(broadcaster))
  const team = Team.layer.pipe(Layer.provide(Layer.mergeAll(chat, providers)), Layer.provide(broadcaster))
  const runtime = ManagedRuntime.make(Layer.mergeAll(jobs, team, providers))
  const run = <A, E>(eff: Effect.Effect<A, E, Jobs | Chat | Db | Team>) => runtime.runPromise(eff)
  const d = <A>(f: (d: Parameters<Parameters<Db['Service']['use']>[0]>[0]) => A) => run(Db.use((db) => db.use(f)))
  const settle = async (ok: () => boolean) => {
    for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    expect(ok()).toBe(true)
  }
  const doneCount = () => events.filter((e) => e.type === 'done').length
  return { runtime, run, d, calls: fake.calls, events, settle, doneCount }
}

const send = (text: string) => Jobs.use((j) => j.send({ text, attachmentIds: [] }))
const listJobs = Db.use((db) => db.use((d) => d.listJobs()))
const replies = (calls: Call[]) => calls.filter((c) => !isAsk(c))
const until = async (ok: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 400 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 5))
}
/** A message in a thread, as the user would write it there. */
const sayIn = (threadId: string, text: string) =>
  Chat.use((c) =>
    Effect.gen(function* () {
      const view = yield* c.view(threadId)
      return yield* c.send({ sessionId: threadId, parentId: view.path.at(-1)?.message.id ?? view.session.rootId, text, attachmentIds: [] })
    })
  )
/** Tomo's conversation as [role, first line, in its own session] rows, the divider as '—'. */
const rows = async (t: ReturnType<typeof setup>) => {
  const view = await t.run(Jobs.use((j) => j.primary))
  return view.path.map((n) => [n.message.role, n.message.post?.kind === 'topic' ? '—' : n.message.content.split('\n').at(-1), n.message.sessionId === view.session.id])
}

describe('talking to the primary bot', () => {
  test('every message goes to Tomo’s own conversation, with no router, and resumes its session', async () => {
    const t = setup()
    const primaryId = (await t.run(Jobs.use((j) => j.primary))).session.id
    let view = await t.run(send('My printer is jammed'))
    expect(view.session.kind).toBe('primary')
    await t.settle(() => t.doneCount() >= 1)
    await t.run(send('Find flights to Lisbon in May'))
    await t.settle(() => t.doneCount() >= 2)
    // No small-model call decided where they went (only nothing: the chat has no job to summarise).
    expect(t.calls.filter(isAsk)).toHaveLength(0)
    expect(await t.run(listJobs)).toHaveLength(0)
    view = await t.run(Jobs.use((j) => j.primary))
    expect(view.path.map((n) => [n.message.role, n.message.content, n.message.sessionId])).toEqual([
      ['user', 'My printer is jammed', primaryId],
      ['assistant', 'Reply to My printer is jammed', primaryId],
      ['user', 'Find flights to Lisbon in May', primaryId],
      ['assistant', 'Reply to Find flights to Lisbon in May', primaryId]
    ])
    expect(view.path[1]!.message.authorBotId).toBe('tomo')
    // One conversation: the second reply resumes the first one's Claude Code session in place.
    const [first, second] = replies(t.calls)
    expect(systemOf(first!)).toStartWith('Be a fox.')
    expect(inChat(first!)).toBe(true)
    expect(second!.options.resume).toBe(first!.session)
    expect(second!.options.forkSession).toBeFalsy()
    expect(second!.prompt.at(-1)!.text).toBe('Find flights to Lisbon in May')
    await t.runtime.dispose()
  })

  test("Tomo's conversation offers the team tools but not the browser or computer, even as the only bot; its own thread does", async () => {
    const platform = fakePlatform()
    const t = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' }, platform)
    await t.d((x) => x.updateBot('tomo', { modules: ['browser', 'computer'] }))
    await t.run(send('Hello'))
    await t.settle(() => t.doneCount() >= 1)
    const hello = replies(t.calls)[0]!
    expect(servers(hello)).toContain('team')
    expect(servers(hello)).not.toContain('browser')
    expect(servers(hello)).not.toContain('computer')
    expect(systemOf(hello)).toContain('You lead a team of bots')
    expect(systemOf(hello)).toContain('You have no other bots yet: hand work to yourself.')
    expect(systemOf(hello)).toContain('to yourself (bot "yourself")')
    expect(systemOf(hello)).not.toContain(BROWSER_AND_COMPUTER_NOTE)
    // No mode tag: it isn't a computer reply.
    expect(hello.prompt.at(-1)!.text).toBe('Hello')

    // The work it hands itself runs in its own thread, with its browser and computer.
    await t.run(send('do: Look up the opening hours'))
    await until(() => replies(t.calls).some(inOwnThread))
    await until(async () => (await t.d((x) => x.listSessions().every((s) => x.streamingIds(s.id).length === 0))) && t.doneCount() >= 4)
    const own = replies(t.calls).find(inOwnThread)!
    expect(servers(own)).toEqual(expect.arrayContaining(['browser', 'computer', 'notes']))
    // As the only bot it has no team tools there: there is nobody to ask.
    expect(servers(own)).not.toContain('team')
    expect(systemOf(own)).not.toContain('You lead a team')
    await t.runtime.dispose()
  })

  test('start_job to Tomo itself opens a job worked in its own thread, which reports back as a turn in its chat', async () => {
    const t = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' })
    await t.run(send('do: Bake bread again'))
    // Tomo hands it off, its own thread does it, the report lands in the chat, and Tomo answers it.
    await t.settle(() => t.doneCount() >= 3)
    await until(async () => (await t.d((x) => [x.primarySession(), ...x.listSessions()].every((s) => x.streamingIds(s.id).length === 0))))
    const [job] = await t.run(listJobs)
    expect(job).toMatchObject({ title: 'Bake bread again', ownerBotId: 'tomo', status: 'open' })
    const sessions = await t.d((x) => x.listSessions().filter((s) => s.jobId === job!.id))
    const own = sessions.find((s) => s.kind === 'worker')!
    expect(own).toMatchObject({ botId: 'tomo', jobId: job!.id, title: 'Bake bread again' })
    expect((await t.d((x) => x.getSession(job!.threadId!)))!.kind).toBe('shared')

    // In its own thread: worker-style instructions, the task as a turn from itself, its own session.
    const [handOff, work, answer] = replies(t.calls)
    expect(inChat(handOff!)).toBe(true)
    expect(inOwnThread(work!)).toBe(true)
    expect(systemOf(work!)).toContain('Your reply is your report')
    expect(systemOf(work!)).not.toContain('one continuous chat')
    expect(work!.prompt.at(-1)!.text).toBe('<from_bot name="Tomo" kind="task">\nBake bread again\n</from_bot>')
    expect(work!.options.resume).toBeUndefined()
    expect(work!.session).not.toBe(handOff!.session)
    expect(promptText(work!)).toContain('<jobs>\nThis job: Bake bread again')
    const ownPath = await t.d((x) => x.activePath(own).map((n) => [n.message.role, n.message.authorBotId, n.message.post?.kind ?? null]))
    expect(ownPath).toEqual([
      ['user', 'tomo', 'task'],
      ['assistant', 'tomo', null]
    ])

    // The report comes back into Tomo's chat as a turn, about the job; answering its own report it
    // tries to start the job again, and is refused: no loop.
    expect(answer!.prompt.at(-1)!.text).toBe(`<from_bot name="Tomo" kind="report" job="Bake bread again" job_id="${job!.id}">\nReply to Bake bread again\n</from_bot>`)
    expect(answer!.options.resume).toBe(handOff!.session)
    expect(await rows(t)).toEqual([
      ['user', 'do: Bake bread again', true],
      ['assistant', expect.stringContaining("I'm on it. (Opened the job “Bake bread again”"), true],
      ['user', 'Reply to Bake bread again', true],
      ['assistant', expect.stringContaining('Tried again: Error: This turn is your own report coming back'), true]
    ])
    const conversation = (await t.run(Jobs.use((j) => j.primary))).path
    expect(conversation[2]!.message).toMatchObject({ authorBotId: 'tomo', post: { kind: 'report', to: 'tomo', state: null } })
    expect(conversation[2]!.jobId).toBe(job!.id)
    await new Promise((r) => setTimeout(r, 50))
    expect(await t.run(listJobs)).toHaveLength(1)
    expect(replies(t.calls)).toHaveLength(3)
    // The job's shared thread keeps the record: the task and the report, both Tomo's.
    const posts = await t.d((x) => x.activePath(x.getSession(job!.threadId!)!).map((n) => [n.message.post?.kind, n.message.authorBotId, n.message.post?.to]))
    expect(posts).toEqual([
      ['task', 'tomo', 'tomo'],
      ['report', 'tomo', 'tomo']
    ])
    await t.runtime.dispose()
  })

  test('New topic: the next reply starts a fresh session, with nothing before the divider resumed or carried', async () => {
    const t = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' })
    await t.run(send('Remember the number 42'))
    await t.settle(() => t.doneCount() >= 1)
    await t.run(send('And the colour blue'))
    await t.settle(() => t.doneCount() >= 2)
    let view = await t.run(Jobs.use((j) => j.newTopic))
    expect(view.path.at(-1)!.message.post?.kind).toBe('topic')
    // Twice in a row makes one divider.
    view = await t.run(Jobs.use((j) => j.newTopic))
    expect(view.path.filter((n) => n.message.post?.kind === 'topic')).toHaveLength(1)
    await t.run(send('What is the capital of France?'))
    await t.settle(() => t.doneCount() >= 3)
    const fresh = replies(t.calls)[2]!
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.session).not.toBe(replies(t.calls)[0]!.session)
    expect(promptText(fresh)).not.toContain('42')
    expect(promptText(fresh)).not.toContain('blue')
    expect(fresh.prompt.map((b) => b.text)).toEqual(['What is the capital of France?'])
    // Its instructions are the same: still Tomo's chat.
    expect(systemOf(fresh)).toBe(systemOf(replies(t.calls)[0]!))
    // After that, the new topic carries on in its own session.
    await t.run(send('And of Spain?'))
    await t.settle(() => t.doneCount() >= 4)
    const next = replies(t.calls)[3]!
    expect(next.options.resume).toBe(fresh.session)
    expect(next.options.forkSession).toBeFalsy()
    expect(await rows(t)).toEqual([
      ['user', 'Remember the number 42', true],
      ['assistant', 'Reply to Remember the number 42', true],
      ['user', 'And the colour blue', true],
      ['assistant', 'Reply to And the colour blue', true],
      ['assistant', '—', true],
      ['user', 'What is the capital of France?', true],
      ['assistant', 'Reply to What is the capital of France?', true],
      ['user', 'And of Spain?', true],
      ['assistant', 'Reply to And of Spain?', true]
    ])
    await t.runtime.dispose()
  })

  test('New topic while Tomo is mid-reply: the divider goes after that reply, and a message queued meanwhile opens the new topic', async () => {
    const t = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' })
    await t.run(send('hold: long'))
    await until(() => replies(t.calls).length === 1)
    await t.run(send('Something else entirely'))
    await t.run(Jobs.use((j) => j.newTopic))
    expect(await rows(t)).toEqual([
      ['user', 'hold: long', true],
      ['assistant', 'Thinking it over.', true],
      ['assistant', '—', true],
      ['user', 'Something else entirely', true]
    ])
    expect(replies(t.calls)).toHaveLength(1)
    gate('long').open()
    await t.settle(() => t.doneCount() >= 2)
    const fresh = replies(t.calls)[1]!
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.prompt.map((b) => b.text)).toEqual(['Something else entirely'])
    expect((await rows(t)).map((r) => r[1])).toEqual(['hold: long', 'Reply to hold: long', '—', 'Something else entirely', 'Reply to Something else entirely'])
    await t.runtime.dispose()
  })

  test('a message while Tomo replies in its own conversation is queued there, and answered after', async () => {
    const t = setup()
    const primaryId = (await t.run(Jobs.use((j) => j.primary))).session.id
    await t.run(send('hold: chat1'))
    await until(() => replies(t.calls).length === 1)
    // Two more while it replies: both wait in Tomo's own conversation; no job is made for them.
    await t.run(send('Are you there?'))
    let view = await t.run(send('Hello?'))
    await new Promise((r) => setTimeout(r, 50))
    expect(replies(t.calls)).toHaveLength(1)
    expect(await t.run(listJobs)).toHaveLength(0)
    expect(view.path.map((n) => [n.message.role, n.message.status, n.message.sessionId === primaryId])).toEqual([
      ['user', 'complete', true],
      ['assistant', 'streaming', true],
      ['user', 'complete', true],
      ['user', 'complete', true]
    ])
    gate('chat1').open()
    await t.settle(() => t.doneCount() >= 2)
    const answer = replies(t.calls)[1]!
    expect(promptText(answer)).toContain('<user>\nAre you there?\n</user>')
    expect(answer.prompt.at(-1)!.text).toBe('Hello?')
    view = await t.run(Jobs.use((j) => j.primary))
    expect(view.path.map((n) => n.message.content.split('\n').at(-1))).toEqual(['hold: chat1', 'Reply to hold: chat1', 'Are you there?', 'Hello?', 'Reply to Hello?'])
    await new Promise((r) => setTimeout(r, 50))
    expect(replies(t.calls)).toHaveLength(2)
    await t.runtime.dispose()
  })

  test("old routed turns, in jobs' threads, still show in Tomo's conversation, in order with the new ones", async () => {
    const t = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' })
    // As routing left them: a turn said to Tomo, in a job's thread, and small talk in Tomo's own.
    const { job, primaryId } = await t.d((x) => {
      const primary = x.primarySession()
      const made = x.createJob({ title: 'Printer', botId: 'tomo' })
      const u = x.insertMessage({ sessionId: made.thread.id, parentId: made.thread.rootId, role: 'user', content: 'My printer jams', status: 'complete' })
      x.markVia(u.id, primary.id)
      x.insertMessage({ sessionId: made.thread.id, parentId: u.id, role: 'assistant', content: 'Open the tray.', status: 'complete' })
      const hi = x.insertMessage({ sessionId: primary.id, parentId: primary.rootId, role: 'user', content: 'Hi', status: 'complete' })
      x.markVia(hi.id, primary.id)
      x.insertMessage({ sessionId: primary.id, parentId: hi.id, role: 'assistant', content: 'Hello!', status: 'complete' })
      return { job: made.job, primaryId: primary.id }
    })
    await t.run(send('Thanks for the help'))
    await t.settle(() => t.doneCount() >= 1)
    const view = await t.run(Jobs.use((j) => j.primary))
    expect(view.path.map((n) => [n.message.content, n.message.sessionId === primaryId])).toEqual([
      ['My printer jams', false],
      ['Open the tray.', false],
      ['Hi', true],
      ['Hello!', true],
      ['Thanks for the help', true],
      ['Reply to Thanks for the help', true]
    ])
    expect(view.path[0]!.message.sessionId).toBe(job.threadId!)
    // The old job is still there, untouched, and nothing new was made.
    expect((await t.run(listJobs)).map((j) => j.title)).toEqual(['Printer'])
    await t.runtime.dispose()
  })

  test('writing in a finished job reopens it; deleting a job takes its thread', async () => {
    const t = setup({ titleModel: '', memoryModel: '' })
    const made = await t.d((x) => x.createJob({ title: 'First topic', botId: 'tomo' }))
    await t.run(Jobs.use((j) => j.setStatus(made.job.id, 'done')))
    await t.run(sayIn(made.thread.id, 'Back to the first'))
    await t.settle(() => t.doneCount() >= 1)
    expect((await t.run(listJobs)).find((j) => j.id === made.job.id)!.status).toBe('open')
    await t.run(Jobs.use((j) => j.remove(made.job.id)))
    expect(await t.run(listJobs)).toEqual([])
    expect(await t.d((x) => x.getSession(made.thread.id))).toBeUndefined()
    await t.runtime.dispose()
  })
})

describe('jobs and memory', () => {
  test("a job's replies keep its notes and recall them; a finished job is archived, a deleted one forgotten", async () => {
    const t = setup({ titleModel: 'claude-haiku-5-5', memoryModel: 'claude-haiku-5-5', systemPrompt: 'Be a fox.' })
    let job = (await t.d((x) => x.createJob({ title: 'Fix the garden gate', botId: 'tomo' }))).job
    await t.run(sayIn(job.threadId!, 'Fix the garden gate'))
    await t.settle(() => t.doneCount() >= 1)
    // A reply on a job gets the notes tool, and recall scoped to its bot and job.
    const first = replies(t.calls)[0]!
    expect(servers(first)).toEqual(expect.arrayContaining(['notes', 'memory']))
    expect(systemOf(first)).not.toContain('Notes on this job so far')

    // Notes written on the job show in the next reply's instructions, and recall finds them in that job only.
    await t.d((x) => x.writeNote(job.id, { kind: 'state', text: 'Hinge ordered, zanzibar bolts pending.' }, { sessionId: job.threadId }))
    await t.run(sayIn(job.threadId!, 'recall: zanzibar'))
    await t.settle(() => t.doneCount() >= 2)
    const second = replies(t.calls)[1]!
    expect(systemOf(second)).toContain('Notes on this job so far')
    expect(systemOf(second)).toContain('Hinge ordered, zanzibar bolts pending.')
    const lastIn = async (id: string) => (await t.d((x) => x.activePath(x.getSession(id)!))).at(-1)!.message.content
    expect(await lastIn(job.threadId!)).toContain('Hinge ordered')
    // Tomo's own conversation is on no job: recall there doesn't see the job's notes.
    await t.run(send('recall: zanzibar'))
    await t.settle(() => t.doneCount() >= 3)
    expect((await t.run(Jobs.use((j) => j.primary))).path.at(-1)!.message.content).toContain('Nothing in memory matches')

    // Finished: filed in the archive with its one-line summary.
    await until(async () => !!(await t.run(listJobs)).find((j) => j.id === job.id)?.summary)
    job = (await t.run(listJobs)).find((j) => j.id === job.id)!
    expect(job.summary).toBeTruthy()
    await t.run(Jobs.use((j) => j.setStatus(job.id, 'done')))
    const archived = Db.use((db) => db.use((d) => d.records('archive', job.id)))
    await until(async () => (await t.run(archived)).length > 0)
    expect((await t.run(archived))[0]).toMatchObject({ type: 'job', title: job.title, body: job.summary! })

    // Deleted: its notes and archive record go with it.
    await t.run(Jobs.use((j) => j.remove(job.id)))
    expect(await t.run(archived)).toEqual([])
    expect(await t.d((x) => x.jobNotes(job.id))).toEqual([])
    await t.runtime.dispose()
  })

  test('a finished job with no summary yet gets one from the small model for the archive', async () => {
    const t = setup({ titleModel: 'claude-haiku-5-5', memoryModel: 'claude-haiku-5-5', systemPrompt: 'Be a fox.' })
    const { job } = await t.d((x) => x.createJob({ title: 'Paint the fence', botId: 'tomo' }))
    await t.run(sayIn(job.threadId!, 'Paint the fence'))
    await t.settle(() => t.doneCount() >= 1)
    // The summary written after the reply, taken away again.
    await until(async () => !!(await t.run(listJobs))[0]!.summary)
    await t.d((x) => x.setJobSummary(job.id, null))
    const asked = t.calls.filter((c) => systemOf(c) === SUMMARY_INSTRUCTIONS).length
    await t.run(Jobs.use((j) => j.setStatus(job.id, 'done')))
    const archived = Db.use((db) => db.use((d) => d.records('archive', job.id)))
    await until(async () => (await t.run(archived)).length > 0)
    expect((await t.run(archived))[0]!.body).toBe('Summary of: Paint the fence')
    expect(t.calls.filter((c) => systemOf(c) === SUMMARY_INSTRUCTIONS).length).toBe(asked + 1)
    expect((await t.run(listJobs))[0]!.summary).toBe('Summary of: Paint the fence')
    await t.runtime.dispose()
  })

  test('what memory learns in a job records the job and its thread as the source', async () => {
    const t = setup({ titleModel: '', memoryModel: '' })
    const { job } = await t.d((x) => x.createJob({ title: 'Plan the trip', botId: 'tomo' }))
    const versions = await t.d((x) => {
      x.changeMemory({ add: ['Lives in Lisbon.'], update: [], remove: [] }, { kind: 'learned', sessionId: job.threadId, jobId: job.id })
      return x.recordVersions(x.profile()[0]!.id)
    })
    expect(versions[0]).toMatchObject({ sourceJobId: job.id, sourceSessionId: job.threadId, sourceTitle: job.title })
    await t.runtime.dispose()
  })
})

describe('Tomo’s chat starting afresh by itself', () => {
  const m = (role: Message['role'], content = '', post: Post['kind'] | null = null) => ({ role, content, post: post ? { kind: post, to: null, state: null } : null })

  test('rolls over only in the primary’s chat, after more than the gap, past more than the budget', () => {
    const limits = { gapMs: 1000, budget: 500 }
    const at = (over: Partial<Parameters<typeof shouldRollOver>[0]>) => shouldRollOver({ kind: 'primary', endedAt: 0, contextTokens: 501, now: 1001, ...over }, limits)
    expect(at({})).toBe(true)
    // Exactly the gap or the budget isn't past it.
    expect(at({ now: 1000 })).toBe(false)
    expect(at({ contextTokens: 500 })).toBe(false)
    // A job's thread or a worker's keeps resuming.
    expect(at({ kind: 'shared' })).toBe(false)
    expect(at({ kind: 'worker' })).toBe(false)
    // A reply from before sizes were kept, or that never ended, is resumed.
    expect(at({ endedAt: undefined })).toBe(false)
    expect(at({ contextTokens: null })).toBe(false)
  })

  test('the limits default to five minutes and 25k tokens; the env sets them for tests', () => {
    expect(ROLLOVER_GAP_MS).toBe(300_000)
    expect(ROLLOVER_BUDGET).toBe(25_000)
    expect(rolloverLimits({})).toEqual({ gapMs: 300_000, budget: 25_000 })
    expect(rolloverLimits({ CHAT_V2_ROLLOVER_GAP_MS: '250', CHAT_V2_ROLLOVER_BUDGET: '100' })).toEqual({ gapMs: 250, budget: 100 })
    expect(rolloverLimits({ CHAT_V2_ROLLOVER_GAP_MS: 'soon', CHAT_V2_ROLLOVER_BUDGET: '-3' })).toEqual({ gapMs: 300_000, budget: 25_000 })
    // Read when asked, so a run can change them.
    const was = process.env.CHAT_V2_ROLLOVER_BUDGET
    process.env.CHAT_V2_ROLLOVER_BUDGET = '7'
    expect(rolloverLimits().budget).toBe(7)
    if (was === undefined) delete process.env.CHAT_V2_ROLLOVER_BUDGET
    else process.env.CHAT_V2_ROLLOVER_BUDGET = was
  })

  test('the last three exchanges, the summary they carry, and a stretch as memory files it', () => {
    const stretch = [m('user', 'a'), m('assistant', 'A'), m('user', 'b'), m('user', 'b2'), m('assistant', 'B'), m('user', 'c'), m('assistant', 'C'), m('user', 'd'), m('assistant', 'D')]
    expect(recentExchanges(stretch).map((x) => x.content)).toEqual(['b', 'b2', 'B', 'c', 'C', 'd', 'D'])
    expect(recentExchanges(stretch.slice(0, 4)).map((x) => x.content)).toEqual(['a', 'A', 'b', 'b2'])
    const carried = carryText('They like 42.', ['<user>\nhi\n</user>'])
    expect(carried).toBe('<summary>\nThey like 42.\n</summary>\n<recent_turns>\n<user>\nhi\n</user>\n</recent_turns>')
    expect(summaryIn(carried)).toBe('They like 42.')
    expect(summaryIn(carryText(null, ['x']))).toBeNull()
    expect(cleanChatSummary('Summary:\nThe user likes 42.')).toBe('The user likes 42.')
    expect(cleanChatSummary('  ')).toBeNull()
    expect(cleanChatSummary('word '.repeat(600))!.split(/\s+/).length).toBeLessThanOrEqual(321)
    const at = Date.UTC(2026, 10, 20, 9)
    const record = segmentRecord({
      botName: 'Tomo',
      turns: [
        { ...m('user', 'Plan Lisbon'), authorBotId: null, createdAt: at },
        { ...m('assistant', 'On it.'), authorBotId: 'tomo', createdAt: at },
        { ...m('user', 'Flights found', 'report'), authorBotId: 'tomo', createdAt: at + 2 * 86_400_000 },
        { ...m('assistant', 'Done!'), authorBotId: 'tomo', createdAt: at + 2 * 86_400_000 }
      ],
      summary: 'Lisbon trip planned.',
      nameOf: () => 'Tomo',
      jobOf: (i) => (i === 2 ? { title: 'Lisbon' } : null)
    })!
    expect(record.title).toBe('Chat with Tomo, 2026-11-20 to 2026-11-22')
    expect(record.body).toBe('Summary: Lisbon trip planned.\n\nUser: Plan Lisbon\n\nTomo: On it.\n\nReport from Tomo on “Lisbon”: Flights found\n\nTomo: Done!')
    // A rollover is a boundary as a New topic is, and the one place that knows says so.
    expect(isTopicStart(m('assistant', '', 'rollover'))).toBe(true)
    expect(topicStart([m('root'), m('user'), m('assistant'), m('assistant', '', 'rollover'), m('user')])).toBe(3)
  })

  test('recall shows a long stretch of chat by its start and the passage that matches', () => {
    const body = `Summary: trip.\n\n${'User: filler words here\n\n'.repeat(200)}User: the zanzibar bolts arrived\n\n${'Tomo: more filler\n\n'.repeat(50)}`
    const shown = excerpt(body, 'zanzibar')
    expect(shown.startsWith('Summary: trip.')).toBe(true)
    expect(shown).toContain('zanzibar bolts arrived')
    expect(shown.length).toBeLessThan(1300)
    expect(describeHits('zanzibar', [{ id: 9, scope: 'archive', scopeId: 'tomo', type: 'chat', title: 'Chat with Tomo, 2026-11-20', aliases: [], body, updatedAt: Date.UTC(2026, 10, 21), sourceSessionId: null }])).toContain(
      '[9] Earlier conversation: Chat with Tomo, 2026-11-20 (2026-11-21)'
    )
  })

  // Tiny limits: a gap of a few hundred ms, and a budget the fake's 135-token sessions are past.
  const env = { gap: process.env.CHAT_V2_ROLLOVER_GAP_MS, budget: process.env.CHAT_V2_ROLLOVER_BUDGET }
  const limits = (gap: number, budget: number) => {
    process.env.CHAT_V2_ROLLOVER_GAP_MS = String(gap)
    process.env.CHAT_V2_ROLLOVER_BUDGET = String(budget)
  }
  afterEach(() => {
    summaryAsks.fail = false
    for (const [k, v] of [['CHAT_V2_ROLLOVER_GAP_MS', env.gap], ['CHAT_V2_ROLLOVER_BUDGET', env.budget]] as const)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const summaryCalls = (calls: Call[]) => calls.filter((c) => isAsk(c) && systemOf(c) === CHAT_SUMMARY_INSTRUCTIONS)
  const chatted = async (t: ReturnType<typeof setup>, ...texts: string[]) => {
    for (const text of texts) {
      const n = t.doneCount()
      await t.run(send(text))
      await t.settle(() => t.doneCount() > n)
    }
  }

  test('a reply keeps how big its session got and when it ended: its last model call, not the sum', async () => {
    const t = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' })
    await chatted(t, 'big: a long one', 'small one')
    const [big, small] = (await t.run(Jobs.use((j) => j.primary))).path.filter((n) => n.message.role === 'assistant').map((n) => n.message.usage!)
    expect(big!.contextTokens).toBe(30_155)
    expect(big!.promptTokens).toBe(130)
    expect(small!.contextTokens).toBe(135)
    expect(Math.abs(small!.endedAt! - Date.now())).toBeLessThan(5000)
    await t.runtime.dispose()
  })

  test('after a gap past the budget the next turn starts fresh, carrying the summary written ahead and the last exchanges; nothing shows', async () => {
    limits(400, 100)
    const t = setup()
    await chatted(t, 'Remember the number 42', 'And the colour blue', 'And the city Porto', 'And the dog Rex')
    // Within the gap: resumed as ever.
    const before = replies(t.calls)
    expect(before[3]!.options.resume).toBe(before[0]!.session)
    // The summary is written after the last reply, in the background.
    await until(() => summaryCalls(t.calls).length > 0)
    await sleep(500)
    const asked = summaryCalls(t.calls).length
    expect(asked).toBeGreaterThanOrEqual(1)
    await chatted(t, 'What was the number?')
    const fresh = replies(t.calls).at(-1)!
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.session).not.toBe(before[0]!.session)
    const carried = fresh.prompt[0]!.text!
    expect(carried).toStartWith('<earlier_conversation>\n<summary>\nRUNNING SUMMARY of 4 user turns\n</summary>\n<recent_turns>\n<user>\nAnd the colour blue\n</user>')
    expect(carried).toContain('<assistant>\nReply to And the dog Rex\n</assistant>\n</recent_turns>\n</earlier_conversation>')
    // The last three exchanges only: the first is in the summary.
    expect(carried).not.toContain('Remember the number 42')
    expect(fresh.prompt.at(-1)!.text).toBe('What was the number?')
    expect(systemOf(fresh)).toBe(systemOf(before[0]!))
    // Reused, not written again.
    expect(summaryCalls(t.calls).length).toBe(asked)
    // Tomo's conversation shows one chat, with nothing where it started afresh.
    expect((await rows(t)).map((r) => r[1])).toEqual([
      'Remember the number 42',
      'Reply to Remember the number 42',
      'And the colour blue',
      'Reply to And the colour blue',
      'And the city Porto',
      'Reply to And the city Porto',
      'And the dog Rex',
      'Reply to And the dog Rex',
      'What was the number?',
      'Reply to What was the number?'
    ])
    const tree = await t.d((x) => x.activePath(x.primarySession()).map((n) => n.message.post?.kind ?? n.message.role))
    expect(tree.filter((k) => k === 'rollover')).toHaveLength(1)
    // Then it carries on in the fresh session, and the next rollover's summary builds on this one.
    await chatted(t, 'Thanks')
    expect(replies(t.calls).at(-1)!.options.resume).toBe(fresh.session)
    await until(() => summaryCalls(t.calls).length > asked)
    await sleep(500)
    await chatted(t, 'Back again')
    const again = replies(t.calls).at(-1)!
    expect(again.options.resume).toBeUndefined()
    expect(again.prompt[0]!.text).toContain('RUNNING SUMMARY of 2 user turns, after [RUNNING SUMMARY of 4 user turns]')
    await t.runtime.dispose()
  })

  test('under the budget, or within the gap, a turn resumes as before', async () => {
    limits(300, 1000)
    const t = setup()
    await chatted(t, 'One', 'Two')
    await sleep(400)
    await chatted(t, 'Three')
    const [first, , third] = replies(t.calls)
    expect(third!.options.resume).toBe(first!.session)
    expect(third!.prompt.map((b) => b.text)).toEqual(['Three'])
    // Nothing is summed up under the budget.
    expect(summaryCalls(t.calls)).toHaveLength(0)
    await t.runtime.dispose()
  })

  test('a failed summary, or no small model, still lets the turn run with the last exchanges', async () => {
    limits(300, 100)
    summaryAsks.fail = true
    const t = setup()
    await chatted(t, 'Hello there')
    await sleep(450)
    await chatted(t, 'Still there?')
    const fresh = replies(t.calls).at(-1)!
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.prompt.map((b) => b.text)).toEqual([
      '<earlier_conversation>\n<recent_turns>\n<user>\nHello there\n</user>\n<assistant>\nReply to Hello there\n</assistant>\n</recent_turns>\n</earlier_conversation>',
      'Still there?'
    ])
    expect(summaryCalls(t.calls).length).toBeGreaterThan(0)
    await t.runtime.dispose()

    const u = setup({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' })
    await chatted(u, 'Hello there')
    await sleep(450)
    await chatted(u, 'Still there?')
    expect(replies(u.calls).at(-1)!.prompt[0]!.text).toStartWith('<earlier_conversation>\n<recent_turns>\n<user>\nHello there')
    expect(u.calls.filter(isAsk)).toHaveLength(0)
    await u.runtime.dispose()
  })

  test('New topic still carries nothing, past the budget after a gap too', async () => {
    limits(300, 100)
    const t = setup()
    await chatted(t, 'Remember 42')
    await sleep(450)
    await t.run(Jobs.use((j) => j.newTopic))
    await chatted(t, 'Something new')
    const fresh = replies(t.calls).at(-1)!
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.prompt.map((b) => b.text)).toEqual(['Something new'])
    expect((await rows(t)).map((r) => r[1])).toEqual(['Remember 42', 'Reply to Remember 42', '—', 'Something new', 'Reply to Something new'])
    await t.runtime.dispose()
  })

  test('turns waiting across a rollover are all answered', async () => {
    limits(300, 100)
    const t = setup()
    const primaryId = (await t.run(Jobs.use((j) => j.primary))).session.id
    await chatted(t, 'Hello')
    await sleep(450)
    // Two turns waiting with nothing answering them (as a restart leaves them), then drained.
    await t.d((x) => {
      const leaf = x.activePath(x.primarySession()).at(-1)!.message
      const a = x.insertMessage({ sessionId: primaryId, parentId: leaf.id, role: 'user', content: 'First waiting', status: 'complete' })
      x.markVia(a.id, primaryId)
      const b = x.insertMessage({ sessionId: primaryId, parentId: a.id, role: 'user', content: 'Second waiting', status: 'complete' })
      x.markVia(b.id, primaryId)
    })
    await t.run(Chat.use((c) => c.drain(primaryId)))
    await t.settle(() => t.doneCount() >= 2)
    const fresh = replies(t.calls).at(-1)!
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.prompt[0]!.text).toContain('<recent_turns>\n<user>\nHello\n</user>')
    expect(fresh.prompt.slice(1).map((b) => b.text)).toEqual(['<user>\nFirst waiting\n</user>', 'Second waiting'])
    // One sent while a fresh reply runs waits, and is answered in that fresh session after it.
    await sleep(450)
    const n = t.doneCount()
    await t.run(send('hold: fresh2'))
    await until(() => replies(t.calls).at(-1)!.prompt.at(-1)!.text === 'hold: fresh2')
    await t.run(send('Meanwhile'))
    gate('fresh2').open()
    await t.settle(() => t.doneCount() >= n + 2)
    const [rolled, after] = replies(t.calls).slice(-2)
    expect(rolled!.options.resume).toBeUndefined()
    expect(after!.options.resume).toBe(rolled!.session)
    expect(after!.prompt.at(-1)!.text).toBe('Meanwhile')
    expect((await rows(t)).map((r) => r[1]).slice(-4)).toEqual(['hold: fresh2', 'Reply to hold: fresh2', 'Meanwhile', 'Reply to Meanwhile'])
    await t.runtime.dispose()
  })

  test('the stretch a boundary ends is filed in memory, where recall finds it; nothing while memory is off', async () => {
    limits(300, 100)
    const t = setup({ titleModel: 'claude-haiku-5-5', memoryModel: 'claude-haiku-5-5', systemPrompt: 'Be a fox.' })
    await chatted(t, 'My locksmith is called Zebulon')
    await sleep(450)
    await chatted(t, 'Hi again')
    const chats = Db.use((db) => db.use((d) => d.records('archive', 'tomo')))
    await until(async () => (await t.run(chats)).length > 0)
    const [record] = await t.run(chats)
    expect(record).toMatchObject({ type: 'chat', title: expect.stringMatching(/^Chat with Tomo, \d{4}-\d\d-\d\d$/) })
    expect(record!.body).toContain('User: My locksmith is called Zebulon')
    expect(record!.body).toContain('Tomo: Reply to My locksmith is called Zebulon')
    expect(record!.body).toStartWith('Summary: RUNNING SUMMARY')
    await chatted(t, 'recall: zebulon')
    const said = (await t.run(Jobs.use((j) => j.primary))).path.at(-1)!.message.content
    expect(said).toContain('Earlier conversation: Chat with Tomo')
    expect(said).toContain('My locksmith is called Zebulon')
    // A New topic files the stretch it ends too.
    await t.run(Jobs.use((j) => j.newTopic))
    await until(async () => (await t.run(chats)).length > 1)
    expect((await t.run(chats))[1]!.body).toContain('User: Hi again')
    // Another bot's recall doesn't see Tomo's chat.
    expect(await t.d((x) => x.recall('zebulon', { botId: 'someone-else' }))).toEqual([])
    await t.runtime.dispose()

    const off = setup({ titleModel: 'claude-haiku-5-5', memoryModel: '', systemPrompt: 'Be a fox.' })
    await chatted(off, 'My locksmith is called Zebulon')
    await sleep(450)
    await chatted(off, 'Hi again')
    expect(replies(off.calls).at(-1)!.options.resume).toBeUndefined()
    await off.run(Jobs.use((j) => j.newTopic))
    await sleep(100)
    expect(await off.run(chats)).toEqual([])
    await off.runtime.dispose()
  })
})
