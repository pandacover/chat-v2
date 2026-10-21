import { describe, expect, test } from 'bun:test'
import { parseContent } from '../src/shared/artifacts'
import { makeLineBuffer } from '../src/shared/lines'
import { parseSseLine } from '../src/main/sse'
import { splitSteps, stepLine, summarizeSteps } from '../src/shared/steps'
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/main/services/SettingsStore'
import { classify } from '../src/main/services/Attachments'
import { DROPPED_SNAPSHOT, STALE_SNAPSHOT_CHARS, cleanTitle, pruneSnapshots } from '../src/main/services/Chat'
import type { ChatMessage } from '../src/main/services/OpenRouter'
import { clipElements } from '../src/main/agent'

const feed = (deltas: string[]) => {
  const buf = makeLineBuffer()
  const out = deltas.flatMap((d) => buf.push(d))
  return [...out, ...buf.flush()]
}

describe('line buffer', () => {
  test('emits nothing until a newline arrives', () => {
    const buf = makeLineBuffer()
    expect(buf.push('Hel')).toEqual([])
    expect(buf.push('lo')).toEqual([])
    expect(buf.push(' world\nnext')).toEqual(['Hello world'])
    expect(buf.flush()).toEqual(['next'])
    expect(buf.flush()).toEqual([])
  })

  test('handles several lines in one delta and empty lines', () => {
    expect(feed(['a\n\nb\nc'])).toEqual(['a', '', 'b', 'c'])
  })

  test('strips \\r\\n even when split across deltas', () => {
    expect(feed(['one\r', '\ntwo\r\n'])).toEqual(['one', 'two'])
  })

  test('trailing newline produces no phantom empty line', () => {
    expect(feed(['x\n'])).toEqual(['x'])
  })

  test('character-by-character input reassembles identically', () => {
    const text = 'line 1\n```js\nconst a = 1\n```\n\nlast'
    expect(feed(text.split('')).join('\n')).toBe(text)
  })
})

describe('sse', () => {
  test('parses deltas, done, comments and errors', () => {
    expect(parseSseLine(': OPENROUTER PROCESSING')).toEqual([])
    expect(parseSseLine('')).toEqual([])
    expect(parseSseLine('data: [DONE]')).toEqual([{ type: 'done' }])
    expect(parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')).toEqual([{ type: 'delta', text: 'hi' }])
    expect(parseSseLine('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toEqual([])
    expect(parseSseLine('data: {"error":{"message":"rate limited"}}')).toEqual([{ type: 'error', message: 'rate limited' }])
  })

  test('parses the usage chunk OpenRouter sends last', () => {
    const line =
      'data: ' +
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.95, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 1 } }
      })
    expect(parseSseLine(line)).toEqual([
      { type: 'usage', usage: { promptTokens: 194, completionTokens: 2, totalTokens: 196, cachedTokens: 10, reasoningTokens: 1, cost: 0.95 } }
    ])
  })

  test('parses streamed tool-call fragments', () => {
    const first = parseSseLine(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'browser_click', arguments: '' } }] } }] })
    )
    expect(first).toEqual([{ type: 'tool', index: 0, id: 'call_1', name: 'browser_click' }])
    const next = parseSseLine('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ref":' } }] } }] }))
    expect(next).toEqual([{ type: 'tool', index: 0, args: '{"ref":' }])
  })
})

describe('artifacts', () => {
  test('splits text and complete artifacts', () => {
    const blocks = parseContent(
      'Here you go:\n<artifact identifier="clock" title="Clock">\n<!doctype html><p>hi</p>\n</artifact>\nEnjoy.'
    )
    expect(blocks).toEqual([
      { type: 'text', content: 'Here you go:\n' },
      { type: 'artifact', identifier: 'clock', title: 'Clock', kind: 'html', content: '<!doctype html><p>hi</p>', complete: true },
      { type: 'text', content: '\nEnjoy.' }
    ])
  })

  test('marks an unterminated artifact as incomplete and strips code fences', () => {
    const blocks = parseContent('<artifact identifier="a" title="A">\n```html\n<div>')
    expect(blocks).toEqual([{ type: 'artifact', identifier: 'a', title: 'A', kind: 'html', content: '```html\n<div>', complete: false }])
    const fenced = parseContent('<artifact title="B">\n```html\n<b>x</b>\n```\n</artifact>')
    expect(fenced[0]).toMatchObject({ content: '<b>x</b>', identifier: 'artifact-1', complete: true })
  })
})

