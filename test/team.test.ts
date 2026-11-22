// Workers (services/Team.ts, agent/team.ts): the four team tools, run end to end against a fake
// Claude Code that plays every bot from a script, plus the pure parts (bouncing, presence).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { Bot, BotPatch, JobTarget, Message, StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Broadcaster, Chat } from '../src/main/services/Chat'
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
 *   start <Bot> | <task>      start_job (and `wait` after it waits on that job)
 *   wait                      wait on the job started last
 *   ask <Bot> | <text>        message
 *   waitfor <Bot> <seconds>   wait for that bot
 *   loop <Bot> | <text> | <n> message and wait (1 s), n times
 *   open job                  start_job, from wherever it runs
 *   gate <name>               waits until the test opens it
 *   slow <name>               the same, said as work
 * Builder answers "Do the thing" with "No, you do it." Each reply ends saying what its tools said.
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
  let lastJob: string | null = null
  // A worker's task can carry several commands, joined with ' ; '.
  for (const line of said.split(who === 'Tomo' ? '\n' : /\n| ; /).map((l) => l.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null
    if ((m = /^start (\w+) \| (.+)$/.exec(line))) {
      const r = say(yield* t.tool('mcp__team__start_job', { bot: m[1], task: m[2], title: m[2] }))
      lastJob = /\(id ([^)]+)\)/.exec(r)?.[1] ?? null
      out.push(r)
    } else if (line === 'wait') out.push(say(yield* t.tool('mcp__team__wait', { thread: lastJob, timeout_seconds: 20 })))
    else if ((m = /^ask (\w+) \| (.+)$/.exec(line))) out.push(say(yield* t.tool('mcp__team__message', { to: m[1], text: m[2] })))
    else if ((m = /^waitfor (\w+) (\d+)$/.exec(line))) out.push(say(yield* t.tool('mcp__team__wait', { bot: m[1], timeout_seconds: Number(m[2]) })))
    else if ((m = /^loop (\w+) \| (.+) \| (\d+)$/.exec(line))) {
      for (let i = 0; i < Number(m[3]); i++) {
        out.push(say(yield* t.tool('mcp__team__message', { to: m[1], text: m[2] })))
        out.push(say(yield* t.tool('mcp__team__wait', { bot: m[1], timeout_seconds: 1 })))
      }
    } else if (line === 'open job') out.push(say(yield* t.tool('mcp__team__start_job', { bot: 'Builder', task: 'Something new' })))
    else if (line === 'list') out.push(say(yield* t.tool('mcp__team__list_jobs', {})))
    else if ((m = /^(?:gate|slow) (\w+)/.exec(line))) {
      yield* t.text(`${who} is on it.\n`)
      await t.wait(gate(m[1]!).promise)
      out.push(`${m[1]} finished`)
    } else out.push(line)
  }
  yield* t.text(`${who} done: ${out.join(' / ')}`)
  yield t.result()
}

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-team-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '', systemPrompt: 'Be a fox.' }))
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
  const send = (text: string, target: JobTarget = 'new') => run(Jobs.use((j) => j.send({ text, attachmentIds: [], target })))
  /** Every post in a job's shared thread. */
  const posts = (title: string) =>
    d((x) => {
      const job = x.listJobs().find((j) => j.title === title)
      return job?.threadId ? x.activePath(x.getSession(job.threadId)!).map((n) => n.message).filter((m) => m.post) : []
    })
  const replies = () => fake.calls.filter((c) => !isAsk(c))
  const idle = () => d((x) => x.listSessions().every((s) => x.streamingIds(s.id).length === 0))
  return { runtime, run, d, until, addBot, send, posts, replies, events, idle }
}

type T = ReturnType<typeof setup>
const lastPrimary = async (t: T) => (await t.run(Jobs.use((j) => j.primary))).path.at(-1)!.message
const name = (bots: Bot[], id: string | null) => bots.find((b) => b.id === id)?.name
const postsAre = (bots: Bot[], ps: Message[]) => ps.map((p) => [p.post!.kind, name(bots, p.authorBotId), name(bots, p.post!.to), p.post!.state])

