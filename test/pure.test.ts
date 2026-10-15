import { describe, expect, test } from 'bun:test'
import { parseContent } from '../src/shared/artifacts'
import { makeLineBuffer } from '../src/shared/lines'
import { parseSseLine } from '../src/main/sse'
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/main/services/SettingsStore'
import { classify } from '../src/main/services/Attachments'

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
    expect(parseSseLine(': OPENROUTER PROCESSING')).toEqual({ type: 'ignore' })
    expect(parseSseLine('')).toEqual({ type: 'ignore' })
    expect(parseSseLine('data: [DONE]')).toEqual({ type: 'done' })
    expect(parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')).toEqual({ type: 'delta', text: 'hi' })
    expect(parseSseLine('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toEqual({ type: 'ignore' })
    expect(parseSseLine('data: {"error":{"message":"rate limited"}}')).toEqual({ type: 'error', message: 'rate limited' })
  })
})

describe('artifacts', () => {
  test('splits text and complete artifacts', () => {
    const blocks = parseContent(
      'Here you go:\n<artifact identifier="clock" title="Clock">\n<!doctype html><p>hi</p>\n</artifact>\nEnjoy.'
    )
    expect(blocks).toEqual([
      { type: 'text', content: 'Here you go:\n' },
      { type: 'artifact', identifier: 'clock', title: 'Clock', content: '<!doctype html><p>hi</p>', complete: true },
      { type: 'text', content: '\nEnjoy.' }
    ])
  })

  test('marks an unterminated artifact as incomplete and strips code fences', () => {
    const blocks = parseContent('<artifact identifier="a" title="A">\n```html\n<div>')
    expect(blocks).toEqual([{ type: 'artifact', identifier: 'a', title: 'A', content: '```html\n<div>', complete: false }])
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

describe('attachments', () => {
  test('classifies uploads', () => {
    expect(classify('a.png', 'image/png')).toBe('image')
    expect(classify('doc.pdf', '')).toBe('pdf')
    expect(classify('main.rs', '')).toBe('text')
    expect(classify('data.json', 'application/json')).toBe('text')
    expect(classify('movie.mp4', 'video/mp4')).toBe(null)
  })
})
