// Jobs, as the models see them: the one-line summary each job keeps, the job list the primary
// sees with every message, and what the primary is told in its own conversation and in the
// threads it works in.
//
// Tomo has one continuous chat with the user (the primary's conversation). Everything the user
// says to Tomo goes there; a job, and its thread, opens only when work is handed off with
// start_job, to a worker or to Tomo itself. Reports come back into the chat as turns. Most of the
// tokens of real work are tool results, so keeping them in threads keeps Tomo's chat small.
import { summarizeSteps } from '@shared/steps'
import type { Job } from '@shared/types'

/** Jobs a list shows: the open ones first, then the latest finished. */
export const LIST_OPEN = 12
export const LIST_DONE = 4

/** The jobs a list shows, in this order: the open ones, newest first, then the latest finished. */
export const listedJobs = (jobs: readonly Job[]): Job[] => {
  const byTime = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)
  return [...byTime.filter((j) => j.status === 'open').slice(0, LIST_OPEN), ...byTime.filter((j) => j.status === 'done').slice(0, LIST_DONE)]
}

const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export const SUMMARY_INSTRUCTIONS = `You keep a one-line status for a job: one piece of work a user has going with their assistant. You get the job's title, its status line so far (if any), and its latest exchange. Reply with the new status line alone: one sentence of at most 20 words saying where the job stands (what was done or decided, and what is next if anything), in the conversation's language. No quotes, no lead-in like "Status:".`

const SUMMARY_SOURCE = 1500

export const summaryPrompt = (job: Pick<Job, 'title' | 'summary'>, user: string, reply: string) =>
  `Job: ${oneLine(job.title, 120)}\nStatus so far: ${job.summary ? oneLine(job.summary, 240) : '(none)'}\n\n<user>\n${user.slice(0, SUMMARY_SOURCE)}\n</user>\n<assistant>\n${summarizeSteps(reply).trim().slice(-SUMMARY_SOURCE)}\n</assistant>`

/** Tidies the summary model's reply; null when nothing usable is left. */
export const cleanSummary = (reply: string): string | null => {
  const line = (reply.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^\s*(?:status(?: line)?|summary)\s*[:：]\s*/i, '')
    .trim()
    .replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, '')
    .trim()
  return line ? oneLine(line, 200) : null
}

/** In the system prompt of every job's shared thread a bot answers in; it never changes, so it never breaks the cache. */
export const jobsNote = (botName: string) =>
  `You are ${botName}, the user's assistant. Your work with the user is split into jobs, and this conversation is one job's thread. A message may start with a <jobs> block listing the job you are in and the user's other jobs; it is context only, never something to answer or mention unless the user asks about their jobs.`

/**
 * In the system prompt of the primary's own conversation: its one chat with the user. Quick things
 * it answers there; anything that takes steps it hands off with start_job (to a worker, or to
 * itself), so the tool calls and results of real work stay in the job's thread.
 */
export const chatNote = (botName: string) =>
  `You are ${botName}, the user's assistant, and this is your one continuous chat with the user. Answer quick things here yourself: small talk, questions you can answer from what you know or from memory, a decision, a short piece of writing.
Anything that takes steps you hand off with the team tool start_job: browsing or looking things up, using the computer, making or editing files, research, anything long. You have no browser or computer here; the job's thread does. Hand it to the bot that suits it, or to yourself (bot "yourself") when none does or you have no other bots. Give a whole, self-contained task: the thread can't see this chat, so put in everything the conversation established that the work needs (names, choices, details, what the user wants back). Then tell the user in a line who is on it, and carry on with them: don't wait for it.
When the work is done, its report arrives here as a turn of its own, a <from_bot> message; the user sees it as a card just above your reply. Don't repeat it: tell them the outcome in a sentence or two and anything they need to do or decide. A report of work you handed yourself is that work done, not a new request: don't start another job for it unless the user asks for more.
A message may start with a <jobs> block listing the user's jobs; it is context only, never something to answer or mention unless the user asks about their jobs.`

/**
 * In the system prompt of the primary's own thread on a job it handed itself (a 'worker' session
 * of the primary bot): it works there as a worker does, and its reply is its report.
 */
export const selfJobNote = (botName: string) =>
  `You are ${botName}, the user's assistant, working on a task you handed yourself from your chat with the user. This thread is the job's own: the task arrives as a message from you (a <from_bot> message), and this thread can't see that chat, so the task holds all you know. Do the work here, with your tools. Your reply is your report: when it ends, it goes back to your chat with the user as a turn, and the user sees it there, so make it complete and say what is left. The user may open this thread and write to you here too. A message may start with a <jobs> block listing this job and the user's others; it is context only.`

/**
 * The job list the primary sees with a message: the job this thread is, then the others (titles,
 * status and one-line summaries). In the message rather than the system prompt, so a summary
 * changing after a reply doesn't throw away the conversation's prompt cache.
 */
export const jobsBlock = (current: Job | null, jobs: readonly Job[]): string => {
  const others = listedJobs(jobs).filter((j) => j.id !== current?.id)
  if (!current && others.length === 0) return ''
  const line = (j: Job) => `- [${j.status === 'open' ? 'open' : 'finished'}] ${oneLine(j.title, 80)}${j.summary ? ` — ${oneLine(j.summary, 160)}` : ''}`
  const parts = [current ? `This job: ${oneLine(current.title, 80)}${current.summary ? ` — ${oneLine(current.summary, 160)}` : ''}` : '']
  if (others.length) parts.push(`Other jobs:\n${others.map(line).join('\n')}`)
  return `<jobs>\n${parts.filter(Boolean).join('\n')}\n</jobs>`
}
