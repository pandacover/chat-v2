import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { StreamEvent } from '../src/shared/types'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments } from '../src/main/services/Attachments'
import { Browser, type BrowserApi } from '../src/main/services/Browser'
import { Broadcaster, Chat, DROPPED_SCREENSHOT } from '../src/main/services/Chat'
import { Computer, GLIDE_MS } from '../src/main/services/Computer'
import { Db } from '../src/main/services/Db'
import { OpenRouter } from '../src/main/services/OpenRouter'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { mergeReasoning, parseSseLine } from '../src/main/sse'
import { withCacheBreakpoints } from '../src/main/services/OpenRouter'
import { type ActionRecord, type CallRecord, type ReplyRecord, type TimingRecord, timingTable } from '../src/main/timing'
import { fakeDesktop } from './fakeDesktop'

// These run the real OpenRouter layer against a stubbed fetch that streams scripted SSE, so the
// network phases are timed the way they are in the app. Nothing leaves the machine.

const realFetch = globalThis.fetch
const realKey = process.env.OPENROUTER_API_KEY
beforeAll(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
})
afterAll(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = realKey
})

const dirs: string[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One streamed reply: SSE lines with a pause before each, then [DONE]. */
type Reply = Array<{ wait?: number; line: string }>

const chunk = (body: object, wait = 5) => ({ wait, line: `data: ${JSON.stringify({ model: 'openai/gpt-test', provider: 'OpenAI', ...body })}` })
const text = (t: string, wait?: number) => chunk({ choices: [{ delta: { content: t } }] }, wait)
const toolCall = (id: string, name: string, args: object) =>
  chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const usage = (prompt: number, completion: number) =>
  chunk({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 3 } } })
/** What OpenRouter sends first: a keep-alive comment, then an empty assistant delta. */
const opening = (wait = 10): Reply => [{ wait, line: ': OPENROUTER PROCESSING' }, chunk({ choices: [{ delta: { role: 'assistant', content: '' } }] })]

const sseResponse = (reply: Reply, signal?: AbortSignal | null, hang = false) => {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (const { wait, line } of reply) {
          if (wait) await pause(wait)
          if (signal?.aborted) return
          c.enqueue(enc.encode(`${line}\n\n`))
        }
        if (hang) return
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

/** Stubs fetch: each chat completion gets the next scripted reply (or a Response as is). */
const stubOpenRouter = (replies: Array<Reply | Response | 'hang'>, sent: any[] = []) => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith('/chat/completions')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    sent.push(JSON.parse(String(init?.body)))
    await pause(15)
    const next = replies.shift()
    if (next === undefined) throw new Error('no more scripted replies')
    if (next instanceof Response) return next
    return next === 'hang' ? sseResponse(opening(), init?.signal, true) : sseResponse(next, init?.signal)
  }) as typeof fetch
  return sent
}

const setup = (desktop = fakeDesktop(), model = 'openai/gpt-test') => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-timing-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '', defaultModel: model }))
  const events: StreamEvent[] = []
  const paths = AppPaths.layer(dir)
  const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths)), paths)
  const providers = Layer.mergeAll(OpenRouter.layer, Attachments.layer, Computer.layer(desktop.ports)).pipe(Layer.provideMerge(base))
  // No script here uses the browser; handing it back is all a reply may ask of it.
  const browser = Layer.succeed(Browser, { release: Effect.void } as unknown as BrowserApi)
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Chat.layer.pipe(Layer.provide(providers), Layer.provide(Layer.succeed(Broadcaster, Broadcaster.of({ send: (e) => void events.push(e) }))), Layer.provide(browser)),
      providers
    )
  )
  const run = <A, E>(eff: Effect.Effect<A, E, Chat | Db>) => runtime.runPromise(eff)
  const file = join(dir, 'timing.jsonl')
  /** The log so far, once the reply summary is in it. */
  const records = async (): Promise<TimingRecord[]> => {
    for (let i = 0; i < 500; i++) {
      const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
      const parsed = lines.map((l) => JSON.parse(l) as TimingRecord)
      if (parsed.some((r) => r.kind === 'reply')) return parsed
      await pause(10)
    }
    throw new Error('no reply summary in timing.jsonl')
  }
  const send = async (text: string, computerEnabled = false) => {
    const s = await run(
      Effect.gen(function* () {
        const db = yield* Db
        const s = yield* db.use((d) => d.createSession({ title: 'New chat', model: null, systemPrompt: null, forkedFromSessionId: null }))
        if (computerEnabled) yield* db.use((d) => d.updateSession(s.id, { computerEnabled: true }))
        return s
      })
    )
    const view = await run(Chat.use((c) => c.send({ sessionId: s.id, parentId: s.rootId, text, attachmentIds: [] })))
    return view.path[1]!.message.id
  }
  return { runtime, run, send, records, events, desktop }
}

