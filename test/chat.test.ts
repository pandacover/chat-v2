import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { StreamEvent } from '../src/shared/types'
import { stepLine } from '../src/shared/steps'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { BROWSER_AND_COMPUTER_NOTE, Broadcaster, Chat } from '../src/main/services/Chat'
import { Db } from '../src/main/services/Db'
import { Browser, type BrowserApi, type PageSnapshot } from '../src/main/services/Browser'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { Agent } from '../src/main/agent/driver'
import { BROWSER_INSTRUCTIONS } from '../src/main/agent/browser'
import { RECALL_INSTRUCTIONS } from '../src/main/agent/recall'
import { HISTORY_NOTE } from '../src/main/agent/history'
import { WRITING_GUIDELINES } from '../src/main/guidelines'
import { ComputerUse, noOverlay, type OverlayPort, type Platform } from '../src/main/computer'
import { type Call, type Script, fakeQuery } from './fakeQuery'
import { fakeOverlay, fakePlatform } from './computer/fakes'

const page = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'http://shop.test/',
  title: 'Shop',
  elements: '[e1] button "Buy now"',
  text: 'Welcome',
  scroll: { y: 0, height: 800, viewport: 800 },
  ...over
})

/** Records browser calls instead of driving a real page. */
const fakeBrowser = (log: string[]) =>
  Layer.succeed(
    Browser,
    Browser.of({
      attach: () => Effect.void,
      navigate: (url) => Effect.sync(() => (log.push(`navigate ${url}`), page({ url }))),
      history: (d) => Effect.sync(() => (log.push(d), page())),
      snapshot: Effect.sync(() => (log.push('snapshot'), page())),
      search: (q) => Effect.sync(() => (log.push(`search ${q}`), [{ title: 'Camera guide', url: 'https://wiki.test/camera', snippet: 'How to change the camera' }])),
      read: (url) => Effect.sync(() => (log.push(`read ${url}`), { url: url ?? 'http://shop.test/', title: 'Camera guide', text: '# Camera\n1. Open Settings\n2. Pick Controls' })),
      click: (t) => Effect.sync(() => (log.push(`click ${t.ref}`), page({ elements: '[e1] button "Bought!"' }))),
      type: (ref, text) => Effect.sync(() => (log.push(`type ${ref} ${text}`), page())),
      press: (k) => Effect.sync(() => (log.push(`press ${k}`), page())),
      scroll: (dy) => Effect.sync(() => (log.push(`scroll ${dy}`), page())),
      screenshot: () => Effect.succeed({ dataUrl: 'data:image/jpeg;base64,AAAA', png: new Uint8Array(4) }),
      evaluate: () => Effect.succeed('42'),
      elementAt: () => Effect.succeed(null),
      screencast: () => Effect.void,
      startRecording: Effect.sync(() => void log.push('record start')),
      stopRecording: Effect.sync(() => (log.push('record stop'), { path: 'C:\\Videos\\Tomo\\recording-1.webm', seconds: 7 })),
      recordReply: () => Effect.void,
      status: (label) => Effect.sync(() => void log.push(`status ${label}`)),
      release: Effect.sync(() => void log.push('release'))
    } satisfies BrowserApi)
  )

