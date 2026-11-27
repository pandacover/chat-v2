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
//   create_bot(...)        primary only, in its chat with the user: a new worker bot, or changes
//   edit_bot(bot, ...)     to one, made only once the user approves them on the approval card
//   approve_for_user(...)  primary only, when the user says so: it answers a job's approvals for
//                          them (agent/deputy.ts), or hands them back
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
import type { Bot, BotPatch, Effort } from '@shared/types'
import { MODULES, RULE_IDS, RULE_ITEMS, type ModuleId, type RuleId, type Rules, type Verdict, cleanRules, ruleValue } from '@shared/rules'
import { MODELS, isClaudeModel, modelName } from '@shared/models'
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
  readonly who: (ctx: RunContext) => { me: Bot; primary: Bot; bots: Bot[]; place: TeamPlace; connections?: Connections | undefined }
  readonly startJob: (ctx: RunContext, input: { bot: string; task: string; title?: string | undefined; subTask?: boolean | undefined }) => Promise<TeamResult>
  readonly message: (ctx: RunContext, input: { text: string; to?: string | undefined; thread?: string | undefined }, signal: AbortSignal) => Promise<TeamResult>
  readonly listJobs: (ctx: RunContext) => Promise<TeamResult>
  /** A new worker (no `bot`), or changes to the one `bot` names, once the user approves them. */
  readonly makeBot: (ctx: RunContext, input: BotInput, signal: AbortSignal) => Promise<TeamResult>
  /** Lets the primary approve for the user on a job (`words`: theirs, quoted), or hands approvals back (null). */
  readonly setApprover: (ctx: RunContext, input: { thread?: string | undefined; words: string | null }) => Promise<TeamResult>
}

const TOOLS = ['start_job', 'message', 'list_jobs']
const APPROVE_TOOL = 'approve_for_user'
const BOT_TOOLS = ['create_bot', 'edit_bot']
const load = (names: readonly string[]) => `ToolSearch "select:${names.map((n) => `mcp__team__${n}`).join(',')}"`
const LOAD = load(TOOLS)

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]

/** What create_bot and edit_bot are given: `bot` names the one to change, and is absent for a new one. */
export interface BotInput {
  bot?: string | undefined
  name?: string | undefined
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  tools?: string[] | undefined
  rules?: Record<string, string> | undefined
}

/**
 * The model's input as a change to a bot (`before` is the bot it changes, null for a new one), or
 * what is wrong with it. Models go by id or name; rules are merged into the bot's own.
 */
export const botPatchFrom = (input: BotInput, before: Bot | null): { patch: BotPatch } | { error: string } => {
  const patch: BotPatch = {}
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 40)
    if (!name) return { error: 'The name is empty.' }
    patch.name = name
  }
  if (input.instructions !== undefined) patch.instructions = input.instructions.trim() || null
  if (input.model?.trim()) {
    const m = input.model.trim()
    const low = m.toLowerCase()
    const id = MODELS.find((x) => x.id === m || x.name.toLowerCase() === low || x.name.split(' ')[0]!.toLowerCase() === low)?.id ?? m
    if (!isClaudeModel(id)) return { error: `“${m}” isn't a Claude model. The models: ${MODELS.map((x) => `${x.name} (${x.id})`).join(', ')}.` }
    patch.model = id
  }
  if (input.effort?.trim()) {
    const e = EFFORTS.find((x) => x === input.effort!.trim().toLowerCase())
    if (!e) return { error: `The effort is one of ${EFFORTS.join(', ')}.` }
    patch.effort = e
  }
  if (input.tools !== undefined) {
    const asked = input.tools.map((t) => t.trim().toLowerCase())
    const unknown = asked.filter((t) => !MODULES.some((m) => m.id === t))
    if (unknown.length) return { error: `There is no tool set called ${unknown.map((u) => `“${u}”`).join(', ')}. The tool sets: ${MODULES.map((m) => m.id).join(', ')}.` }
    patch.modules = MODULES.map((m) => m.id).filter((id) => asked.includes(id))
  }
  if (input.rules !== undefined) {
    const bad = Object.entries(input.rules).filter(([k, v]) => !RULE_ITEMS.has(k as RuleId) || !['allow', 'ask', 'block'].includes(v))
    if (bad.length) return { error: `Rules map these ids to allow, ask or block: ${RULE_IDS.join(', ')}. Not understood: ${bad.map(([k, v]) => `${k}: ${v}`).join(', ')}.` }
    patch.rules = cleanRules({ ...(before?.rules ?? {}), ...input.rules })
  }
  if (before && Object.keys(patch).length === 0) return { error: 'Nothing to change: give at least one of name, instructions, model, effort, tools or rules.' }
  return { patch }
}