const calls = (rs: TimingRecord[]) => rs.filter((r): r is CallRecord => r.kind === 'call')
const actions = (rs: TimingRecord[]) => rs.filter((r): r is ActionRecord => r.kind === 'action')
const summary = (rs: TimingRecord[]) => rs.find((r): r is ReplyRecord => r.kind === 'reply')!

/** Network moments come in order: headers, then any chunk, then content, then the end. */
const expectOrdered = (c: CallRecord) => {
  expect(c.headersMs).toBeGreaterThanOrEqual(0)
  expect(c.firstDeltaMs!).toBeGreaterThanOrEqual(c.headersMs!)
  expect(c.firstContentMs!).toBeGreaterThanOrEqual(c.firstDeltaMs!)
  expect(c.totalMs).toBeGreaterThanOrEqual(c.firstContentMs!)
}

describe('timing', () => {
  test('a plain reply logs its one call and a summary led by time to first token', async () => {
    stubOpenRouter([[...opening(), text('Hello ', 40), text('there.\n'), usage(120, 4)]])
    const t = setup()
    const id = await t.send('Say hello')
    const rs = await t.records()

    const [c] = calls(rs)
    expect(calls(rs)).toHaveLength(1)
    expect(c).toMatchObject({ reply: id, step: 0, model: 'openai/gpt-test', status: 'ok', images: 0, answeredModel: 'openai/gpt-test', provider: 'OpenAI', promptTokens: 120, completionTokens: 4, reasoningTokens: 3, cachedTokens: 7 })
    expect(c!.bytes).toBeGreaterThan(100)
    expectOrdered(c!)
    // The content came 40 ms after the opening chunk.
    expect(c!.firstContentMs! - c!.firstDeltaMs!).toBeGreaterThanOrEqual(30)

    const s = summary(rs)
    expect(s).toMatchObject({ reply: id, model: 'openai/gpt-test', status: 'ok', calls: 1, actions: 0, actionMs: 0, promptTokens: 120, completionTokens: 4 })
    expect(s.firstTokenMs!).toBeGreaterThanOrEqual(c!.firstContentMs!)
    expect(s.modelMs).toBeLessThanOrEqual(s.wallMs)
    expect(s.modelShare).toBeGreaterThan(0)
    await t.runtime.dispose()
  })

  test('a computer-use run logs every model call and the phases of every action', async () => {
    const sent = stubOpenRouter([
      [...opening(), toolCall('a', 'computer_screenshot', {}), usage(900, 20)],
      [...opening(), toolCall('b', 'computer_click', { x: 100, y: 100, target: 'File' }), usage(1900, 25)],
      [...opening(), text('Done.'), usage(2900, 5)]
    ])
    const t = setup()
    const id = await t.send('Open the File menu', true)
    const rs = await t.records()

    // The first request carries the screen already (the glance); each later one only the newest screenshot.
    expect(calls(rs).map((c) => [c.step, c.status, c.images])).toEqual([
      [0, 'ok', 1],
      [1, 'ok', 1],
      [2, 'ok', 1]
    ])
    for (const c of calls(rs)) expectOrdered(c)
    // The logged size is the body that went out.
    expect(calls(rs)[2]!.bytes).toBe(Buffer.byteLength(JSON.stringify(sent[2])))

    expect(actions(rs).map((a) => [a.step, a.tool, a.status])).toEqual([
      [0, 'computer.glance', 'ok'],
      [0, 'computer.begin', 'ok'],
      [0, 'computer_screenshot', 'ok'],
      [1, 'computer_click', 'ok']
    ])
    const [glance, begin, look, click] = actions(rs)
    // The glance leaves the chat window out of its capture first (Windows).
    expect(Object.keys(glance!.phases).sort()).toEqual(['capture', 'capture.cover', 'capture.encode', 'capture.hide', 'capture.sources', 'leaveOut', 'readState'])
    // Getting ready waits only for the chat window to leave the window list, not for its animation.
    expect(Object.keys(begin!.phases).sort()).toEqual(['readState'])
    expect(begin!.totalMs).toBeLessThan(100)
    // A plain look straight after lets the screen settle first, in case the chat is still minimising.
    expect(Object.keys(look!.phases).sort()).toEqual(['capture', 'capture.cover', 'capture.encode', 'capture.hide', 'capture.sources', 'readState', 'settle'])
    // The screen port's own part timings come through as they were reported.
    expect(look!.phases).toMatchObject({ 'capture.sources': 3, 'capture.cover': 1, 'capture.encode': 2 })
    expect(look!.phases['capture.hide']).toBeGreaterThanOrEqual(0)
    // A click: the glide, the input, the wait for the screen to settle, then a fresh look.
    expect(Object.keys(click!.phases).sort()).toEqual(['capture', 'capture.cover', 'capture.encode', 'capture.hide', 'capture.sources', 'driver', 'glide', 'readState', 'settle'])
    expect(click!.phases.glide).toBeGreaterThanOrEqual(GLIDE_MS - 5)
    // The fake screen is still: at least 150 ms, then two looks 80 ms apart that match.
    expect(click!.phases.settle).toBeGreaterThanOrEqual(150 + 160 - 5)
    expect(click!.phases.settle).toBeLessThan(550)
    expect(click!.totalMs).toBeGreaterThanOrEqual(click!.phases.glide! + click!.phases.settle!)

    const s = summary(rs)
    expect(s).toMatchObject({ reply: id, status: 'ok', calls: 3, actions: 4, images: 3, promptTokens: 5700, completionTokens: 50, cachedTokens: 21 })
    expect(s.actionMs).toBeGreaterThanOrEqual(glance!.totalMs + begin!.totalMs + look!.totalMs + click!.totalMs - 1)
    expect(s.modelMs + s.actionMs).toBeLessThanOrEqual(s.wallMs + 1)
    expect(s.firstTokenMs!).toBeGreaterThan(0)
    await t.runtime.dispose()
  })

  test('computer_wait logs the time it really waited, not the most it was given', async () => {
    stubOpenRouter([
      [...opening(), toolCall('a', 'computer_wait', { seconds: 10 }), usage(900, 20)],
      [...opening(), text('Done.'), usage(1900, 5)]
    ])
    const t = setup()
    await t.send('Wait for it', true)
    const rs = await t.records()
    const wait = actions(rs).find((a) => a.tool === 'computer_wait')!
    // The fake screen never changes, so the wait ends after 2 s of stillness.
    expect(Object.keys(wait.phases).sort()).toEqual(['capture', 'capture.cover', 'capture.encode', 'capture.hide', 'capture.sources', 'readState', 'wait'])
    expect(wait.phases.wait).toBeGreaterThanOrEqual(2000 - 5)
    expect(wait.phases.wait).toBeLessThan(2600)
    expect(wait.totalMs).toBeLessThan(3000)
    await t.runtime.dispose()
  })

  test('a failed call is logged as an error, and so is the reply', async () => {
    stubOpenRouter([new Response(JSON.stringify({ error: { message: 'No credits' } }), { status: 402 })])
    const t = setup()
    await t.send('Hi')
    const rs = await t.records()
    expect(calls(rs)).toHaveLength(1)
    expect(calls(rs)[0]).toMatchObject({ status: 'error', images: 0 })
    expect(calls(rs)[0]!.headersMs).toBeGreaterThanOrEqual(0)
    expect(calls(rs)[0]!.firstDeltaMs).toBeUndefined()
    expect(summary(rs)).toMatchObject({ status: 'error', calls: 1 })
    await t.runtime.dispose()
  })

  test('a stopped reply still logs the call it cut off', async () => {
    stubOpenRouter(['hang'])
    const t = setup()
    const id = await t.send('Write a long story')
    // Let the stream open (it sends its opening chunk, then nothing), then press Stop.
    await pause(150)
    await t.run(Chat.use((c) => c.stop(id)))
    const rs = await t.records()
    expect(calls(rs)[0]).toMatchObject({ status: 'interrupted' })
    expect(calls(rs)[0]!.firstDeltaMs).toBeGreaterThanOrEqual(0)
    expect(summary(rs)).toMatchObject({ status: 'interrupted', calls: 1 })
    await t.runtime.dispose()
  })
})

