// Parsing of <artifact> blocks the model emits inside assistant messages.

export interface ArtifactBlock {
  type: 'artifact'
  /** Stable identifier; the same id across messages means a new version of one artifact. */
  identifier: string
  title: string
  content: string
  /** False while the closing tag has not streamed in yet. */
  complete: boolean
}

export interface TextBlock {
  type: 'text'
  content: string
}

export type ContentBlock = TextBlock | ArtifactBlock

const OPEN = /<artifact\b([^>]*)>/i
const CLOSE = /<\/artifact>/i

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  return m ? (m[2] ?? m[3] ?? null) : null
}

/** Strips a ```html fence some models wrap around the artifact body. */
const unfence = (body: string): string => {
  const trimmed = body.trim()
  const m = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return m ? (m[1] ?? '') : trimmed
}

export const parseContent = (content: string): ContentBlock[] => {
  const blocks: ContentBlock[] = []
  let rest = content
  let counter = 0
  while (rest.length > 0) {
    const open = OPEN.exec(rest)
    if (!open) {
      blocks.push({ type: 'text', content: rest })
      break
    }
    if (open.index > 0) blocks.push({ type: 'text', content: rest.slice(0, open.index) })
    const attrs = open[1] ?? ''
    const afterOpen = rest.slice(open.index + open[0].length)
    const close = CLOSE.exec(afterOpen)
    counter += 1
    const identifier = attr(attrs, 'identifier') ?? attr(attrs, 'id') ?? `artifact-${counter}`
    const title = attr(attrs, 'title') ?? 'Untitled artifact'
    if (!close) {
      blocks.push({ type: 'artifact', identifier, title, content: unfence(afterOpen), complete: false })
      break
    }
    blocks.push({
      type: 'artifact',
      identifier,
      title,
      content: unfence(afterOpen.slice(0, close.index)),
      complete: true
    })
    rest = afterOpen.slice(close.index + close[0].length)
  }
  return blocks.filter((b) => b.type === 'artifact' || b.content.trim() !== '')
}

export const ARTIFACT_INSTRUCTIONS = `You can create interactive artifacts that the user's app renders live in a sandboxed panel.
Use an artifact for self-contained, interactive or visual output (apps, games, visualizations, UI mockups, charts, simulations) that is longer than a few lines. Do not use artifacts for short code snippets or plain explanations.

Format: wrap a single complete HTML document in an artifact tag, outside any code fence:
<artifact identifier="kebab-case-id" title="Short title">
<!doctype html>
<html>...</html>
</artifact>

Rules:
- Put all CSS and JavaScript inline. External scripts may be loaded from https://cdn.jsdelivr.net, https://unpkg.com or https://cdnjs.cloudflare.com.
- The artifact runs in a sandbox with no access to the app, cookies, localStorage, or parent window. Keep state in memory.
- To update an existing artifact, emit it again in full with the same identifier.
- Keep prose about the artifact brief and outside the tag.`
