// Browser actions taken during a reply are stored as single lines in the message,
// so they persist and stream exactly like text. A line looks like:
//   ::step {"tool":"click","label":"Clicked “Buy now”","ok":true}

export interface Step {
  tool: string
  label: string
  ok: boolean
  detail?: string
  /** The user said no (an approval they denied): neither done nor failed. */
  denied?: boolean
}

const PREFIX = '::step '

export const stepLine = (step: Step): string => PREFIX + JSON.stringify(step)

export const parseStep = (line: string): Step | null => {
  if (!line.startsWith(PREFIX)) return null
  try {
    const s = JSON.parse(line.slice(PREFIX.length)) as Partial<Step>
    return typeof s.label === 'string'
      ? { tool: String(s.tool ?? ''), label: s.label, ok: s.ok !== false, ...(s.detail ? { detail: String(s.detail) } : {}), ...(s.denied ? { denied: true } : {}) }
      : null
  } catch {
    return null
  }
}

/** One line for a step: what it did and to what ("Click · “Save”"), cut to `max` characters. */
export const stepText = (s: { label: string; detail?: string | undefined }, max = 80): string => {
  const full = s.detail ? `${s.label} · ${s.detail}` : s.label
  return full.length > max ? `${full.slice(0, max - 1).trimEnd()}…` : full
}

export type Segment = { type: 'text'; content: string } | { type: 'steps'; steps: Step[] }

/** Splits message content into prose and runs of consecutive steps. */
export const splitSteps = (content: string): Segment[] => {
  // Most replies have no steps: no need to split them into lines (this runs on every streamed line).
  if (!content.includes(PREFIX)) return /\S/.test(content) ? [{ type: 'text', content }] : []
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

/** Claude Code's own tools, which only computer use brings (its file and web search). */
const COMPUTER_BUILTINS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'WebSearch'])

/** Whether a run of steps used the computer (its tools or the built-ins it brings) or only the browser. */
export const isDesktopRun = (steps: Step[]) => steps.some((s) => s.tool.startsWith('computer_') || COMPUTER_BUILTINS.has(s.tool))

/** Whether a run of steps only searched memory or wrote job notes (agent/recall.ts, agent/notes.ts). */
export const isMemoryRun = (steps: Step[]) => steps.length > 0 && steps.every((s) => s.tool.startsWith('memory_') || s.tool.startsWith('notes_'))

/** Whether a run of steps only worked with the other bots: handing out jobs, messages, waiting (agent/team.ts). */
export const isTeamRun = (steps: Step[]) => steps.length > 0 && steps.every((s) => s.tool.startsWith('team_'))

/** Whether a run of steps only looked at or listened to videos (agent/video.ts). */
export const isVideoRun = (steps: Step[]) => steps.length > 0 && steps.every((s) => s.tool.startsWith('video'))

/** Whether a run of steps only used MCP servers the user connected (agent/mcp.ts). */
export const isMcpRun = (steps: Step[]) => steps.length > 0 && steps.every((s) => s.tool === 'mcp')

/** The servers a run of MCP steps used, by name: a call's label starts "<server> · ", a failed connection's ends with it. */
export const mcpServersOf = (steps: Step[]) => [
  ...new Set(steps.map((s) => (s.label.includes(' · ') ? s.label.split(' · ')[0]! : s.label.replace(/^Couldn't connect to /, ''))))
]

const usedWhat = (steps: Step[]) =>
  isDesktopRun(steps)
    ? 'Used the computer'
    : isMemoryRun(steps)
      ? 'Used memory'
      : isTeamRun(steps)
        ? 'Worked with the bots'
        : isVideoRun(steps)
          ? 'Looked at a video'
          : isMcpRun(steps)
            ? `Used ${mcpServersOf(steps).join(', ')} (MCP)`
            : 'Used the browser'

/** History sent back to a model: step lines become one plain-language summary per run. */
export const summarizeSteps = (content: string): string =>
  splitSteps(content)
    .map((s) => (s.type === 'text' ? s.content : `[${usedWhat(s.steps)}: ${s.steps.map((x) => x.label).join('; ')}]`))
    .join('\n')