describe('timing table', () => {
  test('lists calls and actions, then the reply in a line', () => {
    const at = '2026-10-19T00:00:00.000Z'
    const table = timingTable([
      { kind: 'call', at, reply: 'r1', step: 0, model: 'm', answeredModel: 'openai/gpt-test', provider: 'OpenAI', status: 'ok', totalMs: 2400, headersMs: 600, firstDeltaMs: 900, firstContentMs: 2100, bytes: 400_000, images: 3, promptTokens: 5000, completionTokens: 40, reasoningTokens: 30, cachedTokens: 0 },
      { kind: 'action', at, reply: 'r1', step: 0, tool: 'computer_click', status: 'ok', totalMs: 1300, phases: { glide: 420, driver: 20, settle: 550, readState: 10, capture: 250, 'capture.sources': 200, 'capture.hide': 0 } },
      { kind: 'reply', at, reply: 'r1', model: 'm', status: 'ok', wallMs: 3800, firstTokenMs: 2150, calls: 1, actions: 1, modelMs: 2400, actionMs: 1300, otherMs: 100, modelShare: 0.63, bytes: 400_000, images: 3, promptTokens: 5000, completionTokens: 40, reasoningTokens: 30, cachedTokens: 0 }
    ])
    const lines = table.split('\n')
    expect(lines[0]).toMatch(/^step\s+what\s+ms\s+headers/)
    expect(lines[2]).toContain('model openai/gpt-test (OpenAI)')
    expect(lines[2]).toContain('391k')
    expect(lines[2]).toContain('5000/40/30/0')
    expect(lines[3]).toContain('glide 420, driver 20, settle 550, readState 10, capture 250')
    expect(lines[3]).toContain('sources 200, hide 0')
    expect(lines[4]).toContain('3800 ms wall, first token 2150 ms, 1 model calls 2400 ms (63%)')
  })
})

