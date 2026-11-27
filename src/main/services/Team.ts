// Workers: the bots besides the primary, and how they work together (agent/team.ts has the tools).
//
// A job's shared thread is where bots talk, in the open: each task, message and report is a post
// there, signed by its bot, which the primary and the user read. Each bot on a job also has a
// thread of its own (kind 'worker'), its own Claude Code session: a post addressed to it lands
// there as a turn and starts its reply, or is held while a reply of its runs and answered once that
// ends (Chat.drain), so workers run long, in parallel, and the user can open any of them and steer
// it. When a worker's reply ends, it goes back as a report to whoever wrote to it; a report (or a
// message) to the primary arrives in the primary's own conversation as a turn, which the primary
// answers for the user the same way: at once when it is free, after the reply it is writing
// otherwise. No one waits on anyone: having handed work off, a bot carries on, and the answer
// comes to it as a turn of its own. A worker that asked another worker for something doesn't
// report the reply it asked in; its reply to the answer is its report.
//
// The primary can hand work to itself too: the job is its own, and the work runs in its own thread
// on the job (a 'worker' session of the primary bot), with its tools, as a worker's would. Its reply
// there reports back into its chat with the user, like any worker's.
//
// Access across bots: the primary hands out work freely. A worker asking another worker that can
// do more than it can (agent/rules.ts `exceeds`) is held until the user approves it, on the same
// card as every other approval; the doing bot's own rules still apply as it works. A request that
// keeps bouncing between two bots is stopped (agent/stuck.ts `bouncing`).
//
// The primary makes and changes workers too (create_bot, edit_bot), in its chat with the user, and
// only once the user approves the card that says exactly what the change sets. It never changes
// itself: that stays the user's, in Settings.
import { Cause, Context, Effect, Layer, Option } from 'effect'
import { parseContent } from '@shared/artifacts'
import { splitSteps } from '@shared/steps'
import { RULE_ITEMS } from '@shared/rules'
import type { Bot, BotPatch, Job, JobDetail, Message, Post, Presence, Session } from '@shared/types'
import { type DbError, type NotFound, errorMessage } from '../errors'
import { ComputerUse } from '../computer'
import { exceeds } from '../agent/rules'
import { bouncing } from '../agent/stuck'
import { userSaid } from '../agent/deputy'
import type { RunContext } from '../agent/module'
import { type Connections, SELF_NAMES, type TeamDeps, type TeamPlace, type TeamResult, botPatchFrom, describeBotChange, teamModule } from '../agent/team'
import { LIST_OPEN } from '../jobs'
import { Broadcaster, Chat, titleFrom } from './Chat'
import { McpStore, serverForBot } from './McpStore'
import { Db, type DbApi } from './Db'

/** How long a worker shows as done after its last reply. */
export const DONE_MS = 10 * 60 * 1000
/** How much of a reply a report carries. */
const REPORT_CHARS = 8000

/**
 * A reply's words, without its step lines: what a report says. An artifact it made is named, not
 * carried: it stays in the thread it was made in, and the report goes into a chat.
 */
export const reportText = (content: string) =>
  splitSteps(content)
    .flatMap((s) => (s.type === 'text' ? parseContent(s.content) : []))
    .map((b) => (b.type === 'artifact' ? `(Made “${b.title}”: it's in the job's thread.)` : b.content.trim()))
    .filter(Boolean)
    .join('\n\n')
    .slice(0, REPORT_CHARS)