const toolsLabel = (ms: readonly ModuleId[]) => ms.map((m) => MODULES.find((x) => x.id === m)?.label ?? m).join(', ') || 'none'
const verdictWord = (v: Verdict) => (v === 'allow' ? 'allowed' : v === 'ask' ? 'asks you' : 'blocked')
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** What the approval card says a change does: a line per thing it sets, before → after when it changes a bot. */
export const describeBotChange = (patch: BotPatch, before: Bot | null): string[] => {
  const lines: string[] = []
  const from = <T>(was: T, now: T, show: (v: T) => string) => (before ? `${show(was)} → ${show(now)}` : show(now))
  if (patch.name !== undefined && patch.name !== before?.name) lines.push(`Name: ${from(before?.name ?? '', patch.name, (v) => v)}`)
  if (patch.model !== undefined && patch.model !== before?.model) lines.push(`Model: ${from(before?.model ?? null, patch.model, (v) => (v ? modelName(v) : 'the default'))}`)
  if (patch.effort !== undefined && patch.effort !== before?.effort) lines.push(`Thinking: ${from(before?.effort ?? null, patch.effort, (v) => v ?? 'the default')}`)
  if (patch.modules !== undefined && (!before || toolsLabel(patch.modules) !== toolsLabel(before.modules))) lines.push(`Tools: ${from(before?.modules ?? [], patch.modules, toolsLabel)}`)
  if (patch.rules !== undefined) {
    const was: Rules = before?.rules ?? {}
    for (const id of RULE_IDS) {
      if (before ? ruleValue(was, id) === ruleValue(patch.rules, id) : patch.rules[id] === undefined) continue
      const item = RULE_ITEMS.get(id)!
      lines.push(`${item.group.label} · ${item.label}: ${from(ruleValue(was, id), ruleValue(patch.rules, id), verdictWord)}`)
    }
  }
  if (patch.instructions !== undefined && patch.instructions !== before?.instructions)
    lines.push(`${before ? 'New instructions' : 'Instructions'}: ${patch.instructions ? cut(patch.instructions, 700) : 'none'}`)
  return lines
}

/** The MCP servers each bot may use (Settings › Connections), by bot id: their names. */
export type Connections = ReadonlyMap<string, readonly string[]>

