// The team tools: how bots hand out work, talk and report, mirroring a thread-orchestration API.
// The primary always has them in its chat with the user (where it hands off anything that takes
// steps, to a worker or to itself); every reply on a job gets them once there is more than one
// bot. They are one more ToolModule; services/Team.ts does the work behind them.
//
//   start_job(bot, task)   primary only: opens a job (or a sub-task of the current one) for a bot,
//                          or for itself ("yourself"): the work runs in that bot's own thread
//   message(text, to)      posts in a job's shared thread, to one bot or everyone; naming a bot
//                          not on the job brings it in
//   list_jobs()            open jobs: title, status, owner, bots on it, one-line summary
//
// No one waits. The app carries what bots say between threads: a post to a bot is its next turn
// (held while it is mid-reply), and a report or message to the primary is a turn in the primary's
// own conversation. So a bot hands work off or asks for help, ends its reply, and the answer
// arrives as a turn of its own.
//
// Workers never open jobs and post only in the job they were given, so every job sits one level
// under the primary. There are no side channels: everything bots say to each other is a post in
// the job's shared thread, which the primary and the user read.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Step } from '@shared/steps'
import type { Bot } from '@shared/types'
import { MODULES } from '@shared/rules'
import type { RunContext, ToolModuleFactory } from './module'

/** What a tool call comes to: the text the model gets, and the step line the user sees. */
export interface TeamResult {
  ok: boolean
  text: string
  step: Step | null
}

/** The work behind the tools (services/Team.ts). */
export interface TeamDeps {
  /** The bot running this reply, the primary, every bot, and where the reply runs. */
  readonly who: (ctx: RunContext) => { me: Bot; primary: Bot; bots: Bot[]; place: TeamPlace }
  readonly startJob: (ctx: RunContext, input: { bot: string; task: string; title?: string | undefined; subTask?: boolean | undefined }) => Promise<TeamResult>
  readonly message: (ctx: RunContext, input: { text: string; to?: string | undefined; thread?: string | undefined }, signal: AbortSignal) => Promise<TeamResult>
  readonly listJobs: (ctx: RunContext) => Promise<TeamResult>
}

const LOAD = 'ToolSearch "select:mcp__team__start_job,mcp__team__message,mcp__team__list_jobs"'

/** One line per bot for the prompt: its name, what it is for (its instructions' first line), its tool modules. */
export const rosterLines = (bots: readonly Bot[], me: Bot) =>
  bots
    .filter((b) => b.id !== me.id)
    .map((b) => {
      const about = (b.instructions ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 160)
      const tools = b.modules.map((m) => MODULES.find((x) => x.id === m)?.label ?? m).join(', ')
      return `- ${b.name}${b.isPrimary ? ' (the primary)' : ''}${about ? `: ${about}` : ''} (tools: ${tools || 'none beyond memory and notes'})`
    })
    .join('\n')

/** Where a reply runs: the primary's chat with the user, a job's shared thread, or a bot's own thread on a job. */
export type TeamPlace = 'chat' | 'thread' | 'own'

/** Names a bot may give start_job to hand the work to itself. */
export const SELF_NAMES = /^(yourself|myself|me|self|you|itself)$/i

/**
 * The prompt section: the primary leads (in its chat with the user, and in a job's shared thread);
 * a worker does the job it was given, and so does the primary in its own thread on a job it
 * handed itself.
 */