/** What every bot is doing, from what runs and waits now and each bot's latest reply. */
export const presenceOf = (input: {
  bots: readonly Bot[]
  running: ReadonlyArray<{ botId: string; working: boolean }>
  waitingBot: string | null
  latest: (botId: string) => { status: string; createdAt: number } | null
  now: number
}): Record<string, Presence> =>
  Object.fromEntries(
    input.bots.map((b): [string, Presence] => {
      if (input.waitingBot === b.id) return [b.id, 'waiting']
      const runs = input.running.filter((r) => r.botId === b.id)
      if (runs.some((r) => r.working)) return [b.id, 'working']
      if (runs.length > 0) return [b.id, 'thinking']
      const last = input.latest(b.id)
      if (last?.status === 'paused') return [b.id, 'stuck']
      if (!b.isPrimary && last?.status === 'complete' && input.now - last.createdAt < DONE_MS) return [b.id, 'done']
      return [b.id, 'idle']
    })
  )

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export class Team extends Context.Service<
  Team,
  {
    readonly presence: Effect.Effect<Record<string, Presence>, DbError>
    readonly detail: (jobId: string) => Effect.Effect<JobDetail, DbError | NotFound>
    readonly createBot: (patch: BotPatch) => Effect.Effect<Bot[], DbError>
    /** Stops what the bot is doing and deletes it (never the primary). */
    readonly removeBot: (id: string) => Effect.Effect<Bot[], DbError>
    readonly setPrimary: (id: string) => Effect.Effect<Bot[], DbError>
    /**
     * At startup: what the last run left held is delivered. Posts a worker never got become its
     * turns (what it got is read from its own thread, not remembered), and every thread that ends
     * with turns nothing answered yet is answered. Returns how many threads started a reply.
     */
    readonly resume: Effect.Effect<number, DbError>
  }
