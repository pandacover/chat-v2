import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked, type Tokens } from 'marked'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? ''
      const highlighted =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text)
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || 'text')}</span><button type="button" class="copy-code" data-copy>Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`
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

const sanitize = (html: string) =>
  DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy'], FORBID_TAGS: ['style', 'iframe', 'form'] })

export const renderMarkdown = (md: string, streaming = false): string => {
  const source = streaming ? closeOpenFence(md) : md
  return sanitize(marked.parse(source, { async: false }) as string)
}

/** Top-level blocks whose HTML is complete on its own (raw HTML can open a tag in one block and close it in another). */
const SELF_CONTAINED = new Set(['space', 'paragraph', 'heading', 'code', 'list', 'blockquote', 'table', 'hr'])

/**
 * Like renderMarkdown, but as one HTML string per top-level block, each rendered once and
 * remembered by its source. Re-rendering the whole message on every streamed line cost
 * O(length²) (with every code block re-highlighted); this way only the block still being
 * written is redone, and the finished ones keep their DOM.
 */
export const blockRenderer = () => {
  let cache = new Map<string, string>()
  return (md: string, streaming = false): string[] => {
    const tokens = marked.lexer(streaming ? closeOpenFence(md) : md)
    // Reference-style link definitions apply across blocks, so render those messages whole.
    if (Object.keys(tokens.links).length > 0 || tokens.some((t) => !SELF_CONTAINED.has(t.type))) {
      cache = new Map()
      return [renderMarkdown(md, streaming)]
    }
    const next = new Map<string, string>()
    const blocks: string[] = []
    for (const token of tokens) {
      const html = cache.get(token.raw) ?? next.get(token.raw) ?? sanitize(marked.parser([token]))
      next.set(token.raw, html)
      if (html) blocks.push(html)
    }
    // Keep only this pass's blocks, so a streaming block's earlier versions don't pile up,
    // and nothing once the message is finished (it doesn't render again).
    cache = streaming ? next : new Map()
    return blocks
  }
}