describe('the team tools', () => {
  test('one bot gets no team tools; once there is a worker, every reply on a job gets them', async () => {
    const t = setup()
    await t.send('hello')
    await t.until(t.idle, 'first reply')
    expect(Object.keys(t.replies()[0]!.options.mcpServers ?? {})).not.toContain('team')
    expect(systemOf(t.replies()[0]!)).not.toContain('team of bots')

    await t.addBot({ name: 'Scout', instructions: 'Finds things out on the web.\nBe thorough.' })
    await t.send('hello again')
    await t.until(t.idle, 'second reply')
    const second = t.replies()[1]!
    expect(Object.keys(second.options.mcpServers ?? {})).toContain('team')
    expect(systemOf(second)).toContain('You lead a team of bots')
    expect(systemOf(second)).toContain('- Scout: Finds things out on the web. (tools: none beyond memory and notes)')
    await t.runtime.dispose()
  })

  test('start_job opens a job for a worker, which works in its own thread and reports back to the primary as a card', async () => {
    const t = setup()
    const scout = await t.addBot({ name: 'Scout' })
    await t.send('start Scout | Find the cheapest flight')
    await t.until(async () => (await t.posts('Find the cheapest flight')).some((p) => p.post?.kind === 'report'), 'the report')
    await t.until(t.idle, 'all replies')
    const bots = await t.d((x) => x.listBots())
    const job = (await t.d((x) => x.listJobs())).find((j) => j.title === 'Find the cheapest flight')!
    // Owned by the bot doing it; the primary answers on its shared thread.
    expect(job.ownerBotId).toBe(scout.id)
    expect((await t.d((x) => x.getSession(job.threadId!)))!.botId).toBe('tomo')
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
    expect(systemOf(scoutCall)).not.toContain('this conversation is one job\'s thread')
    // The report, in the primary's conversation, from the job's thread.
    const card = await lastPrimary(t)
    expect(card).toMatchObject({ role: 'assistant', authorBotId: scout.id, sessionId: job.threadId, post: { kind: 'report', to: 'tomo', state: null } })
    expect(card.content).toBe('Scout done: Find the cheapest flight')
    expect(t.events.some((e) => e.type === 'thread' && e.sessionId === job.threadId)).toBe(true)
    // Scout is done; Tomo idle.
    const presence = await t.run(Team.use((x) => x.presence))
    expect(presence).toEqual({ tomo: 'idle', [scout.id]: 'done' })
    await t.runtime.dispose()
  })

  test('wait gives the primary the report; list_jobs shows the jobs and their bots', async () => {
    const t = setup()
    await t.addBot({ name: 'Scout' })
    await t.send('start Scout | Check the weather\nwait\nlist')
    await t.until(t.idle, 'replies', 8000)
    const reply = (await t.d((x) => x.listJobs().find((j) => j.title !== 'Check the weather')!))
    const thread = await t.d((x) => x.activePath(x.getSession(reply.threadId!)!).map((n) => n.message))
    const said = thread.at(-1)!.content
    expect(said).toContain('Scout (report):\nScout done: Check the weather')
    expect(said).toMatch(/Open jobs:\n- Check the weather \[id [^\]]+\] · owner Scout · bots: Scout \(done\), Tomo \(\w+\)/)
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
    expect((await t.d((x) => x.listJobs())).map((j) => j.title).sort()).toEqual(['open job', 'start Scout | open job'])
    await t.runtime.dispose()
  })

  test('a worker asking a worker with more access is held for the user, named on the card, then passed on', async () => {
    const t = setup()
    const scout = await t.addBot({ name: 'Scout', modules: [] })
    const builder = await t.addBot({ name: 'Builder', modules: ['computer'] })
    const waiting = () => t.run(ComputerUse.use((c) => Effect.sync(c.waiting)))
    await t.send('start Scout | ask Builder | Write the notes file ; waitfor Builder 10')
    await t.until(async () => (await waiting())?.kind === 'approval', 'the approval card')
    const card = (await waiting())!
    expect(card.kind === 'approval' && card.title).toBe('Scout asks Builder to do what Scout can’t')
    expect(card.kind === 'approval' && card.detail).toContain('Write the notes file')
    expect(card.kind === 'approval' && card.detail).toContain('Builder may ')
    // It shows in Scout's reply, in Scout's own thread; Scout is waiting for the user.
    const scoutThread = await t.d((x) => x.workerThread(x.listJobs().find((j) => j.title.startsWith('ask Builder'))!.id, scout.id)!)
    expect(card.sessionId).toBe(scoutThread.id)
    expect((await t.run(Team.use((x) => x.presence)))[scout.id]).toBe('waiting')
    const jobTitle = (await t.d((x) => x.listJobs().find((j) => j.ownerBotId === scout.id)!.title))
    expect(postsAre(await t.d((x) => x.listBots()), await t.posts(jobTitle)).at(-1)).toEqual(['message', 'Scout', 'Builder', 'held'])
    // Nothing reached Builder yet.
    expect(await t.d((x) => x.workerThread(x.listJobs().find((j) => j.title === jobTitle)!.id, builder.id))).toBeUndefined()

    await t.run(ComputerUse.use((c) => c.approve(card.id, true)))
    await t.until(async () => (await t.posts(jobTitle)).some((p) => p.post?.kind === 'report' && p.post.to === 'tomo'), "Scout's report")
    await t.until(t.idle, 'replies')
    const bots = await t.d((x) => x.listBots())
    expect(postsAre(bots, await t.posts(jobTitle))).toEqual([
      ['task', 'Tomo', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', null],
      ['report', 'Scout', 'Tomo', null]
    ])
    const scoutReport = (await t.posts(jobTitle)).at(-1)!.content
    expect(scoutReport).toContain('Builder (report):\nBuilder done: Write the notes file')
    // Builder ran under its own rules, in its own thread, and only once: Scout read its report with wait.
    expect(t.replies().filter((c) => botOf(c) === 'Builder')).toHaveLength(1)
    expect(t.replies().filter((c) => botOf(c) === 'Scout')).toHaveLength(1)
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
    const conversation = (await t.run(Jobs.use((j) => j.primary))).path.map((n) => n.message)
    expect(conversation.filter((m) => m.post?.kind === 'report').map((m) => m.content.split('\n').at(-1)).sort()).toEqual(['Builder done: b finished', 'Scout done: a finished'])
    await t.runtime.dispose()
  })

  test('a request bouncing between two bots is stopped, and the user told in the primary’s conversation', async () => {
    const t = setup()
    await t.addBot({ name: 'Scout' })
    await t.addBot({ name: 'Builder' })
    await t.send('start Scout | loop Builder | Do the thing | 4')
    await t.until(async () => (await t.posts('loop Builder | Do the thing | 4')).some((p) => p.post?.kind === 'report' && p.post.to === 'tomo' && p.authorBotId !== 'tomo'), "Scout's report", 15000)
    await t.until(t.idle, 'replies')
    const bots = await t.d((x) => x.listBots())
    const ps = postsAre(bots, await t.posts('loop Builder | Do the thing | 4'))
    expect(ps.slice(0, 7)).toEqual([
      ['task', 'Tomo', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', null],
      ['message', 'Scout', 'Builder', null],
      ['report', 'Builder', 'Scout', 'stopped']
    ])
    expect(ps.filter((p) => p[3] === 'stopped').length).toBeGreaterThanOrEqual(2)
    // Builder answered three times, not four: the fourth request was stopped too.
    expect(t.replies().filter((c) => botOf(c) === 'Builder')).toHaveLength(3)
    const conversation = (await t.run(Jobs.use((j) => j.primary))).path.map((n) => n.message)
    expect(conversation.some((m) => m.authorBotId === 'tomo' && m.content.includes('Scout and Builder kept passing the same request back and forth'))).toBe(true)
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

  test("a report is the reply's words, without its steps", () => {
    expect(reportText('Looked.\n::step {"tool":"x","label":"Searched","ok":true}\nFound two flights.')).toBe('Looked.\n\nFound two flights.')
  })
})
