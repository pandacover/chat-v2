import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { ModelInfo, StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Broadcaster, CONTINUE_NOTE, Chat, DROPPED_SCREENSHOT } from '../src/main/services/Chat'
import { Db } from '../src/main/services/Db'
import { type ChatDelta, type ChatRequest, OpenRouter } from '../src/main/services/OpenRouter'
import { Browser, type BrowserApi, type PageSnapshot } from '../src/main/services/Browser'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { Computer, THINKING_LABEL } from '../src/main/services/Computer'
import { type FakeDesktop, SELF_PID, fakeDesktop, win } from './fakeDesktop'
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
      stopRecording: Effect.sync(() => (log.push('record stop'), { path: 'C:\\Videos\\chat-v2\\recording-1.webm', seconds: 7 })),
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

const setup = (
  script: Script,
  dir = mkdtempSync(join(tmpdir(), 'chat-v2-')),
  browserLog: string[] = [],
  models: ModelInfo[] = [],
  // Titling and memory are off unless a test is about them, so every request a script sees is a reply.
  config: Record<string, unknown> = { titleModel: '', memoryModel: '' },
  desktop: FakeDesktop = fakeDesktop()
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
  const providers = Layer.mergeAll(fakeOpenRouter, Attachments.layer, Computer.layer(desktop.ports)).pipe(Layer.provideMerge(base))
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
  return { runtime, run, events, requests, waitForDone, dir, desktop }
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
    // The model is remembered as one that must think: the next check asks that way straight away.
    const s2 = await t.run(newSession)
    await t.run(Chat.use((c) => c.send({ sessionId: s2.id, parentId: s2.rootId, text: 'My other cat is Tofu', attachmentIds: [] })))
    await t.waitForDone(2)
    while (t.requests.filter((r) => r.model === 'thinker/memory').length < 3) await new Promise((r) => setTimeout(r, 5))
    expect(t.requests.filter((r) => r.model === 'thinker/memory').map((r) => [r.reasoning, r.max_tokens])[2]).toEqual([undefined, 4000])
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
    // The partial reply goes back as the assistant's turn, and a note asks for the rest.
    expect(t2.requests[0]!.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: CONTINUE_NOTE }
    ])
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
    // The partial reply still carries everything received so far, partial line included.
    expect(t.requests[1]!.messages.at(-2)).toEqual({ role: 'assistant', content: 'done line\n<artifact title="C' })
    const reEmitted = t.events.filter((e) => e.type === 'line' && e.index === 1).map((e) => (e as { text: string }).text)
    expect(reEmitted).toEqual(['<artifact title="C', '<artifact title="Counter">'])
    await t.runtime.dispose()
  })

  test('every model continues the same way: never a request ending on the assistant, always the note after it', async () => {
    for (const model of ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-4.5', 'deepseek/deepseek-v4.1-flash']) {
      let call = 0
      const t = setup(
        () => (++call === 1 ? Stream.concat(Stream.make('done line\nhalf a sen'), Stream.never) : Stream.make('tence.')),
        undefined,
        [],
        [],
        { titleModel: '', memoryModel: '', defaultModel: model }
      )
      const s = await t.run(newSession)
      const view = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'go', attachmentIds: [] })))
      const id = view.path[1]!.message.id
      while (!t.events.some((e) => e.type === 'line')) await new Promise((r) => setTimeout(r, 5))
      await t.run(Chat.use((c) => c.stop(id)))
      await t.waitForDone(1)

      await t.run(Chat.use((c) => c.continue({ sessionId: s.id, assistantId: id })))
      await t.waitForDone(2)
      expect(t.requests[1]!.model).toBe(model)
      expect(t.requests[1]!.messages.slice(-2)).toEqual([
        { role: 'assistant', content: 'done line\nhalf a sen' },
        { role: 'user', content: CONTINUE_NOTE }
      ])
      const after = await t.run(Chat.use((c) => c.view(s.id)))
      expect(after.path[1]!.message).toMatchObject({ status: 'complete', content: 'done line\nhalf a sentence.' })
      await t.runtime.dispose()
    }
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

  test('research: the reply runs on the research model with research on, and without browser tools', async () => {
    const t = setup(() => Stream.make('::step {"tool":"web_search","label":"Searched “x”","ok":true}\n', 'Report.'), undefined, [], [], {
      titleModel: '',
      memoryModel: '',
      defaultModel: 'deepseek/deepseek-v4.1-flash',
      researchModel: 'claude/claude-fable-5-1'
    })
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { browserEnabled: true, researchEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'Compare hosts', attachmentIds: [] })))
    await t.waitForDone(1)

    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]!.model).toBe('claude/claude-fable-5-1')
    expect(t.requests[0]!.research).toBe(true)
    expect(t.requests[0]!.tools).toBeUndefined()
    expect(String(t.requests[0]!.messages[0]!.content)).toContain('research mode')
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.model).toBe('claude/claude-fable-5-1')
    expect(view.path[1]!.message.content).toContain('Report.')

    // A chat already on a Claude API model keeps it; forks keep the switch.
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { model: 'claude/claude-sonnet-5-5' }))))
    const fork = await t.run(Db.use((db) => db.use((d) => d.forkSession(s.id, view.path[1]!.message.id))))
    expect(fork.researchEnabled).toBe(true)
    await t.runtime.dispose()
  })

  test('browser agent: a saved screenshot goes on the reply, and a recording is saved to a file', async () => {
    const log: string[] = []
    const tool = (id: string, name: string, args: object): ChatDelta => ({ type: 'tool', index: 0, id, name, args: JSON.stringify(args) })
    const t = setup(
      (req) => {
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (turns === 0) return Stream.make(tool('s1', 'browser_screenshot', { save: true }))
        if (turns === 1) return Stream.make(tool('r1', 'browser_record', { action: 'start' }))
        if (turns === 2) return Stream.make(tool('r2', 'browser_record', { action: 'stop' }))
        return Stream.make('Here they are.')
      },
      undefined,
      log
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { browserEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'screenshot and record it', attachmentIds: [] })))
    await t.waitForDone(1)

    const view = await t.run(Chat.use((c) => c.view(s.id)))
    const reply = view.path[1]!.message
    expect(reply.attachments).toHaveLength(1)
    expect(reply.attachments[0]).toMatchObject({ kind: 'image', mime: 'image/png', messageId: reply.id })
    expect(reply.attachments[0]!.name).toMatch(/^screenshot-\d{6}\.png$/)
    // Open windows hear about it as it happens, not only on reload.
    expect(t.events.find((e) => e.type === 'attachment')).toMatchObject({ messageId: reply.id, attachment: { id: reply.attachments[0]!.id } })
    expect(log).toContain('record start')
    expect(log).toContain('record stop')
    expect(reply.content).toContain('"label":"Recorded 7s of the browser","ok":true,"detail":"C:\\\\Videos\\\\chat-v2\\\\recording-1.webm"')
    // The model sees the screenshot it saved, and is told where the video went.
    expect(t.requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] })
    expect(String((t.requests[3]!.messages.at(-1) as { content: string }).content)).toContain('recording-1.webm')
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

  test('computer use runs on the computer use model, which the message and the timing log record; other jobs keep theirs', async () => {
    const model = (id: string, image: boolean): ModelInfo => ({ id, name: id, contextLength: null, inputModalities: image ? ['text', 'image'] : ['text'], supportsTools: true, pricing: { input: null, output: null, cacheRead: null, cacheWrite: null } })
    const t = setup(
      (req) => {
        if (req.model === 'title/model') return Stream.make('Clicking about')
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (req.tools && turns === 0) return Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: 'c0', name: 'computer_click', args: '{"x":10,"y":10,"target":"File"}' })
        return Stream.make('Done.')
      },
      undefined,
      [],
      [model('luna/chat', true), model('fast/eye', true)],
      { titleModel: 'title/model', memoryModel: '', defaultModel: 'luna/chat', computerModel: 'fast/eye' }
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click file', attachmentIds: [] })))
    await t.waitForDone(1)
    while (!t.requests.some((r) => r.model === 'title/model')) await new Promise((r) => setTimeout(r, 10))
    const replies = t.requests.filter((r) => r.model !== 'title/model')
    expect(replies.map((r) => r.model)).toEqual(['fast/eye', 'fast/eye'])
    let view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.model).toBe('fast/eye')
    expect(t.events.find((e) => e.type === 'done')).toMatchObject({ model: 'fast/eye' })
    const log = readFileSync(join(t.dir, 'timing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(log.filter((r) => r.kind === 'call').map((r) => r.model)).toEqual(['fast/eye', 'fast/eye'])
    expect(log.find((r) => r.kind === 'reply')).toMatchObject({ model: 'fast/eye' })

    // A chat without computer use keeps the chat's model.
    const plain = await t.run(newSession)
    const before = t.requests.length
    await t.run(Chat.use((c) => c.send({ sessionId: plain.id, parentId: plain.rootId, text: 'hello', attachmentIds: [] })))
    await t.waitForDone(2)
    expect(t.requests.slice(before).filter((r) => r.model !== 'title/model').map((r) => r.model)).toEqual(['luna/chat'])
    view = await t.run(Chat.use((c) => c.view(plain.id)))
    expect(view.path[1]!.message.model).toBe('luna/chat')
    await t.runtime.dispose()
  })

  test('a computer use model that cannot see images hands the screenshots to the vision model, else to the chat model', async () => {
    const model = (id: string, image: boolean): ModelInfo => ({ id, name: id, contextLength: null, inputModalities: image ? ['text', 'image'] : ['text'], supportsTools: true, pricing: { input: null, output: null, cacheRead: null, cacheWrite: null } })
    const t = setup(
      (req) => {
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (turns === 0) return Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: 'c0', name: 'computer_click', args: '{"x":10,"y":10,"target":"File"}' })
        return Stream.make('Done.')
      },
      undefined,
      [],
      [model('luna/chat', true), model('blind/fast', false), model('eye/model', true)],
      { titleModel: '', memoryModel: '', defaultModel: 'luna/chat', computerModel: 'blind/fast', visionModel: 'eye/model' }
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click file', attachmentIds: [] })))
    await t.waitForDone(1)
    // Every request of a computer run carries a screenshot, so none goes to the blind model.
    expect(t.requests.map((r) => r.model)).toEqual(['eye/model', 'eye/model'])
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.model).toBe('eye/model')

    await t.run(SettingsStore.use((st) => st.update({ settings: { visionModel: '' } })))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: view.path[1]!.message.id, text: 'again', attachmentIds: [] })))
    await t.waitForDone(2)
    expect(t.requests.slice(2).map((r) => r.model)).toEqual(['luna/chat', 'luna/chat'])
    await t.runtime.dispose()
  })

  const clickFile = (id: string): ChatDelta => ({ type: 'tool', index: 0, id, name: 'computer_click', args: '{"x":10,"y":10,"target":"File"}' })

  test('computer use: the thinking spinner shows while the model decides, and goes when the reply is stopped', async () => {
    const desktop = fakeDesktop()
    const t = setup(
      (req) => (req.messages.some((m) => m.role === 'tool') ? Stream.never : Stream.make<Array<string | ChatDelta>>(clickFile('c0'))),
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    const sent = await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click file', attachmentIds: [] })))
    while (t.requests.length < 2) await new Promise((r) => setTimeout(r, 10))
    expect(desktop.overlay.at(-1)).toEqual({ type: 'status', state: 'working', label: THINKING_LABEL, busy: true })
    expect(desktop.spinning).toBe(true)
    await t.run(Chat.use((c) => c.stop(sent.path[1]!.message.id)))
    await t.waitForDone(1)
    expect(desktop.spinning).toBe(false)
    expect(desktop.overlay.at(-1)).toEqual({ type: 'status', state: 'off', label: '' })
    expect(desktop.watchedWhileSpinning).toBe(0)
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.status).toBe('stopped')
    await t.runtime.dispose()
  })

  test('computer use: a provider error mid-run takes the spinner down, and the cursor goes back to following the user', async () => {
    const desktop = fakeDesktop()
    const t = setup(
      (req) =>
        req.messages.some((m) => m.role === 'tool')
          ? (Stream.fail(new ProviderError({ provider: 'test', status: 500, message: 'upstream died' })) as unknown as Stream.Stream<string>)
          : Stream.make<Array<string | ChatDelta>>(clickFile('c0')),
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    await t.runtime.runPromise(Computer.use((c) => c.setMode(true)))
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click file', attachmentIds: [] })))
    await t.waitForDone(1)
    // It span before the first step too, on the cursor beside the user's pointer.
    expect(desktop.overlay).toContainEqual({ type: 'hint', label: THINKING_LABEL, busy: true })
    expect(desktop.overlay).toContainEqual({ type: 'status', state: 'working', label: THINKING_LABEL, busy: true })
    expect(desktop.spinning).toBe(false)
    expect(desktop.overlay.filter((e) => e.type === 'status').at(-1)).toEqual({ type: 'status', state: 'idle', label: '' })
    expect(desktop.watchedWhileSpinning).toBe(0)
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.status).toBe('error')
    await t.runtime.dispose()
  })

  test('computer use: failing before it ever took control clears the spinner on the hint', async () => {
    const desktop = fakeDesktop()
    const t = setup(() => Stream.fail(new ProviderError({ provider: 'test', status: 500, message: 'down' })) as unknown as Stream.Stream<string>, undefined, [], [], undefined, desktop)
    await t.runtime.runPromise(Computer.use((c) => c.setMode(true)))
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click file', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(desktop.overlay.slice(-2)).toEqual([{ type: 'hint', label: THINKING_LABEL, busy: true }, { type: 'hint', label: '' }])
    expect(desktop.spinning).toBe(false)
    await t.runtime.dispose()
  })

  test('computer use: what a reply says goes to the chat, not the cursor', async () => {
    const desktop = fakeDesktop()
    // Slow enough that what it said reached the cursor before the reply ended.
    const t = setup(() => Stream.make('It is 4.').pipe(Stream.concat(Stream.fromEffect(Effect.as(Effect.sleep('150 millis'), '')))), undefined, [], [], undefined, desktop)
    await t.runtime.runPromise(Computer.use((c) => c.setMode(true)))
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'what is 2+2', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(desktop.overlay.filter((e) => e.type === 'say')).toEqual([])
    expect(desktop.chat).toEqual(['leave out', 'let in'])
    await t.runtime.dispose()
  })

  test('computer use: desktop and browser tools, control handed back, old screenshots dropped', async () => {
    const tool = (id: string, name: string, args: object): ChatDelta => ({ type: 'tool', index: 0, id, name, args: JSON.stringify(args) })
    const desktop = fakeDesktop()
    const t = setup(
      (req) => {
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (turns < 4) return Stream.make<Array<string | ChatDelta>>(tool(`c${turns}`, 'computer_click', { x: 10 * (turns + 1), y: 10, target: `Button ${turns + 1}` }))
        return Stream.make('Done clicking.')
      },
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click things', attachmentIds: [] })))
    await t.waitForDone(1)

    const names = t.requests[0]!.tools!.map((x) => x.function.name)
    expect(names).toContain('computer_click')
    expect(names).toContain('browser_navigate')
    expect(String(t.requests[0]!.messages[0]!.content)).toContain('Work from the screen first')
    expect(desktop.input.filter((i) => i.startsWith('click ') && i.endsWith(' left'))).toHaveLength(4)
    // The glance left the chat out of its screenshot; then it got out of the way, and came back when the reply ended.
    expect(desktop.chat).toEqual(['leave out', 'let in', 'hide', 'show'])
    expect(desktop.overlay.at(-1)).toEqual({ type: 'status', state: 'off', label: '' })
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.content).toContain('"label":"Clicked “Button 1” in Notepad"')
    await t.runtime.dispose()
  })

  test('computer use: the first request shows the screen, so the first step can act without taking over first', async () => {
    const desktop = fakeDesktop([win({ hwnd: 1, w: 900, h: 700 }), win({ hwnd: 3, pid: SELF_PID, exe: 'chat-v2.exe', title: 'chat-v2', x: 960, y: 0, w: 900, h: 700 })])
    // What the desktop looked like when the first request went out.
    let atFirst = null as { chat: string[]; overlay: unknown[] } | null
    const t = setup(
      (req) => {
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (turns === 0) {
          atFirst = { chat: [...desktop.chat], overlay: [...desktop.overlay] }
          return Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: 'c0', name: 'computer_click', args: '{"x":100,"y":100,"target":"File"}' })
        }
        return Stream.make('Opened the File menu.')
      },
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'open the file menu', attachmentIds: [] })))
    await t.waitForDone(1)

    const first = t.requests[0]!.messages
    const seen = first.at(-1)!
    expect(seen.role).toBe('user')
    const parts = seen.content as Array<{ type: string; text?: string }>
    expect(parts[0]!.text).toStartWith('The screen as this task starts:\nScreenshot: 1280×720 pixels')
    expect(parts[0]!.text).toContain('"notes.txt - Notepad" (notepad.exe)')
    // The chat was left out of the capture, so it isn't in the picture or the window list.
    expect(parts[0]!.text).not.toContain('chat-v2')
    expect(parts[0]!.text).not.toContain("This chat's own window")
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1)
    expect(desktop.shots[0]).toEqual({ fresh: true, chatLeftOut: true, after: 0 })
    expect(desktop.covers[0]).toEqual([])
    // Looking took nothing over: the chat was still up (back in captures at once) and the overlay said nothing.
    expect(atFirst).toEqual({ chat: ['leave out', 'let in'], overlay: [] })
    // The click aimed at that screenshot and landed, with no computer_screenshot in between.
    expect(desktop.input).toEqual(['click 1 150,150 left'])
    expect(t.requests).toHaveLength(2)
    expect(desktop.chat).toEqual(['leave out', 'let in', 'hide', 'show'])
    await t.runtime.dispose()
  })

  test('computer use: on a Mac with the chat window over most of the screen, the first request lists the windows but has no screenshot', async () => {
    const desktop = fakeDesktop([win({ hwnd: 3, pid: SELF_PID, exe: 'chat-v2.exe', title: 'chat-v2' }), win({ hwnd: 1 })], 'darwin')
    const t = setup(() => Stream.make('Hi.'), undefined, [], [], undefined, desktop)
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'thanks', attachmentIds: [] })))
    await t.waitForDone(1)
    const seen = t.requests[0]!.messages.at(-1)!
    const parts = seen.content as Array<{ type: string; text?: string }>
    expect(parts).toHaveLength(1)
    expect(parts[0]!.text).toContain('No screenshot yet')
    // It points the model at acting first, not at a screenshot it would spend a step on.
    expect(parts[0]!.text).toContain("Don't start with computer_screenshot: your first action's result includes a screenshot")
    expect(parts[0]!.text).not.toContain('Start with computer_screenshot')
    expect(parts[0]!.text).not.toContain('Screenshot: 1280×720')
    expect(desktop.covers).toEqual([])
    // A reply that never used the computer never took it over.
    expect(desktop.chat).toEqual([])
    await t.runtime.dispose()
  })

  test('computer use: several actions in one step run in order, and only the screen after the last goes back', async () => {
    const call = (index: number, id: string, name: string, args: object): ChatDelta => ({ type: 'tool', index, id, name, args: JSON.stringify(args) })
    const desktop = fakeDesktop()
    const t = setup(
      (req) =>
        req.messages.some((m) => m.role === 'tool')
          ? Stream.make('Done.')
          : Stream.make<Array<string | ChatDelta>>(
              'I will write the note and save it.',
              call(0, 'a', 'computer_click', { x: 100, y: 100, target: 'Page', say: 'Writing your note: **click** the page, type, then save.' }),
              call(1, 'b', 'computer_type', { text: 'hello' }),
              call(2, 'c', 'computer_key', { keys: 'Ctrl+S' })
            ),
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'write hello and save', attachmentIds: [] })))
    await t.waitForDone(1)

    // Computer runs may send several calls in a turn; they ran one after another.
    expect(t.requests[0]!.parallel_tool_calls).toBe(true)
    expect(desktop.input).toEqual(['click 1 150,150 left', 'text hello', 'keys 17,83'])
    const next = t.requests[1]!.messages
    const results = next.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results).toHaveLength(3)
    // The first two say they're done, and that the screen after the last is the one that follows.
    expect(results[0]).toBe('Done. The screenshot after your last action in this turn follows instead of this one.')
    expect(results[1]).toBe(results[0])
    expect(results[2]).toContain('The screenshot after this action follows as an image.')
    const shot = next.at(-1)!
    expect(shot.role).toBe('user')
    const parts = shot.content as Array<{ type: string; text?: string }>
    expect(parts[0]!.text).toBe('Screenshot after the last of your 3 actions this step (the screen as it is now):')
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(1)
    // The cursor carried what the first action said, as plain words (not the reply's text), and let
    // go of them when the reply ended.
    const said = desktop.overlay.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text)
    expect(said).toEqual(['Writing your note: click the page, type, then save.', ''])
    await t.runtime.dispose()
  })

  test('computer use: a batch shows each of its steps in the reply, and one screenshot goes back', async () => {
    const desktop = fakeDesktop()
    const t = setup(
      (req) =>
        req.messages.some((m) => m.role === 'tool')
          ? Stream.make('Saved.')
          : Stream.make<Array<string | ChatDelta>>({
              type: 'tool',
              index: 0,
              id: 'b',
              name: 'computer_batch',
              args: JSON.stringify({
                say: 'Typing your note and saving it',
                actions: [
                  { action: 'click', x: 100, y: 100, target: 'Page' },
                  { action: 'type', text: 'hello' },
                  { action: 'key', keys: 'Ctrl+S' }
                ]
              })
            }),
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'write hello and save', attachmentIds: [] })))
    await t.waitForDone(1)

    expect(desktop.input).toEqual(['click 1 150,150 left', 'text hello', 'keys 17,83'])
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    const content = view.path[1]!.message.content
    for (const label of ['Clicked “Page” in Notepad', 'Typed “hello” in Notepad', 'Pressed Ctrl+S in Notepad']) expect(content).toContain(`"label":"${label}"`)
    const next = t.requests[1]!.messages
    expect(String(next.find((m) => m.role === 'tool')!.content)).toStartWith('Ran 3 of 3 actions:')
    const shot = next.at(-1)!.content as Array<{ type: string; text?: string }>
    expect(shot.filter((p) => p.type === 'image_url')).toHaveLength(1)
    expect(desktop.overlay.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text)).toEqual(['Typing your note and saving it', ''])
    await t.runtime.dispose()
  })

  test('computer use: an action the screen changed under is held back, with the rest of its step', async () => {
    const call = (index: number, id: string, name: string, args: object): ChatDelta => ({ type: 'tool', index, id, name, args: JSON.stringify(args) })
    const desktop = fakeDesktop()
    // Clicking File opens its menu, a window of its own, over where Save As would be guessed.
    const click = desktop.ports.driver!.click
    desktop.ports.driver!.click = async (...args) => {
      await click(...args)
      if (desktop.input.length === 1) desktop.state.windows = [win({ hwnd: 5, title: '', cls: '#32768', x: 0, y: 20, w: 300, h: 400 }), ...desktop.state.windows]
    }
    const t = setup(
      (req) =>
        req.messages.some((m) => m.role === 'tool')
          ? Stream.make('The menu is open.')
          : Stream.make<Array<string | ChatDelta>>(
              call(0, 'a', 'computer_click', { x: 10, y: 10, target: 'File' }),
              call(1, 'b', 'computer_click', { x: 20, y: 60, target: 'Save As' }),
              call(2, 'c', 'computer_type', { text: 'notes' })
            ),
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'save as notes', attachmentIds: [] })))
    await t.waitForDone(1)

    // Only File was clicked: Save As would have been a guess at a menu the model never saw.
    expect(desktop.input).toEqual(['click 1 15,15 left'])
    const results = t.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(results[0]).toStartWith('Done.')
    expect(results[1]).toStartWith('Not done: a menu came up at that point since the screenshot you planned this on')
    expect(results[1]).toContain('Windows, front to back:')
    expect(results[2]).toStartWith('Not run: the computer_click before this')
    // One screenshot, of the screen with the menu open.
    const images = t.requests[1]!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : []))
    expect(images).toHaveLength(1)
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.content).toContain('"label":"Held back: the screen changed first"')
    await t.runtime.dispose()
  })

  test('computer use: only the newest screenshot is sent, and each request starts with the one before except where its screenshot was', async () => {
    const desktop = fakeDesktop()
    const t = setup(
      (req) => {
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (turns < 4) return Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: `c${turns}`, name: 'computer_click', args: JSON.stringify({ x: 10 + turns, y: 10, target: 'Next' }) })
        return Stream.make('Done.')
      },
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'click on', attachmentIds: [] })))
    await t.waitForDone(1)

    const withImage = (m: ChatRequest['messages'][number]) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
    // The glance, then the screenshot after each click: one in every request.
    expect(t.requests.map((r) => r.messages.filter(withImage).length)).toEqual([1, 1, 1, 1, 1])
    // The glance's screenshot went too, the same way.
    expect(t.requests.at(-1)!.messages.filter((m) => m.content === DROPPED_SCREENSHOT)).toHaveLength(4)
    expect(t.requests[1]!.messages.findIndex((m) => m.content === DROPPED_SCREENSHOT)).toBe(t.requests[0]!.messages.findIndex(withImage))
    // Each request starts with the one before it, byte for byte, except the previous screenshot,
    // which is now the note: that was the end of the previous request, so the rest can be cached.
    for (let i = 1; i < t.requests.length; i++) {
      const before = t.requests[i - 1]!.messages
      const now = t.requests[i]!.messages
      const shot = before.findIndex(withImage)
      expect(shot).toBe(before.length - 1)
      expect(JSON.stringify(now.slice(0, shot))).toBe(JSON.stringify(before.slice(0, shot)))
      expect(now[shot]!.content).toBe(DROPPED_SCREENSHOT)
    }
    // The system prompt and the tools never change within a reply.
    expect(new Set(t.requests.map((r) => JSON.stringify(r.messages[0]))).size).toBe(1)
    expect(new Set(t.requests.map((r) => JSON.stringify(r.tools))).size).toBe(1)
    await t.runtime.dispose()
  })

  test('the model gets its thinking back with its tool calls, in browser runs too', async () => {
    const t = setup((req) => {
      const turns = req.messages.filter((m) => m.role === 'tool').length
      if (turns === 0)
        return Stream.make<Array<string | ChatDelta>>(
          { type: 'reasoning', text: 'Look at ', details: [{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: 'Look at ' }] },
          { type: 'reasoning', text: 'the shop', details: [{ type: 'reasoning.text', index: 0, text: 'the shop' }] },
          { type: 'reasoning', details: [{ type: 'reasoning.text', index: 0, signature: 'sig-1' }] },
          { type: 'reasoning', details: [{ type: 'reasoning.encrypted', index: 1, format: 'anthropic-claude-v1', data: 'ENCRYPTED' }] },
          { type: 'tool', index: 0, id: 'n1', name: 'browser_navigate', args: '{"url":"http://shop.test/"}' }
        )
      if (turns === 1)
        return Stream.make<Array<string | ChatDelta>>({ type: 'reasoning', text: 'Now click.' }, { type: 'tool', index: 0, id: 'k1', name: 'browser_click', args: '{"ref":"e1"}' })
      return Stream.make('Bought it.')
    })
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { browserEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'buy it', attachmentIds: [] })))
    await t.waitForDone(1)
    const steps = t.requests.at(-1)!.messages.filter((m) => m.role === 'assistant' && 'tool_calls' in m && m.tool_calls)
    // Fragments of a block are joined; blocks keep their order, types and signature as sent.
    expect(steps[0]).toMatchObject({
      reasoning_details: [
        { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: 'Look at the shop', signature: 'sig-1' },
        { type: 'reasoning.encrypted', index: 1, format: 'anthropic-claude-v1', data: 'ENCRYPTED' }
      ]
    })
    expect('reasoning' in steps[0]!).toBe(false)
    // Plain thinking, without structured blocks, goes back as text.
    expect(steps[1]).toMatchObject({ reasoning: 'Now click.' })
    expect('reasoning_details' in steps[1]!).toBe(false)
    // Browser runs don't set an effort; only computer use does.
    expect(t.requests.every((r) => r.reasoning === undefined)).toBe(true)
    await t.runtime.dispose()
  })

  test('computer use asks for low reasoning effort by default, as Settings say, and again without it if refused', async () => {
    const t = setup((req) => {
      if (req.reasoning?.effort === 'medium') return Stream.fail(new ProviderError({ provider: 'test', status: 400, message: 'reasoning.effort is not supported' })) as unknown as Stream.Stream<string>
      return Stream.make('Nothing to do.')
    })
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'hi', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(t.requests.map((r) => r.reasoning)).toEqual([{ effort: 'low' }])

    await t.run(SettingsStore.use((st) => st.update({ settings: { computerReasoningEffort: 'medium' } })))
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: view.path[1]!.message.id, text: 'again', attachmentIds: [] })))
    await t.waitForDone(2)
    expect(t.requests.slice(1).map((r) => r.reasoning)).toEqual([{ effort: 'medium' }, undefined])
    const after = await t.run(Chat.use((c) => c.view(s.id)))
    expect(after.path[3]!.message).toMatchObject({ status: 'complete', content: 'Nothing to do.' })
    await t.runtime.dispose()
  })

  test('computer use: a refused action ends the reply with a plain explanation', async () => {
    const desktop = fakeDesktop([win({ hwnd: 7, pid: 300, exe: 'SystemSettings.exe', title: 'Settings' })])
    const t = setup(
      (req) => {
        const turns = req.messages.filter((m) => m.role === 'tool').length
        if (turns === 0) return Stream.make<Array<string | ChatDelta>>({ type: 'tool', index: 0, id: 'a', name: 'computer_screenshot', args: '{}' })
        return Stream.make<Array<string | ChatDelta>>(
          { type: 'tool', index: 0, id: 'b', name: 'computer_click', args: '{"x":5,"y":5,"target":"Bluetooth"}' },
          { type: 'tool', index: 1, id: 'c', name: 'computer_type', args: '{"text":"x"}' }
        )
      },
      undefined,
      [],
      [],
      undefined,
      desktop
    )
    const s = await t.run(newSession)
    await t.run(Db.use((db) => db.use((d) => d.updateSession(s.id, { computerEnabled: true }))))
    await t.run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text: 'turn on bluetooth', attachmentIds: [] })))
    await t.waitForDone(1)
    expect(t.requests).toHaveLength(2)
    expect(desktop.input).toEqual([])
    const view = await t.run(Chat.use((c) => c.view(s.id)))
    expect(view.path[1]!.message.content.split('\n').at(-1)).toBe("I stopped here: Windows Settings is protected, so I can't use it. You'll need to do this step yourself.")
    expect(view.path[1]!.message.status).toBe('complete')
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
