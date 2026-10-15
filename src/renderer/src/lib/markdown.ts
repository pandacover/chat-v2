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

export const renderMarkdown = (md: string, streaming = false): string => {
  const source = streaming ? closeOpenFence(md) : md
  const html = marked.parse(source, { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy'], FORBID_TAGS: ['style', 'iframe', 'form'] })
}
