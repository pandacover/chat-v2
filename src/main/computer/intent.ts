import type { Mode } from './tools'

/** "Just do it", "do it for me": the user hands the task over, even mid-lesson. */
const HAND_OVER = /\b(just do it|do it (for me|yourself)|you do it|go ahead and do it)\b/i
/** "Show me how", "how do I", "teach me": the user wants to learn to do it themselves. */
const LEARN =
  /\b(show me (how|where)|teach me|walk me through|talk me through|guide me|how (do|can|could|should|would) i|i want to learn|help me learn|let me do it|i('ll| will) do it myself)\b|^\s*how to\b/i
/** "Can you", "please", "for me": a request for the assistant to act. */
const REQUEST = /\b(can|could|would|will) you\b|\bplease\b|\bfor me\b/i
/** "Next", "ok", "and then…": carries on with what the chat was doing. */
const CARRY_ON = /^\s*(ok(ay)?|next|done|go on|continue|got it|yes|yep|sure|i did it|did it|and|then|now|also|what now|what next|what's next)\b/i

/** A message typed during a Show-me step that hands the rest over ("just do it"). */
export const handsOver = (text: string) => HAND_OVER.test(text)

/**
 * Whether a message asks computer use to do something (do) or to show the user how (teach).
 * `previous` is what the chat's last message was read as; follow-ups like "next" or a plain
 * question keep it, and anything else defaults to doing it.
 */
export const decideMode = (text: string, previous: Mode): Mode => {
  if (handsOver(text)) return 'do'
  if (LEARN.test(text)) return 'teach'
  if (REQUEST.test(text)) return 'do'
  if (CARRY_ON.test(text) || text.trim().endsWith('?')) return previous
  return 'do'
}