const dirs: string[] = []
afterEach(() => {
  // Best effort: on Windows, Bun keeps the SQLite file locked after close() (Node/Electron do not).
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const reply: Script = async function* (t) {
  yield* t.text('ok')
  yield t.result()
}

/** Whether a call is a one-off ask (a title, a memory read) rather than a reply. */
const isAsk = (c: Call) => c.options.persistSession === false
const promptText = (c: Call) => c.prompt.map((b) => b.text ?? `[${b.type}]`).join('\n---\n')
const systemOf = (c: Call) => (c.options.systemPrompt as { prompt: string }).prompt

const setup = (
  script: Script,
  // Titling and memory are off unless a test is about them, so every call a script sees is a reply.
  config: Record<string, unknown> = { titleModel: '', memoryModel: '' },
  dir = mkdtempSync(join(tmpdir(), 'chat-v2-')),
  browserLog: string[] = [],
  // No computer use unless a test brings a (fake) platform.
  computer: { platform: Platform | null; overlay: OverlayPort } = { platform: null, overlay: noOverlay }
) => {
  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const events: StreamEvent[] = []
  const waiters: Array<() => void> = []
  const fake = fakeQuery(script)
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const agent = Agent.layer({ query: fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
  const facts: string[] = []
  const computerUse = ComputerUse.layer({ ...computer, remember: async (fact) => void facts.push(fact) })
  const providers = Layer.mergeAll(agent, Attachments.layer, computerUse).pipe(Layer.provideMerge(base))
  const broadcaster = Broadcaster.of({
    send: (e) => {
      events.push(e)
      if (e.type === 'done') waiters.splice(0).forEach((w) => w())
    }
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Chat.layer.pipe(Layer.provide(providers), Layer.provide(Layer.succeed(Broadcaster, broadcaster)), Layer.provide(fakeBrowser(browserLog))),
      providers
    )
  )
  const run = <A, E>(eff: Effect.Effect<A, E, Chat | Db | SettingsStore | Attachments | Agent | ComputerUse>) => runtime.runPromise(eff)
  const doneCount = () => events.filter((e) => e.type === 'done').length
  const waitForDone = async (n: number) => {
    while (doneCount() < n) await new Promise<void>((r) => waiters.push(r))
  }
  const replies = () => fake.calls.filter((c) => !isAsk(c))
  return { runtime, run, events, calls: fake.calls, replies, waitForDone, dir, facts }
}

const newSession = Effect.gen(function* () {
  const db = yield* Db
  return yield* db.use((d) => d.createSession({ title: 'New chat', model: null, systemPrompt: null, forkedFromSessionId: null }))
})

const sendTo = (session: { id: string }, parentId: string, text: string, attachmentIds: string[] = []) =>
  Chat.use((c) => c.send({ sessionId: session.id, parentId, text, attachmentIds }))

const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('replies', () => {
  test('stream line by line, persist, and run on one query set up for the chat', async () => {
    const leaked = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-shell'
    try {
      const t = setup(async function* (t) {
        yield* t.text('Hel', 'lo\nwor', 'ld\n', 'end')
        yield t.result({ cost: 0.002, turns: 1 })
      })
      const session = await t.run(newSession)
      await t.run(sendTo(session, session.rootId, 'Say hello'))
      await t.waitForDone(1)

      expect(t.events.filter((e) => e.type === 'line').map((e) => (e.type === 'line' ? [e.index, e.text] : null))).toEqual([
        [0, 'Hello'],
        [1, 'world'],
        [2, 'end']
      ])
      const view = await t.run(Chat.use((c) => c.view(session.id)))
      expect(view.session.title).toBe('Say hello')
      expect(view.path[1]!.message).toMatchObject({
        content: 'Hello\nworld\nend',
        status: 'complete',
        lineCount: 3,
        model: 'claude-sonnet-5-5',
        usage: { promptTokens: 130, completionTokens: 5, totalTokens: 135, cachedTokens: 100, cacheWriteTokens: 20, reasoningTokens: 2, cost: 0.002, requests: 1 }
      })

      const call = t.calls[0]!
      expect(call.prompt).toEqual([{ type: 'text', text: 'Say hello' }])
      expect(call.options).toMatchObject({
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        tools: [],
        mcpServers: {},
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        title: 'Tomo',
        cwd: t.dir
      })
      expect(call.options.resume).toBeUndefined()
      expect(call.options.sessionId).toMatch(/^[0-9a-f-]{36}$/)
      const system = systemOf(call)
      expect(system).toStartWith('You are a helpful, concise assistant.')
      expect(system).toContain(WRITING_GUIDELINES)
      expect(system).toContain(HISTORY_NOTE)
      expect(system).not.toContain(BROWSER_INSTRUCTIONS)
      // A Claude sign-in: no key from the shell reaches Claude Code, and its sessions stay in the app's folder.
      expect(call.options.env).toMatchObject({
        CLAUDE_CONFIG_DIR: join(t.dir, 'claude'),
        ENABLE_TOOL_SEARCH: 'true',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'tomo/test'
      })
      expect(call.options.env!.ANTHROPIC_API_KEY).toBeUndefined()
      expect(typeof call.options.env!.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('string')

      expect(await t.run(Chat.use((c) => c.linesSince(view.path[1]!.message.id, 1)))).toEqual({ lines: ['world', 'end'], status: 'complete' })
      await t.runtime.dispose()
    } finally {
      if (leaked === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = leaked
    }
  })

  test('a new text block after earlier text starts a new paragraph', async () => {
    const t = setup(async function* (t) {
      yield* t.text('Let me check.')
      yield* t.text('Found it.')
      yield t.result()
    })
    const s = await t.run(newSession)
    const view = await t.run(sendTo(s, s.rootId, 'Look'))
    await t.waitForDone(1)
    expect((await t.run(Db.use((db) => db.use((d) => d.getMessage(view.path[1]!.message.id)))))!.content).toBe('Let me check.\n\nFound it.')
    await t.runtime.dispose()
  })

  test('with an API key chosen, Claude Code gets the key; without one, the reply says where to add it', async () => {
    const t = setup(reply, { titleModel: '', memoryModel: '', auth: 'apiKey' })
    const before = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const s = await t.run(newSession)
      await t.run(sendTo(s, s.rootId, 'Hi'))
      await t.waitForDone(1)
      const failed = (await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
      expect(failed).toMatchObject({ status: 'error', error: 'Add your Anthropic API key in Settings (or set ANTHROPIC_API_KEY).' })
      expect(t.calls).toHaveLength(0)

      await t.run(SettingsStore.use((st) => st.update({ anthropicKey: 'sk-ant-123' })))
      await t.run(Chat.use((c) => c.regenerate({ sessionId: s.id, assistantId: failed.id })))
      await t.waitForDone(2)
      expect(t.calls[0]!.options.env!.ANTHROPIC_API_KEY).toBe('sk-ant-123')
      await t.runtime.dispose()
    } finally {
      if (before !== undefined) process.env.ANTHROPIC_API_KEY = before
    }
  })

  test('errors Claude Code reports show in the chat in plain words', async () => {
    const kinds = [
      ['authentication_failed', 'Not logged in · Please run /login'],
      ['rate_limit', "You've hit your limit · resets 5pm"],
      ['billing_error', 'Credit balance is too low'],
      // The SDK can also throw, with no assistant message saying what kind of error it was.
      ['thrown', 'Claude Code returned an error result: Invalid API key · Fix external API key']
    ]
    let n = 0
    const t = setup(async function* (t) {
      const [kind, text] = kinds[n++]!
      yield* t.text('Partial ')
      if (kind === 'thrown') throw new Error(text)
      yield* t.apiError(kind!, text!)
    })
    const s = await t.run(newSession)
    const first = await t.run(sendTo(s, s.rootId, 'Hi'))
    for (let i = 1; i < kinds.length; i++) {
      await t.waitForDone(i)
      await t.run(Chat.use((c) => c.regenerate({ sessionId: s.id, assistantId: first.path[1]!.message.id })))
    }
    await t.waitForDone(kinds.length)
    const errors = t.events.flatMap((e) => (e.type === 'done' ? [e.error] : []))
    expect(errors).toEqual([
      "Claude Code isn't signed in. Run `claude` in a terminal and sign in with /login, or use an Anthropic API key in Settings. (Not logged in · Please run /login)",
      "You've reached a usage or rate limit. (You've hit your limit · resets 5pm)",
      'Your Anthropic account has a billing problem or no credit left. (Credit balance is too low)',
      "Claude Code isn't signed in. Run `claude` in a terminal and sign in with /login, or use an Anthropic API key in Settings. (Invalid API key · Fix external API key)"
    ])
    // What streamed before the error is kept.
    expect((await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message).toMatchObject({ status: 'error', content: 'Partial ' })
    await t.runtime.dispose()
  })

  test('a reply has no step limit: 55 different calls run to the end, judged at checkpoints', async () => {
    const t = setup(async function* (t) {
      // The checkpoint judge (a hidden small-model call): clearly progressing.
      if (isAsk(t.call)) {
        yield* t.text('{"done": "Read 30 pages", "left": "30 more", "closer": "closer", "verdict": "progressing", "confidence": 0.95}')
        return void (yield t.result())
      }
      for (let i = 0; i < 55; i++) {
        yield* t.tool('mcp__nothing__look', { page: i })
        // Let the judge's call run in between, as a real model call would.
        await new Promise((r) => setTimeout(r, 1))
      }
      yield* t.text('Done after 55 calls.')
      yield t.result({ turns: 56 })
    })
    const s = await t.run(newSession)
    await t.run(sendTo(s, s.rootId, 'Do a lot'))
    await t.waitForDone(1)
    expect(t.replies()[0]!.options.maxTurns).toBeUndefined()
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message).toMatchObject({ status: 'complete', content: 'Done after 55 calls.' })
    // Checkpoints at 30, then 15 later while clearly progressing: 45 (the next, 60, is past the end).
    const notes = await t.run(Db.use((db) => db.use((d) => d.progressNotes(s.id, 10))))
    expect(notes.map((n) => [n.step, n.verdict, n.done])).toEqual([
      [30, 'progressing', 'Read 30 pages'],
      [45, 'progressing', 'Read 30 pages']
    ])
    const judged = t.calls.filter(isAsk)
    expect(judged).toHaveLength(2)
    expect(systemOf(judged[0]!)).toContain('You check on an AI assistant')
    expect(promptText(judged[0]!)).toContain('<task>\nDo a lot\n</task>')
    expect(promptText(judged[1]!)).toContain('- At step 30: done: Read 30 pages')
    await t.runtime.dispose()
  })

  test('images and PDFs go as content blocks, text files inline, before the message', async () => {
    const t = setup(reply)
    const s = await t.run(newSession)
    const add = (name: string, mime: string, data: Uint8Array) => t.run(Attachments.use((a) => a.add({ name, mime, data: data.buffer as ArrayBuffer })))
    const image = await add('shot.png', 'image/png', new Uint8Array([137, 80, 78, 71]))
    const pdf = await add('paper.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4'))
    const notes = await add('notes.md', 'text/markdown', new TextEncoder().encode('# Notes'))
    await t.run(sendTo(s, s.rootId, 'What are these?', [image.id, pdf.id, notes.id]))
    await t.waitForDone(1)
    const prompt = t.calls[0]!.prompt
    expect(prompt.map((b) => b.type)).toEqual(['image', 'document', 'text', 'text'])
    expect(prompt[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } } as never)
    expect(prompt[1]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' }, title: 'paper.pdf' })
    expect(prompt[2]!.text).toBe('<file name="notes.md">\n# Notes\n</file>')
    expect(prompt[3]!.text).toBe('What are these?')
    await t.runtime.dispose()
  })
})

describe('history', () => {
  /** Each reply adds a cent to its session's running total, as Claude Code's does. */
  const ledger = () => {
    const totals = new Map<string, number>()
    let n = 0
    const script: Script = async function* (t) {
      const from = t.call.options.resume ?? t.call.session
      const total = (totals.get(from) ?? 0) + 0.01
      totals.set(t.call.session, total)
      yield* t.text(`reply ${++n}`)
      yield t.result({ cost: total })
    }
    return script
  }

  test('a turn resumes the session of the reply it answers; a branch forks it at that reply', async () => {
    const t = setup(ledger())
    const point = (id: string) => t.run(Db.use((db) => db.use((d) => d.agentPoint(id))))
    const s = await t.run(newSession)
    const one = await t.run(sendTo(s, s.rootId, 'First'))
    await t.waitForDone(1)
    const r1 = one.path[1]!.message.id
    const p1 = (await point(r1))!
    expect(p1.session).toBe(t.calls[0]!.session)
    expect(p1.uuid).toBeString()

    // Answering the newest reply: resumed in place, and the prompt is the new message alone.
    const two = await t.run(sendTo(s, r1, 'Second'))
    await t.waitForDone(2)
    const r2 = two.path[3]!.message.id
    expect(t.calls[1]!.options).toMatchObject({ resume: p1.session, resumeSessionAt: p1.uuid })
    expect(t.calls[1]!.options.forkSession).toBeUndefined()
    expect(t.calls[1]!.prompt).toEqual([{ type: 'text', text: 'Second' }])
    expect((await point(r2))!.session).toBe(p1.session)
    // The session's running total was 0.01 before: this reply cost the difference.
    expect((await t.run(Chat.use((c) => c.view(s.id)))).path[3]!.message.usage!.cost).toBeCloseTo(0.01, 10)

    // Regenerating the second reply branches at the first: a fork, with a session id of its own.
    await t.run(Chat.use((c) => c.regenerate({ sessionId: s.id, assistantId: r2 })))
    await t.waitForDone(3)
    const fork = t.calls[2]!
    expect(fork.options).toMatchObject({ resume: p1.session, resumeSessionAt: p1.uuid, forkSession: true })
    expect(fork.session).not.toBe(p1.session)
    expect(fork.prompt).toEqual([{ type: 'text', text: 'Second' }])

    // Editing the second message branches there too.
    await t.run(Chat.use((c) => c.edit({ sessionId: s.id, messageId: two.path[2]!.message.id, text: 'Second, edited', attachmentIds: [] })))
    await t.waitForDone(4)
    expect(t.calls[3]!.options).toMatchObject({ resume: p1.session, resumeSessionAt: p1.uuid, forkSession: true })
    expect(t.calls[3]!.prompt).toEqual([{ type: 'text', text: 'Second, edited' }])

    // Going on from the edited branch resumes its own session in place.
    const edited = await t.run(Chat.use((c) => c.view(s.id)))
    const r4 = edited.path[3]!.message.id
    const p4 = (await point(r4))!
    expect(p4.session).toBe(t.calls[3]!.session)
    await t.run(sendTo(s, r4, 'Third'))
    await t.waitForDone(5)
    expect(t.calls[4]!.options).toMatchObject({ resume: p4.session, resumeSessionAt: p4.uuid })
    expect(t.calls[4]!.options.forkSession).toBeUndefined()

    // Switching back shows the first branch as it was.
    const back = await t.run(Chat.use((c) => c.switchBranch({ sessionId: s.id, messageId: r2 })))
    expect(back.path.map((n) => n.message.content)).toEqual(['First', 'reply 1', 'Second', 'reply 2'])
    expect(back.path[3]!.siblingIds).toHaveLength(2)
    await t.runtime.dispose()
  })

  test('with no session to resume (a chat from before Claude, a missing file), the earlier turns go as a transcript', async () => {
    const t = setup(ledger())
    const s = await t.run(newSession)
    // A chat from the OpenRouter days: its replies never ran in Claude Code.
    const old = await t.run(
      Db.use((db) =>
        db.use((d) => {
          d.updateSession(s.id, { model: 'deepseek/deepseek-v4.1-flash' })
          const u = d.insertMessage({ sessionId: s.id, parentId: s.rootId, role: 'user', content: 'Find a camera guide', status: 'complete' })
          const a = d.insertMessage({ sessionId: s.id, parentId: u.id, role: 'assistant', content: `${stepLine({ tool: 'browser_search', label: 'Searched “camera”', ok: true })}\nHere is one.`, status: 'complete', model: 'deepseek/deepseek-v4.1-flash' })
          return a
        })
      )
    )
    const view = await t.run(sendTo(s, old.id, 'Thanks'))
    await t.waitForDone(1)
    expect(t.calls[0]!.options.resume).toBeUndefined()
    expect(t.calls[0]!.options.model).toBe('claude-sonnet-5-5')
    expect(promptText(t.calls[0]!)).toBe('<user>\nFind a camera guide\n</user>\n---\n<assistant>\n[Used the browser: Searched “camera”]\nHere is one.\n</assistant>\n---\nThanks')

    // The next turn resumes the session that one started.
    const r = view.path[3]!.message.id
    await t.run(sendTo(s, r, 'And another'))
    await t.waitForDone(2)
    expect(t.calls[1]!.options.resume).toBe(t.calls[0]!.session)
    expect(t.calls[1]!.prompt).toEqual([{ type: 'text', text: 'And another' }])

    // Its file gone (the data folder was cleared), the next turn starts over with the transcript.
    rmSync(join(t.dir, 'claude'), { recursive: true, force: true })
    const latest = await t.run(Chat.use((c) => c.view(s.id)))
    await t.run(sendTo(s, latest.path.at(-1)!.message.id, 'Last one'))
    await t.waitForDone(3)
    expect(t.calls[2]!.options.resume).toBeUndefined()
    expect(promptText(t.calls[2]!)).toContain('<user>\nAnd another\n</user>')
    expect(promptText(t.calls[2]!).endsWith('Last one')).toBe(true)
    await t.runtime.dispose()
  })

  test('deleting a chat deletes the Claude Code sessions only it used', async () => {
    const t = setup(ledger())
    const s = await t.run(newSession)
    await t.run(sendTo(s, s.rootId, 'Hi'))
    await t.waitForDone(1)
    const session = t.calls[0]!.session
    expect(await t.run(Agent.use((a) => Effect.sync(() => a.hasSession(session))))).toBe(true)
    const orphans = await t.run(Db.use((db) => db.use((d) => d.deleteSession(s.id))))
    expect(orphans.agentSessions).toEqual([session])
    await t.run(Agent.use((a) => Effect.sync(() => a.forget(orphans.agentSessions))))
    expect(await t.run(Agent.use((a) => Effect.sync(() => a.hasSession(session))))).toBe(false)
    await t.runtime.dispose()
  })
})

describe('stop, interrupt, continue', () => {
  test('stop aborts the query and keeps the partial reply including the unfinished line', async () => {
    let aborted = false
    const t = setup(async function* (t) {
      yield* t.text('First line\nhalf a li')
      try {
        await t.wait(new Promise(() => {}))
      } catch (e) {
        aborted = true
        throw e
      }
    })
    const s = await t.run(newSession)
    const view = await t.run(sendTo(s, s.rootId, 'Go'))
    const id = view.path[1]!.message.id
    await settle(() => t.events.some((e) => e.type === 'line'))
    await t.run(Chat.use((c) => c.stop(id)))
    await t.waitForDone(1)
    await settle(() => aborted)
    expect(aborted).toBe(true)
    expect((await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message).toMatchObject({ status: 'stopped', content: 'First line\nhalf a li' })
    await t.runtime.dispose()
  })

  test('quitting mid-reply leaves it interrupted; Continue resumes its own session and completes the line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-'))
    const hang: Script = async function* (t) {
      yield* t.text('First line\nSecond ha')
      await t.wait(new Promise(() => {}))
    }
    const first = setup(hang, undefined, dir)
    const s = await first.run(newSession)
    const view = await first.run(sendTo(s, s.rootId, 'Write two lines'))
    const id = view.path[1]!.message.id
    await settle(() => first.events.some((e) => e.type === 'line'))
    await first.runtime.dispose()

    const second = setup(async function* (t) {
      yield* t.text('lf, done.\n')
      yield t.result()
    }, undefined, dir)
    const before = (await second.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(before).toMatchObject({ status: 'interrupted', content: 'First line\nSecond ha' })
    const point = (await second.run(Db.use((db) => db.use((d) => d.agentPoint(id)))))!
    await second.run(Chat.use((c) => c.continue({ sessionId: s.id, assistantId: id })))
    await second.waitForDone(1)
    const call = second.calls[0]!
    expect(call.options).toMatchObject({ resume: point.session, resumeSessionAt: point.uuid })
    expect(call.options.forkSession).toBeUndefined()
    expect(promptText(call)).toContain('<cut_off>\nFirst line\nSecond ha\n</cut_off>')
    const after = (await second.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(after).toMatchObject({ status: 'complete', content: 'First line\nSecond half, done.' })
    await second.runtime.dispose()
  })

  test('a reply cut off before its first checkpoint is continued with the partial reply in the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-'))
    const first = setup(async function* (t) {
      // Text streams, but the assistant message that would hold it never arrives.
      yield* t.text('Half a').slice(0, 2)
      await t.wait(new Promise(() => {}))
    }, undefined, dir)
    const s = await first.run(newSession)
    const view = await first.run(sendTo(s, s.rootId, 'Tell me'))
    const id = view.path[1]!.message.id
    await settle(() => first.events.length > 0)
    await new Promise((r) => setTimeout(r, 20))
    await first.runtime.dispose()

    const second = setup(async function* (t) {
      yield* t.text(' story.')
      yield t.result()
    }, undefined, dir)
    await second.run(Chat.use((c) => c.continue({ sessionId: s.id, assistantId: id })))
    await second.waitForDone(1)
    expect(second.calls[0]!.options.resume).toBeUndefined()
    expect(promptText(second.calls[0]!)).toBe(
      "<user>\nTell me\n</user>\n---\n<assistant>\nHalf a\n</assistant>\n---\nYour reply above was cut off. Continue it from exactly where it stopped: don't repeat anything you already wrote, don't start over, and don't say that you are continuing."
    )
    expect((await second.run(Chat.use((c) => c.view(s.id)))).path[1]!.message.content).toBe('Half a story.')
    await second.runtime.dispose()
  })
})

describe('titles', () => {
  test('the title model names a new chat once, from its first message, with a one-off ask', async () => {
    const t = setup(
      async function* (t) {
        if (isAsk(t.call)) yield* t.text('**"Greeting the', ' assistant."**\n')
        else yield* t.text('Hello!')
        yield t.result()
      },
      { titleModel: 'claude-haiku-5-5', memoryModel: '' }
    )
    const s = await t.run(newSession)
    await t.run(sendTo(s, s.rootId, 'Say hello'))
    await t.waitForDone(1)
    await settle(() => t.events.some((e) => e.type === 'title'))
    expect(t.events.find((e) => e.type === 'title')).toEqual({ type: 'title', sessionId: s.id, title: 'Greeting the assistant' })
    const ask = t.calls.find(isAsk)!
    expect(ask.options).toMatchObject({ model: 'claude-haiku-5-5', tools: [], maxTurns: 1, persistSession: false, thinking: { type: 'disabled' }, effort: 'low' })
    expect(ask.options.mcpServers).toBeUndefined()
    expect(promptText(ask)).toBe('<message>\nSay hello\n</message>')

    const view = await t.run(Chat.use((c) => c.view(s.id)))
    await t.run(sendTo(s, view.path[1]!.message.id, 'And goodbye'))
    await t.waitForDone(2)
    expect(t.calls.filter(isAsk)).toHaveLength(1)
    await t.runtime.dispose()
  })

  test('renaming a chat before its generated title arrives keeps the new name', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let titled = false
    const t = setup(
      async function* (t) {
        if (isAsk(t.call)) {
          await t.wait(gate)
          yield* t.text('Generated title')
          titled = true
        } else yield* t.text('ok')
        yield t.result()
      },
      { titleModel: 'claude-haiku-5-5', memoryModel: '' }
    )
    const s = await t.run(newSession)
    const sent = await t.run(sendTo(s, s.rootId, 'Plan my week'))
    expect(sent.session.title).toBe('Plan my week')
    await t.waitForDone(1)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { title: 'Mine' }))))
    release()
    await settle(() => titled)
    await new Promise((r) => setTimeout(r, 20))
    expect((await t.run(Chat.use((c) => c.view(s.id)))).session.title).toBe('Mine')
    expect(t.events.some((e) => e.type === 'title')).toBe(false)
    await t.runtime.dispose()
  })

  test('a fork keeps its title, and its first reply starts a session of its own', async () => {
    const t = setup(
      async function* (t) {
        yield* t.text(isAsk(t.call) ? 'Generated title' : 'ok')
        yield t.result()
      },
      { titleModel: 'claude-haiku-5-5', memoryModel: '' }
    )
    const s = await t.run(newSession)
    const first = await t.run(sendTo(s, s.rootId, 'Plan my week'))
    await t.waitForDone(1)
    await settle(() => t.events.some((e) => e.type === 'title'))
    const fork = await t.run(Db.use((db) => db.use((d) => d.forkSession(s.id, first.path[1]!.message.id))))
    expect(fork.title).toBe('Generated title (fork)')
    const forked = await t.run(Chat.use((c) => c.view(fork.id)))
    await t.run(sendTo(fork, forked.path[1]!.message.id, 'Now plan June'))
    await t.waitForDone(2)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.calls.filter(isAsk)).toHaveLength(1)
    // Forks copy no Claude Code session: the copy's history goes as a transcript, once.
    const call = t.replies()[1]!
    expect(call.options.resume).toBeUndefined()
    expect(promptText(call)).toBe('<user>\nPlan my week\n</user>\n---\n<assistant>\nok\n</assistant>\n---\nNow plan June')
    await t.runtime.dispose()
  })
})