describe('settings', () => {
  test('falls back to defaults for bad values', () => {
    expect(normalizeSettings({ temperature: 'hot', pdfEngine: 'nope', systemPrompt: 'Be brief.' })).toEqual({
      ...DEFAULT_SETTINGS,
      systemPrompt: 'Be brief.'
    })
    expect(normalizeSettings({ temperature: 9 }).temperature).toBe(2)
  })
})

describe('titles', () => {
  test('strips what small models wrap a title in', () => {
    expect(cleanTitle('Debugging a React hook')).toBe('Debugging a React hook')
    expect(cleanTitle('"Debugging a React hook."')).toBe('Debugging a React hook')
    expect(cleanTitle('\nTitle: **Weekend trip to Goa**.\n\nThis title sums up the request.')).toBe('Weekend trip to Goa')
    expect(cleanTitle('## “Résumé tips”')).toBe('Résumé tips')
    expect(cleanTitle('Why is the sky blue?')).toBe('Why is the sky blue?')
    expect(cleanTitle(' \n"" ')).toBeNull()
    expect(cleanTitle('word '.repeat(20))).toHaveLength(58)
  })
})

describe('attachments', () => {
  test('classifies uploads', () => {
    expect(classify('a.png', 'image/png')).toBe('image')
    expect(classify('doc.pdf', '')).toBe('pdf')
    expect(classify('main.rs', '')).toBe('text')
    expect(classify('data.json', 'application/json')).toBe('text')
    expect(classify('movie.mp4', 'video/mp4')).toBe(null)
  })
})

describe('steps', () => {
  test('step lines group into runs and summarise for history', () => {
    const content = [
      'Let me look.',
      stepLine({ tool: 'browser_navigate', label: 'Opened example.com', ok: true }),
      stepLine({ tool: 'browser_click', label: 'Clicked “Buy”', ok: true }),
      'Done.'
    ].join('\n')
    const segments = splitSteps(content)
    expect(segments.map((s) => s.type)).toEqual(['text', 'steps', 'text'])
    expect(segments[1]).toMatchObject({ steps: [{ label: 'Opened example.com' }, { label: 'Clicked “Buy”' }] })
    expect(summarizeSteps(content)).toBe('Let me look.\n[Used the browser: Opened example.com; Clicked “Buy”]\nDone.')
  })
})

describe('lists', async () => {
  const { continueList, indentList, renumberList } = await import('../src/renderer/src/lib/lists')
  type Edit = { value: string; start: number; end: number } | null
  // `|` marks the caret, in the input and in what comes back.
  const run = (f: (value: string, start: number, end: number) => Edit, text: string) => {
    const at = text.indexOf('|')
    const out = f(text.slice(0, at) + text.slice(at + 1), at, at)
    return out && `${out.value.slice(0, out.start)}|${out.value.slice(out.start)}`
  }
  const enter = (text: string) => run(continueList, text)
  const tab = (text: string) => run((v, s, e) => indentList(v, s, e, false), text)
  const untab = (text: string) => run((v, s, e) => indentList(v, s, e, true), text)

  test('Shift+Enter starts the next item', () => {
    expect(enter('- milk|')).toBe('- milk\n- |')
    expect(enter('* milk|')).toBe('* milk\n* |')
    expect(enter('1. milk|')).toBe('1. milk\n2. |')
    expect(enter('9) milk|')).toBe('9) milk\n10) |')
    expect(enter('  - [x] milk|')).toBe('  - [x] milk\n  - [ ] |')
    // Text after the caret moves to the new item.
    expect(enter('1. milk |and eggs')).toBe('1. milk\n2. |and eggs')
    expect(enter('- |milk')).toBe('- \n- |milk')
  })

  test('a new item in the middle of a numbered list renumbers the ones after it', () => {
    expect(enter('1. a|\n2. b\n   1. nested\n3. c')).toBe('1. a\n2. |\n3. b\n   1. nested\n4. c')
  })

  test('Shift+Enter on an empty item ends the list, or moves a nested one out a level', () => {
    expect(enter('- a\n- |')).toBe('- a\n|')
    expect(enter('1. a\n2. |')).toBe('1. a\n|')
    expect(enter('- a\n- [ ] |')).toBe('- a\n|')
    expect(enter('1. a\n   - b\n   - |')).toBe('1. a\n   - b\n2. |')
    expect(enter('- a\n  - |\n- c')).toBe('- a\n- |\n- c')
  })

  test('Shift+Enter outside a list is an ordinary line break', () => {
    expect(enter('hello|')).toBeNull()
    expect(enter('|- a')).toBeNull()
    expect(enter('-5 degrees|')).toBeNull()
    expect(enter('```\n- a|')).toBeNull()
  })

  test('Tab nests an item under the one before it, Shift+Tab moves it back', () => {
    expect(tab('1. a\n2. b|\n3. c')).toBe('1. a\n   1. b|\n2. c')
    expect(tab('- a\n- b|\n  - c')).toBe('- a\n  - b|\n    - c')
    // It joins a sub-list that is already there, taking its marker.
    expect(tab('1. a\n   - x\n2. b|')).toBe('1. a\n   - x\n   - b|')
    expect(tab('1. a\n   1. x\n2. b|')).toBe('1. a\n   1. x\n   2. b|')
    expect(untab('1. a\n   1. b|\n2. c')).toBe('1. a\n2. b|\n3. c')
    expect(untab('1. a\n   - b|\n2. c')).toBe('1. a\n2. b|\n3. c')
    expect(untab('- a\n  - b|\n    - c')).toBe('- a\n- b|\n  - c')
  })

  test('Tab leaves focus navigation alone when there is nothing to move', () => {
    expect(tab('- first|')).toBeNull()
    expect(tab('plain text|')).toBeNull()
    expect(untab('- top|')).toBeNull()
  })

  test('Tab moves every selected item', () => {
    const value = '1. a\n2. b\n3. c\n4. d'
    const out = indentList(value, value.indexOf('b'), value.indexOf('c') + 1, false)
    expect(out?.value).toBe('1. a\n   1. b\n   2. c\n2. d')
    expect(out && out.value.slice(out.start, out.end)).toBe('b\n   2. c')
  })

  test('renumbering keeps the first number and stops at the end of the list', () => {
    expect(run(renumberList, '1. a\n3. c|')).toBe('1. a\n2. c|')
    expect(run(renumberList, '5. a\n7. b|\n8. c')).toBe('5. a\n6. b|\n7. c')
    expect(run(renumberList, '1. a\n2. b|')).toBeNull()
    expect(run(renumberList, '1. a\n\n1. b|')).toBeNull()
    expect(run(renumberList, 'Pros:\n1. a\nCons:\n1. b|')).toBeNull()
  })
})