export const teamInstructions = (me: Bot, primary: Bot, bots: readonly Bot[], place: TeamPlace = 'chat') => {
  const roster = rosterLines(bots, me)
  if (me.isPrimary && place !== 'own')
    return `You lead a team of bots who work for the user. Load the team tools with ${LOAD}.
- start_job(bot, task, title): opens a new job and hands it the task: to one of your bots, or to yourself (bot "yourself"), when none suits it or you have none. The work runs in the job's own thread, in parallel, while you carry on with the user. Hand off anything that takes steps or will take long, write work included; you don't need to ask the user first. sub_task: true makes it part of the job you are in.
- message(text, to, thread): posts in a job's shared thread, to one bot or to everyone on it. Naming a bot not on the job brings it in. In your chat with the user, name the job with thread (its job_id).
- list_jobs(): the open jobs, their bots and where each stands.
Once you hand work off you don't track it or wait for it: tell the user who is on it and carry on with them. When the work reports back, or a bot writes to you, it arrives in your conversation with the user as a turn of its own, a <from_bot> message naming who sent it, whether it is a report or a message, and its job. The user sees it there as a card just above your reply, so don't repeat it: tell them the outcome in a sentence or two and anything they need to do or decide. If a bot's report calls for a next step, take it; your own report is the work you handed yourself, done.
Everything bots say to each other is in the job's shared thread, which you and the user can read. Give each task whole and self-contained: the job's thread can't see this conversation.
${roster ? `Your bots:\n${roster}` : 'You have no other bots yet: hand work to yourself.'}`
  if (me.isPrimary)
    return `This is your own thread on a job you handed yourself. Load the team tools with ${LOAD}.
- message(text, to): posts in this job's shared thread, to one of your bots or to everyone on it; naming a bot not on the job brings it in. Its answer arrives as your next turn here: end your reply when you need it.
- list_jobs(): the user's open jobs.
You don't open jobs from here, and you post only in this job. If the work needs a job of its own, say so in your report.
${roster ? `Your bots:\n${roster}` : ''}`.trim()
  return `You are ${me.name}, one of the user's bots. ${primary.name}, the primary bot, hands you work on a job; this conversation is your own thread on it, where ${primary.name}, other bots and the user may write to you. Your reply to each message is your report: it goes back to whoever wrote to you, and the user sees it, so make it complete and say what is left. Load the team tools with ${LOAD}.
- message(text, to): posts in your job's shared thread, to one bot or to everyone on it; naming a bot not on the job brings it in. Use it to ask another bot for help or to tell ${primary.name} how it's going.
- list_jobs(): the user's open jobs.
No one waits on anyone. When you ask another bot for something, end your reply there: its answer arrives as your next turn, and your reply to that is your report. Anything written to you while you work comes as a turn after your reply.
You can't open jobs, and you post only in the job you were given: if the work needs a job of its own, say so to ${primary.name}. A request to a bot that can do more than you waits for the user's OK first.
The other bots:
${roster}`
}

const asContent = async (ctx: RunContext, r: TeamResult) => {
  if (r.step) await ctx.step(r.step)
  return { content: [{ type: 'text' as const, text: r.ok ? r.text : `Error: ${r.text}` }], ...(r.ok ? {} : { isError: true }) }
}

const guarded = (ctx: RunContext, f: () => Promise<TeamResult>) =>
  f().then(
    (r) => asContent(ctx, r),
    (e: unknown) => asContent(ctx, { ok: false, text: e instanceof Error ? e.message : String(e), step: null })
  )

/** The tool set, for a reply of any bot. */
export const teamModule =
  (deps: TeamDeps): ToolModuleFactory =>
  (ctx) => {
    const { me, primary, bots, place } = deps.who(ctx)
    const startJob = tool(
      'start_job',
      `Primary only. Opens a job and hands it a task: to one of the user's bots, or to yourself (bot "yourself") when no bot suits it or there are none. The work starts at once in the job's own thread, and its report arrives in your conversation with the user when it is done.`,
      {
        bot: z.string().describe(`The bot's name, or "yourself" to do the work yourself in the job's own thread`),
        task: z.string().describe("The whole task, self-contained: the job's thread sees nothing else"),
        title: z.string().optional().describe('2 to 6 words naming the job'),
        sub_task: z.boolean().optional().describe('Make it a sub-task of the job this conversation is in, rather than a job of its own')
      },
      (a) => guarded(ctx, () => deps.startJob(ctx, { bot: a.bot, task: a.task, title: a.title, subTask: a.sub_task })),
      { searchHint: 'start_job: delegate, hand off work to a bot or to yourself, open a job, do something that takes steps' }
    )
    const message = tool(
      'message',
      "Posts in a job's shared thread, addressed to one bot or to everyone on the job. Naming a bot not on the job brings it in. The answer arrives as a turn of its own after your reply: don't wait for it.",
      {
        text: z.string().describe('The message'),
        to: z.string().optional().describe('The bot it is for, by name, or "everyone" (the default)'),
        thread: z.string().optional().describe('The job, by its id from list_jobs; the one this conversation is on when left out')
      },
      (a) => guarded(ctx, () => deps.message(ctx, { text: a.text, to: a.to, thread: a.thread }, ctx.signal)),
      { searchHint: 'message: post to a bot, ask another bot, reply in the shared thread of a job' }
    )
    const listJobs = tool(
      'list_jobs',
      'The open jobs: id, title, status, owner, the bots on each and a one-line summary.',
      {},
      () => guarded(ctx, () => deps.listJobs(ctx)),
      { searchHint: 'list_jobs: see open jobs, what each bot is working on', annotations: { readOnlyHint: true } }
    )
    return {
      name: 'team',
      instructions: teamInstructions(me, primary, bots, place),
      server: createSdkMcpServer({ name: 'team', version: '1.0.0', tools: [startJob, message, listJobs] })
    }
  }
