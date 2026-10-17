// Memory: a short profile of the user, learned from their messages.
//
// Every user message goes through two steps in the background, alongside the reply:
//   1. `memorySource`, a local script that strips what the user pasted (code, quotes) and
//      checks the rest talks about the user at all (or answers a question the assistant
//      asked). Most messages stop here, for free.
//   2. A model (Settings → memoryModel) reads what is left, with the facts so far and the
//      assistant's previous message for context, and replies with facts to add, update or
//      remove. Facts naming things the message never mentioned are dropped.
// The profile is sent to the chat model once per chat (see Db.sessionMemoryRev).
import type { MemoryFact } from '@shared/types'
import type { MemoryChange } from './services/Db'

/** Characters of a message the extractor reads; personal details come early, pastes later. */
const SOURCE_CHARS = 2000
/** The end of the assistant's previous message, which is what the user is answering. */
const CONTEXT_CHARS = 600
const FACT_CHARS = 200
/** Facts one message can add; more means the model is transcribing, not remembering. */
const MAX_ADDS = 8

// The user talking about themselves: "I", "my", "call me", contractions, "we"/"our" for family.
const SELF = /\b(?:i|i'm|im|i've|i'd|i'll|me|my|mine|myself|we|we're|our|ours|us)\b/i

/** Whether the assistant's last message ended by asking something; a bare answer ("Berlin") then counts. */
export const askedQuestion = (previous: string | null) => !!previous && previous.slice(-300).includes('?')

/**
 * The part of a message worth reading for facts, or null when there is nothing to read.
 * Code blocks, inline code, quoted passages ("> ") and links are things the user pasted or
 * is asking about, not things they said about themselves. Without "I", "my" and the like
 * a message isn't about the user, unless it answers a question the assistant asked.
 */
export const memorySource = (text: string, answering = false): string | null => {
  const own = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (own.length < 2 || (!answering && (own.length < 4 || !SELF.test(own)))) return null
  return own.slice(0, SOURCE_CHARS)
}

export const MEMORY_INSTRUCTIONS = `You keep a short profile of the user of a chat app. You get the profile so far as numbered facts, sometimes the end of the assistant's previous message inside <assistant> tags (only so you know what the user is answering), then one message the user wrote, inside <message> tags.

Record lasting things the user says about themselves: name, pronouns, where they live, their job and where they study, languages, family and pets, interests and tastes, skills and the tools they use, what they are working on or building (projects, products, research, a company), goals and plans they are pursuing, and how they like answers written.

A message often says several of these at once, in passing. Record each one as its own fact, including the ones mentioned on the way to something else.

Don't record: the request itself (what they ask you to do or answer in this message), errands, hypotheticals, role-play, things about other people that aren't about the user's own life, or what the assistant should do this one time. Never record passwords, API keys, tokens, payment card or bank details, or ID numbers.

Only record what the user's message says. The assistant's message is context: never record something only the assistant said. Never guess, fill in likely details, or repeat anything from these instructions.

Reply with JSON only, in this shape (every part optional):
{"add": ["<new fact>"], "update": [{"id": <number of a fact above>, "fact": "<corrected fact>"}], "remove": [<number of a fact above>]}
Write each fact as one short sentence about the user that starts with a verb ("Is", "Works", "Has", "Prefers", and so on), never with "The user" or their name. Use "update" when the message changes a fact you already have, "remove" when it says a fact is no longer true, and leave out anything already in the profile. Most messages contain nothing worth keeping; then reply {}.`

/** The extractor's user turn: the profile so far, what the assistant last said, then the message. */
export const memoryPrompt = (facts: readonly MemoryFact[], source: string, previous: string | null = null) => {
  const profile = facts.length ? facts.map((f) => `${f.id}. ${f.fact}`).join('\n') : '(empty)'
  const context = previous?.trim() ? `<assistant>\n…${previous.trim().slice(-CONTEXT_CHARS)}\n</assistant>\n\n` : ''
  return `Profile so far:\n${profile}\n\n${context}<message>\n${source}\n</message>`
}

// Things that must never be stored, whatever the model says: card/account-length digit runs,
// key-looking tokens, and anything that calls itself a password or secret.
const SENSITIVE = [
  /\b(?:\d[ -]?){12,19}\b/,
  /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{8,}/,
  /\b[A-Za-z0-9_-]{32,}\b/,
  /\b(?:password|passcode|passphrase|api[ -]?key|secret key|access token|pin code|cvv|iban|ssn|social security)\b/i
]

export const isSensitive = (fact: string) => SENSITIVE.some((re) => re.test(fact))

const cleanFact = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  // "The user's name is Luv" and "User works as…" read as "Name is Luv" and "Works as…".
  let fact = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the\s+)?user(?:['’]s)?\s+/i, '')
  fact = fact.charAt(0).toUpperCase() + fact.slice(1)
  if (fact.length < 3 || isSensitive(fact)) return null
  if (fact.length > FACT_CHARS) fact = `${fact.slice(0, FACT_CHARS - 1).trimEnd()}…`
  return /[.!?…]$/.test(fact) ? fact : `${fact}.`
}

/**
 * Whether the names, places and numbers in a fact come from the message. Small models invent
 * them, or copy them out of their instructions; "Lives in Lisbon." from a message that never
 * mentions Lisbon is dropped. The first word is skipped (sentence case), and so are plain
 * lowercase words, which the model is free to paraphrase.
 */
export const grounded = (fact: string, source: string) => {
  const text = source.toLowerCase()
  return fact
    .split(/\s+/)
    .slice(1)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/u, ''))
    .every((w) => !(/^\p{Lu}/u.test(w) || /\d/.test(w)) || text.includes(w.toLowerCase()))
}