describe('quoting', () => {
  test('quotes the selection as Markdown with the reply under it', async () => {
    const { citation } = await import('../src/renderer/src/lib/quote')
    expect(citation('  First paragraph.\n\n\n\nSecond one.  ', ' Why? ')).toBe('> First paragraph.\n>\n> Second one.\n\nWhy?')
    expect(citation('const a = 1\n  return a')).toBe('> const a = 1\n>   return a')
  })
})

describe('pricing', () => {
  test('formats per-million prices', async () => {
    const { money } = await import('../src/renderer/src/lib/pricing')
    expect([15, 3.75, 3, 0.3, 0.25, 0.075, 0.025, 0.0005, 0].map(money)).toEqual(['$15', '$3.75', '$3', '$0.30', '$0.25', '$0.075', '$0.025', '$0.0005', '$0'])
  })
})

describe('browser snapshots', () => {
  const line = (i: number, offscreen = false) => `[e${i}] button "Button number ${i}"${offscreen ? ' offscreen' : ''}`

  test('element lists keep on-screen elements first, in page order, within the budget', () => {
    const lines = [line(1, true), line(2), line(3, true), line(4)]
    expect(clipElements(lines.join('\n'))).toBe(lines.join('\n'))
    const clipped = clipElements(lines.join('\n'), line(2).length + line(4).length + line(1, true).length + 3)
    expect(clipped.split('\n')).toEqual([line(1, true), line(2), line(4), '[1 more elements not listed. Scroll to bring them on screen.]'])
  })

  test('stale snapshots are dropped together once they add up, never the newest', () => {
    const big = 'x'.repeat(STALE_SNAPSHOT_CHARS / 2)
    const snaps = [{ role: 'tool', content: big }, { role: 'tool', content: big }] as ChatMessage[]
    pruneSnapshots(snaps)
    expect(snaps.map((m) => m.content)).toEqual([big, big])
    snaps.push({ role: 'tool', content: big } as ChatMessage, { role: 'tool', content: 'newest' } as ChatMessage)
    const all = [...snaps]
    pruneSnapshots(snaps)
    expect(all.map((m) => m.content)).toEqual([DROPPED_SNAPSHOT, DROPPED_SNAPSHOT, DROPPED_SNAPSHOT, 'newest'])
    expect(snaps.map((m) => m.content)).toEqual(['newest'])
  })
})
