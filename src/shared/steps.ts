// Browser actions taken during a reply are stored as single lines in the message,
// so they persist and stream exactly like text. A line looks like:
//   ::step {"tool":"click","label":"Clicked “Buy now”","ok":true}

export interface Step {
  tool: string
  label: string
  ok: boolean
  detail?: string
}

const PREFIX = '::step '

export const stepLine = (step: Step): string => PREFIX + JSON.stringify(step)

export const parseStep = (line: string): Step | null => {
  if (!line.startsWith(PREFIX)) return null
  try {
    const s = JSON.parse(line.slice(PREFIX.length)) as Partial<Step>
    return typeof s.label === 'string' ? { tool: String(s.tool ?? ''), label: s.label, ok: s.ok !== false, ...(s.detail ? { detail: String(s.detail) } : {}) } : null
  } catch {
    return null
  }
}

export type Segment = { type: 'text'; content: string } | { type: 'steps'; steps: Step[] }

/** Splits message content into prose and runs of consecutive steps. */
export const splitSteps = (content: string): Segment[] => {
  const out: Segment[] = []
  let text: string[] = []
  const flushText = () => {
    if (text.length && text.join('\n').trim()) out.push({ type: 'text', content: text.join('\n') })
    text = []
  }
  for (const line of content.split('\n')) {
    const step = parseStep(line)
    if (!step) {
      text.push(line)
      continue
    }
    flushText()
    const last = out[out.length - 1]
    if (last?.type === 'steps') last.steps.push(step)
    else out.push({ type: 'steps', steps: [step] })
  }
  flushText()
  return out
}

/** History sent back to a model: step lines become one plain-language summary per run. */
export const summarizeSteps = (content: string): string =>
  splitSteps(content)
    .map((s) => (s.type === 'text' ? s.content : `[Used the browser: ${s.steps.map((x) => x.label).join('; ')}]`))
    .join('\n')