describe('memory', () => {
  test('messages about the user are read beside the reply, and later chats start with what was learned', async () => {
    const t = setup(
      async function* (t) {
        if (!isAsk(t.call)) {
          yield* t.text('ok')
          return void (yield t.result())
        }
        const prompt = promptText(t.call)
        yield* t.text(prompt.includes('Lisbon') ? '```json\n{"add": ["Lives in Lisbon"]}\n```' : '{}')
        yield t.result()
      },
      { titleModel: '', memoryModel: 'claude-haiku-5-5' }
    )
    const s = await t.run(newSession)
    await t.run(sendTo(s, s.rootId, 'I live in Lisbon, by the way.'))
    await t.waitForDone(1)
    await settle(() => t.events.some((e) => e.type === 'memory'))
    expect(t.events.find((e) => e.type === 'memory')).toEqual({ type: 'memory', sessionId: s.id, added: ['Lives in Lisbon.'], removed: [] })
    const ask = t.calls.find(isAsk)!
    expect(ask.options.model).toBe('claude-haiku-5-5')
    expect(systemOf(ask)).toContain('You keep a short profile of the user')

    const later = await t.run(newSession)
    await t.run(sendTo(later, later.rootId, 'What should I see this weekend?'))
    await t.waitForDone(2)
    expect(systemOf(t.replies().at(-1)!)).toContain('- Lives in Lisbon.')
    // Replies can search long-term memory, read-only, with recall.
    const reply = t.replies().at(-1)!
    expect(Object.keys(reply.options.mcpServers!)).toEqual(['memory'])
    expect(reply.options.tools).toEqual(['ToolSearch'])
    expect(systemOf(reply)).toContain(RECALL_INSTRUCTIONS)
    await t.runtime.dispose()
  })

  test('failed and unreadable memory checks are reported, not swallowed', async () => {
    let n = 0
    const t = setup(
      async function* (t) {
        if (!isAsk(t.call)) {
          yield* t.text('ok')
          return void (yield t.result())
        }
        if (n++ === 0) return void (yield* t.apiError('rate_limit', 'Slow down'))
        yield* t.text('I could not find anything.')
        yield t.result()
      },
      { titleModel: '', memoryModel: 'claude-haiku-5-5' }
    )
    const s = await t.run(newSession)
    const lastRun = () => t.run(Chat.use((c) => c.lastMemoryRun))
    const one = await t.run(sendTo(s, s.rootId, 'My name is Ana.'))
    await settle(() => t.events.filter((e) => e.type === 'memory').length === 1)
    expect(await lastRun()).toMatchObject({ outcome: 'error', detail: "You've reached a usage or rate limit. (Slow down)" })
    await t.waitForDone(1)
    await t.run(sendTo(s, one.path[1]!.message.id, 'I work at a bakery.'))
    await settle(() => t.events.filter((e) => e.type === 'memory').length === 2)
    expect(await lastRun()).toMatchObject({ outcome: 'unreadable', detail: 'I could not find anything.' })
    await t.waitForDone(2)
    await t.runtime.dispose()
  })

  test("the bot's playbook reaches its prompt when a thread starts, and stays as it was for the rest of it", async () => {
    const t = setup(
      async function* (t) {
        yield* t.text(isAsk(t.call) ? '{}' : 'ok')
        yield t.result()
      },
      { titleModel: '', memoryModel: 'claude-haiku-5-5' }
    )
    const lesson = (body: string) =>
      t.run(
        Db.use((db) =>
          db.use((d) => d.reconcile({ changes: [{ what: 'Added', closes: [], puts: [{ body, scope: 'bot', scopeId: 'tomo', type: 'procedure', jobId: 'j', sessionId: null }] }] }, 'Daily review'))
        )
      )
    await lesson('Never add comments to code.')
    const s = await t.run(newSession)
    const first = await t.run(sendTo(s, s.rootId, 'Write a sort function.'))
    await t.waitForDone(1)
    expect(systemOf(t.replies().at(-1)!)).toContain('Your playbook: lessons from your earlier jobs')
    expect(systemOf(t.replies().at(-1)!)).toContain('- Never add comments to code.')
    const before = systemOf(t.replies().at(-1)!)
    // A lesson learned meanwhile waits for the next thread: the system prompt (and its cache) stays the same.
    await lesson('Use tabs for indentation.')
    await t.run(sendTo(s, first.path.at(-1)!.message.id, 'And a search one.'))
    await t.waitForDone(2)
    expect(systemOf(t.replies().at(-1)!)).toBe(before)
    const next = await t.run(newSession)
    await t.run(sendTo(next, next.rootId, 'Another function.'))
    await t.waitForDone(3)
    expect(systemOf(t.replies().at(-1)!)).toContain('- Use tabs for indentation.')
    await t.runtime.dispose()
  })

  test('with memory off, nothing is read or sent', async () => {
    const t = setup(reply)
    const s = await t.run(newSession)
    await t.run(sendTo(s, s.rootId, 'I live in Lisbon.'))
    await t.waitForDone(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.calls).toHaveLength(1)
    expect(t.events.some((e) => e.type === 'memory')).toBe(false)
    expect(t.calls[0]!.options.mcpServers).toEqual({})
    await t.runtime.dispose()
  })
})

