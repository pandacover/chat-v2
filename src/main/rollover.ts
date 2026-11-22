// Keeping Tomo's one chat with the user small.
//
// Claude Code compacts a session by itself, but no lower than about 100k tokens, so Tomo bounds
// its chat instead. While the user is chatting, each reply resumes the same session: the prompt
// cache is warm, and the history reads at about 0.1x the input price. The cache lasts about five
// minutes, and writing it again costs about 1.25x, so once a pause has let it go cold a fresh
// session costs nothing extra. Then, if the session has grown past a budget, the next turn starts
// one (an automatic boundary, history.ts): it is handed a running summary of the chat (kept by the
// small model), the last few exchanges word for word, and as always the job list and the profile.
// What the boundary ends is filed in memory, so recall still finds older detail. The user sees one
// continuous chat: the boundary is never shown. Claude Code's own compaction stays on underneath.
import { summarizeSteps } from '@shared/steps'
import type { Message, SessionKind } from '@shared/types'

/** How long after the last reply ended the prompt cache is taken to have gone cold. */
export const ROLLOVER_GAP_MS = 5 * 60_000
/**
 * How big a session may get before Tomo starts afresh after a pause, in tokens. Tomo's system
 * prompt and tool search come to a few thousand, so this is some 20k of chat: resuming it cold
 * costs about as much as one long message, and a summary of it fits in a few hundred words.
 */
export const ROLLOVER_BUDGET = 25_000
/** Exchanges carried word for word into the fresh session. */
export const CARRIED_EXCHANGES = 3

export interface RolloverLimits {
  gapMs: number
  budget: number
}

const positive = (raw: string | undefined, fallback: number) => {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The limits, which tests and smoke runs may set lower (CHAT_V2_ROLLOVER_GAP_MS, CHAT_V2_ROLLOVER_BUDGET). */
export const rolloverLimits = (env: Record<string, string | undefined> = process.env): RolloverLimits => ({
  gapMs: positive(env.CHAT_V2_ROLLOVER_GAP_MS, ROLLOVER_GAP_MS),
  budget: positive(env.CHAT_V2_ROLLOVER_BUDGET, ROLLOVER_BUDGET)
})

/** Whether a session this big is past the budget (unknown sizes never are). */
export const overBudget = (contextTokens: number | null | undefined, limits: RolloverLimits = rolloverLimits()): boolean =>
  typeof contextTokens === 'number' && contextTokens > limits.budget

/**
 * Whether a new turn in a chat starts a fresh session instead of resuming: only in the primary's
 * own conversation, when the reply it would resume ended more than the gap ago and left its
 * session past the budget. A reply without a known end or size is resumed, as before.
 */
export const shouldRollOver = (
  input: { kind: SessionKind; endedAt: number | null | undefined; contextTokens: number | null | undefined; now: number },
  limits: RolloverLimits = rolloverLimits()
): boolean =>
  input.kind === 'primary' &&
  typeof input.endedAt === 'number' &&
  input.now - input.endedAt > limits.gapMs &&
  overBudget(input.contextTokens, limits)

/** A reply of Tomo's in its chat (not a boundary, a post, or a turn). */
export const isReply = (m: Pick<Message, 'role' | 'post'>) => m.role === 'assistant' && !m.post

/** The last `n` exchanges of a stretch of chat: each is the turns a reply answered, and the reply. */
export const recentExchanges = <M extends Pick<Message, 'role' | 'post'>>(segment: readonly M[], n = CARRIED_EXCHANGES): M[] => {
  const ends = segment.flatMap((m, i) => (isReply(m) ? [i] : []))
  if (ends.length <= n) return [...segment]
  return segment.slice(ends[ends.length - n - 1]! + 1)
}

/** What a boundary hands the fresh session: the summary, then the last turns as they were. */
export const carryText = (summary: string | null, recent: readonly string[]) =>
  [
    summary ? `<summary>\n${summary.trim()}\n</summary>` : '',
    recent.length ? `<recent_turns>\n${recent.join('\n')}\n</recent_turns>` : ''
  ]
    .filter(Boolean)
    .join('\n')

/** The summary a boundary carried, which the next one's summary builds on. */
export const summaryIn = (content: string): string | null => /<summary>\n([\s\S]*?)\n<\/summary>/.exec(content)?.[1]?.trim() || null

export const CHAT_SUMMARY_INSTRUCTIONS = `You keep the running summary of a long chat between a user and their assistant. You get the summary so far (if any) and the turns since, in <user> and <assistant> tags; <from_bot> turns are reports and messages from the assistant's bots about jobs handed to them. Reply with the new summary alone, covering the whole chat: at most 250 words, in the chat's language, as short plain lines. Keep what the user told about themselves and their plans, decisions made, questions still open, what was handed off to which bot and how that went, and anything promised or pending. Drop greetings, small talk and detail that no longer matters. No heading or lead-in.`

/** How much of a stretch's turns the summary model reads: its end, where the news is. */
const SUMMARY_SOURCE = 120_000

export const chatSummaryPrompt = (previous: string | null, turns: string) => {
  const cut = turns.length > SUMMARY_SOURCE
  return `<summary_so_far>\n${previous?.trim() || '(none)'}\n</summary_so_far>\n<turns_since>\n${cut ? '(earlier turns cut)\n' : ''}${turns.slice(-SUMMARY_SOURCE)}\n</turns_since>`
}

/** At most this many words of summary are kept, whatever the model wrote. */
const SUMMARY_WORDS = 320

/** Tidies the summary model's reply; null when nothing usable is left. */
export const cleanChatSummary = (reply: string): string | null => {
  const text = reply
    .trim()
    .replace(/^<\/?summary[^>]*>|<\/?summary[^>]*>$/g, '')
    .replace(/^\s*(?:#+\s*)?(?:new |running |updated )?summary\s*(?:[:：]|\n)\s*/i, '')
    .trim()
  if (!text) return null
  const words = text.split(/(\s+)/)
  return words.length > SUMMARY_WORDS * 2 ? `${words.slice(0, SUMMARY_WORDS * 2).join('').trimEnd()}…` : text
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

/** A stretch of Tomo's chat as memory keeps it: plain lines, each turn with who said it. */
export const segmentRecord = (input: {
  botName: string
  turns: ReadonlyArray<Pick<Message, 'role' | 'content' | 'authorBotId' | 'post' | 'createdAt'>>
  summary: string | null
  nameOf: (botId: string | null) => string
  jobOf: (index: number) => { title: string } | null
}): { title: string; body: string } | null => {
  const lines = input.turns.flatMap((m, i) => {
    if (m.role === 'user') {
      const text = m.content.trim()
      if (!text) return []
      if (!m.authorBotId) return [`User: ${text}`]
      const job = input.jobOf(i)
      return [`${m.post?.kind === 'report' ? 'Report' : 'Message'} from ${input.nameOf(m.authorBotId)}${job ? ` on “${job.title}”` : ''}: ${text}`]
    }
    if (!isReply(m)) return []
    const text = summarizeSteps(m.content).trim()
    return text ? [`${input.botName}: ${text}`] : []
  })
  if (lines.length === 0) return null
  const first = input.turns[0]!.createdAt
  const last = input.turns.at(-1)!.createdAt
  const when = day(first) === day(last) ? day(first) : `${day(first)} to ${day(last)}`
  const body = [input.summary ? `Summary: ${input.summary.trim()}` : '', lines.join('\n\n')].filter(Boolean).join('\n\n')
  return { title: `Chat with ${input.botName}, ${when}`, body }
}
