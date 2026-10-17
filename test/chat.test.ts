import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { ModelInfo, StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Broadcaster, Chat } from '../src/main/services/Chat'
import { Db } from '../src/main/services/Db'
import { type ChatDelta, type ChatRequest, OpenRouter } from '../src/main/services/OpenRouter'
import { Browser, type BrowserApi, type PageSnapshot } from '../src/main/services/Browser'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { ProviderError } from '../src/main/errors'
import { layoutBoard, parseMoodboard } from '../src/shared/moodboard'

type Script = (req: ChatRequest) => Stream.Stream<string | ChatDelta>

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
      click: (t) => Effect.sync(() => (log.push(`click ${t.ref}`), page({ elements: '[e1] button "Bought!"' }))),
      type: (ref, text) => Effect.sync(() => (log.push(`type ${ref} ${text}`), page())),
      press: (k) => Effect.sync(() => (log.push(`press ${k}`), page())),
      scroll: (dy) => Effect.sync(() => (log.push(`scroll ${dy}`), page())),
      screenshot: () => Effect.succeed({ dataUrl: 'data:image/jpeg;base64,AAAA', png: new Uint8Array(4) }),
      evaluate: () => Effect.succeed('42'),
      elementAt: () => Effect.succeed(null),
      screencast: () => Effect.void,
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

