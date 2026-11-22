// Workers (services/Team.ts, agent/team.ts): the team tools, run end to end against a fake Claude
// Code that plays every bot from a script, how what bots say is delivered (reports as turns in the
// primary's conversation, held while a reply runs, caught up at startup), plus the pure parts
// (bouncing, presence).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { Bot, BotPatch, Message, StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Broadcaster, Chat, unanswered } from '../src/main/services/Chat'
import { WRITING_GUIDELINES } from '../src/main/guidelines'
import { Db } from '../src/main/services/Db'
import { Jobs } from '../src/main/services/Jobs'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { DONE_MS, Team, presenceOf, reportText } from '../src/main/services/Team'
import { Agent } from '../src/main/agent/driver'
import { bouncing } from '../src/main/agent/stuck'
import { ComputerUse, noOverlay } from '../src/main/computer'
import { Browser } from '../src/main/services/Browser'
import { type Call, type Script, fakeQuery } from './fakeQuery'

setDefaultTimeout(30_000)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const isAsk = (c: Call) => c.options.persistSession === false
const systemOf = (c: Call) => (c.options.systemPrompt as { prompt: string }).prompt
/** Who a reply runs as: a worker's section names it; the primary's says it leads. */
const botOf = (c: Call) => /You are (\w+), one of the user's bots/.exec(systemOf(c))?.[1] ?? 'Tomo'
/** What the reply answers: the last block, a bot's message unwrapped. */
const asked = (c: Call) => {
  const last = c.prompt.at(-1)?.text ?? ''
  return /<from_bot [^>]*>\n([\s\S]*)\n<\/from_bot>/.exec(last)?.[1] ?? last
}
const promptOf = (c: Call) => c.prompt.map((b) => b.text ?? '').join('\n---\n')

/** Gates a script can wait on (`gate <name>`), opened by the test. */
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

/**
 * Every bot, scripted. A message is read line by line:
 *   start <Bot> | <task>      start_job
 *   ask <Bot> | <text>        message
 *   try wait                  calls the wait tool there used to be
 *   open job                  start_job, from wherever it runs
 *   list                      list_jobs
 *   gate <name>               waits until the test opens it
 *   slow <name>               the same, said as work
 *   hold-<name>               anywhere in a report Tomo answers: its reply waits on that gate
 * Builder answers "Do the thing" with "No, you do it."; a worker told that asks Builder again.
 * Each reply ends saying what its tools said.
 */
const script: Script = async function* (t) {
  if (isAsk(t.call)) {
    yield* t.text('Named')
    yield t.result()
    return
  }
  const who = botOf(t.call)
  const said = asked(t.call)
  if (who === 'Builder' && said.trim() === 'Do the thing') {
    yield* t.text('No, you do it.')
    yield t.result()
    return
  }
  const out: string[] = []
  const say = (r: { permission: { behavior: string; message?: string }; result: { content: Array<{ text?: string }> } | null }) =>
    r.permission.behavior === 'deny' ? `denied: ${r.permission.message}` : (r.result?.content ?? []).map((c) => c.text ?? '').join('')
  // Tomo answering a bot (a report in its conversation) holds on what the report names.
  const hold = who === 'Tomo' && /^<from_bot /.test(t.call.prompt.at(-1)?.text ?? '') ? /\bhold-(\w+)/.exec(said)?.[1] : undefined
  if (hold) {
    yield* t.text('Tomo is on it.\n')
    await t.wait(gate(hold).promise)
    out.push(`${hold} released`)
  }
  // A worker's task can carry several commands, joined with ' ; '; told "No, you do it.", it asks again.
  const lines = who !== 'Tomo' && said.trim() === 'No, you do it.' ? ['ask Builder | Do the thing'] : said.split(who === 'Tomo' ? '\n' : /\n| ; /)
  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null
    if ((m = /^start (\w+) \| (.+)$/.exec(line))) out.push(say(yield* t.tool('mcp__team__start_job', { bot: m[1], task: m[2], title: m[2] })))
    else if ((m = /^ask (\w+) \| (.+)$/.exec(line))) out.push(say(yield* t.tool('mcp__team__message', { to: m[1], text: m[2] })))
    else if (line === 'try wait') out.push(say(yield* t.tool('mcp__team__wait', { timeout_seconds: 1 })))
    else if (line === 'open job') out.push(say(yield* t.tool('mcp__team__start_job', { bot: 'Builder', task: 'Something new' })))
    else if (line === 'list') out.push(say(yield* t.tool('mcp__team__list_jobs', {})))
    else if ((m = /^(?:gate|slow) (\w+)/.exec(line))) {
      yield* t.text(`${who} is on it.\n`)
      await t.wait(gate(m[1]!).promise)
      out.push(`${m[1]} finished`)
    } else if (!hold || line !== said.trim()) out.push(line)
  }
  yield* t.text(`${who} done: ${out.join(' / ')}`)
  yield t.result()
}

