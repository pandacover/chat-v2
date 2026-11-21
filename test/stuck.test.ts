import { describe, expect, test } from 'bun:test'
import { CHECKPOINTS, THRESHOLDS, checkpointAfter, decide, makeDetector, stableJson, toolWords, type Finding } from '../src/main/agent/stuck'
import { judgePrompt, parseJudgement } from '../src/main/agent/judge'
import { type JudgeReply, type Pause, type ProgressNote, makeWatch, outputText, pauseNote } from '../src/main/agent/watch'

const ok = (text: string) => [{ type: 'text', text }]
/** Feeds calls to a fresh detector; returns what each one found. */
const feed = (calls: Array<[name: string, input: unknown, output: unknown, isError?: boolean]>) => {
  const d = makeDetector()
  return calls.map(([name, input, output, isError = false]) => d.toolCall({ name, input, output, isError }))
}
const kinds = (fs: Array<Finding | null>) => fs.map((f) => (f ? `${f.kind}:${f.signal}` : null))

describe('same call, same result', () => {
  test('pauses at the 4th in a row', () => {
    const found = feed(Array.from({ length: 4 }, () => ['mcp__computer__look_at_screen', {}, ok('the same screen')] as const).map((c) => [...c]))
    expect(kinds(found)).toEqual([null, null, null, 'pause:same_result'])
    expect(found[3]).toMatchObject({ reason: 'It made the same look at screen call 4 times in a row and got the same result each time.' })
  })

  test('a different result, input or tool in between starts the count again', () => {
    const look = (out: string, input: unknown = { at: 1 }): [string, unknown, unknown] => ['look', input, ok(out)]
    expect(kinds(feed([look('a'), look('a'), look('a'), look('b')]))).toEqual([null, null, null, null])
    expect(kinds(feed([look('a'), look('a'), look('a', { at: 2 }), look('a'), look('a')]))).toEqual([null, null, null, null, null])
    expect(kinds(feed([look('a'), look('a'), ['other', {}, ok('x')], look('a'), look('a')]))).toEqual([null, null, null, null, null])
  })

  test('inputs that differ only in key order are the same call', () => {
    const found = feed([
      ['click', { x: 1, y: 2 }, ok('ok')],
      ['click', { y: 2, x: 1 }, ok('ok')],
      ['click', { x: 1, y: 2 }, ok('ok')],
      ['click', { y: 2, x: 1 }, ok('ok')]
    ])
    expect(kinds(found).at(-1)).toBe('pause:same_result')
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
})

describe('same call, any result', () => {
  test('pauses at the 5th in a row, whatever came back', () => {
    const found = feed(Array.from({ length: 5 }, (_, i) => ['mcp__browser__browser_snapshot', {}, ok(`page at ${i}`)]))
    expect(kinds(found)).toEqual([null, null, null, null, 'pause:same_call'])
    expect(found[4]).toMatchObject({ reason: 'It made the same browser snapshot call 5 times in a row.' })
  })
})

describe('same error from the same call', () => {
  test('nudges the model at the 3rd and pauses at the 4th', () => {
    const fail: [string, unknown, unknown, boolean] = ['mcp__computer__click', { x: 5, y: 5 }, 'Error: the window is gone\n  at click', true]
    const found = feed([fail, fail, fail, fail])
    expect(kinds(found)).toEqual([null, null, 'nudge:same_error', 'pause:same_error'])
    expect(found[2]).toMatchObject({ message: expect.stringContaining('mcp__computer__click call has now failed 3 times in a row with the same error') })
    expect(found[3]).toMatchObject({ reason: 'It kept getting the same error from click: “Error: the window is gone”' })
  })

  test('different errors, or an error from another input, are not the same error', () => {
    const fail = (error: string, x = 5): [string, unknown, unknown, boolean] => ['click', { x }, error, true]
    expect(kinds(feed([fail('a'), fail('b'), fail('a'), fail('b')]))).toEqual([null, null, null, null])
    expect(kinds(feed([fail('a'), fail('a', 6), fail('a'), fail('a', 6)]))).toEqual([null, null, null, null])
  })
})

describe('two calls alternating', () => {
  const a: [string, unknown, unknown] = ['mcp__browser__browser_back', {}, ok('page one')]
  const b: [string, unknown, unknown] = ['mcp__browser__browser_forward', {}, ok('page two')]

  test('pauses after 6 calls of A, B, A, B, A, B', () => {
    const found = feed([a, b, a, b, a, b])
    expect(kinds(found)).toEqual([null, null, null, null, null, 'pause:alternating'])
    expect(found[5]).toMatchObject({ reason: 'It kept going back and forth between browser back and browser forward, with the same results each time.' })
  })

  test('alternating calls whose results change are progress (a press, then a look)', () => {
    const press: [string, unknown, unknown] = ['press_keys', { combo: 'pagedown' }, ok('pressed')]
    const look = (n: number): [string, unknown, unknown] => ['look_at_screen', {}, ok(`page ${n}`)]
    expect(kinds(feed([press, look(1), press, look(2), press, look(3), press, look(4)])).every((k) => k === null)).toBe(true)
  })
})

describe('repeated text', () => {
  const stream = (chunks: string[]) => {
    const d = makeDetector()
    return chunks.map((c) => d.text(c)).find((f) => f) ?? null
  }

  test('the same 50 characters 10 times close together pause the reply', () => {
    const line = 'I will now check the file again to be sure it is right. '
    expect(line.length).toBeGreaterThan(50)
    const found = stream(Array.from({ length: 12 }, () => line))
    expect(found).toMatchObject({ kind: 'pause', signal: 'repeated_text', reason: 'It started writing the same text over and over.' })
  })

  test('streamed in small pieces, it is found all the same', () => {
    const text = 'Let me try that one more time, carefully. '.repeat(20)
    const pieces = text.match(/.{1,7}/gs)!
    expect(stream(pieces)).toMatchObject({ signal: 'repeated_text' })
  })

  test('nine times is not yet a loop, and ordinary prose never is', () => {
    const line = 'A sentence of more than fifty characters that comes back. '
    expect(stream(Array.from({ length: 9 }, () => line))).toBeNull()
    const prose = Array.from({ length: 200 }, (_, i) => `Point ${i} is about something else entirely, number ${i * 7}. `)
    expect(stream(prose)).toBeNull()
  })

  test('code blocks, artifacts, tables, lists and rules repeat by nature and are not counted', () => {
    const row = '  { "name": "item", "price": 10, "tags": ["a", "b"] },\n'
    expect(stream(['```json\n', ...Array.from({ length: 30 }, () => row), '```\n'])).toBeNull()
    expect(stream(['<artifact identifier="x" title="X">\n', ...Array.from({ length: 30 }, () => '<li class="card"><span class="dot"></span>Item</li>\n'), '</artifact>'])).toBeNull()
    expect(stream(Array.from({ length: 30 }, () => '\n| cell one | cell two | cell three | cell four |'))).toBeNull()
    expect(stream(Array.from({ length: 30 }, () => '\n- the same list item, written out at some length here'))).toBeNull()
    expect(stream(['='.repeat(800)])).toBeNull()
  })

  test('a tool call in between starts the text count again', () => {
    const d = makeDetector()
    const line = 'I will now check the file again to be sure it is right. '
    for (let i = 0; i < 6; i++) expect(d.text(line)).toBeNull()
    d.toolCall({ name: 'read', input: { i: 1 }, output: ok('x'), isError: false })
    for (let i = 0; i < 6; i++) expect(d.text(line)).toBeNull()
  })
})

describe('checkpoint schedule', () => {
  const j = (verdict: JudgeReply['verdict'], confidence: number) => ({ verdict, confidence })

  test('the first checkpoint is after 30 model calls, then every 10', () => {
    expect(CHECKPOINTS).toMatchObject({ first: 30, every: 10, afterUnclear: 5, whileProgressing: 15, confidence: 0.9 })
    expect(checkpointAfter(null, null)).toBe(30)
    // A judge that failed: carry on, look again in 10.
    expect(checkpointAfter(30, null)).toBe(40)
    expect(decide(null)).toEqual({ action: 'carry_on', gap: 10 })
  })

  test('15 while clearly progressing, 10 while less sure', () => {
    expect(decide(j('progressing', 0.95))).toEqual({ action: 'carry_on', gap: 15 })
    expect(checkpointAfter(30, j('progressing', 0.95))).toBe(45)
    expect(decide(j('progressing', 0.6))).toEqual({ action: 'carry_on', gap: 10 })
  })

  test('5 after an unclear check, with a nudge', () => {
    expect(decide(j('unclear', 0.8))).toEqual({ action: 'nudge', gap: 5 })
    expect(checkpointAfter(40, j('unclear', 0.5))).toBe(45)
  })

  test('stuck pauses only at 90% confidence; less sure counts as unclear', () => {
    expect(decide(j('stuck', 0.9)).action).toBe('pause')
    expect(decide(j('stuck', 0.89))).toEqual({ action: 'nudge', gap: 5 })
  })

  test('the starting thresholds', () => {
    expect(THRESHOLDS).toEqual({ sameResult: 4, sameCall: 5, errorNudge: 3, errorPause: 4, alternating: 6, textChunk: 50, textRepeats: 10 })
  })
})

describe('judge', () => {
  test('reads the JSON reply, around any words, and clamps what it can', () => {
    expect(parseJudgement('Here: {"done":"a","left":"b","closer":"closer","verdict":"stuck","confidence":1.4,"why":"It keeps   rereading the file."} ok')).toEqual({
      verdict: 'stuck',
      confidence: 1,
      closer: 'closer',
      done: 'a',
      left: 'b',
      why: 'It keeps rereading the file.',
      nudge: undefined
    })
    expect(parseJudgement('{"verdict":"unclear","closer":"sideways"}')).toMatchObject({ verdict: 'unclear', confidence: 0, closer: 'same' })
    expect(parseJudgement('{"verdict":"maybe"}')).toBeNull()
    expect(parseJudgement('not json')).toBeNull()
    expect(parseJudgement('{broken')).toBeNull()
  })

  test('the prompt carries the task, earlier notes and the trail', () => {
    const note: ProgressNote = { sessionId: 's', messageId: 'm', step: 30, done: 'Set up', left: 'Tests', closer: 'closer', verdict: 'progressing', confidence: 0.9, createdAt: 0 }
    const p = judgePrompt({ task: 'Build it', step: 40, trail: ['[39] read {} → ok', '[40] wrote: hi'], notes: [note] })
    expect(p).toContain('<task>\nBuild it\n</task>')
    expect(p).toContain('- At step 30: done: Set up Left: Tests (closer, progressing)')
    expect(p).toContain('made 40 model calls')
    expect(p).toContain('[39] read {} → ok\n[40] wrote: hi')
  })
})

describe('watch', () => {
  const setup = (judge?: (step: number) => JudgeReply | null) => {
    const notes: ProgressNote[] = []
    const pauses: Array<Pause & { sessionId: string; messageId: string }> = []
    const stops: Pause[] = []
    const judged: number[] = []
    const w = makeWatch(
      {
        judge: judge ? { judge: async (input) => (judged.push(input.step), judge(input.step)) } : null,
        notes: { add: (n) => void notes.push(n), recent: () => notes.slice(-3) },
        pauses: { record: (p) => void pauses.push(p) },
        now: () => 7
      },
      { sessionId: 's1', messageId: 'm1', task: 'Do it' },
      { stop: (p) => void stops.push(p) }
    )
    let n = 0
    /** One model call making one tool call, reported through its hook. */
    const callHook = (name: string, input: unknown, output: unknown, isError = false) => {
      const id = `t${++n}`
      w.step(`msg${n}`)
      w.call(id, name, input)
      return w.hook(id, name, input, output, isError)
    }
    return { w, notes, pauses, stops, judged, callHook }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test('a nudge goes out with the hook that found it; a pause stops at the hook and is recorded', () => {
    const t = setup()
    const fail = () => t.callHook('mcp__computer__click', { x: 1 }, 'No window', true)
    expect(fail()).toEqual({ context: null, stop: null })
    expect(fail()).toEqual({ context: null, stop: null })
    expect(fail().context).toContain('failed 3 times in a row')
    const last = fail()
    expect(last.stop).toEqual({ signal: 'same_error', reason: 'It kept getting the same error from click: “No window”', step: 4 })
    expect(t.w.paused).toEqual(last.stop)
    expect(t.pauses).toEqual([{ ...last.stop!, sessionId: 's1', messageId: 'm1' }])
    // Claude Code going on after continue:false is stopped the hard way.
    t.w.step('msg-after')
    expect(t.stops).toEqual([last.stop!])
  })

  test('a result from the stream counts once: after its hook it is ignored; without one, a pause stops the reply directly', () => {
    const t = setup()
    for (let i = 0; i < 3; i++) {
      t.callHook('look', {}, ok('same'))
      t.w.result(`t${i + 1}`, ok('same'), false)
    }
    expect(t.w.paused).toBeNull()
    // A refused call has no hook: the stream reports it.
    t.w.step('msg4')
    t.w.call('t4', 'look', {})
    t.w.result('t4', ok('same'), false)
    expect(t.stops).toMatchObject([{ signal: 'same_result', step: 4 }])
  })

  test('repeated text stops the reply directly', () => {
    const t = setup()
    t.w.step('msg1')
    for (let i = 0; i < 12; i++) t.w.text('I will now check the file again to be sure it is right. ')
    expect(t.stops).toMatchObject([{ signal: 'repeated_text', step: 1 }])
    expect(t.pauses).toHaveLength(1)
  })

  test('checkpoints: judged at 30, then on the schedule; notes kept; unclear nudges at the next hook', async () => {
    const t = setup((step) => ({ verdict: step === 30 ? 'unclear' : 'progressing', confidence: 0.95, done: `done by ${step}`, left: 'more', closer: 'closer', nudge: 'Try the other file.' }))
    for (let i = 1; i <= 29; i++) t.callHook('read', { i }, ok(`r${i}`))
    expect(t.judged).toEqual([])
    t.callHook('read', { i: 30 }, ok('r30'))
    expect(t.judged).toEqual([30])
    await tick()
    expect(t.notes).toMatchObject([{ sessionId: 's1', messageId: 'm1', step: 30, done: 'done by 30', verdict: 'unclear', createdAt: 7 }])
    expect(t.callHook('read', { i: 31 }, ok('r31')).context).toBe('Try the other file.')
    // Unclear: the next look is 5 steps on, at 35; progressing clearly then: 15 more, at 50.
    for (let i = 32; i <= 60; i++) {
      t.callHook('read', { i }, ok(`r${i}`))
      await tick()
    }
    expect(t.judged).toEqual([30, 35, 50])
  })

  test('stuck at 90%: the next tool call is paused with the judge’s reason', async () => {
    const t = setup(() => ({ verdict: 'stuck', confidence: 0.92, done: 'little', left: 'all of it', closer: 'same', why: 'It keeps rewriting the same plan.' }))
    for (let i = 1; i <= 30; i++) t.callHook('read', { i }, ok(`r${i}`))
    await tick()
    expect(t.notes).toHaveLength(1)
    const answer = t.callHook('read', { i: 31 }, ok('r31'))
    expect(answer.stop).toEqual({ signal: 'no_progress', reason: 'It keeps rewriting the same plan.', step: 31 })
    expect(t.pauses).toHaveLength(1)
  })

  test('a judge that fails or is cancelled changes nothing', async () => {
    const t = setup(() => {
      throw new Error('offline')
    })
    for (let i = 1; i <= 41; i++) {
      t.callHook('read', { i }, ok(`r${i}`))
      await tick()
    }
    expect(t.judged).toEqual([30, 40])
    expect(t.w.paused).toBeNull()
    t.w.end()
  })

  test('tool output as text, and the note for a continued pause', () => {
    expect(outputText([{ type: 'text', text: 'a' }, { type: 'image', data: 'xx' }])).toBe('a [image]')
    expect(outputText({ content: [{ type: 'text', text: 'b' }], isError: true })).toBe('b')
    expect(outputText('plain')).toBe('plain')
    expect(toolWords('mcp__computer__look_at_screen')).toBe('look at screen')
    expect(toolWords('Bash')).toBe('Bash')
    expect(pauseNote('It made the same click call 4 times.')).toContain('You were paused because you seemed stuck: It made the same click call 4 times.')
  })
})