>()('chat-v2/Team') {
  static readonly layer = Layer.effect(
    Team,
    Effect.gen(function* () {
      const db = yield* Db
      const chat = yield* Chat
      // The MCP servers each bot may use, for the roster; optional, so a test without it runs as before.
      const mcp = Option.getOrNull(yield* Effect.serviceOption(McpStore))
      const connections = (bots: readonly Bot[]): Connections | undefined => {
        if (!mcp) return undefined
        const servers = Effect.runSync(mcp.list.pipe(Effect.orElseSucceed(() => [])))
        if (servers.length === 0) return undefined
        return new Map(bots.map((b) => [b.id, servers.filter((s) => serverForBot(s, b.id)).map((s) => s.name)]))
      }
      const computer = yield* ComputerUse
      const broadcaster = yield* Broadcaster

      const sync = <A>(f: (d: DbApi) => A): A => Effect.runSync(db.use(f))
      const changed = (...threads: Array<string | null | undefined>) => {
        broadcaster.send({ type: 'jobs' })
        for (const id of new Set(threads)) if (id) broadcaster.send({ type: 'thread', sessionId: id })
      }

      // Presence: worked out again whenever replies start, end or call tools, or an approval waits.
      let shown = ''
      let presenceTimer: ReturnType<typeof setTimeout> | undefined
      const presenceWith = (d: DbApi) => {
        const waiting = computer.waiting()
        return presenceOf({
          bots: d.listBots(),
          running: chat.running(),
          waitingBot: waiting ? d.botOf(waiting.sessionId).id : null,
          latest: d.latestReply,
          now: Date.now()
        })
      }
      const currentPresence = () => sync(presenceWith)
      const pushPresence = () => {
        clearTimeout(presenceTimer)
        presenceTimer = setTimeout(() => {
          try {
            const presence = currentPresence()
            const json = JSON.stringify(presence)
            if (json === shown) return
            shown = json
            broadcaster.send({ type: 'presence', presence })
          } catch {}
        }, 60)
      }
      const offActivity = chat.onActivity(pushPresence)
      const offWaiting = computer.subscribe(pushPresence)
      // Done wears off into idle.
      const tick = setInterval(pushPresence, 60_000)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          offActivity()
          offWaiting()
          clearInterval(tick)
          clearTimeout(presenceTimer)
        })
      )

      /**
       * Worker replies that asked another worker for something: they end there and don't report,
       * as the answer comes back as the worker's next turn and its reply to that is the report.
       * (A reply cut off by quitting doesn't report anyway, so this needn't outlive the run.)
       */
      const asking = new Set<string>()

      const findBot = (bots: readonly Bot[], name: string) => bots.find((b) => b.id === name || same(b.name, name)) ?? null
      const nameList = (bots: readonly Bot[]) => bots.map((b) => b.name).join(', ')

      /** The job a call is about: the one named (by id, or by title), else the one the reply is on. */
      const jobFor = (d: DbApi, ctx: RunContext, thread: string | undefined): Job | null => {
        if (!thread?.trim()) return ctx.jobId ? (d.getJob(ctx.jobId) ?? null) : null
        const t = thread.trim()
        return d.getJob(t) ?? d.listJobs().find((j) => same(j.title, t)) ?? null
      }

      const fail = (text: string): TeamResult => ({ ok: false, text, step: null })

      /**
       * Hands a post to `to` in its own thread on `job`, bringing it onto the job if it wasn't: as
       * its next turn, which starts its reply, or waits for the one running there to end.
       */
      const deliver = (job: Job, from: Bot, to: Bot, text: string, kind: Post['kind'], files: readonly string[] = []) =>
        Effect.gen(function* () {
          const thread = sync((d) => d.workerThread(job.id, to.id, true))
          if (!thread) return null
          const turn = yield* chat.queue({ sessionId: thread.id, text, from: from.id, post: { kind, to: to.id, state: null }, attachmentIds: files })
          // Started a reply; reaches the one running there at its next tool call (Chat's steering); or waits for it to end.
          const state: 'started' | 'steering' | 'held' = turn.started ? 'started' : turn.steering ? 'steering' : 'held'
          return { id: thread.id, state }
        })

      /**
       * A report or message to the primary: a turn in its own conversation, which it answers for the
       * user at once, or after the reply it is writing there. The post in the job's shared thread is
       * the job's record; the user sees this one.
       */
      const toPrimary = (from: Bot, text: string, kind: Post['kind'], files: readonly string[] = []) =>
        Effect.gen(function* () {
          const { session, primary } = sync((d) => ({ session: d.primarySession(), primary: d.primaryBot() }))
          yield* chat.queue({ sessionId: session.id, text, from: from.id, post: { kind, to: primary.id, state: null }, via: session.id, attachmentIds: files })
          return session.id
        })

      /**
       * A report or message to the primary about `job`, from a reply in `fromThread`: to the
       * primary's own thread on the job when it works on it itself (a job it handed itself), unless
       * that is where it comes from; to its conversation with the user otherwise.
       */
      const toPrimaryOn = (job: Job, from: Bot, fromThread: string, text: string, kind: Post['kind'], files: readonly string[] = []) =>
        Effect.gen(function* () {
          const primary = sync((d) => d.primaryBot())
          const own = sync((d) => d.workerThread(job.id, primary.id))
          if (own && own.id !== fromThread) return (yield* deliver(job, from, primary, text, kind, files))?.id ?? own.id
          return yield* toPrimary(from, text, kind, files)
        })

      /**
       * Posts in a job's shared thread; `via` also shows it in the primary's conversation (a notice for
       * the user). `files` are attachments it carries (a report's screenshots), bound to it too.
       */
      const post = (job: Job, author: Bot, text: string, p: Post, notice = false, files: readonly string[] = []) =>
        sync((d) => {
          const posted = d.appendPost({ threadId: job.threadId!, authorBotId: author.id, text, post: p, via: notice ? d.primarySession().id : null })
          if (files.length) d.bindAttachments(files, posted.message.id)
          return posted
        })

      /** Two bots passing the same request back and forth: stopped, and the user told in the primary's conversation. */
      const bounced = (job: Job, from: Bot, to: Bot, text: string, kind: Post['kind']) => {
        const recent = sync((d) => d.recentPosts(job.threadId!, 5))
        if (!bouncing([...recent, { from: from.id, to: to.id, text }])) return false
        const primary = sync((d) => d.primaryBot())
        post(job, from, text, { kind, to: to.id, state: 'stopped' })
        post(
          job,
          primary,
          `${from.name} and ${to.name} kept passing the same request back and forth, so I stopped passing it on. Tell me how you'd like them to go on, or open the job to steer them.`,
          { kind: 'report', to: primary.id, state: null },
          true
        )
        return true
      }

      const deps: TeamDeps = {
        who: (ctx) =>
          sync((d) => {
            const kind = d.getSession(ctx.sessionId)?.kind
            const place: TeamPlace = kind === 'primary' ? 'chat' : kind === 'worker' ? 'own' : 'thread'
            const bots = d.listBots()
            return { me: d.botOf(ctx.sessionId), primary: d.primaryBot(), bots, place, connections: connections(bots) }
          }),

        startJob: (ctx, input) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const { me, bots, place } = deps.who(ctx)
              if (!me.isPrimary) {
                const primary = bots.find((b) => b.isPrimary)!
                return fail(`Only ${primary.name}, the primary bot, opens jobs, and you post only in the job you were given. If this needs a job of its own, ask ${primary.name} with message.`)
              }
              if (place === 'own')
                return fail("You're working on a job in its own thread: do the work here, or ask one of your bots on this job with message. If it needs a job of its own, say so in your report.")
              // Answering the report of work it handed itself (and nothing the user said with it), the
              // primary opens nothing again by accident.
              const answering = sync((d) => {
                const reply = d.getMessage(ctx.messageId)
                const lineage = reply?.parentId ? d.lineage(reply.parentId) : []
                const turns: Message[] = []
                for (let i = lineage.length - 1; i >= 0 && lineage[i]!.role === 'user'; i--) turns.push(lineage[i]!)
                return turns
              })
              if (answering.some((m) => m.authorBotId === me.id && m.post?.kind === 'report') && !answering.some((m) => !m.authorBotId))
                return fail("This turn is your own report coming back: the work you handed yourself is done. Tell the user how it went; open another job only when they ask for more.")
              const doer = SELF_NAMES.test(input.bot.trim()) ? me : findBot(bots, input.bot)
              const workers = bots.filter((b) => !b.isPrimary)
              if (!doer) return fail(`There is no bot called “${input.bot}”. ${workers.length ? `Your bots: ${nameList(workers)}, or yourself.` : 'You have no other bots: hand it to yourself.'}`)
              const task = input.task.trim()
              if (!task) return fail('The task is empty.')
              const title = titleFrom(input.title?.trim() || task)
              const { job } = sync((d) =>
                d.createJob({ title, botId: doer.id, threadBotId: me.id, parentJobId: input.subTask ? (ctx.jobId ?? null) : null })
              )
              post(job, me, task, { kind: 'task', to: doer.id, state: null })
              const thread = yield* deliver(job, me, doer, task, 'task')
              changed(job.threadId, thread?.id)
              pushPresence()
              const self = doer.id === me.id
              return {
                ok: true,
                text: self
                  ? `Opened the job “${title}” (id ${job.id}) and started on it yourself, in its own thread. Don't do the work here as well, and don't wait or check on it: its report arrives in your conversation with the user as a turn of its own when it is done. Tell the user you're on it and carry on.`
                  : `Opened the job “${title}” (id ${job.id}) and handed it to ${doer.name}, who has started on it in its own thread. You don't need to wait or check on it: its report arrives in your conversation with the user as a turn of its own when it is done. Tell the user who is on it and carry on.`,
                step: { tool: 'team_start_job', label: self ? `Started “${title}” in its own thread` : `Handed “${title}” to ${doer.name}`, ok: true }
              } satisfies TeamResult
            })
          ),

        message: (ctx, input, signal) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const { me, primary, bots, place } = deps.who(ctx)
              // A worker, or the primary in its own thread on a job: it posts only in that job, and an
              // answer it asks for comes back as its next turn.
              const onlyHere = !me.isPrimary || place === 'own'
              const job = sync((d) => jobFor(d, ctx, input.thread))
              if (!job?.threadId) return fail(input.thread ? `There is no job “${input.thread}”. list_jobs shows them.` : "This conversation isn't on a job: name one with thread.")
              if (onlyHere && job.id !== ctx.jobId) return fail('You post only in the job you are working on.')
              const text = input.text.trim()
              if (!text) return fail('The message is empty.')
              const everyone = !input.to?.trim() || /^(everyone|all|everybody)$/i.test(input.to.trim())
              const to = everyone ? null : findBot(bots, input.to!)
              if (!everyone && !to) return fail(`There is no bot called “${input.to}”. The bots: ${nameList(bots)}.`)
              // The primary's own thread on the job (a job it handed itself), which it steers from its
              // chat or the shared thread like any worker's: by a message to itself, or to everyone.
              const ownThread = me.isPrimary && !onlyHere ? sync((d) => d.workerThread(job.id, me.id)) : null
              if (to?.id === me.id && !ownThread) return fail("That's you.")
              const onJob = sync((d) => d.botsOnJob(job.id)).map((b) => b.botId)
              // Everyone is the workers on the job, and the primary's own thread on it; the primary
              // hears a message addressed to it.
              const recipients = to ? [to] : [...(ownThread ? [me] : []), ...bots.filter((b) => onJob.includes(b.id) && b.id !== me.id && !b.isPrimary)]
              if (recipients.length === 0)
                return fail(
                  `No one else is on “${job.title}”, so a message to everyone would reach no one. Name a bot with to to bring it in${me.isPrimary ? ', or hand the work on with start_job' : `, or tell ${primary.name}`}.`
                )

              // The same request bouncing between two bots goes no further.
              if (to && !me.isPrimary && !to.isPrimary && bounced(job, me, to, text, 'message')) {
                changed(job.threadId, sync((d) => d.primarySession().id))
                return fail(`You and ${to.name} have passed the same request back and forth too many times, so it wasn't passed on. Tell ${primary.name} what is blocking you instead.`)
              }

              // A worker asking a worker that can do more than it can: the user's OK first.
              const stronger = me.isPrimary ? [] : recipients.filter((b) => !b.isPrimary && exceeds(me, b).exceeds)
              const held = stronger.length > 0
              const posted = post(job, me, text, { kind: 'message', to: to?.id ?? null, state: held ? 'held' : null })
              changed(job.threadId)
              if (held) {
                const beyond = [...new Set(stronger.flatMap((b) => exceeds(me, b).beyond))].map((id) => RULE_ITEMS.get(id)?.label.toLowerCase() ?? id)
                const doers = stronger.map((b) => b.name).join(' and ')
                const approved = yield* Effect.promise(() =>
                  Effect.runPromise(
                    computer.ask(
                      { sessionId: ctx.sessionId, messageId: ctx.messageId },
                      `${me.name} asks ${doers} to do what ${me.name} can’t`,
                      `${text.slice(0, 600)}\n\n${doers} may ${beyond.join(', ')}; ${me.name} may not. ${doers}’s own rules still apply.`,
                      'team'
                    ),
                    { signal }
                  ).catch(() => false)
                )
                sync((d) => d.setPostState(posted.message.id, approved ? null : 'declined'))
                changed(job.threadId)
                if (!approved)
                  return {
                    ok: false,
                    text: `The user didn't approve passing this on to ${doers}. Don't ask again another way: tell ${primary.name} or the user what you need.`,
                    step: { tool: 'team_message', label: `Asked ${doers}`, ok: false, denied: true, detail: text.slice(0, 120) }
                  } satisfies TeamResult
              }
              const brought: string[] = []
              const threads: string[] = []
              /** What became of the message in each bot's own thread, for the model. */
              const fates: string[] = []
              for (const b of recipients) {
                const self = b.id === me.id
                if (b.isPrimary && !self) {
                  threads.push(yield* toPrimaryOn(job, me, ctx.sessionId, text, 'message'))
                  continue
                }
                if (!onJob.includes(b.id)) brought.push(b.name)
                const thread = yield* deliver(job, me, b, text, 'message')
                if (!thread) continue
                threads.push(thread.id)
                const name = self ? 'Your own thread on the job' : b.name
                fates.push(
                  thread.state === 'started'
                    ? `${name} started on it.`
                    : thread.state === 'steering'
                      ? `${name} is mid-reply: it gets this with the result of its next tool call and takes it into account then (if it calls none, it answers right after).`
                      : `${name} is mid-reply: it answers this once that reply ends.`
                )
              }
              const asked = recipients.some((b) => !b.isPrimary || b.id === me.id)
              // A worker that asked another: this reply isn't its report; the answer comes first.
              if (asked && onlyHere) asking.add(ctx.messageId)
              changed(job.threadId, ...threads)
              pushPresence()
              const who = to ? (to.id === me.id ? 'your own thread on the job' : to.name) : 'everyone on the job'
              const next = !asked
                ? ''
                : !onlyHere
                  ? ' The answer arrives in your conversation with the user as a turn of its own: carry on meanwhile.'
                  : ' End your reply here if you need the answer: it arrives as your next turn.'
              return {
                ok: true,
                text: `Posted to ${who} in “${job.title}”.${brought.length ? ` ${brought.join(' and ')} joined the job.` : ''}${fates.length ? ` ${fates.join(' ')}` : ''}${next}`,
                step: { tool: 'team_message', label: to?.id === me.id ? `Messaged “${job.title}”` : `Messaged ${who}`, ok: true, detail: text.slice(0, 120) }
              } satisfies TeamResult
            })
          ),

        makeBot: (ctx, input, signal) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const { me, bots, place } = deps.who(ctx)
              if (!me.isPrimary || place !== 'chat') return fail('Only the primary bot makes and changes bots, in its chat with the user.')
              const creating = input.bot === undefined
              const before = creating ? null : findBot(bots, input.bot!)
              if (!creating && !before) return fail(`There is no bot called “${input.bot}”. Your bots: ${nameList(bots.filter((b) => !b.isPrimary)) || 'none yet'}.`)
              if (before?.id === me.id) return fail("You can't change yourself: the user changes you in Settings › Bots.")
              const parsed = botPatchFrom(input, before)
              if ('error' in parsed) return fail(parsed.error)
              const { patch } = parsed
              const newName = patch.name ?? before?.name
              const clash = bots.find((b) => b.id !== before?.id && newName !== undefined && same(b.name, newName))
              if (clash) return fail(`There is already a bot called “${clash.name}”: pick another name.`)
              const lines = describeBotChange(patch, before)
              if (!creating && lines.length === 0) return { ok: true, text: `${before!.name} already has all of that: nothing changed.`, step: null } satisfies TeamResult
              const title = creating ? `${me.name} wants to make a bot, “${patch.name}”` : `${me.name} wants to change ${before!.name}`
              const label = creating ? `Made the bot ${patch.name}` : `Changed ${before!.name}`
              const approved = yield* Effect.promise(() =>
                Effect.runPromise(computer.ask({ sessionId: ctx.sessionId, messageId: ctx.messageId }, title, lines.join('\n')), { signal }).catch(() => false)
              )
              if (!approved)
                return {
                  ok: false,
                  text: `The user didn't approve ${creating ? 'making this bot' : 'this change'}, so nothing changed. Don't try again another way: ask what they'd like instead.`,
                  step: { tool: 'team_bot', label: creating ? `Make the bot ${patch.name}` : `Change ${before!.name}`, ok: false, denied: true }
                } satisfies TeamResult
              const bot = sync((d) => {
                if (creating) return d.createBot(patch)
                d.updateBot(before!.id, patch)
                return d.getBot(before!.id)!
              })
              broadcaster.send({ type: 'bots' })
              pushPresence()
              return {
                ok: true,
                text: creating
                  ? `Made the bot ${bot.name}. It is on your team now: hand it work with start_job. The user can change it in Settings › Bots.`
                  : `Changed ${bot.name}. Its replies from now on run with the change; one running now finishes as it started.`,
                step: { tool: 'team_bot', label, ok: true, detail: lines[0] }
              } satisfies TeamResult
            })
          ),

        setApprover: async (ctx, input) => {
          const { me, place } = deps.who(ctx)
          if (!me.isPrimary || place === 'own') return fail('Only the primary bot approves for the user, from its chat with them or a job’s shared thread.')
          const job = sync((d) => jobFor(d, ctx, input.thread))
          if (!job) return fail(input.thread ? `There is no job “${input.thread}”. list_jobs shows them.` : "This conversation isn't on a job: name one with thread.")
          if (input.words === null) {
            if (job.approvesForUser) sync((d) => d.setJobApprover(job.id, null))
            changed(job.threadId)
            return { ok: true, text: `Approvals on “${job.title}” go to the user again.`, step: { tool: 'team_approver', label: `Approvals on “${job.title}” go to you again`, ok: true } }
          }
          // Only on the user's own words, from their own recent messages here: never a bot's, never made up.
          const said = sync((d) => {
            const reply = d.getMessage(ctx.messageId)
            const lineage = reply?.parentId ? d.lineage(reply.parentId) : []
            return lineage.filter((m) => m.role === 'user' && !m.authorBotId).slice(-6).map((m) => m.content)
          })
          const words = input.words.trim()
          if (!userSaid(words, said))
            return fail(
              "Turn this on only when the user has told you, in their own words, that you may approve things for them. Copy those words exactly into user_words (a few words at least). If they haven't said so, don't turn it on: they'll approve each request themselves."
            )
          sync((d) => d.setJobApprover(job.id, words))
          changed(job.threadId)
          return {
            ok: true,
            text: `You now approve for the user on “${job.title}”: its bots' approvals come to you first. You'll approve what their words and the task cover; the rest, and anything irreversible, still goes to them. They can hand approvals back at any time, by telling you or from the job's bar.`,
            step: { tool: 'team_approver', label: `${me.name} approves for you on “${job.title}”`, ok: true, detail: words.slice(0, 120) }
          }
        },

        listJobs: async () => {
          const { jobs, bots, presence } = sync((d) => ({ jobs: d.listJobs(), bots: d.listBots(), presence: currentPresence() }))
          const name = (id: string | null) => bots.find((b) => b.id === id)?.name ?? 'nobody'
          const open = jobs.filter((j) => j.status === 'open').slice(0, LIST_OPEN)
          const lines = open.map((j) => {
            const on = sync((d) => d.botsOnJob(j.id)).map((b) => `${name(b.botId)} (${presence[b.botId] ?? 'idle'})`)
            return `- ${j.title} [id ${j.id}] · owner ${name(j.ownerBotId)} · bots: ${on.join(', ') || 'none'}${j.summary ? ` — ${j.summary}` : ''}`
          })
          return { ok: true, text: lines.length ? `Open jobs:\n${lines.join('\n')}` : 'There are no open jobs.', step: { tool: 'team_list_jobs', label: 'Looked over the jobs', ok: true } }
        }
      }

      // The primary's own conversation always gets the team tools: it hands off there anything that
      // takes steps, to a worker or to itself, and reports arrive there. Every reply on a job gets
      // them once there is more than one bot.
      const module = teamModule(deps)
      chat.provideTools((session: Session) => (session.kind === 'primary' || (session.jobId && sync((d) => d.listBots().length) > 1) ? [module] : []))

      /**
       * A worker's reply ended: what it said goes back as a report to whoever wrote to it (posted in
       * the job's shared thread, and delivered: to the primary, in its own conversation; to another
       * worker, as its next turn). What was held for it meanwhile is answered next (Chat.drain).
       */
      const report = (messageId: string, status: string, limited = false) =>
        Effect.gen(function* () {
          const wasAsking = asking.delete(messageId)
          const info = sync((d) => {
            const reply = d.getMessage(messageId)
            const thread = reply ? d.getSession(reply.sessionId) : undefined
            if (!reply || !thread || thread.kind !== 'worker' || !thread.jobId || !thread.botId) return null
            const job = d.getJob(thread.jobId)
            const bot = d.getBot(thread.botId)
            // Who asked: the nearest turn that wasn't a report (answering a report reports to whoever asked before it).
            const asked = reply.parentId ? d.lineage(reply.parentId).findLast((m) => m.role === 'user' && m.post?.kind !== 'report') : undefined
            const requester = asked?.authorBotId ? d.getBot(asked.authorBotId) : undefined
            // What the reply made for whoever asked (a screenshot it saved) goes with its report.
            const files = (d.storedAttachmentsFor([reply.id]).get(reply.id) ?? []).map((a) => a.id)
            return job?.threadId && bot ? { reply, job, bot, requester, files } : null
          })
          if (!info) return
          const { reply, job, bot, requester, files } = info
          // Quitting cuts replies off; they report when continued. A reply that asked another bot
          // reports once the answer is in.
          // Paused at a usage limit, it goes on by itself at the reset, and reports when it ends.
          if (!requester || limited || status === 'interrupted' || status === 'streaming' || (wasAsking && status === 'complete')) {
            if (wasAsking && limited) asking.add(messageId)
            return pushPresence()
          }
          const said = reportText(reply.content)
          const text =
            status === 'complete'
              ? said || `${bot.name} finished without saying anything.`
              : status === 'paused'
                ? `${bot.name} paused: ${reply.error ?? 'it seemed stuck.'}${said ? `\n\nSo far:\n${said}` : ''}`
                : status === 'error'
                  ? `${bot.name}'s reply stopped on an error: ${reply.error ?? 'something went wrong.'}\n\nIts work so far is kept in its thread. To pick it up, message ${bot.id === requester.id ? 'the job' : bot.name} asking it to carry on: it continues from where it stopped.${said ? `\n\nSo far:\n${said}` : ''}`
                  : `${bot.name} was stopped.${said ? `\n\nSo far:\n${said}` : ''}`
          if (!requester.isPrimary && bounced(job, bot, requester, text, 'report')) {
            changed(job.threadId, sync((d) => d.primarySession().id))
          } else {
            post(job, bot, text, { kind: 'report', to: requester.id, state: null }, false, files)
            const back = requester.isPrimary
              ? yield* toPrimaryOn(job, bot, reply.sessionId, text, 'report', files)
              : (yield* deliver(job, bot, requester, text, 'report', files))?.id
            changed(job.threadId, back)
          }
          pushPresence()
        }).pipe(
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`A worker's report failed: ${errorMessage(Cause.squash(cause))}`)))
        )
      const offEnd = chat.onReplyEnd(({ messageId, status, limited }) => void Effect.runFork(report(messageId, status, limited)))
      yield* Effect.addFinalizer(() => Effect.sync(offEnd))

      const resume = Effect.gen(function* () {
        // Posts made for a worker that never reached its thread (the app stopped in between): every
        // post before the newest turn a bot sent the thread was delivered, as they go in order.
        const going = new Set<string>()
        const workers = yield* db.use((d) => d.listSessions().filter((s) => s.kind === 'worker' && s.jobId && s.botId))
        for (const thread of workers) {
          const unread = yield* db.use((d) => {
            const job = d.getJob(thread.jobId!)
            if (!job?.threadId || !d.getBot(thread.botId!)) return []
            return d.postsFor(job.threadId, thread.botId!, Math.max(d.lastPostSeq(job.threadId, thread.botId!), d.lastBotTurnSeq(thread.id)))
          })
          for (const { message } of unread) {
            const turn = yield* chat
              .queue({ sessionId: thread.id, text: message.content, from: message.authorBotId!, post: { kind: message.post?.kind ?? 'message', to: thread.botId!, state: null } })
              .pipe(Effect.orElseSucceed(() => null))
            if (turn?.started) going.add(thread.id)
          }
        }
        // Then every thread that ends on turns nothing answered.
        for (const id of yield* db.use((d) => d.heldThreads())) if (yield* chat.drain(id).pipe(Effect.orElseSucceed(() => false))) going.add(id)
        changed(...going)
        pushPresence()
        return going.size
      })

      const bots = db.use((d) => d.listBots())
      return Team.of({
        presence: db.use(presenceWith),
        detail: (jobId) =>
          db.require('Job', (d) => {
            const job = d.getJob(jobId)
            return job ? { job, bots: d.botsOnJob(jobId), notes: d.jobNotes(jobId) } : undefined
          }),
        createBot: (patch) =>
          db.use((d) => d.createBot(patch)).pipe(
            Effect.andThen(bots),
            Effect.tap(() => Effect.sync(pushPresence))
          ),
        removeBot: (id) =>
          Effect.gen(function* () {
            for (const r of chat.running().filter((r) => r.botId === id)) yield* chat.stop(r.messageId)
            yield* db.use((d) => d.deleteBot(id))
            changed()
            pushPresence()
            return yield* bots
          }),
        setPrimary: (id) =>
          db.use((d) => d.setPrimary(id)).pipe(
            Effect.andThen(bots),
            Effect.tap(() => Effect.sync(() => (changed(), pushPresence())))
          ),
        resume
      })
    })
  )
}