const setup = (
  script: Script,
  dir = mkdtempSync(join(tmpdir(), 'chat-v2-')),
  browserLog: string[] = [],
  models: ModelInfo[] = [],
  // Titling and memory are off unless a test is about them, so every request a script sees is a reply.
  config: Record<string, unknown> = { titleModel: '', memoryModel: '' }
) => {
  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const events: StreamEvent[] = []
  const requests: ChatRequest[] = []
  const waiters: Array<() => void> = []
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const fakeOpenRouter = Layer.succeed(
    OpenRouter,
    OpenRouter.of({
      streamChat: (req) => {
        // Snapshot the request: the agent loop keeps appending to its messages.
        requests.push(structuredClone(req))
        return script(req).pipe(Stream.map((d): ChatDelta => (typeof d === 'string' ? { type: 'text', text: d } : d)))
      },
      listModels: Effect.succeed(models),
      listImageModels: Effect.succeed([]),
      generateImage: () => Effect.succeed({ data: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', cost: 0.008 })
    })
  )
  const providers = Layer.mergeAll(fakeOpenRouter, Attachments.layer).pipe(Layer.provideMerge(base))
  const broadcaster = Broadcaster.of({
    send: (e) => {
      events.push(e)
      if (e.type === 'done') waiters.splice(0).forEach((w) => w())
    }
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Chat.layer.pipe(
        Layer.provide(providers),
        Layer.provide(Layer.succeed(Broadcaster, broadcaster)),
        Layer.provide(fakeBrowser(browserLog))
      ),
      providers
    )
  )
  const run = <A, E>(eff: Effect.Effect<A, E, Chat | Db | SettingsStore>) => runtime.runPromise(eff)
  const doneCount = () => events.filter((e) => e.type === 'done').length
  const waitForDone = async (n: number) => {
    while (doneCount() < n) await new Promise<void>((r) => waiters.push(r))
  }
  return { runtime, run, events, requests, waitForDone, dir }
}

const newSession = Effect.gen(function* () {
  const db = yield* Db
  const s = yield* db.use((d) => d.createSession({ title: 'New chat', model: null, systemPrompt: null, forkedFromSessionId: null }))
  return s
})

describe('chat', () => {
  test('streams line by line, persists the reply and titles the session', async () => {
    const t = setup(() => Stream.fromIterable(['Hel', 'lo\nwor', 'ld\n', 'end']))
    const session = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: session.id, parentId: session.rootId, text: 'Say hello', attachmentIds: [] })))
    await t.waitForDone(1)

    const lines = t.events.filter((e) => e.type === 'line')
    expect(lines.map((e) => [e.index, e.text])).toEqual([
      [0, 'Hello'],
      [1, 'world'],
      [2, 'end']
    ])
    const view = await t.run(Chat.use((c) => c.view(session.id)))
    expect(view.session.title).toBe('Say hello')
    expect(view.path.map((n) => n.message.role)).toEqual(['user', 'assistant'])
    expect(view.path[1]!.message).toMatchObject({ content: 'Hello\nworld\nend', status: 'complete', lineCount: 3 })
    // System prompt and user turn reach the provider.
    expect(t.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user'])

    const since = await t.run(Chat.use((c) => c.linesSince(view.path[1]!.message.id, 1)))
    expect(since).toEqual({ lines: ['world', 'end'], status: 'complete' })
    await t.runtime.dispose()
  })

  test('the title model names a new chat once, from its first message', async () => {
    const t = setup(
      (req) => (req.model === 'tiny/titler' ? Stream.make('**"Greeting the', ' assistant."**\n') : Stream.make('Hello!')),
      undefined,
      [],
      [],
      { titleModel: 'tiny/titler' }
    )
    const s = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'Say hello', attachmentIds: [] })))
    await t.waitForDone(1)
    while (!t.events.some((e) => e.type === 'title')) await new Promise((r) => setTimeout(r, 5))

    expect(t.events.find((e) => e.type === 'title')).toEqual({ type: 'title', sessionId: s.id, title: 'Greeting the assistant' })
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.session.title).toBe('Greeting the assistant')
    const titleRequest = t.requests.find((r) => r.model === 'tiny/titler')!
    expect(titleRequest.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(titleRequest.messages[1]!.content).toBe('<message>\nSay hello\n</message>')
    expect(titleRequest.tools).toBeUndefined()

    // Later turns keep the title.
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: view.path[1]!.message.id, text: 'And goodbye', attachmentIds: [] })))
    await t.waitForDone(2)
    expect(t.requests.filter((r) => r.model === 'tiny/titler')).toHaveLength(1)
    await t.runtime.dispose()
  })

  test('renaming a chat before its generated title arrives keeps the new name', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let titled = false
    const t = setup(
      (req) =>
        req.model === 'tiny/titler'
          ? Stream.fromEffect(Effect.promise(() => gate)).pipe(
              Stream.map(() => 'Generated title'),
              Stream.ensuring(Effect.sync(() => (titled = true)))
            )
          : Stream.make('ok'),
      undefined,
      [],
      [],
      { titleModel: 'tiny/titler' }
    )
    const s = await t.run(newSession)
    const sent = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'Plan my week', attachmentIds: [] })))
    // The start of the message stands in until the title arrives.
    expect(sent.session.title).toBe('Plan my week')
    await t.waitForDone(1)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { title: 'Mine' }))))
    release()
    while (!titled) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 20))

    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.session.title).toBe('Mine')
    expect(t.events.some((e) => e.type === 'title')).toBe(false)
    await t.runtime.dispose()
  })

  test('a fork keeps its title: the title model only names new chats', async () => {
    const t = setup(
      (req) => (req.model === 'tiny/titler' ? Stream.make('Generated title') : Stream.make('ok')),
      undefined,
      [],
      [],
      { titleModel: 'tiny/titler', memoryModel: '' }
    )
    const s = await t.run(newSession)
    const first = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'Plan my week', attachmentIds: [] })))
    await t.waitForDone(1)
    while (!t.events.some((e) => e.type === 'title')) await new Promise((r) => setTimeout(r, 5))

    // Forking from the first message, then sending and editing there, never asks for a title.
    const fork = await t.run(Db.use((db) => db.use((d) => d.forkSession(s.id, first.path[0]!.message.id))))
    expect(fork.title).toBe('Generated title (fork)')
    const forked = await t.run(Chat.use((c) => c.view(fork.id)))
    await t.run(Chat.use((c) => c.send({ sessionId: fork.id, parentId: forked.path[0]!.message.id, text: 'Now plan June', attachmentIds: [] })))
    await t.waitForDone(2)
    await t.run(Chat.use((c) => c.edit({ sessionId: fork.id, messageId: forked.path[0]!.message.id, text: 'Plan my month', attachmentIds: [] })))
    await t.waitForDone(3)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.requests.filter((r) => r.model === 'tiny/titler')).toHaveLength(1)
    expect((await t.run(Chat.use((c) => c.view(fork.id)))).session.title).toBe('Generated title (fork)')
    await t.runtime.dispose()
  })

  test('memory: messages about the user are read beside the reply, and later chats start with what was learned', async () => {
    const t = setup(
      (req) => {
        if (req.model !== 'tiny/memory') return Stream.make('ok')
        const prompt = req.messages[1]!.content as string
        if (prompt.includes('Porto')) return Stream.make('{"update": [{"id": 1, "fact": "Lives in Porto."}]}')
        if (prompt.includes('Lisbon')) return Stream.make('```json\n{"add": ["Lives in Lisbon"]}\n```')
        return Stream.make('{}')
      },
      undefined,
      [],
      [],
      { titleModel: '', memoryModel: 'tiny/memory' }
    )
    const waitForMemory = async (n: number) => {
      while (t.events.filter((e) => e.type === 'memory' && e.added.length + e.removed.length > 0).length < n) await new Promise((r) => setTimeout(r, 5))
    }
    const a = await t.run(newSession)
    let view = await t.run(Chat.use((c) => c.send({ sessionId: a.id, parentId: a.rootId, text: 'I just moved to Lisbon!', attachmentIds: [] })))
    await t.waitForDone(1)
    await waitForMemory(1)
    expect(t.events.find((e) => e.type === 'memory')).toEqual({ type: 'memory', sessionId: a.id, added: ['Lives in Lisbon.'], removed: [] })
    const memoryRequest = t.requests.find((r) => r.model === 'tiny/memory')!
    expect(memoryRequest.messages[1]!.content).toBe('Profile so far:\n(empty)\n\n<message>\nI just moved to Lisbon!\n</message>')

    // Questions that aren't about the user never reach the memory model.
    view = await t.run(Chat.use((c) => c.send({ sessionId: a.id, parentId: view.path[1]!.message.id, text: 'What is 2 + 2?', attachmentIds: [] })))
    await t.waitForDone(2)
    expect(t.requests.filter((r) => r.model === 'tiny/memory')).toHaveLength(1)
    expect(await t.run(Chat.use((c) => c.lastMemoryRun))).toMatchObject({ message: 'What is 2 + 2?', model: null, outcome: 'skipped' })
    // The first chat started before anything was known, and keeps the profile it started with.
    expect(t.requests.filter((r) => r.model !== 'tiny/memory').at(-1)!.messages[0]!.content).not.toContain('Lisbon')

    const b = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: b.id, parentId: b.rootId, text: 'Actually I live in Porto now', attachmentIds: [] })))
    await t.waitForDone(3)
    await waitForMemory(2)
    const replyToB = t.requests.filter((r) => r.model !== 'tiny/memory').at(-1)!
    expect(replyToB.messages[0]!.content).toContain('- Lives in Lisbon.')
    expect(t.requests.filter((r) => r.model === 'tiny/memory').at(-1)!.messages[1]!.content).toContain('1. Lives in Lisbon.')
    const facts = await t.run(Db.use((db) => db.use((d) => d.liveFacts())))
    expect(facts.map((f) => f.fact)).toEqual(['Lives in Porto.'])
    await t.runtime.dispose()
  })

  test('memory asks for no thinking, and retries with room to think if the model insists', async () => {
    const t = setup(
      (req) => {
        if (req.model !== 'thinker/memory') return Stream.make('ok')
        if (req.reasoning) return Stream.fail(new ProviderError({ provider: 'test', status: 400, message: 'Reasoning is mandatory for this endpoint' })) as unknown as Stream.Stream<string>
        return Stream.make('{"add": ["Has a cat named Miso."]}')
      },
      undefined,
      [],
      [],
      { titleModel: '', memoryModel: 'thinker/memory' }
    )
    const s = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'My cat Miso says hi', attachmentIds: [] })))
    await t.waitForDone(1)
    while (!t.events.some((e) => e.type === 'memory')) await new Promise((r) => setTimeout(r, 5))
    const asks = t.requests.filter((r) => r.model === 'thinker/memory')
    expect(asks.map((r) => [r.reasoning, r.max_tokens])).toEqual([
      [{ effort: 'none' }, 400],
      [undefined, 4000]
    ])
    expect((await t.run(Db.use((db) => db.use((d) => d.liveFacts())))).map((f) => f.fact)).toEqual(['Has a cat named Miso.'])
    await t.runtime.dispose()
  })

  test('failed and unreadable memory checks are reported, not swallowed', async () => {
    let reply: Stream.Stream<string> = Stream.make('Sorry, I cannot help with that.')
    const t = setup((req) => (req.model === 'tiny/memory' ? reply : Stream.make('ok')), undefined, [], [], { titleModel: '', memoryModel: 'tiny/memory' })
    const lastRun = () => t.run(Chat.use((c) => c.lastMemoryRun))
    const s = await t.run(newSession)
    const first = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'I live in Oslo', attachmentIds: [] })))
    await t.waitForDone(1)
    while ((await lastRun())?.outcome !== 'unreadable') await new Promise((r) => setTimeout(r, 5))
    expect((await lastRun())!.detail).toBe('Sorry, I cannot help with that.')

    reply = Stream.fail(new ProviderError({ provider: 'test', status: 402, message: 'Insufficient credits' })) as unknown as Stream.Stream<string>
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: first.path[1]!.message.id, text: 'I also speak Norwegian', attachmentIds: [] })))
    await t.waitForDone(2)
    while ((await lastRun())?.outcome !== 'error') await new Promise((r) => setTimeout(r, 5))
    expect(await lastRun()).toMatchObject({ message: 'I also speak Norwegian', model: 'tiny/memory', detail: 'Insufficient credits' })
    await t.runtime.dispose()
  })

  test('with memory off, nothing is read or sent', async () => {
    const t = setup(() => Stream.make('ok'))
    await t.run(Db.use((db) => db.use((d) => d.changeMemory({ add: ['Likes tea.'], update: [], remove: [] }, { kind: 'edited' }))))
    const s = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'I love green tea', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]!.messages[0]!.content).not.toContain('Likes tea')
    await t.runtime.dispose()
  })

  test('regenerate and edit create branches; switching restores the old one', async () => {
    let n = 0
    const t = setup(() => Stream.make(`reply ${++n}`))
    const s = await t.run(newSession)
    let view = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'q1', attachmentIds: [] })))
    await t.waitForDone(1)
    const firstAssistant = view.path[1]!.message.id

    view = await t.run(Chat.use((c) => c.regenerate({ sessionId: s.id, assistantId: firstAssistant })))
    await t.waitForDone(2)
    view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.siblingIds.length).toBe(2)
    expect(view.path[1]!.siblingIndex).toBe(1)
    expect(view.path[1]!.message.content).toBe('reply 2')

    view = await t.run(Chat.use((c) => c.switchBranch({ sessionId: s.id, messageId: firstAssistant })))
    expect(view.path[1]!.message.content).toBe('reply 1')

    view = await t.run(Chat.use((c) => c.edit({ sessionId: s.id, messageId: view.path[0]!.message.id, text: 'q1 edited', attachmentIds: [] })))
    await t.waitForDone(3)
    view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[0]!.siblingIds.length).toBe(2)
    expect(view.path.map((p) => p.message.content)).toEqual(['q1 edited', 'reply 3'])

    // Switching back to the original user turn brings back the branch it had active.
    view = await t.run(Chat.use((c) => c.switchBranch({ sessionId: s.id, messageId: view.path[0]!.siblingIds[0]! })))
    expect(view.path.map((p) => p.message.content)).toEqual(['q1', 'reply 1'])

    // Fork copies the path up to a message into an independent session.
    const forked = await t.run(
      Effect.gen(function* () {
        const db = yield* Db
        const f = yield* db.use((d) => d.forkSession(s.id, firstAssistant))
        return yield* (yield* Chat).view(f.id)
      })
    )
    expect(forked.session.forkedFromSessionId).toBe(s.id)
    expect(forked.path.map((p) => p.message.content)).toEqual(['q1', 'reply 1'])
    expect(forked.path[0]!.message.id).not.toBe(view.path[0]!.message.id)
    await t.runtime.dispose()
  })

  test('stop keeps the partial reply including the unfinished line', async () => {
    const t = setup(() => Stream.concat(Stream.make('first line\nsecond hal'), Stream.never))
    const s = await t.run(newSession)
    const view = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'go', attachmentIds: [] })))
    const id = view.path[1]!.message.id
    while (!t.events.some((e) => e.type === 'line')) await new Promise((r) => setTimeout(r, 5))
    await t.run(Chat.use((c) => c.stop(id)))
    await t.waitForDone(1)
    const after = await t.run(Chat.use((c) => c.view(s.id)))
    expect(after.path[1]!.message).toMatchObject({ status: 'stopped', content: 'first line\nsecond hal', lineCount: 2 })
    await t.runtime.dispose()
  })

  test('quitting mid-stream leaves an interrupted reply that can be continued', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-'))
    const t1 = setup(() => Stream.concat(Stream.make('partial\n'), Stream.never), dir)
    const s = await t1.run(newSession)
    const view = await t1.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'go', attachmentIds: [] })))
    const id = view.path[1]!.message.id
    while (!t1.events.some((e) => e.type === 'line')) await new Promise((r) => setTimeout(r, 5))
    await t1.runtime.dispose()

    const t2 = setup(() => Stream.make('\nrest of it'), dir)
    dirs.splice(dirs.indexOf(dir), 1)
    const before = await t2.run(Chat.use((c) => c.view(s.id)))
    expect(before.path[1]!.message).toMatchObject({ status: 'interrupted', content: 'partial' })
    await t2.run(Chat.use((c) => c.continue({ sessionId: s.id, assistantId: id })))
    await t2.waitForDone(1)
    const after = await t2.run(Chat.use((c) => c.view(s.id)))
    expect(after.path[1]!.message).toMatchObject({ status: 'complete', content: 'partial\nrest of it' })
    // The partial reply is sent back as an assistant prefill.
    expect(t2.requests[0]!.messages.at(-1)).toEqual({ role: 'assistant', content: 'partial' })
    await t2.runtime.dispose()
  })

  test('continuing a reply that stopped mid-line completes that line instead of starting a new one', async () => {
    let call = 0
    const t = setup(() =>
      ++call === 1 ? Stream.concat(Stream.make('done line\n<artifact title="C'), Stream.never) : Stream.make('ounter">\nnext')
    )
    const s = await t.run(newSession)
    const view = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'go', attachmentIds: [] })))
    const id = view.path[1]!.message.id
    while (!t.events.some((e) => e.type === 'line')) await new Promise((r) => setTimeout(r, 5))
    await t.run(Chat.use((c) => c.stop(id)))
    await t.waitForDone(1)

    await t.run(Chat.use((c) => c.continue({ sessionId: s.id, assistantId: id })))
    await t.waitForDone(2)
    const after = await t.run(Chat.use((c) => c.view(s.id)))
    expect(after.path[1]!.message).toMatchObject({ status: 'complete', content: 'done line\n<artifact title="Counter">\nnext', lineCount: 3 })
    // The prefill still carries everything received so far, partial line included.
    expect(t.requests[1]!.messages.at(-1)).toEqual({ role: 'assistant', content: 'done line\n<artifact title="C' })
    const reEmitted = t.events.filter((e) => e.type === 'line' && e.index === 1).map((e) => (e as { text: string }).text)
    expect(reEmitted).toEqual(['<artifact title="C', '<artifact title="Counter">'])
    await t.runtime.dispose()
  })

  test('browser agent: tool calls run, steps persist, results go back to the model', async () => {
    const log: string[] = []
    const tool = (id: string, name: string, args: string): ChatDelta => ({ type: 'tool', index: 0, id, name, args })
    const t = setup(
      (req) => {
        const toolTurns = req.messages.filter((m) => m.role === 'tool').length
        if (toolTurns === 0) return Stream.make<Array<string | ChatDelta>>('Opening the shop.\nChecking', tool('c1', 'browser_navigate', '{"url":"shop.test"}'))
        if (toolTurns === 1) return Stream.make(tool('c2', 'browser_click', '{"ref":"e1"}'))
        return Stream.make('I bought it.')
      },
      undefined,
      log
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { browserEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'buy it', attachmentIds: [] })))
    await t.waitForDone(1)

    expect(log).toEqual(['status Opened shop.test', 'navigate shop.test', 'status Clicked “Buy now”', 'click e1', 'release'])
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.content.split('\n')).toEqual([
      'Opening the shop.',
      'Checking',
      '::step {"tool":"browser_navigate","label":"Opened shop.test","ok":true}',
      '::step {"tool":"browser_click","label":"Clicked “Buy now”","ok":true}',
      'I bought it.'
    ])
    // Tools are offered, and the follow-up request carries the call and its result.
    expect(t.requests[0]!.tools?.map((x) => x.function.name)).toContain('browser_click')
    expect(t.requests[1]!.messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'browser_navigate' } }] })
    expect(t.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(String((t.requests[1]!.messages.at(-1) as { content: string }).content)).toContain('[e1] button "Buy now"')
    // Chats without the switch get no tools.
    await t.runtime.dispose()
  })

  test('usage is summed over every request in a reply and persisted', async () => {
    const usage: ChatDelta = { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 40, reasoningTokens: 5, cost: 0.001 } }
    const t = setup((req) => {
      const turns = req.messages.filter((m) => m.role === 'tool').length
      if (turns < 2) return Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: `c${turns}`, name: 'browser_snapshot', args: '{}' }, usage)
      return Stream.make<Array<string | ChatDelta>>('All done.', usage)
    })
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { browserEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'look', attachmentIds: [] })))
    await t.waitForDone(1)
    const expected = { promptTokens: 300, completionTokens: 30, totalTokens: 330, cachedTokens: 120, reasoningTokens: 15, requests: 3 }
    const done = t.events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ usage: expected })
    expect((done as { usage: { cost: number } }).usage.cost).toBeCloseTo(0.003)
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.usage).toMatchObject(expected)
    await t.runtime.dispose()
  })

  test('requests with images go to the vision model when the chat model cannot see', async () => {
    const models: ModelInfo[] = [
      { id: 'blind/model', name: 'Blind', contextLength: null, inputModalities: ['text'], supportsTools: true, pricing: { input: null, output: null, cacheRead: null, cacheWrite: null } },
      { id: 'eye/model', name: 'Eye', contextLength: null, inputModalities: ['text', 'image'], supportsTools: true, pricing: { input: null, output: null, cacheRead: null, cacheWrite: null } }
    ]
    const t = setup(
      (req) =>
        req.messages.some((m) => m.role === 'tool')
          ? Stream.make('It shows a shop.')
          : Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: 'c0', name: 'browser_screenshot', args: '{}' }),
      undefined,
      [],
      models
    )
    await t.run(SettingsStore.use((st) => st.update({ settings: { visionModel: 'eye/model' } })))
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { browserEnabled: true, model: 'blind/model' }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'what is on screen?', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(t.requests.map((r) => r.model)).toEqual(['blind/model', 'eye/model'])
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.model).toBe('eye/model')
    await t.runtime.dispose()
  })

  test('chats without browser access are offered no tools', async () => {
    const t = setup(() => Stream.make('plain'))
    const s = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'hi', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(t.requests[0]!.tools).toBeUndefined()
    await t.runtime.dispose()
  })

  test('provider errors are recorded on the message', async () => {
    const t = setup(() => Stream.fail(new Error('boom')) as unknown as Stream.Stream<string>)
    const s = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'go', attachmentIds: [] })))
    await t.waitForDone(1)
    const after = await t.run(Chat.use((c) => c.view(s.id)))
    expect(after.path[1]!.message).toMatchObject({ status: 'error', error: 'boom' })
    await t.runtime.dispose()
  })

  test('a hand-edited mood board goes back to the model as edited, and forks keep the edits', async () => {
    const board = JSON.stringify({ shots: [{ id: 'a', title: 'Wide', sketch: 'rooftop at dusk', steps: ['Tripod low'] }] })
    const t = setup(() => Stream.make(`Here:\n<artifact type="moodboard" identifier="mv" title="MV">\n${board}\n</artifact>\n`))
    const s = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'board please', attachmentIds: [] })))
    await t.waitForDone(1)
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    const reply = view.path[1]!.message
    const doc = layoutBoard(parseMoodboard(board)!)
    const step = doc.items.find((i) => i.kind === 'note')!
    if (step.kind === 'note') step.text = 'Handheld, chest height'
    await t.run(Db.use((db) => db.use((d) => d.saveBoard(reply.id, 'mv', doc))))

    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: reply.id, text: 'add a shot', attachmentIds: [] })))
    await t.waitForDone(2)
    const sent = t.requests[1]!.messages.find((m) => m.role === 'assistant')!.content as string
    expect(sent).toContain('Handheld, chest height')
    expect(sent).not.toContain('Tripod low')
    expect(sent).toStartWith('Here:\n<artifact type="moodboard" identifier="mv" title="MV">')
    expect(t.requests[1]!.messages[0]!.content).toContain('type="moodboard"')

    const fork = await t.run(Db.use((db) => db.use((d) => d.forkSession(s.id, reply.id))))
    const forked = await t.run(Chat.use((c) => c.view(fork.id)))
    const copy = await t.run(Db.use((db) => db.use((d) => d.getBoard(forked.path[1]!.message.id, 'mv'))))
    expect(copy).toEqual(doc)
    await t.runtime.dispose()
  })
})