export interface MemoryReading {
  /** null when the reply asks for no change. */
  change: MemoryChange | null
  /** Facts thrown out for naming things the message never mentioned. */
  dropped: string[]
}

/**
 * Reads the extractor's reply leniently: small models wrap JSON in prose or code fences and
 * get field shapes slightly wrong. Ids that aren't in `facts` are dropped, and so are facts
 * not grounded in `source` (the message). Returns null when the reply has no JSON in it.
 */
export const parseMemoryReply = (reply: string, facts: readonly MemoryFact[], source: string): MemoryReading | null => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const ids = new Set(facts.map((f) => f.id))
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const id = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && ids.has(n) ? n : null
  }
  const dropped: string[] = []
  const keep = (raw: unknown) => {
    const fact = cleanFact(raw)
    if (fact && !grounded(fact, source)) dropped.push(fact)
    return fact && grounded(fact, source) ? fact : null
  }
  const add = list(data.add)
    .map((x) => keep(typeof x === 'object' && x ? (x as { fact?: unknown }).fact : x))
    .filter((f): f is string => f !== null)
    .slice(0, MAX_ADDS)
  const update = list(data.update).flatMap((x) => {
    const u = (x && typeof x === 'object' ? x : {}) as { id?: unknown; fact?: unknown }
    const target = id(u.id)
    const fact = keep(u.fact)
    return target !== null && fact ? [{ id: target, fact }] : []
  })
  const remove = list(data.remove).flatMap((x) => {
    const target = id(typeof x === 'object' && x ? (x as { id?: unknown }).id : x)
    return target !== null ? [target] : []
  })
  return { change: add.length || update.length || remove.length ? { add, update, remove } : null, dropped }
}

/** The profile as the chat model sees it, at the end of the system prompt. */
export const profileBlock = (facts: readonly MemoryFact[]) =>
  facts.length === 0
    ? ''
    : `What you know about the user from earlier conversations (it may be out of date; use it where it helps, and don't mention it for its own sake):\n${facts.map((f) => `- ${f.fact}`).join('\n')}`