describe('browser', () => {
  const browserChat = async (t: ReturnType<typeof setup>) => {
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateBot(d.botOf(s.id).id, { modules: ['browser'] }))))
    return s
  }

  test('its tools are deferred behind ToolSearch, run through MCP, and leave steps in the reply; other tools are refused', async () => {
    const log: string[] = []
    const permissions: string[] = []
    const results: string[] = []
    const t = setup(
      async function* (t) {
        for (const [name, input] of [
          ['mcp__browser__search', { query: 'camera settings' }],
          ['mcp__browser__navigate', { url: 'shop.test' }],
          ['mcp__browser__click', { ref: 'e1' }],
          ['Bash', { command: 'ls' }]
        ] as const) {
          const out = yield* t.tool(name, input)
          permissions.push(out.permission.behavior)
          results.push(out.result?.content.map((c) => c.text).join('') ?? (out.permission.behavior === 'deny' ? out.permission.message : ''))
        }
        yield* t.text('Bought it.')
        yield t.result({ turns: 5 })
      },
      undefined,
      undefined,
      log
    )
    const s = await browserChat(t)
    await t.run(sendTo(s, s.rootId, 'Buy the camera'))
    await t.waitForDone(1)

    const call = t.calls[0]!
    expect(call.options.tools).toEqual(['ToolSearch'])
    expect(Object.keys(call.options.mcpServers!)).toEqual(['browser'])
    expect(call.options.mcpServers!.browser).toMatchObject({ type: 'sdk', name: 'browser' })
    expect(systemOf(call)).toContain(BROWSER_INSTRUCTIONS)
    expect(call.options.env!.ENABLE_TOOL_SEARCH).toBe('true')

    expect(permissions).toEqual(['allow', 'allow', 'allow', 'deny'])
    expect(results[0]).toContain('Results for "camera settings"')
    expect(results[2]).toContain('[e1] button "Bought!"')
    expect(results[3]).toBe("Bash isn't available in this chat.")
    expect(log).toEqual(['status Searching “camera settings”', 'search camera settings', 'status Opened shop.test', 'navigate shop.test', 'status Clicked “Buy now”', 'click e1', 'release'])

    const message = (await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(message.content).toBe(
      [
        stepLine({ tool: 'browser_search', label: 'Searched “camera settings”', ok: true }),
        stepLine({ tool: 'browser_navigate', label: 'Opened shop.test', ok: true }),
        stepLine({ tool: 'browser_click', label: 'Clicked “Buy now”', ok: true }),
        'Bought it.'
      ].join('\n')
    )
    expect(message.usage!.requests).toBe(5)
    await t.runtime.dispose()
  })

  test('a screenshot comes back as an image, a saved one goes on the reply, and a recording is saved to a file', async () => {
    const log: string[] = []
    const contents: Array<Array<{ type: string; text?: string; data?: string }>> = []
    const t = setup(
      async function* (t) {
        for (const [name, input] of [
          ['mcp__browser__screenshot', {}],
          ['mcp__browser__screenshot', { save: true }],
          ['mcp__browser__record', { action: 'start' }],
          ['mcp__browser__record', { action: 'stop' }]
        ] as const)
          contents.push((yield* t.tool(name, input)).result!.content)
        yield* t.text('Here you go.')
        yield t.result()
      },
      undefined,
      undefined,
      log
    )
    const s = await browserChat(t)
    await t.run(sendTo(s, s.rootId, 'Screenshot and record it'))
    await t.waitForDone(1)
    expect(contents[0]).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' } as never])
    expect(contents[1]![0]!.text).toMatch(/^Saved as screenshot-\d{6}\.png and attached to your reply\.$/)
    expect(contents[3]![0]!.text).toBe('Recording stopped after 7s and saved to C:\\Videos\\Tomo\\recording-1.webm')
    const message = (await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(message.attachments.map((a) => a.mime)).toEqual(['image/png'])
    expect(t.events.some((e) => e.type === 'attachment')).toBe(true)
    expect(message.content).toContain(stepLine({ tool: 'browser_record', label: 'Recorded 7s of the browser', ok: true, detail: 'C:\\Videos\\Tomo\\recording-1.webm' }))
    expect(log).toContain('record stop')
    await t.runtime.dispose()
  })

  test('chats without the browser get no tools at all, not even ToolSearch', async () => {
    const t = setup(reply)
    const s = await t.run(newSession)
    await t.run(sendTo(s, s.rootId, 'Hi'))
    await t.waitForDone(1)
    expect(t.calls[0]!.options.tools).toEqual([])
    expect(t.calls[0]!.options.mcpServers).toEqual({})
    expect(await t.calls[0]!.options.canUseTool!('mcp__browser__search', {}, { signal: new AbortController().signal } as never)).toMatchObject({ behavior: 'deny' })
    await t.runtime.dispose()
  })
})

