// The team tools every bot gets once there is more than one: how bots hand out work, talk and
// report, mirroring a thread-orchestration API. They are one more ToolModule; services/Team.ts
// does the work behind them.
//
//   start_job(bot, task)   primary only: opens a job (or a sub-task of the current one) for a bot
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
  /** The bot running this reply, the primary, and every bot. */
  readonly who: (ctx: RunContext) => { me: Bot; primary: Bot; bots: Bot[] }
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

/** The prompt section: the primary leads; a worker does the job it was given. */
export const teamInstructions = (me: Bot, primary: Bot, bots: readonly Bot[]) =>
  me.isPrimary
    ? `You lead a team of bots who work for the user. Load the team tools with ${LOAD}.
- start_job(bot, task, title): opens a new job for one of your bots and hands it the task (sub_task: true makes it part of the job you are in). The bot works on it in its own thread, in parallel. Hand over any task that suits a bot better or will take long, write work included; you don't need to ask the user first.
- message(text, to, thread): posts in a job's shared thread, to one bot or to everyone on it. Naming a bot not on the job brings it in. In your conversation with the user, name the job with thread (its job_id).
- list_jobs(): the open jobs, their bots and where each stands.
Once you hand work off you don't track it or wait for it: tell the user who is on it and carry on with them. When a bot reports back or writes to you, it arrives in your conversation with the user as a turn of its own, a <from_bot> message naming the bot, whether it is a report or a message, and its job. The user sees it there as a card just above your reply, so don't repeat it: tell them the outcome in a sentence or two and anything they need to do or decide, and if the task calls for a next step, take it.
Everything bots say to each other is in the job's shared thread, which you and the user can read. Give each bot a whole, self-contained task: it can't see this conversation.
Your bots:
${rosterLines(bots, me)}`
    : `You are ${me.name}, one of the user's bots. ${primary.name}, the primary bot, hands you work on a job; this conversation is your own thread on it, where ${primary.name}, other bots and the user may write to you. Your reply to each message is your report: it goes back to whoever wrote to you, and the user sees it, so make it complete and say what is left. Load the team tools with ${LOAD}.
- message(text, to): posts in your job's shared thread, to one bot or to everyone on it; naming a bot not on the job brings it in. Use it to ask another bot for help or to tell ${primary.name} how it's going.
- list_jobs(): the user's open jobs.
No one waits on anyone. When you ask another bot for something, end your reply there: its answer arrives as your next turn, and your reply to that is your report. Anything written to you while you work comes as a turn after your reply.
You can't open jobs, and you post only in the job you were given: if the work needs a job of its own, say so to ${primary.name}. A request to a bot that can do more than you waits for the user's OK first.
The other bots:
${rosterLines(bots, me)}`

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
    const { me, primary, bots } = deps.who(ctx)
    const startJob = tool(
      'start_job',
      `Primary only. Opens a job for one of the user's bots and hands it a task; the bot starts on it at once, in its own thread, and its report arrives in your conversation with the user when it is done.`,
      {
        bot: z.string().describe("The bot's name"),
        task: z.string().describe('The whole task, self-contained: the bot sees nothing else'),
        title: z.string().optional().describe('2 to 6 words naming the job'),
        sub_task: z.boolean().optional().describe('Make it a sub-task of the job this conversation is in, rather than a job of its own')
      },
      (a) => guarded(ctx, () => deps.startJob(ctx, { bot: a.bot, task: a.task, title: a.title, subTask: a.sub_task })),
      { searchHint: 'start_job: delegate, hand a task to another bot, open a job for a worker' }
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
      instructions: teamInstructions(me, primary, bots),
      server: createSdkMcpServer({ name: 'team', version: '1.0.0', tools: [startJob, message, listJobs] })
    }
  }
