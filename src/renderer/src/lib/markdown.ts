import DOMPurify from 'dompurify'
import { Marked, type Tokens } from 'marked'
import { escapeHtml, highlighter } from './highlight.svelte'

const languageOf = (lang: string | undefined) => (lang ?? '').trim().split(/\s+/)[0] ?? ''

/** Code as HTML: highlighted when highlight.js knows the language, escaped otherwise. */
const highlightCode = (text: string, language: string) => {
  const hljs = language ? highlighter.hljs : null
  return hljs && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text)
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = languageOf(lang)
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || 'text')}</span><button type="button" class="copy-code" data-copy>Copy</button></div><pre><code class="hljs">${highlightCode(text, language)}</code></pre></div>`
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens)
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noreferrer">${text}</a>`
    }
  }
})

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

/**
 * While a reply streams, an unclosed ``` fence would swallow the rest of the
 * message, so close it temporarily for rendering.
 */
const closeOpenFence = (md: string) => {
  const fences = md.match(/^\s*(```|~~~)/gm)
  return fences && fences.length % 2 === 1 ? `${md}\n\`\`\`` : md
}

// Set once: passing the config to every sanitize() call made DOMPurify parse it again each time,
// about a fifth of the time it took to open a long chat.
DOMPurify.setConfig({ ADD_ATTR: ['target', 'data-copy'], FORBID_TAGS: ['style', 'iframe', 'form'] })
const sanitize = (html: string) => DOMPurify.sanitize(html)

/**
 * Finished HTML by its Markdown source, for every message in this window: a block's HTML by the
 * block's source, and a whole message's blocks by the message's. Opening a chat again (or going
 * back to one) reuses them instead of parsing, highlighting and sanitizing every message anew.
 * The least recently used go once the cache holds about CACHE_CHARS characters.
 */
const CACHE_CHARS = 8_000_000
const rendered = new Map<string, string | string[]>()
let renderedChars = 0
let renderedHighlighted = false
const sizeOf = (key: string, value: string | string[]) =>
  key.length + (typeof value === 'string' ? value.length : value.reduce((n, s) => n + s.length, 0))
const recall = <V extends string | string[]>(key: string): V | undefined => {
  const value = rendered.get(key)
  if (value === undefined) return undefined
  rendered.delete(key)
  rendered.set(key, value)
  return value as V
}
const keep = (key: string, value: string | string[]) => {
  if (rendered.has(key)) return
  const size = sizeOf(key, value)
  if (size > CACHE_CHARS / 8) return
  rendered.set(key, value)
  renderedChars += size
  for (const [k, v] of rendered) {
    if (renderedChars <= CACHE_CHARS) break
    rendered.delete(k)
    renderedChars -= sizeOf(k, v)
  }
}
/** Code renders plain until highlight.js loads; what was cached before then is dropped. */
const useCache = (highlighted: boolean) => {
  if (highlighted === renderedHighlighted) return
  renderedHighlighted = highlighted
  rendered.clear()
  renderedChars = 0
}
/** Whole messages and blocks are kept under keys that can't meet (a message can be one block). */
const WHOLE = 'w'
const BLOCK = 'b'

export const renderMarkdown = (md: string, streaming = false): string => {
  const source = streaming ? closeOpenFence(md) : md
  return sanitize(marked.parse(source, { async: false }) as string)
}

/** Top-level blocks whose HTML is complete on its own (raw HTML can open a tag in one block and close it in another). */
const SELF_CONTAINED = new Set(['space', 'paragraph', 'heading', 'code', 'list', 'blockquote', 'table', 'hr'])

/**
 * A code block still being written, as its language and its code in pieces of CODE_CHUNK lines
 * (Markdown.svelte draws the box). A piece is highlighted once it is whole and then kept, with its
 * DOM: highlighting, sanitizing and re-creating the whole block on every streamed line made a long
 * one cost more with every line, until the window crawled. Highlighting resumes fresh at each
 * piece, which can colour a construct that spans two pieces wrongly until the block is finished.
 */
export interface WritingCode {
  lang: string
  chunks: string[]
}
export type Block = string | WritingCode
const CODE_CHUNK = 40

/**
 * Like renderMarkdown, but as one HTML string per top-level block, each rendered once and
 * remembered by its source. Re-rendering the whole message on every streamed line cost
 * O(length²) (with every code block re-highlighted); this way only the block still being
 * written is redone, and the finished ones keep their DOM.
 */
export const blockRenderer = () => {
  let cache = new Map<string, string>()
  /** Whole pieces of the code block being written, by language and text. */
  let pieces = new Map<string, string>()
  // The last call's input and output: a message re-renders with the same text whenever its chat
  // reloads (a send, a branch switch, a model change), and finished messages keep no cache.
  let lastMd: string | null = null
  let lastStreaming = false
  let lastBlocks: Block[] = []
  let lastHighlighted = false
  /** `highlighted`: whether highlight.js has loaded; blocks rendered before it are redone once. */
  return (md: string, streaming = false, highlighted = true): Block[] => {
    if (highlighted !== lastHighlighted) {
      lastHighlighted = highlighted
      lastMd = null
      cache = new Map()
      pieces = new Map()
    }
    if (md === lastMd && streaming === lastStreaming) return lastBlocks
    lastMd = md
    lastStreaming = streaming
    lastBlocks = render(md, streaming)
    return lastBlocks
  }

  function writingCode(code: Tokens.Code): WritingCode {
    const language = languageOf(code.lang)
    const lines = code.text.split('\n')
    const next = new Map<string, string>()
    const chunks: string[] = []
    for (let at = 0; at < lines.length; at += CODE_CHUNK) {
      const whole = at + CODE_CHUNK < lines.length
      const text = lines.slice(at, at + CODE_CHUNK).join('\n') + (whole ? '\n' : '')
      const key = `${language}\u0000${text}`
      const html = (whole ? pieces.get(key) : undefined) ?? highlightCode(text, language)
      if (whole) next.set(key, html)
      chunks.push(html)
    }
    pieces = next
    return { lang: language || 'text', chunks }
  }

  function render(md: string, streaming: boolean): Block[] {
    useCache(lastHighlighted)
    const known = streaming ? undefined : recall<string[]>(WHOLE + md)
    if (known) {
      cache = new Map()
      return known
    }
    const tokens = marked.lexer(streaming ? closeOpenFence(md) : md)
    // Reference-style link definitions apply across blocks, so render those messages whole.
    if (Object.keys(tokens.links).length > 0 || tokens.some((t) => !SELF_CONTAINED.has(t.type))) {
      cache = new Map()
      const whole = [renderMarkdown(md, streaming)]
      if (!streaming) keep(WHOLE + md, whole)
      return whole
    }
    const next = new Map<string, string>()
    const blocks: Block[] = []
    // While streaming, the last block is still being written, so it stays out of the shared cache
    // (each line would add a version of it).
    const writing = streaming ? tokens.findLastIndex((t) => t.type !== 'space') : -1
    for (const [i, token] of tokens.entries()) {
      if (i === writing && token.type === 'code') {
        blocks.push(writingCode(token as Tokens.Code))
        continue
      }
      let html = cache.get(token.raw) ?? next.get(token.raw) ?? (i === writing ? undefined : recall<string>(BLOCK + token.raw))
      if (html === undefined) {
        // A code block's HTML is all made here, its code escaped by highlight.js or escapeHtml:
        // nothing in it to sanitize, and sanitizing a long highlighted block was most of its cost.
        const made = marked.parser([token])
        html = token.type === 'code' ? made : sanitize(made)
        if (i !== writing) keep(BLOCK + token.raw, html)
      }
      next.set(token.raw, html)
      if (html) blocks.push(html)
    }
    if (!streaming) keep(WHOLE + md, blocks as string[])
    if (writing === -1 || tokens[writing]?.type !== 'code') pieces = new Map()
    // Keep only this pass's blocks, so a streaming block's earlier versions don't pile up,
    // and nothing once the message is finished (it doesn't render again).
    cache = streaming ? next : new Map()
    return blocks
  }
}
