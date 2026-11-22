// Which Claude Code session a reply continues, and which messages its prompt has to carry.
//
// Chats are trees (edits, regenerations, forks and Continue add messages), and Claude Code keeps
// a chat's history as sessions. Every reply records its session and the last entry it wrote
// there (its checkpoint). A new turn resumes the session of the reply it answers at that
// checkpoint: in place when that reply is still the newest in its session, on a copy (a fork) when
// the chat has since branched from there. The user message is then all the prompt carries, and
// Claude Code sends the earlier turns, tool calls and results included, as they were, so they come
// from the prompt cache.
//
// Measured with Haiku 5.5 on a chat whose first turn pasted ~10k tokens: the third turn cost
// $0.000118 resumed (62 tokens written to the cache) against $0.000188 with the earlier turns
// sent again as text in a fresh session (about 440 written: Claude Code puts its environment
// block after the user's text, so each turn's cache entry starts over from the newest message).
// Both took 2.6 to 3.4 s, most of it starting Claude Code. A fresh session is still the fallback
// when there is no session to resume: chats from before Claude, and replies that failed before
// writing anything. Its user message then carries the earlier turns as a transcript.
import { summarizeSteps } from '@shared/steps'
import type { Message } from '@shared/types'

/** Where a reply is in Claude Code's sessions. */
export interface AgentPoint {
  session: string
  /** The last entry the reply wrote; null until it wrote one. */
  uuid: string | null
}

export interface SessionLookup {
  point(messageId: string): AgentPoint | null
  /** The reply that started in or last continued the session. */
  tip(session: string): string | null
  /** Claude Code's running total for the session, in dollars. */
  cost(session: string): number
  /** Whether the session's file is still there to resume. */
  exists(session: string): boolean
}

export interface TurnPlan {
  resume: { session: string; at: string; fork: boolean } | null
  baseCost: number
  /** The messages the prompt carries, oldest first. The last is the user message being answered, unless continuing from the reply's own checkpoint. */
  turns: Message[]
  /**
   * What the topic boundary the turns start after hands on to a fresh session (its text), or null.
   * Only when nothing after the boundary is resumed: a resumed session had it in its first prompt.
   */
  carried: string | null
}

/**
 * Topic boundaries. In the primary's conversation, New topic puts a divider in the message tree
 * (an assistant row with post kind 'topic', which answers nothing): the next reply starts a fresh
 * Claude Code session, and nothing before the divider is resumed or carried as transcript. The
 * divider's text, when it has any, is handed to that reply instead (a running summary, say). This
 * is the one place that knows where a conversation's history starts.
 */
export const isTopicStart = (m: Pick<Message, 'role' | 'post'>): boolean => m.role === 'assistant' && m.post?.kind === 'topic'

/** Where the history a reply may see starts in `lineage` (root first): the index of its last topic divider, or -1. */
export const topicStart = (lineage: readonly Pick<Message, 'role' | 'post'>[]): number => lineage.findLastIndex(isTopicStart)

/** A topic divider's text, as the first block of the fresh session after it. */
export const carriedText = (text: string) => `<earlier_topics>\n${text.trim()}\n</earlier_topics>`

/**
 * Plans the reply to the user message that ends `lineage` (root first). `reply` is the
 * assistant message being written; `continuing` when it already has text to carry on from.
 * Nothing before the last topic divider in `lineage` is resumed or carried.
 */
export const planTurn = (lineage: readonly Message[], reply: Message, continuing: boolean, look: SessionLookup): TurnPlan => {
  const resumable = (m: Message) => {
    if (m.role !== 'assistant') return null
    const p = look.point(m.id)
    return p?.uuid && look.exists(p.session) ? { session: p.session, at: p.uuid } : null
  }
  const from = (m: Message, p: { session: string; at: string }) => ({
    resume: { ...p, fork: look.tip(p.session) !== m.id },
    baseCost: look.cost(p.session)
  })
  // A reply cut off after its first checkpoint: its own session has everything up to there.
  const own = continuing ? resumable(reply) : null
  if (own) return { ...from(reply, own), turns: [], carried: null }
  const start = topicStart(lineage)
  for (let i = lineage.length - 1; i > start; i--) {
    const p = resumable(lineage[i]!)
    if (p) return { ...from(lineage[i]!, p), turns: lineage.slice(i + 1), carried: null }
  }
  const mark = start >= 0 ? lineage[start]! : null
  return { resume: null, baseCost: 0, turns: lineage.slice(start + 1), carried: mark?.content.trim() ? mark.content : null }
}

/** In every system prompt, so it never changes between turns (which would miss the cache). */
export const HISTORY_NOTE =
  "If a message starts with earlier turns of this chat inside <user> and <assistant> tags, those are turns you don't have in your history. Answer only what comes after them. Turns inside <post> tags are what the user's bots said in this job's shared thread (who wrote each, and to whom); <from_bot> is a message or report another bot sent you (with the job it is about when it comes outside that job)."

/** A bot's name for a prompt, by id; an unknown (deleted) bot is "a bot". */
export type NameOf = (botId: string | null) => string

/** The job a bot's turn is about, when it arrives outside the job (in the primary's conversation). */
export interface TurnJob {
  id: string
  title: string
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** What a bot sent another bot's thread, as that bot's prompt shows it. */
export const fromBotText = (m: Pick<Message, 'content' | 'authorBotId' | 'post'>, nameOf: NameOf, job: TurnJob | null = null) =>
  `<from_bot name="${nameOf(m.authorBotId)}"${m.post ? ` kind="${m.post.kind}"` : ''}${job ? ` job="${attr(job.title)}" job_id="${job.id}"` : ''}>\n${m.content}\n</from_bot>`

/** An earlier turn written into a prompt, or null when it has nothing to show. */
export const transcriptText = (m: Message, nameOf?: NameOf, job: TurnJob | null = null): string | null => {
  if (m.role === 'user') return m.authorBotId && nameOf ? fromBotText(m, nameOf, job) : `<user>\n${m.content}\n</user>`
  const text = summarizeSteps(m.content).trim()
  if (!text) return null
  if (m.post && nameOf) return `<post from="${nameOf(m.authorBotId)}" to="${m.post.to ? nameOf(m.post.to) : 'everyone'}"${m.post.state ? ` ${m.post.state}` : ''}>\n${text}\n</post>`
  return `<assistant>\n${text}\n</assistant>`
}

/** How much of a cut-off reply's end is quoted back when continuing it from its own session. */
const TAIL_CHARS = 1500

/** Continuing a reply: asks for the rest. `tail` is quoted when the session may not have it all. */
export const continueNote = (tail: string | null) => {
  const ask =
    "Continue it from exactly where it stopped: don't repeat anything you already wrote, don't start over, and don't say that you are continuing."
  if (tail === null) return `Your reply above was cut off. ${ask}`
  const end = summarizeSteps(tail).trimEnd().slice(-TAIL_CHARS)
  return `Your reply was cut off. What you had written ends with:\n<cut_off>\n${end}\n</cut_off>\n${ask}`
}