describe('sse meta', () => {
  test('reports the model and provider a chunk names', () => {
    expect(parseSseLine('data: {"model":"openai/gpt-test","provider":"OpenAI","choices":[{"delta":{"content":"hi"}}]}')).toEqual([
      { type: 'meta', model: 'openai/gpt-test', provider: 'OpenAI' },
      { type: 'delta', text: 'hi' }
    ])
  })
})

describe('sse reasoning', () => {
  test('reads thinking text and structured blocks from a delta', () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Hmm', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Hmm' }, 'junk'] } }] })}`
    expect(parseSseLine(line)).toEqual([{ type: 'reasoning', text: 'Hmm', details: [{ type: 'reasoning.text', index: 0, text: 'Hmm' }] }])
  })

  test('joins the fragments of each block and keeps blocks apart, in order', () => {
    const blocks = mergeReasoning([], [{ type: 'reasoning.summary', index: 0, summary: 'Find ', format: 'openai-responses-v1' }])
    mergeReasoning(blocks, [{ type: 'reasoning.summary', index: 0, summary: 'the menu.' }])
    mergeReasoning(blocks, [{ type: 'reasoning.encrypted', index: 1, data: 'gAAAA', id: 'rs_1' }])
    // No index: a fragment continues the block before it, if it's of the same kind.
    mergeReasoning(blocks, [{ type: 'reasoning.text', text: 'a' }])
    mergeReasoning(blocks, [{ type: 'reasoning.text', text: 'b', signature: 'sig' }])
    expect(blocks).toEqual([
      { type: 'reasoning.summary', index: 0, summary: 'Find the menu.', format: 'openai-responses-v1' },
      { type: 'reasoning.encrypted', index: 1, data: 'gAAAA', id: 'rs_1' },
      { type: 'reasoning.text', text: 'ab', signature: 'sig' }
    ])
  })
})

describe('requests', () => {
  /** Where a request body marks cache breakpoints, by message index. */
  const breakpoints = (body: any) =>
    (body.messages as any[]).flatMap((m, i) => (Array.isArray(m.content) && m.content.some((p: any) => p.cache_control) ? [i] : []))

  test('Claude gets cache breakpoints on the system prompt and the newest message without a screenshot, and its thinking back', async () => {
    const thinking = (text: string, extra: object = {}) => chunk({ choices: [{ delta: { reasoning: text, reasoning_details: [{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text, ...extra }] } }] })
    const sent = stubOpenRouter([
      [...opening(), thinking('The File menu '), thinking('is top left.', { signature: 'sig' }), toolCall('b', 'computer_click', { x: 10, y: 10, target: 'File' }), usage(900, 20)],
      [...opening(), text('Done.'), usage(1900, 5)]
    ])
    const t = setup(fakeDesktop(), 'anthropic/claude-test')
    await t.send('Open the File menu', true)
    await t.records()
    expect(sent).toHaveLength(2)
    for (const body of sent) {
      expect(body.messages[0].content).toEqual([{ type: 'text', text: expect.stringContaining('Computer mode is on'), cache_control: { type: 'ephemeral' } }])
      expect(body.reasoning).toEqual({ effort: 'low' })
    }
    // The newest screenshot is replaced by a note next step, so the breakpoint goes before it: on
    // the user's message first, then on the glance's note, which stays as it is from then on.
    expect(breakpoints(sent[0])).toEqual([0, 1])
    expect(sent[0].messages[1].content).toEqual([{ type: 'text', text: 'Open the File menu', cache_control: { type: 'ephemeral' } }])
    expect(sent[0].messages.at(-1).content[0].text).toStartWith('The screen as this task starts')
    expect(breakpoints(sent[1])).toEqual([0, 2])
    expect(sent[1].messages[2].content).toEqual([{ type: 'text', text: DROPPED_SCREENSHOT, cache_control: { type: 'ephemeral' } }])
    expect(sent[1].messages.at(-1).content[0]).toEqual({ type: 'text', text: 'Screenshot after that step:' })
    const step = sent[1].messages.find((m: any) => m.tool_calls)
    expect(step.reasoning_details).toEqual([{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: 'The File menu is top left.', signature: 'sig' }])
    await t.runtime.dispose()
  })

  test('other models get no breakpoints: their providers cache the unchanged start on their own', async () => {
    const sent = stubOpenRouter([[...opening(), text('Hello.'), usage(100, 2)]])
    const t = setup()
    await t.send('Hi')
    await t.records()
    expect(JSON.stringify(sent[0])).not.toContain('cache_control')
    expect(typeof sent[0].messages[0].content).toBe('string')
    expect(sent[0].reasoning).toBeUndefined()
    // The ~ aliases name Claude models too.
    expect(breakpoints({ messages: withCacheBreakpoints('~anthropic/claude-sonnet-latest', [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]) })).toEqual([0, 1])
    await t.runtime.dispose()
  })
})