/** One line per bot for the prompt: its name, what it is for (its instructions' first line), its tool modules and MCP servers. */
export const rosterLines = (bots: readonly Bot[], me: Bot, connections?: Connections) =>
  bots
    .filter((b) => b.id !== me.id)
    .map((b) => {
      const about = (b.instructions ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 160)
      const tools = b.modules.map((m) => MODULES.find((x) => x.id === m)?.label ?? m).join(', ')
      const servers = connections?.get(b.id) ?? []
      const connected = servers.length ? `; MCP servers: ${servers.join(', ')}` : ''
      return `- ${b.name}${b.isPrimary ? ' (the primary)' : ''}${about ? `: ${about}` : ''} (tools: ${tools || 'none beyond memory and notes'}${connected})`
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
export const teamInstructions = (me: Bot, primary: Bot, bots: readonly Bot[], place: TeamPlace = 'chat', connections?: Connections) => {
  const roster = rosterLines(bots, me, connections)
  const mine = connections?.get(me.id) ?? []
  if (me.isPrimary && place !== 'own') {
    const chat = place === 'chat'
    // Its own servers aren't in its chat with the user: work that needs them goes to a job it hands itself.
    const own =
      chat && mine.length
        ? `\nMCP servers the user connected for you: ${mine.join(', ')}. Their tools work in a job's thread, not here: hand yourself a job (bot "yourself") for work that needs them.`
        : ''
    return `You lead a team of bots who work for the user. Load the team tools with ${chat ? load([...TOOLS, ...BOT_TOOLS]) : LOAD}.
- start_job(bot, task, title): opens a new job and hands it the task: to one of your bots, or to yourself (bot "yourself"), when none suits it or you have none. The work runs in the job's own thread, in parallel, while you carry on with the user. Hand off anything that takes steps or will take long, write work included; you don't need to ask the user first. sub_task: true makes it part of the job you are in.
- message(text, to, thread): posts in a job's shared thread, to one bot or to everyone on it. Naming a bot not on the job brings it in. In your chat with the user, name the job with thread (its job_id). On a job you handed yourself, everyone includes your own thread there (or name yourself): that is how you correct, steer or restart that work. A bot mid-reply takes the message in at its next step; one that has finished starts on it again.
- list_jobs(): the open jobs, their bots and where each stands.${
      chat
        ? `
- create_bot(name, instructions, model, effort, tools, rules) and edit_bot(bot, ...): make a new bot, or change one of your bots (not yourself). Use them when the user asks, or when work keeps coming up that a bot of its own would suit and the user agrees to one you suggest. Each shows the user an approval card with exactly what it sets and does nothing until they approve, so don't also ask in text. Give a new bot instructions whose first line says what it is for, and only the tools its work needs. If the user denies it, ask what they'd like instead.`
        : ''
    }
- approve_for_user(thread, user_words, on): only when the user explicitly tells you to approve things for them on a job (load it with ${load([APPROVE_TOOL])}). Then the approvals that job's bots ask for come to you before the user: you approve what their words and the task cover, and leave the rest to them. Quote their words exactly as they wrote them. on: false hands approvals back to them. Never offer or turn it on unasked. Irreversible actions always stay with the user.
Once you hand work off you don't track it or wait for it: tell the user who is on it and carry on with them. When the work reports back, or a bot writes to you, it arrives in your conversation with the user as a turn of its own, a <from_bot> message naming who sent it, whether it is a report or a message, and its job. The user sees it there as a card just above your reply, so don't repeat it: tell them the outcome in a sentence or two and anything they need to do or decide. If a bot's report calls for a next step, take it; your own report is the work you handed yourself, done.
Everything bots say to each other is in the job's shared thread, which you and the user can read. Give each task whole and self-contained: the job's thread can't see this conversation.
${roster ? `Your bots:\n${roster}` : 'You have no other bots yet: hand work to yourself.'}${own}`
  }
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
    const { me, primary, bots, place, connections } = deps.who(ctx)
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
      "Posts in a job's shared thread, addressed to one bot or to everyone on the job (for the primary, everyone includes its own thread on a job it handed itself). Naming a bot not on the job brings it in. A bot that is mid-reply takes it in at its next step; one that has finished starts on it. The answer arrives as a turn of its own after your reply: don't wait for it.",
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
    // Making and changing bots: the primary, in its chat with the user, where the user approves.
    const botFields = {
      instructions: z.string().optional().describe('Its standing instructions (its system prompt). The first line says what it is for: the roster shows it'),
      model: z.string().optional().describe(`A Claude model, by id or name: ${MODELS.map((m) => `${m.id} (${m.note})`).join('; ')}. Left out, the app's default`),
      effort: z.enum(EFFORTS).optional().describe('How long it thinks: low, medium (the usual), high, xhigh, max'),
      tools: z
        .array(z.string())
        .optional()
        .describe(`Its tool sets, replacing what it has: ${MODULES.map((m) => `"${m.id}" (${m.hint})`).join('; ')}. None leaves it memory and job notes`),
      rules: z
        .record(z.string(), z.enum(['allow', 'ask', 'block']))
        .optional()
        .describe(
          `By rule id: allow, ask (the user approves each such call) or block; a rule left out keeps what it was. Rule ids: ${RULE_IDS.map((id) => `${id} (${RULE_ITEMS.get(id)!.label}, default ${RULE_ITEMS.get(id)!.default})`).join('; ')}`
        )
    }
    const createBot = tool(
      'create_bot',
      'Primary only. Makes a new worker bot, once the user approves it on an approval card showing exactly what it sets; until then nothing is made. Use it when the user wants a bot, or agreed to one you suggested.',
      { name: z.string().describe('Its name, short (up to 40 characters)'), ...botFields },
      (a) => guarded(ctx, () => deps.makeBot(ctx, { ...a, bot: undefined }, ctx.signal)),
      { searchHint: 'create_bot: make a new bot, add a worker, set up a bot for a kind of work' }
    )
    const editBot = tool(
      'edit_bot',
      "Primary only. Changes one of the user's bots (not yourself): only what you give changes, and rules merge into its own. The user approves the change on an approval card showing before and after; until then nothing changes.",
      { bot: z.string().describe("The bot's name now"), name: z.string().optional().describe('A new name'), ...botFields },
      (a) => guarded(ctx, () => deps.makeBot(ctx, a, ctx.signal)),
      { searchHint: 'edit_bot: change, modify, rename or reconfigure a bot: its instructions, model, tools or rules' }
    )
    const approveForUser = tool(
      APPROVE_TOOL,
      "Primary only, and only when the user explicitly says you may approve things for them on a job. Their approvals there (commands, file changes, web actions, requests between bots) then come to you first: you approve what their words and the job's task cover, and the rest still goes to them. Irreversible actions always stay with the user. on: false hands approvals back.",
      {
        thread: z.string().optional().describe('The job, by its id from list_jobs; the one this conversation is on when left out'),
        user_words: z.string().optional().describe("The user's own words saying you may approve for them, copied exactly from their message. Needed to turn it on"),
        on: z.boolean().optional().describe('false hands approvals back to the user; true (the default) lets you approve')
      },
      (a) => guarded(ctx, () => deps.setApprover(ctx, { thread: a.thread, words: a.on === false ? null : (a.user_words ?? '') })),
      { searchHint: 'approve_for_user: approve on the user’s behalf, auto-approve, answer approvals for the user on a job or thread' }
    )
    const botTools = me.isPrimary && place === 'chat' ? [createBot, editBot] : []
    const approveTools = me.isPrimary && place !== 'own' ? [approveForUser] : []
    return {
      name: 'team',
      instructions: teamInstructions(me, primary, bots, place, connections),
      server: createSdkMcpServer({ name: 'team', version: '1.0.0', tools: [startJob, message, listJobs, ...botTools, ...approveTools] })
    }
  }
