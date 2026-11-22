// The team tools every bot gets once there is more than one: how bots hand out work, talk and
// report, mirroring a thread-orchestration API. They are one more ToolModule; services/Team.ts
// does the work behind them.
//
//   start_job(bot, task)   primary only: opens a job (or a sub-task of the current one) for a bot
//   message(text, to)      posts in a job's shared thread, to one bot or everyone; naming a bot
//                          not on the job brings it in
//   wait(thread, bot)      waits for a report (or any post) addressed to the caller, with a timeout
//   list_jobs()            open jobs: title, status, owner, bots on it, one-line summary
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

/** How long `wait` waits by default, and at most. */
export const WAIT_DEFAULT_S = 600
export const WAIT_MAX_S = 3600

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
  readonly wait: (ctx: RunContext, input: { thread?: string | undefined; bot?: string | undefined; timeoutSeconds?: number | undefined }, signal: AbortSignal) => Promise<TeamResult>
  readonly listJobs: (ctx: RunContext) => Promise<TeamResult>
}

const LOAD = 'ToolSearch "select:mcp__team__start_job,mcp__team__message,mcp__team__wait,mcp__team__list_jobs"'

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
- start_job(bot, task, title): opens a new job for one of your bots and hands it the task (sub_task: true makes it part of the job you are in). The bot works on it in its own thread, in parallel, and reports back. Hand over any task that suits a bot better or will take long, write work included; you don't need to ask the user first.
- message(text, to, thread): posts in a job's shared thread, to one bot or to everyone on it. Naming a bot not on the job brings it in.
- wait(thread, bot): waits for a bot's report. Wait when you need the result to answer the user; otherwise tell the user who is on it and carry on: the report reaches the user as a card either way.
- list_jobs(): the open jobs, their bots and where each stands.
Everything bots say to each other is in the job's shared thread, which you and the user can read. Give each bot a whole, self-contained task: it can't see this conversation.
Your bots:
${rosterLines(bots, me)}`
    : `You are ${me.name}, one of the user's bots. ${primary.name}, the primary bot, hands you work on a job; this conversation is your own thread on it, where ${primary.name}, other bots and the user may write to you. Your reply to each message is your report: it goes back to whoever wrote to you, and the user sees it, so make it complete and say what is left. Load the team tools with ${LOAD}.
- message(text, to): posts in your job's shared thread, to one bot or to everyone on it; naming a bot not on the job brings it in. Use it to ask another bot for help or to tell ${primary.name} how it's going.
- wait(bot): waits for a bot to answer you.
- list_jobs(): the user's open jobs.
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
      `Primary only. Opens a job for one of the user's bots and hands it a task; the bot starts on it at once, in its own thread, and reports back.`,
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
      "Posts in a job's shared thread, addressed to one bot or to everyone on the job. Naming a bot not on the job brings it in.",
      {
        text: z.string().describe('The message'),
        to: z.string().optional().describe('The bot it is for, by name, or "everyone" (the default)'),
        thread: z.string().optional().describe('The job, by its id from list_jobs; the one this conversation is on when left out')
      },
      (a) => guarded(ctx, () => deps.message(ctx, { text: a.text, to: a.to, thread: a.thread }, ctx.signal)),
      { searchHint: 'message: post to a bot, ask another bot, reply in the shared thread of a job' }
    )
    const wait = tool(
      'wait',
      `Waits for a report or message addressed to you in a job's shared thread, and returns it. Returns at once with anything that came since you last looked; otherwise waits up to the timeout (default ${WAIT_DEFAULT_S} s).`,
      {
        thread: z.string().optional().describe('The job, by its id; the one this conversation is on when left out'),
        bot: z.string().optional().describe('Only from this bot, by name'),
        timeout_seconds: z.number().optional().describe(`How long to wait, at most ${WAIT_MAX_S}`)
      },
      (a) => guarded(ctx, () => deps.wait(ctx, { thread: a.thread, bot: a.bot, timeoutSeconds: a.timeout_seconds }, ctx.signal)),
      { searchHint: 'wait: wait for a bot to report back, get the result of a job', annotations: { readOnlyHint: true } }
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
      server: createSdkMcpServer({ name: 'team', version: '1.0.0', tools: [startJob, message, wait, listJobs] })
    }
  }