describe('computer use', () => {
  const computerChat = Effect.gen(function* () {
    const s = yield* newSession
    yield* (yield* Db).use((d) => d.updateBot(d.botOf(s.id).id, { modules: ['computer'] }))
    return s
  })
  const withComputer = (script: Script, over: Partial<Platform> = {}) => {
    const fake = fakePlatform(over)
    const overlay = fakeOverlay()
    const t = setup(script, undefined, undefined, [], { platform: fake.p, overlay: overlay.port })
    const waits = () => t.events.flatMap((e) => (e.type === 'computer' ? [e.waiting] : []))
    return { ...t, fake, overlay, waits, lastWait: () => waits().at(-1) ?? null }
  }
  const resultText = (r: { result: { content: Array<{ text?: string }> } | null }) => (r.result?.content ?? []).map((c) => c.text ?? '').join('')
  const messageOf = async (t: { run: ReturnType<typeof setup>['run'] }, sessionId: string) => (await t.run(Chat.use((c) => c.view(sessionId)))).path[1]!.message

  test("a computer reply: the mode tag, Tomo's effort, its tools behind ToolSearch, and its steps in the message", async () => {
    const t = withComputer(async function* (t) {
      yield* t.tool('mcp__computer__look_at_screen')
      yield* t.tool('mcp__computer__click', { x: 100, y: 50 })
      yield* t.tool('Glob', { pattern: '**/*.pdf' })
      yield* t.text('Done.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    await t.run(sendTo(s, s.rootId, 'Click the thing'))
    await t.waitForDone(1)

    const call = t.calls[0]!
    expect(call.prompt).toEqual([{ type: 'text', text: '[mode: do] Click the thing' }])
    expect(call.options.effort).toBe('low')
    expect(call.options.tools).toEqual(['ToolSearch', 'Read', 'Glob', 'Grep', 'WebSearch', 'Bash'])
    expect(Object.keys(call.options.mcpServers ?? {})).toEqual(['computer'])
    expect(call.options.env?.ENABLE_TOOL_SEARCH).toBe('true')
    expect(systemOf(call)).toContain('# Computer use')
    expect(systemOf(call)).not.toContain(BROWSER_AND_COMPUTER_NOTE)
    // 1024x576 of a 2048x1152 screen: the click lands at twice the pixels.
    expect(t.fake.calls).toContain('click 200,100')
    const message = await messageOf(t, s.id)
    expect(message.status).toBe('complete')
    expect(message.content).toBe(
      [
        stepLine({ tool: 'computer_click', label: 'Click', ok: true, detail: '100, 50' }),
        stepLine({ tool: 'Glob', label: 'Search files', ok: true, detail: '**/*.pdf' }),
        'Done.'
      ].join('\n')
    )
    // Content protection and the Stop shortcut are on for the reply only.
    expect(t.overlay.protect).toEqual([true, false])
    expect(t.overlay.stopKey).toEqual([true, false])
    await t.runtime.dispose()
  })

  test('with the browser on too, the prompt says which to use for what', async () => {
    const t = withComputer(reply)
    const s = await t.run(computerChat)
    await t.run(Db.use((db) => db.use((d) => d.updateBot(d.botOf(s.id).id, { modules: ['browser', 'computer'] }))))
    await t.run(sendTo(s, s.rootId, 'Hi'))
    await t.waitForDone(1)
    expect(Object.keys(t.calls[0]!.options.mcpServers ?? {}).sort()).toEqual(['browser', 'computer'])
    expect(systemOf(t.calls[0]!)).toContain(BROWSER_AND_COMPUTER_NOTE)
    await t.runtime.dispose()
  })

  test('without a platform (Linux) a computer chat replies without computer use', async () => {
    const t = setup(reply)
    const s = await t.run(computerChat)
    await t.run(sendTo(s, s.rootId, 'Hi'))
    await t.waitForDone(1)
    expect(t.calls[0]!.prompt).toEqual([{ type: 'text', text: 'Hi' }])
    expect(t.calls[0]!.options.tools).toEqual([])
    await t.runtime.dispose()
  })

  test('an approval waits in its chat, is answered through the API, and Stop resolves the next one as denied', async () => {
    const results: string[] = []
    const t = withComputer(async function* (t) {
      results.push(resultText(yield* t.tool('mcp__computer__ask_approval', { action: 'Delete 3 files', detail: 'a.txt, b.txt, c.txt' })))
      // A command that changes something asks too, from the permission check.
      const signal = new AbortController().signal
      const answer = await t.call.options.canUseTool!('Bash', { command: 'del report.txt' }, { signal, toolUseID: 'toolu_bash' } as never)
      results.push(answer?.behavior === 'deny' ? answer.message : 'allowed')
      yield* t.text('Deleted.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    const view = await t.run(sendTo(s, s.rootId, 'Clean up and send it'))
    const id = view.path[1]!.message.id
    await settle(() => t.lastWait()?.kind === 'approval')
    const first = t.lastWait()!
    expect(first).toMatchObject({ kind: 'approval', title: 'Delete 3 files', detail: 'a.txt, b.txt, c.txt', sessionId: s.id, messageId: id })
    expect(await t.run(ComputerUse.use((c) => Effect.sync(c.waiting)))).toEqual(first)
    await t.run(ComputerUse.use((c) => c.approve(first.id, true)))
    await settle(() => t.lastWait()?.kind === 'approval' && t.lastWait()!.id !== first.id)

    await t.run(Chat.use((c) => c.stop(id)))
    await t.waitForDone(1)
    await settle(() => results.length === 2)
    expect(results).toEqual(['Approved. Go ahead.', 'The user denied this.'])
    expect(t.waits().at(-2)).toMatchObject({ kind: 'approval', title: 'Run a command on your computer', detail: 'del report.txt' })
    expect(t.lastWait()).toBeNull()
    const message = await messageOf(t, s.id)
    expect(message.status).toBe('stopped')
    expect(message.content).toBe(stepLine({ tool: 'computer_ask_approval', label: 'Approval', ok: true, detail: 'Delete 3 files' }))
    await t.runtime.dispose()
  })

  test("Show me: a step ends with the overlay's Done or a typed message, and acting is refused", async () => {
    const results: string[] = []
    let denied = ''
    const t = withComputer(async function* (t) {
      yield* t.tool('mcp__computer__look_at_screen')
      const click = yield* t.tool('mcp__computer__click', { x: 1, y: 1 })
      denied = click.permission.behavior === 'deny' ? click.permission.message : ''
      results.push(resultText(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Display', step: 1, total: 3, x: 100, y: 100 })))
      results.push(resultText(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Night light', step: 2, total: 3, x: 100, y: 200 })))
      results.push(resultText(yield* t.tool('mcp__computer__teach_step', { instruction: 'Turn it on', step: 3, total: 3, x: 100, y: 300 })))
      yield* t.text('That was it.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    const view = await t.run(sendTo(s, s.rootId, 'Show me how to turn on night light'))
    const id = view.path[1]!.message.id
    const atStep = (n: number) => () => {
      const w = t.lastWait()
      return w?.kind === 'teach' && w.step === n
    }
    await settle(atStep(1))
    expect(t.calls[0]!.prompt).toEqual([{ type: 'text', text: '[mode: teach] Show me how to turn on night light' }])
    expect(t.lastWait()).toMatchObject({ kind: 'teach', instruction: 'Click Display', step: 1, total: 3, sessionId: s.id, messageId: id })
    expect(t.overlay.last().teach?.instruction).toBe('Click Display')
    t.overlay.pressDone()
    await settle(atStep(2))
    // Typed while a step waits: an answer to the step, not a new message.
    await t.run(sendTo(s, id, "There's no Night light in my menu"))
    await settle(atStep(3))
    await t.run(sendTo(s, id, 'done'))
    await t.waitForDone(1)

    expect(denied).toContain('The user wants to learn this')
    expect(results).toEqual([
      'The user did it. Look at the screen before the next step.',
      `The user said: "There's no Night light in my menu"`,
      'The user did it. Look at the screen before the next step.'
    ])
    expect(t.replies()).toHaveLength(1)
    const after = await t.run(Chat.use((c) => c.view(s.id)))
    expect(after.path).toHaveLength(2)
    expect(after.path[1]!.message.content).toBe(
      [
        stepLine({ tool: 'computer_teach_step', label: 'Step 1 of 3', ok: true, detail: 'Click Display' }),
        stepLine({ tool: 'computer_teach_step', label: 'Step 2 of 3', ok: true, detail: "Click Night light · You said “There's no Night light in my menu”" }),
        stepLine({ tool: 'computer_teach_step', label: 'Step 3 of 3', ok: true, detail: 'Turn it on' }),
        'That was it.'
      ].join('\n')
    )
    expect(t.overlay.last().teach).toBeNull()
    await t.runtime.dispose()
  })

  test('each message picks the mode: "show me how" teaches, "just do it" mid-step hands over, a follow-up keeps the mode', async () => {
    let click = ''
    const t = withComputer(async function* (t) {
      if (t.call.prompt.some((b) => b.text?.includes('Show me how'))) {
        yield* t.tool('mcp__computer__look_at_screen')
        yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Display', step: 1, total: 2, x: 100, y: 100 })
        const p = (yield* t.tool('mcp__computer__click', { x: 1, y: 1 })).permission
        click = p.behavior === 'deny' ? p.message : p.behavior
      }
      yield* t.text('Ok.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    const lastId = async () => (await t.run(Chat.use((c) => c.view(s.id)))).path.at(-1)!.message.id
    const tagOf = (n: number) => t.calls[n]!.prompt.at(-1)!.text!.match(/^\[mode: (\w+)\]/)?.[1]
    const modeSaved = async () => (await t.run(Chat.use((c) => c.view(s.id)))).session.computerMode

    await t.run(sendTo(s, s.rootId, 'Show me how to turn on dark mode'))
    await settle(() => t.lastWait()?.kind === 'teach')
    expect(tagOf(0)).toBe('teach')
    await t.run(sendTo(s, await lastId(), 'Just do it for me'))
    await t.waitForDone(1)
    expect(click).toBe('allow')
    expect(await modeSaved()).toBe('do')

    const asks: Array<[string, string]> = [
      ['How do I change the wallpaper?', 'teach'],
      ['ok, next', 'teach'],
      ['Draw me a cat in Excalidraw', 'do'],
      ['What did you draw?', 'do']
    ]
    for (const [i, [text, mode]] of asks.entries()) {
      await t.run(sendTo(s, await lastId(), text))
      await t.waitForDone(i + 2)
      expect([text, tagOf(i + 1)]).toEqual([text, mode])
    }
    await t.runtime.dispose()
  })

  test('the reply shows its mode and the tool under way; switching to do mid-step hands the step over, as "Do it for me" does', async () => {
    const results: string[] = []
    let click = ''
    const t = withComputer(async function* (t) {
      yield* t.tool('mcp__computer__look_at_screen')
      results.push(resultText(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Display', step: 1, total: 2, x: 100, y: 100 })))
      results.push(resultText(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Scale', step: 2, total: 2, x: 100, y: 200 })))
      const p = (yield* t.tool('mcp__computer__click', { x: 1, y: 1 })).permission
      click = p.behavior === 'deny' ? p.message : p.behavior
      yield* t.text('Done.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    const view = await t.run(sendTo(s, s.rootId, 'Show me how to change the scale'))
    const id = view.path[1]!.message.id
    const modes = () => t.events.flatMap((e) => (e.type === 'computerMode' ? [e.mode] : []))
    const doings = () => t.events.flatMap((e) => (e.type === 'computerDoing' && e.messageId === id ? [e.doing?.label ?? null] : []))
    await settle(() => t.lastWait()?.kind === 'teach')
    expect(modes()).toEqual(['teach'])
    // The overlay's "Can't find it" answers the step it shows.
    t.overlay.press('cant_find')
    await settle(() => { const w = t.lastWait(); return w?.kind === 'teach' && w.step === 2 })
    // The chip: switched to do while step 2 waits.
    await t.run(Chat.use((c) => c.setComputerMode({ sessionId: s.id, messageId: id, mode: 'do' })))
    await t.waitForDone(1)
    expect(modes()).toEqual(['teach', 'do'])
    expect(results[0]).toContain("The user pressed \"Can't find it\"")
    expect(results[1]).toContain('the mode is do from now on')
    expect(click).toBe('allow')
    expect((await t.run(Chat.use((c) => c.view(s.id)))).session.computerMode).toBe('do')
    // Live: the look (quiet), each step, the click; each cleared once over.
    expect(doings()).toEqual(['Looking at the screen', null, 'Step 1 of 2', null, 'Step 2 of 2', null, 'Click', null])
    const content = (await messageOf(t, s.id)).content
    expect(content).toContain(stepLine({ tool: 'computer_teach_step', label: 'Step 1 of 2', ok: true, detail: "Click Display · Couldn't find it" }))
    expect(content).toContain(stepLine({ tool: 'computer_teach_step', label: 'Step 2 of 2', ok: true, detail: 'Click Scale · Handed over' }))
    await t.runtime.dispose()
  })

  test('Stop cuts off typing in progress, and the next reply may act again', async () => {
    const t = withComputer(async function* (t) {
      if (t.call.prompt.some((b) => b.text?.includes('again'))) {
        yield* t.tool('mcp__computer__press_keys', { combo: 'ctrl+s' })
        yield* t.text('Saved.')
        yield t.result()
        return
      }
      yield* t.tool('mcp__computer__type_text', { text: 'x'.repeat(400) })
      yield* t.text('Typed.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    const view = await t.run(sendTo(s, s.rootId, 'Type a lot'))
    const id = view.path[1]!.message.id
    await settle(() => t.fake.calls.some((c) => c.startsWith('type ')))
    await t.run(Chat.use((c) => c.stop(id)))
    await t.waitForDone(1)
    await new Promise((r) => setTimeout(r, 300))
    // 400 characters go in 25 chunks of about 64 ms. Stop lands after the first one or two (this
    // fake can't cut off the chunk in flight; the Windows host can).
    expect(t.fake.calls.filter((c) => c.startsWith('type ')).length).toBeLessThan(4)
    expect((await messageOf(t, s.id)).status).toBe('stopped')

    await t.run(sendTo(s, id, 'Save it again'))
    await t.waitForDone(2)
    expect(t.fake.calls).toContain('keys ctrl+s')
    await t.runtime.dispose()
  })

  test('the Stop shortcut stops the computer reply as the chat Stop would', async () => {
    const t = withComputer(async function* (t) {
      yield* t.tool('mcp__computer__ask_approval', { action: 'Buy it', detail: '$20' })
      yield* t.text('Bought.')
      yield t.result()
    })
    const s = await t.run(computerChat)
    await t.run(sendTo(s, s.rootId, 'Buy it'))
    await settle(() => t.lastWait()?.kind === 'approval')
    t.overlay.pressStopKey()
    await t.waitForDone(1)
    expect(t.lastWait()).toBeNull()
    expect((await messageOf(t, s.id)).status).toBe('stopped')
    expect(t.overlay.stopKey).toEqual([true, false])
    await t.runtime.dispose()
  })
})


describe('stuck replies', () => {
  test('a reply looping on the same browser call is paused with why, kept, recorded, and Continue resumes it with the reason', async () => {
    let looped = 0
    const t = setup(async function* (t) {
      const last = t.call.prompt.at(-1)?.text ?? ''
      if (last.includes('cut off')) {
        yield* t.text('Tried another way: done.')
        return void (yield t.result())
      }
      yield* t.text('Looking at the page.')
      for (;;) {
        looped++
        yield* t.tool('mcp__browser__snapshot')
      }
    })
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateBot(d.botOf(s.id).id, { modules: ['browser'] }))))
    const view = await t.run(sendTo(s, s.rootId, 'Find the camera settings'))
    const id = view.path[1]!.message.id
    await t.waitForDone(1)
    expect(looped).toBe(4)
    const paused = (await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(paused).toMatchObject({ status: 'paused', error: 'It made the same snapshot call 4 times in a row and got the same result each time.' })
    expect(paused.content.startsWith('Looking at the page.')).toBe(true)
    expect(t.events.find((e) => e.type === 'done')).toMatchObject({ status: 'paused' })
    const recorded = await t.run(Db.use((db) => db.use((d) => d.stuckPauses())))
    expect(recorded).toMatchObject([{ sessionId: s.id, messageId: id, signal: 'same_result', step: 5, resumedAt: null }])

    const point = (await t.run(Db.use((db) => db.use((d) => d.agentPoint(id)))))!
    await t.run(Chat.use((c) => c.continue({ sessionId: s.id, assistantId: id })))
    await t.waitForDone(2)
    const call = t.replies()[1]!
    expect(call.options).toMatchObject({ resume: point.session, resumeSessionAt: point.uuid })
    expect(promptText(call)).toContain('You were paused because you seemed stuck: It made the same snapshot call 4 times in a row')
    expect(promptText(call).endsWith("don't say that you are continuing.")).toBe(true)
    const done = (await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(done).toMatchObject({ status: 'complete', error: null })
    expect(done.content.endsWith('Tried another way: done.')).toBe(true)
    const [resumed] = await t.run(Db.use((db) => db.use((d) => d.stuckPauses())))
    expect(resumed!.resumedAt).not.toBeNull()
    await t.runtime.dispose()
  })

  test('progress notes and pauses survive a restart in chat.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-'))
    const first = setup(reply, undefined, dir)
    const s = await first.run(newSession)
    await first.run(
      Db.use((db) =>
        db.use((d) => {
          d.addProgressNote({ sessionId: s.id, messageId: 'm', step: 30, done: 'a', left: 'b', closer: 'closer', verdict: 'progressing', confidence: 0.9, createdAt: 1 })
          d.addProgressNote({ sessionId: s.id, messageId: 'm', step: 45, done: 'c', left: 'd', closer: 'same', verdict: 'unclear', confidence: 0.5, createdAt: 2 })
          d.recordPause({ sessionId: s.id, messageId: 'm', signal: 'alternating', reason: 'r', step: 9 }, 3)
        })
      )
    )
    await first.runtime.dispose()
    const second = setup(reply, undefined, dir)
    const [notes, pauses] = await second.run(Db.use((db) => db.use((d) => [d.progressNotes(s.id, 1), d.stuckPauses()] as const)))
    expect(notes.map((n) => n.step)).toEqual([45])
    expect(pauses).toMatchObject([{ signal: 'alternating', step: 9, createdAt: 3, resumedAt: null }])
    await second.runtime.dispose()
  })
})

describe('rules', () => {
  /** A chat whose bot has these modules and rules. */
  const chatWith = (modules: Array<'browser' | 'computer'>, rules: Record<string, string>) =>
    Effect.gen(function* () {
      const s = yield* newSession
      yield* (yield* Db).use((d) => d.updateBot(d.botOf(s.id).id, { modules, rules: rules as never }))
      return s
    })
  const textOf = (r: { permission: { behavior: string; message?: string }; result: { content: Array<{ text?: string }> } | null }) =>
    r.permission.behavior === 'deny' ? `denied: ${r.permission.message}` : (r.result?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 30)
  const waitsOf = (t: ReturnType<typeof setup>) => t.events.flatMap((e) => (e.type === 'computer' ? [e.waiting] : []))

  test('a blocked tool is refused in the reply with why, and never runs; the rest of the module still works', async () => {
    const out: string[] = []
    const log: string[] = []
    const t = setup(
      async function* (t) {
        out.push(textOf(yield* t.tool('mcp__browser__click', { ref: 'e1' })))
        out.push(textOf(yield* t.tool('mcp__browser__navigate', { url: 'http://shop.test/' })))
        yield* t.text('Could not click.')
        yield t.result()
      },
      undefined,
      undefined,
      log
    )
    const s = await t.run(chatWith(['browser'], { 'browser.act': 'block' }))
    await t.run(sendTo(s, s.rootId, 'Buy it'))
    await t.waitForDone(1)
    expect(out[0]).toContain('denied: ')
    expect(out[0]).toContain('block')
    expect(out[0]).toContain('Settings › Bots')
    expect(out[1]).not.toContain('denied')
    expect(log.some((l) => l.startsWith('click'))).toBe(false)
    expect(log).toContain('navigate http://shop.test/')
    expect(waitsOf(t).filter(Boolean)).toEqual([])
    const message = (await t.run(Chat.use((c) => c.view(s.id)))).path[1]!.message
    expect(message.status).toBe('complete')
    await t.runtime.dispose()
  })

  test('an ask tool waits on the approval card in its chat: approved it runs, denied it does not', async () => {
    const out: string[] = []
    const log: string[] = []
    const t = setup(
      async function* (t) {
        out.push(textOf(yield* t.tool('mcp__browser__click', { ref: 'e1' })))
        out.push(textOf(yield* t.tool('mcp__browser__type', { ref: 'e2', text: 'hello' })))
        yield* t.text('Done.')
        yield t.result()
      },
      undefined,
      undefined,
      log
    )
    const s = await t.run(chatWith(['browser'], { 'browser.act': 'ask' }))
    const view = await t.run(sendTo(s, s.rootId, 'Buy it'))
    const id = view.path[1]!.message.id
    await settle(() => waitsOf(t).at(-1)?.kind === 'approval')
    const first = waitsOf(t).at(-1)!
    expect(first).toMatchObject({ kind: 'approval', title: 'Act on a web page', detail: 'e1', sessionId: s.id, messageId: id })
    expect(log.some((l) => l.startsWith('click'))).toBe(false)
    await t.run(ComputerUse.use((c) => c.approve(first.id, true)))
    await settle(() => waitsOf(t).at(-1)?.kind === 'approval' && waitsOf(t).at(-1)!.id !== first.id)
    const second = waitsOf(t).at(-1)!
    expect(second).toMatchObject({ title: 'Act on a web page', detail: 'hello · e2' })
    await t.run(ComputerUse.use((c) => c.approve(second.id, false)))
    await t.waitForDone(1)
    expect(log).toContain('click e1')
    expect(log.some((l) => l.startsWith('type'))).toBe(false)
    expect(out[1]).toBe('denied: The user denied this.')
    await t.runtime.dispose()
  })

  test("computer use follows the bot's rules, and irreversible commands ask even when other commands are allowed", async () => {
    const out: string[] = []
    const fake = fakePlatform()
    const t = setup(
      async function* (t) {
        const signal = new AbortController().signal
        const ask = (name: string, input: Record<string, unknown>) => t.call.options.canUseTool!(name, input, { signal, toolUseID: `toolu_${name}` } as never)
        out.push(((await ask('Bash', { command: 'npm install' })) as { behavior: string }).behavior)
        out.push(((await ask('Write', { file_path: 'C:\notes.txt', content: 'x' })) as { behavior: string }).behavior)
        out.push(((await ask('Bash', { command: 'rm -rf build' })) as { behavior: string }).behavior)
        yield* t.text('Done.')
        yield t.result()
      },
      undefined,
      undefined,
      [],
      { platform: fake.p, overlay: fakeOverlay().port }
    )
    const s = await t.run(chatWith(['computer'], { 'shell.run': 'allow', 'files.write': 'block', 'shell.irreversible': 'allow' }))
    await t.run(sendTo(s, s.rootId, 'Set it up'))
    await settle(() => waitsOf(t).at(-1)?.kind === 'approval')
    expect(out).toEqual(['allow', 'deny'])
    expect(waitsOf(t).at(-1)).toMatchObject({ kind: 'approval', title: 'Run a command on your computer', detail: 'rm -rf build' })
    await t.run(ComputerUse.use((c) => c.approve(waitsOf(t).at(-1)!.id, true)))
    await t.waitForDone(1)
    expect(out).toEqual(['allow', 'deny', 'allow'])
    // The bot's stored rules never say allow for a locked rule.
    const bot = await t.run(Db.use((db) => db.use((d) => d.botOf(s.id))))
    expect(bot.rules).toEqual({ 'shell.run': 'allow', 'files.write': 'block', 'shell.irreversible': 'ask' })
    await t.runtime.dispose()
  })

  test('two chats asking at once each get their turn on the card, rather than denying each other', async () => {
    const out: string[] = []
    const t = setup(async function* (t) {
      out.push(textOf(yield* t.tool('mcp__browser__click', { ref: 'e1' })))
      yield* t.text('Done.')
      yield t.result()
    })
    const a = await t.run(chatWith(['browser'], { 'browser.act': 'ask' }))
    const b = await t.run(newSession)
    await t.run(sendTo(a, a.rootId, 'One'))
    await settle(() => waitsOf(t).at(-1)?.kind === 'approval')
    await t.run(sendTo(b, b.rootId, 'Two'))
    await new Promise((r) => setTimeout(r, 50))
    const first = waitsOf(t).at(-1)!
    expect(first.sessionId).toBe(a.id)
    await t.run(ComputerUse.use((c) => c.approve(first.id, true)))
    await settle(() => waitsOf(t).at(-1)?.kind === 'approval' && waitsOf(t).at(-1)!.sessionId === b.id)
    await t.run(ComputerUse.use((c) => c.approve(waitsOf(t).at(-1)!.id, true)))
    await t.waitForDone(2)
    expect(out.filter((o) => o.startsWith('denied'))).toEqual([])
    await t.runtime.dispose()
  })
})