/** A fresh data folder; or `dir` as an earlier run left it (the app started again). */
const setup = (dir?: string) => {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'chat-v2-team-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' }))
  }
  const events: StreamEvent[] = []
  const fake = fakeQuery(script)
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const agent = Agent.layer({ query: fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
  const computer = ComputerUse.layer({ platform: null, overlay: noOverlay, remember: async () => {} })
  const providers = Layer.mergeAll(agent, Attachments.layer, computer).pipe(Layer.provideMerge(base))
  const broadcaster = Layer.succeed(Broadcaster, Broadcaster.of({ send: (e) => void events.push(e) }))
  const browser = Layer.succeed(Browser, {} as never)
  const chat = Chat.layer.pipe(Layer.provide(providers), Layer.provide(broadcaster), Layer.provide(browser))
  const jobs = Jobs.layer.pipe(Layer.provideMerge(chat), Layer.provide(providers), Layer.provide(broadcaster))
  const team = Team.layer.pipe(Layer.provide(Layer.mergeAll(chat, providers)), Layer.provide(broadcaster))
  const runtime = ManagedRuntime.make(Layer.mergeAll(jobs, team, providers))
  const run = <A, E>(eff: Effect.Effect<A, E, Jobs | Chat | Db | Team | ComputerUse>) => runtime.runPromise(eff)
  const d = <A>(f: (d: Parameters<Parameters<Db['Service']['use']>[0]>[0]) => A) => run(Db.use((db) => db.use(f)))
  const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
    const t0 = Date.now()
    while (!(await ok())) {
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  const addBot = async (patch: BotPatch) => (await run(Team.use((t) => t.createBot(patch)))).find((b) => b.name === patch.name)!
  const send = (text: string) => run(Jobs.use((j) => j.send({ text, attachmentIds: [] })))
  /** Every post in a job's shared thread. */
  const posts = (title: string) =>
    d((x) => {
      const job = x.listJobs().find((j) => j.title === title)
      return job?.threadId ? x.activePath(x.getSession(job.threadId)!).map((n) => n.message).filter((m) => m.post) : []
    })
  const replies = () => fake.calls.filter((c) => !isAsk(c))
  const idle = () => d((x) => [x.primarySession(), ...x.listSessions()].every((s) => x.streamingIds(s.id).length === 0))
  /** The primary's conversation. */
  const conversation = async () => (await run(Jobs.use((j) => j.primary))).path
  /** Tomo's replies in its own conversation (to reports and messages). */
  const tomoAnswers = () => replies().filter((c) => botOf(c) === 'Tomo' && /<from_bot /.test(c.prompt.at(-1)?.text ?? ''))
  return { dir, runtime, run, d, until, addBot, send, posts, replies, events, idle, conversation, tomoAnswers }
}

type T = ReturnType<typeof setup>
const name = (bots: Bot[], id: string | null) => bots.find((b) => b.id === id)?.name
const postsAre = (bots: Bot[], ps: Message[]) => ps.map((p) => [p.post!.kind, name(bots, p.authorBotId), name(bots, p.post!.to), p.post!.state])
/** The primary's conversation as [role, who, kind, first line] rows. */
const shape = async (t: T) => {
  const bots = await t.d((x) => x.listBots())
  return (await t.conversation()).map((n) => [n.message.role, name(bots, n.message.authorBotId) ?? 'user', n.message.post?.kind ?? null, n.message.content.split('\n').at(-1)!])
}

describe('the team tools', () => {
  test("Tomo's chat always has the team tools; a job's thread gets them once there is a worker; no wait tool", async () => {
    const t = setup()
    await t.send('hello')
    await t.until(t.idle, 'first reply')
    expect(Object.keys(t.replies()[0]!.options.mcpServers ?? {})).toContain('team')
    expect(systemOf(t.replies()[0]!)).toContain('You have no other bots yet: hand work to yourself.')
    // A job's thread, with Tomo the only bot: nobody to talk to there.
    const { thread } = await t.d((x) => x.createJob({ title: 'Solo', botId: 'tomo' }))
    const sayInJob = async (text: string) => {
      const parentId = await t.d((x) => x.activePath(x.getSession(thread.id)!).at(-1)?.message.id ?? thread.rootId)
      await t.run(Chat.use((c) => c.send({ sessionId: thread.id, parentId, text, attachmentIds: [] })))
    }
    await sayInJob('on my own')
    await t.until(t.idle, 'the reply in the job')
    expect(Object.keys(t.replies()[1]!.options.mcpServers ?? {})).not.toContain('team')
    expect(systemOf(t.replies()[1]!)).not.toContain('team of bots')

    await t.addBot({ name: 'Scout', instructions: 'Finds things out on the web.\nBe thorough.' })
    await t.send('try wait')
    await t.until(t.idle, 'third reply')
    const third = t.replies()[2]!
    expect(Object.keys(third.options.mcpServers ?? {})).toContain('team')
    expect(systemOf(third)).toContain('You lead a team of bots')
    expect(systemOf(third)).toContain('- Scout: Finds things out on the web. (tools: none beyond memory and notes)')
    // Nobody waits: the tool is gone, and the instructions say the answer comes as a turn.
    expect(systemOf(third)).toContain('select:mcp__team__start_job,mcp__team__message,mcp__team__list_jobs"')
    expect(systemOf(third)).not.toMatch(/\bwait\(/)
    expect(systemOf(third)).toContain("don't track it or wait for it")
    expect(systemOf(third)).toContain("don't repeat it")
    const said = (await t.conversation()).at(-1)!.message.content
    expect(said).toMatch(/Tomo done: .*wait/i)
    expect(said).toContain('not found')
    // With a worker, the job's thread has them too.
    await sayInJob('together now')
    await t.until(t.idle, 'the second reply in the job')
    expect(Object.keys(t.replies()[3]!.options.mcpServers ?? {})).toContain('team')
    await t.runtime.dispose()
  })

  test("start_job opens a job for a worker; its report arrives in the primary's conversation as a turn, which Tomo answers", async () => {
    const t = setup()
    const scout = await t.addBot({ name: 'Scout' })
    await t.send('start Scout | Find the cheapest flight')
    await t.until(async () => t.tomoAnswers().length === 1, "Tomo's answer to the report")
    await t.until(t.idle, 'all replies')
    const bots = await t.d((x) => x.listBots())
    const job = (await t.d((x) => x.listJobs())).find((j) => j.title === 'Find the cheapest flight')!
    // Owned by the bot doing it; the primary answers on its shared thread.
    expect(job.ownerBotId).toBe(scout.id)
    expect((await t.d((x) => x.getSession(job.threadId!)))!.botId).toBe('tomo')
    // The shared thread keeps the record: the task and the report.
    expect(postsAre(bots, await t.posts(job.title))).toEqual([
      ['task', 'Tomo', 'Scout', null],
      ['report', 'Scout', 'Tomo', null]
    ])
    // The worker's own thread: its own session, the task as a turn from Tomo.
    const detail = await t.run(Team.use((x) => x.detail(job.id)))
    expect(detail.bots.map((b) => [name(bots, b.botId), !!b.threadId])).toEqual([
      ['Scout', true],
      ['Tomo', false]
    ])
    const worker = await t.d((x) => x.getSession(detail.bots[0]!.threadId!)!)
    expect(worker).toMatchObject({ kind: 'worker', botId: scout.id, jobId: job.id, title: job.title })
    const path = await t.d((x) => x.activePath(worker).map((n) => n.message))
    expect(path.map((m) => [m.role, name(bots, m.authorBotId), m.post?.kind ?? null])).toEqual([
      ['user', 'Tomo', 'task'],
      ['assistant', 'Scout', null]
    ])
    const scoutCall = t.replies().find((c) => botOf(c) === 'Scout')!
    expect(scoutCall.prompt.at(-1)!.text).toBe('<from_bot name="Tomo" kind="task">\nFind the cheapest flight\n</from_bot>')
    expect(systemOf(scoutCall)).toContain("You can't open jobs")
    expect(systemOf(scoutCall)).toContain('end your reply there: its answer arrives as your next turn')
    expect(systemOf(scoutCall)).not.toMatch(/\bwait\(/)
    expect(systemOf(scoutCall)).not.toContain("this conversation is one job's thread")
    // A worker writes by the same rules (unslop) as Tomo: its reply is the report Tomo passes on.
    expect(systemOf(scoutCall)).toContain(WRITING_GUIDELINES)

    // In the primary's conversation: the report once, as a turn from Scout about the job, then Tomo's answer.
    const primaryId = (await t.d((x) => x.primarySession())).id
    const conversation = await t.conversation()
    expect(await shape(t)).toEqual([
      ['user', 'user', null, 'start Scout | Find the cheapest flight'],
      ['assistant', 'Tomo', null, expect.stringContaining('Tomo done: Opened the job “Find the cheapest flight”')],
      ['user', 'Scout', 'report', 'Scout done: Find the cheapest flight'],
      ['assistant', 'Tomo', null, 'Tomo done: Scout done: Find the cheapest flight']
    ])
    const [turn, answer] = conversation.slice(2)
    expect(turn!.message).toMatchObject({ sessionId: primaryId, authorBotId: scout.id, post: { kind: 'report', to: 'tomo', state: null } })
    expect(turn!.jobId).toBe(job.id)
    expect(answer!.jobId).toBe(job.id)
    expect(answer!.message.sessionId).toBe(primaryId)
    // Tomo was told who reported, about which job, and how to answer it.
    const tomo = t.tomoAnswers()[0]!
    expect(tomo.prompt.at(-1)!.text).toBe(`<from_bot name="Scout" kind="report" job="Find the cheapest flight" job_id="${job.id}">\nScout done: Find the cheapest flight\n</from_bot>`)
    expect(Object.keys(tomo.options.mcpServers ?? {})).toContain('team')
    expect(systemOf(tomo)).toContain('it arrives in your conversation with the user as a turn of its own')
    // The user's message made no job of its own: the only job is the one handed off.
    expect((await t.d((x) => x.listJobs())).map((j) => j.title)).toEqual(['Find the cheapest flight'])
    expect(conversation.every((n) => n.message.sessionId === primaryId)).toBe(true)
    expect(t.events.some((e) => e.type === 'thread' && e.sessionId === primaryId)).toBe(true)
    // Scout is done; Tomo idle.
    const presence = await t.run(Team.use((x) => x.presence))
    expect(presence).toEqual({ tomo: 'idle', [scout.id]: 'done' })
    await t.runtime.dispose()
  })

  test('list_jobs shows the jobs and their bots', async () => {
    const t = setup()
    await t.addBot({ name: 'Scout' })
    await t.send('start Scout | Check the weather\nlist')
    await t.until(async () => t.tomoAnswers().length === 1, "Tomo's answer to the report")
    await t.until(t.idle, 'replies', 8000)
    // Tomo's first reply, in its chat: the hand-off and the list.
    const said = (await t.conversation()).find((n) => n.message.role === 'assistant' && !n.message.post)!.message.content
    expect(said).toContain("You don't need to wait or check on it")
    expect(said).toMatch(/Open jobs:\n- Check the weather \[id [^\]]+\] · owner Scout · bots: Scout \(\w+\), Tomo \(\w+\)/)
    await t.runtime.dispose()
  })

  test('a report arriving while Tomo is mid-reply waits, and is answered after', async () => {
    const t = setup()
    await t.addBot({ name: 'Scout' })
    await t.addBot({ name: 'Builder' })
    await t.send('start Scout | hold-tomo1\nstart Builder | slow b1')
    // Scout reports at once; Tomo's answer to it runs until the test lets it go.
    await t.until(async () => t.tomoAnswers().length === 1, "Tomo starts answering Scout's report")
    gate('b1').open()
    await t.until(async () => (await t.posts('slow b1')).some((p) => p.post?.kind === 'report'), "Builder's report")
    await new Promise((r) => setTimeout(r, 100))
    // Builder's report is in Tomo's conversation, held: no reply for it yet.
    expect(t.tomoAnswers()).toHaveLength(1)
    let rows = await shape(t)
    expect(rows.at(-1)).toEqual(['user', 'Builder', 'report', 'Builder done: b1 finished'])
    expect(rows.at(-2)).toEqual(['assistant', 'Tomo', null, 'Tomo is on it.'])
    const primary = await t.d((x) => x.primarySession())
    expect(await t.d((x) => unanswered(x.activePath(primary)))).toBe(true)
    gate('tomo1').open()
    await t.until(async () => t.tomoAnswers().length === 2, 'Tomo answers the held report once its reply ends')
    await t.until(t.idle, 'replies')
    rows = await shape(t)
    expect(rows.slice(2)).toEqual([
      ['user', 'Scout', 'report', 'Scout done: hold-tomo1'],
      ['assistant', 'Tomo', null, 'Tomo done: tomo1 released'],
      ['user', 'Builder', 'report', 'Builder done: b1 finished'],
      ['assistant', 'Tomo', null, 'Tomo done: Builder is on it. / Builder done: b1 finished']
    ])
    await t.runtime.dispose()
  })

  test("a user message while Tomo is mid-reply is queued, not refused; two queued are answered by one reply", async () => {
    const t = setup()
    await t.send('slow q1')
    await t.until(async () => t.replies().length === 1, 'the first reply runs')
    // Two more while it runs: neither is refused, neither starts a reply.
    await t.send('First follow-up')
    const view = await t.send('Second follow-up')
    expect(view.session.kind).toBe('primary')
    await new Promise((r) => setTimeout(r, 50))
    expect(t.replies()).toHaveLength(1)
    const thread = await t.d((x) => x.primarySession())
    let path = await t.d((x) => x.activePath(thread).map((n) => n.message))
    expect(path.map((m) => [m.role, m.status, m.role === 'user' ? m.content : ''])).toEqual([
      ['user', 'complete', 'slow q1'],
      ['assistant', 'streaming', ''],
      ['user', 'complete', 'First follow-up'],
      ['user', 'complete', 'Second follow-up']
    ])
    // Both show in the primary's conversation, waiting.
    expect((await t.conversation()).map((n) => n.message.content.trim())).toEqual(['slow q1', 'Tomo is on it.', 'First follow-up', 'Second follow-up'])
    gate('q1').open()
    await t.until(async () => t.replies().length === 2, 'the queued messages are answered')
    await t.until(t.idle, 'replies')
    expect(t.replies()).toHaveLength(2)
    const answer = t.replies()[1]!
    expect(promptOf(answer)).toContain('<user>\nFirst follow-up\n</user>')
    expect(answer.prompt.at(-1)!.text).toBe('Second follow-up')
    path = await t.d((x) => x.activePath(thread).map((n) => n.message))
    expect(path.map((m) => [m.role, m.content.split('\n').at(-1)])).toEqual([
      ['user', 'slow q1'],
      ['assistant', 'Tomo done: q1 finished'],
      ['user', 'First follow-up'],
      ['user', 'Second follow-up'],
      ['assistant', 'Tomo done: Second follow-up']
    ])
    expect((await t.conversation()).map((n) => n.message.content.split('\n').at(-1))).toEqual([
      'slow q1',
      'Tomo done: q1 finished',
      'First follow-up',
      'Second follow-up',
      'Tomo done: Second follow-up'
    ])
    expect(await t.d((x) => x.listJobs())).toEqual([])
    await t.runtime.dispose()
  })

  test("held turns are answered at startup, and a worker gets only the posts it didn't", async () => {
    const first = setup()
    const scout = await first.addBot({ name: 'Scout' })
    await first.send('start Scout | Map the route')
    await first.until(async () => first.tomoAnswers().length === 1, "Tomo's answer to the report")
    await first.until(first.idle, 'replies')
    const job = (await first.d((x) => x.listJobs())).find((j) => j.title === 'Map the route')!
    const scoutThread = (await first.d((x) => x.workerThread(job.id, scout.id)))!
    // As a quit can leave things: a message held in Tomo's conversation, and a post made for Scout
    // that never reached its thread.
    await first.d((x) => {
      const primary = x.primarySession()
      const held = x.insertMessage({ sessionId: primary.id, parentId: x.activePath(primary).at(-1)!.message.id, role: 'user', content: 'Held over the restart', status: 'complete' })
      x.markVia(held.id, primary.id)
      x.appendPost({ threadId: job.threadId!, authorBotId: 'tomo', text: 'Also the scenic way', post: { kind: 'message', to: scout.id, state: null } })
    })
    await first.runtime.dispose()

    const t = setup(first.dir)
    expect(await t.run(Team.use((x) => x.resume))).toBe(2)
    await t.until(async () => t.tomoAnswers().length === 1, "Scout's second report reaches Tomo")
    await t.until(t.idle, 'replies')
    // Scout answered the post it never got, and only that: its task wasn't handed over again.
    const scoutCalls = t.replies().filter((c) => botOf(c) === 'Scout')
    expect(scoutCalls.map((c) => asked(c))).toEqual(['Also the scenic way'])
    const bots = await t.d((x) => x.listBots())
    expect((await t.d((x) => x.activePath(scoutThread))).map((n) => [n.message.role, name(bots, n.message.authorBotId), n.message.content.split('\n').at(-1)])).toEqual([
      ['user', 'Tomo', 'Map the route'],
      ['assistant', 'Scout', 'Scout done: Map the route'],
      ['user', 'Tomo', 'Also the scenic way'],
      ['assistant', 'Scout', 'Scout done: Also the scenic way']
    ])
    // The held message got its answer in Tomo's conversation.
    const tomoCalls = t.replies().filter((c) => botOf(c) === 'Tomo' && c.prompt.at(-1)?.text === 'Held over the restart')
    expect(tomoCalls).toHaveLength(1)
    expect((await t.conversation()).map((n) => n.message.content.split('\n').at(-1))).toContain('Tomo done: Held over the restart')
    // A second start finds nothing left to do.
    expect(await t.run(Team.use((x) => x.resume))).toBe(0)
    await t.runtime.dispose()
  })

  test("workers can't open jobs, and post only in their own", async () => {
    const t = setup()
    await t.addBot({ name: 'Scout' })
    await t.addBot({ name: 'Builder' })
    await t.send('start Scout | open job')
    await t.until(async () => (await t.posts('open job')).some((p) => p.post?.kind === 'report'), 'the report')
    await t.until(t.idle, 'replies')
    const report = (await t.posts('open job')).at(-1)!
    expect(report.content).toContain('Error: Only Tomo, the primary bot, opens jobs')
    expect((await t.d((x) => x.listJobs())).map((j) => j.title)).toEqual(['open job'])
    await t.runtime.dispose()
  })

  test('a worker asking a worker with more access is held for the user, then passed on; it reports once the answer is in', async () => {
    const t = setup()
    const scout = await t.addBot({ name: 'Scout', modules: [] })
    const builder = await t.addBot({ name: 'Builder', modules: ['computer'] })
    const waiting = () => t.run(ComputerUse.use((c) => Effect.sync(c.waiting)))
    await t.send('start Scout | ask Builder | Write the notes file')
    await t.until(async () => (await waiting())?.kind === 'approval', 'the approval card')
    const card = (await waiting())!
    expect(card.kind === 'approval' && card.title).toBe('Scout asks Builder to do what Scout can’t')
    expect(card.kind === 'approval' && card.detail).toContain('Write the notes file')
    expect(card.kind === 'approval' && card.detail).toContain('Builder may ')
    // It shows in Scout's reply, in Scout's own thread; Scout is waiting for the user.
    const scoutThread = await t.d((x) => x.workerThread(x.listJobs().find((j) => j.title.startsWith('ask Builder'))!.id, scout.id)!)
    expect(card.sessionId).toBe(scoutThread.id)
    expect((await t.run(Team.use((x) => x.presence)))[scout.id]).toBe('waiting')
    const jobTitle = await t.d((x) => x.listJobs().find((j) => j.ownerBotId === scout.id)!.title)
    expect(postsAre(await t.d((x) => x.listBots()), await t.posts(jobTitle)).at(-1)).toEqual(['message', 'Scout', 'Builder', 'held'])
    // Nothing reached Builder yet.
    expect(await t.d((x) => x.workerThread(x.listJobs().find((j) => j.title === jobTitle)!.id, builder.id))).toBeUndefined()

    await t.run(ComputerUse.use((c) => c.approve(card.id, true)))
    await t.until(async () => (await t.posts(jobTitle)).some((p) => p.post?.kind === 'report' && p.post.to === 'tomo'), "Scout's report")
    await t.until(t.idle, 'replies')
    const bots = await t.d((x) => x.listBots())
    // Scout's reply that asked Builder didn't report; its reply to Builder's answer did.
    expect(postsAre(bots, await t.posts(jobTitle))).toEqual([
      ['task', 'Tomo', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', null],
      ['report', 'Scout', 'Tomo', null]
    ])
    expect((await t.posts(jobTitle)).at(-1)!.content).toBe('Scout done: Builder done: Write the notes file')
    const scoutCalls = t.replies().filter((c) => botOf(c) === 'Scout')
    expect(scoutCalls).toHaveLength(2)
    expect(scoutCalls[0]!.prompt.at(-1)!.text).toContain('<from_bot name="Tomo" kind="task">')
    expect(scoutCalls[1]!.prompt.at(-1)!.text).toBe('<from_bot name="Builder" kind="report">\nBuilder done: Write the notes file\n</from_bot>')
    // Builder ran under its own rules, in its own thread, once.
    expect(t.replies().filter((c) => botOf(c) === 'Builder')).toHaveLength(1)
    // Tomo heard one report, Scout's final one.
    expect(t.tomoAnswers()).toHaveLength(1)
    await t.runtime.dispose()
  })

  test('denied, the request never reaches the other worker', async () => {
    const t = setup()
    await t.addBot({ name: 'Scout', modules: [] })
    const builder = await t.addBot({ name: 'Builder', modules: ['browser'] })
    const waiting = () => t.run(ComputerUse.use((c) => Effect.sync(c.waiting)))
    await t.send('start Scout | ask Builder | Click buy')
    await t.until(async () => (await waiting())?.kind === 'approval', 'the approval card')
    const card = (await waiting())!
    await t.run(ComputerUse.use((c) => c.approve(card.id, false)))
    await t.until(async () => (await t.posts('ask Builder | Click buy')).some((p) => p.post?.kind === 'report'), "Scout's report")
    await t.until(t.idle, 'replies')
    const ps = await t.posts('ask Builder | Click buy')
    expect(ps.map((p) => [p.post!.kind, p.post!.state])).toEqual([
      ['task', null],
      ['message', 'declined'],
      ['report', null]
    ])
    expect(ps.at(-1)!.content).toContain("Error: The user didn't approve passing this on to Builder")
    expect(await t.d((x) => x.workerThread(x.listJobs().find((j) => j.title === 'ask Builder | Click buy')!.id, builder.id))).toBeUndefined()
    await t.runtime.dispose()
  })

  test('the primary delegates freely, even to a worker with more access; a worker with less asks no one', async () => {
    const t = setup()
    await t.addBot({ name: 'Builder', modules: ['computer', 'browser'], rules: { 'files.write': 'allow' } })
    await t.send('start Builder | Write the report')
    await t.until(async () => (await t.posts('Write the report')).some((p) => p.post?.kind === 'report'), 'the report')
    expect(await t.run(ComputerUse.use((c) => Effect.sync(c.waiting)))).toBeNull()
    await t.until(t.idle, 'replies')
    await t.runtime.dispose()
  })

  test('workers run in parallel, each in its own session', async () => {
    const t = setup()
    const scout = await t.addBot({ name: 'Scout' })
    const builder = await t.addBot({ name: 'Builder' })
    await t.send('start Scout | slow a\nstart Builder | slow b')
    await t.until(async () => (await t.run(Chat.use((c) => Effect.sync(c.running)))).filter((r) => r.botId !== 'tomo').length === 2, 'both workers running')
    const running = await t.run(Chat.use((c) => Effect.sync(c.running)))
    expect(new Set(running.filter((r) => r.botId !== 'tomo').map((r) => r.botId))).toEqual(new Set([scout.id, builder.id]))
    const presence = await t.run(Team.use((x) => x.presence))
    expect(presence[scout.id]).toBe('thinking')
    expect(presence[builder.id]).toBe('thinking')
    const sessions = t.replies().filter((c) => botOf(c) !== 'Tomo').map((c) => c.session)
    expect(new Set(sessions).size).toBe(2)
    gate('a').open()
    gate('b').open()
    await t.until(async () => (await t.posts('slow a')).length === 2 && (await t.posts('slow b')).length === 2, 'both reports')
    await t.until(async () => t.tomoAnswers().length === 2, 'Tomo answers both')
    await t.until(t.idle, 'replies')
    const conversation = (await t.conversation()).map((n) => n.message)
    expect(conversation.filter((m) => m.post?.kind === 'report').map((m) => m.content.split('\n').at(-1)).sort()).toEqual(['Builder done: b finished', 'Scout done: a finished'])
    await t.runtime.dispose()
  })

  test("a job Tomo hands itself runs in its own thread; a worker's answer comes back there, and Tomo's report to its chat", async () => {
    const t = setup()
    const scout = await t.addBot({ name: 'Scout' })
    await t.send('start yourself | ask Scout | Check the map\nstart myself | open job')
    const reported = async (title: string) => (await t.posts(title)).some((p) => p.post?.kind === 'report' && p.post.to === 'tomo' && p.authorBotId === 'tomo')
    await t.until(async () => (await reported('ask Scout | Check the map')) && (await reported('open job')), "both of Tomo's own reports", 10_000)
    await t.until(t.idle, 'replies', 10_000)
    const bots = await t.d((x) => x.listBots())
    const jobs = await t.d((x) => x.listJobs())
    const map = jobs.find((j) => j.title === 'ask Scout | Check the map')!
    expect(map.ownerBotId).toBe('tomo')
    const own = (await t.d((x) => x.workerThread(map.id, 'tomo')))!
    expect(own.kind).toBe('worker')
    // In its own thread Tomo works as a worker does: it asked Scout, ended there, and Scout's answer
    // came back to this thread (not to the chat), where Tomo's reply to it is the report.
    expect((await t.d((x) => x.activePath(own))).map((n) => [n.message.role, name(bots, n.message.authorBotId), n.message.post?.kind ?? null])).toEqual([
      ['user', 'Tomo', 'task'],
      ['assistant', 'Tomo', null],
      ['user', 'Scout', 'report'],
      ['assistant', 'Tomo', null]
    ])
    const ownCalls = t.replies().filter((c) => systemOf(c).includes('working on a task you handed yourself'))
    expect(systemOf(ownCalls[0]!)).toContain('This is your own thread on a job you handed yourself.')
    expect(systemOf(ownCalls[0]!)).not.toContain('You lead a team')
    expect(postsAre(bots, await t.posts(map.title))).toEqual([
      ['task', 'Tomo', 'Tomo', null],
      ['message', 'Tomo', 'Scout', null],
      ['report', 'Scout', 'Tomo', null],
      ['report', 'Tomo', 'Tomo', null]
    ])
    expect((await t.d((x) => x.workerThread(map.id, scout.id)))?.kind).toBe('worker')
    // From its own thread it opens no jobs.
    expect((await t.posts('open job')).at(-1)!.content).toContain("Error: You're working on a job in its own thread")
    expect(jobs.map((j) => j.title).sort()).toEqual(['ask Scout | Check the map', 'open job'])
    // Tomo's chat: the hand-off, then its two reports as turns from itself, each answered once.
    const rows = (await shape(t)).filter((r) => r[1] === 'Tomo' && r[2] === 'report')
    expect(rows.map((r) => r[3]).sort()).toEqual([
      "Tomo done: Error: You're working on a job in its own thread: do the work here, or ask one of your bots on this job with message. If it needs a job of its own, say so in your report.",
      'Tomo done: Scout done: Check the map'
    ])
    expect((await t.conversation()).filter((n) => n.message.role === 'assistant' && !n.message.post)).toHaveLength(3)
    await t.runtime.dispose()
  })

  test('a request bouncing between two bots is stopped, and the user told in the primary’s conversation', async () => {
    const t = setup()
    await t.addBot({ name: 'Scout' })
    await t.addBot({ name: 'Builder' })
    await t.send('start Scout | ask Builder | Do the thing')
    const title = 'ask Builder | Do the thing'
    await t.until(async () => (await t.posts(title)).some((p) => p.post?.state === 'stopped'), 'the bounce is stopped', 15000)
    await t.until(t.idle, 'replies')
    const bots = await t.d((x) => x.listBots())
    const ps = postsAre(bots, await t.posts(title))
    expect(ps).toEqual([
      ['task', 'Tomo', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', 'stopped'],
      ['report', 'Tomo', 'Tomo', null]
    ])
    // Builder answered three times; its third answer went no further.
    expect(t.replies().filter((c) => botOf(c) === 'Builder')).toHaveLength(3)
    expect(t.replies().filter((c) => botOf(c) === 'Scout')).toHaveLength(3)
    // The user sees the notice in Tomo's conversation, as a card; Tomo doesn't answer its own notice.
    const conversation = (await t.conversation()).map((n) => n.message)
    expect(conversation.some((m) => m.authorBotId === 'tomo' && m.post?.kind === 'report' && m.content.includes('Builder and Scout kept passing the same request back and forth'))).toBe(true)
    expect(t.tomoAnswers()).toHaveLength(0)
    await t.runtime.dispose()
  })
})

describe('the pure parts', () => {
  test('bouncing: six posts back and forth between two bots, each saying the same thing', () => {
    const ab = { from: 'a', to: 'b', text: 'Please do X' }
    const ba = { from: 'b', to: 'a', text: 'No, you do it.' }
    expect(bouncing([ab, ba, ab, ba, ab])).toBe(false)
    expect(bouncing([ab, ba, ab, ba, ab, ba])).toBe(true)
    expect(bouncing([ab, ba, ab, ba, ab, { ...ba, text: '  no, YOU do it. ' }])).toBe(true)
    // Something changed: not a bounce.
    expect(bouncing([ab, ba, ab, { ...ba, text: 'Done half of it.' }, ab, ba])).toBe(false)
    // A third bot in between.
    expect(bouncing([ab, ba, ab, { from: 'c', to: 'a', text: 'No, you do it.' }, ab, ba])).toBe(false)
    // Not addressed to each other.
    expect(bouncing([ab, { ...ba, to: null }, ab, { ...ba, to: null }, ab, { ...ba, to: null }])).toBe(false)
  })

  test('presence: waiting, working, thinking, stuck, done, idle', () => {
    const bot = (id: string, isPrimary = false) => ({ id, isPrimary }) as Bot
    const now = 1_000_000_000
    const latest: Record<string, { status: string; createdAt: number }> = {
      stuck: { status: 'paused', createdAt: now },
      done: { status: 'complete', createdAt: now - 1000 },
      old: { status: 'complete', createdAt: now - DONE_MS - 1 },
      tomo: { status: 'complete', createdAt: now }
    }
    expect(
      presenceOf({
        bots: ['tomo', 'w', 'work', 'think', 'stuck', 'done', 'old'].map((id) => bot(id, id === 'tomo')),
        running: [
          { botId: 'work', working: true },
          { botId: 'think', working: false },
          { botId: 'w', working: true }
        ],
        waitingBot: 'w',
        latest: (id) => latest[id] ?? null,
        now
      })
    ).toEqual({ tomo: 'idle', w: 'waiting', work: 'working', think: 'thinking', stuck: 'stuck', done: 'done', old: 'idle' })
  })

  test("a report is the reply's words, without its steps; an artifact is named, not carried", () => {
    expect(reportText('Looked.\n::step {"tool":"x","label":"Searched","ok":true}\nFound two flights.')).toBe('Looked.\n\nFound two flights.')
    expect(reportText('Here it is.\n<artifact identifier="cats" title="Cats">\n<h1>Cats</h1>\n</artifact>\nDone.')).toBe("Here it is.\n\n(Made “Cats”: it's in the job's thread.)\n\nDone.")
  })

  test('a thread waits on turns nothing answered: user turns after its last reply; posts answer nothing', () => {
    const n = (role: Message['role'], post = false) => ({ message: { role, post: post ? { kind: 'report' as const, to: null, state: null } : null } })
    expect(unanswered([n('root'), n('user'), n('assistant')])).toBe(false)
    expect(unanswered([n('root'), n('user'), n('assistant'), n('user')])).toBe(true)
    expect(unanswered([n('root'), n('user'), n('assistant'), n('user'), n('user')])).toBe(true)
    expect(unanswered([n('root'), n('user'), n('assistant'), n('user'), n('assistant', true)])).toBe(true)
    expect(unanswered([n('root'), n('user'), n('assistant'), n('assistant', true)])).toBe(false)
    expect(unanswered([n('root')])).toBe(false)
  })
})
