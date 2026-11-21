// Workers: the bots besides the primary, and how they work together (agent/team.ts has the tools).
//
// A job's shared thread is where bots talk, in the open: each task, message and report is a post
// there, signed by its bot, which the primary and the user read. Each bot on a job also has a
// thread of its own (kind 'worker'), its own Claude Code session: a post addressed to it lands
// there as a turn and starts its reply (or waits for the one running to end), so workers run long,
// in parallel, and the user can open any of them and steer it. When a worker's reply ends, it goes
// back as a report to whoever wrote to it; a report to the primary also shows in the primary's
// conversation, as a card labelled with the job. Nothing there pauses: the primary doesn't answer a
// report unless it is waiting for one (`wait`), and the user's other jobs keep going.
//
// Access across bots: the primary hands out work freely. A worker asking another worker that can
// do more than it can (agent/rules.ts `exceeds`) is held until the user approves it, on the same
// card as every other approval; the doing bot's own rules still apply as it works. A request that
// keeps bouncing between two bots is stopped (agent/stuck.ts `bouncing`).
import { Cause, Context, Effect, Layer } from 'effect'
import { splitSteps } from '@shared/steps'
import { RULE_ITEMS } from '@shared/rules'
import type { Bot, BotPatch, Job, JobDetail, Message, Post, Presence, Session } from '@shared/types'
import { type DbError, type NotFound, errorMessage } from '../errors'
import { ComputerUse } from '../computer'
import { exceeds } from '../agent/rules'
import { bouncing } from '../agent/stuck'
import type { RunContext } from '../agent/module'
import { type TeamDeps, type TeamResult, WAIT_DEFAULT_S, WAIT_MAX_S, teamModule } from '../agent/team'
import { ROUTE_OPEN } from '../jobs'
import { Broadcaster, Chat, titleFrom } from './Chat'
import { Db, type DbApi } from './Db'

/** How long a worker shows as done after its last reply. */
export const DONE_MS = 10 * 60 * 1000
/** How much of a reply a report carries. */
const REPORT_CHARS = 8000

/** A reply's words, without its step lines: what a report says. */
export const reportText = (content: string) =>
  splitSteps(content)
    .flatMap((s) => (s.type === 'text' ? [s.content.trim()] : []))
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
  }
>()('chat-v2/Team') {
  static readonly layer = Layer.effect(
    Team,
    Effect.gen(function* () {
      const db = yield* Db
      const chat = yield* Chat
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

      // What each bot has read of each job's shared thread, so `wait` returns only what is new to it.
      const cursors = new Map<string, number>()
      const cursorKey = (jobId: string, botId: string) => `${jobId}\u0000${botId}`
      const advance = (jobId: string, botId: string, seq: number) => {
        const key = cursorKey(jobId, botId)
        cursors.set(key, Math.max(cursors.get(key) ?? 0, seq))
      }
      // `wait` calls blocked on a job, woken by each post on it.
      const waiters = new Map<string, Set<() => void>>()
      const wake = (jobId: string) => {
        for (const f of waiters.get(jobId) ?? []) f()
      }

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
       * its next turn, which starts its reply. While a reply of its runs there, the post waits: the
       * bot reads it with `wait`, or gets what it didn't read as a turn when that reply ends.
       */
      const deliver = (job: Job, from: Bot, to: Bot, text: string, seq: number, kind: Post['kind']) =>
        Effect.gen(function* () {
          const thread = sync((d) => d.workerThread(job.id, to.id, true))
          if (!thread) return null
          if (sync((d) => d.streamingIds(thread.id).length > 0)) return thread
          // What it is handed it has read: its own `wait` returns only what comes after.
          advance(job.id, to.id, seq)
          yield* chat.queue({ sessionId: thread.id, text, from: from.id, post: { kind, to: to.id, state: null } })
          return thread
        })

      /** The posts a bot's reply on `job` didn't read: its next turns. */
      const catchUp = (job: Job, bot: Bot, threadId: string) =>
        Effect.gen(function* () {
          const unread = sync((d) => d.postsFor(job.threadId!, bot.id, cursors.get(cursorKey(job.id, bot.id)) ?? d.lastPostSeq(job.threadId!, bot.id)))
          for (const { seq, message } of unread) {
            advance(job.id, bot.id, seq)
            yield* chat.queue({ sessionId: threadId, text: message.content, from: message.authorBotId!, post: { kind: message.post?.kind ?? 'message', to: bot.id, state: null } })
          }
          return unread.length > 0
        })

      /** Posts in a job's shared thread; a post addressed to the primary also shows in its conversation. */
      const post = (job: Job, author: Bot, text: string, p: Post) =>
        sync((d) => {
          const primary = d.primaryBot()
          const via = p.to === primary.id ? d.primarySession().id : null
          const posted = d.appendPost({ threadId: job.threadId!, authorBotId: author.id, text, post: p, via })
          // A bot has read the thread up to its own post.
          advance(job.id, author.id, posted.seq)
          return { ...posted, via }
        })

      /** Two bots passing the same request back and forth: stopped, and the user told in the primary's conversation. */
      const bounced = (job: Job, from: Bot, to: Bot, text: string, kind: Post['kind']) => {
        const recent = sync((d) => d.recentPosts(job.threadId!, 5))
        if (!bouncing([...recent, { from: from.id, to: to.id, text }])) return false
        const primary = sync((d) => d.primaryBot())
        post(job, from, text, { kind, to: to.id, state: 'stopped' })
        post(job, primary, `${from.name} and ${to.name} kept passing the same request back and forth, so I stopped passing it on. Tell me how you'd like them to go on, or open the job to steer them.`, {
          kind: 'report',
          to: primary.id,
          state: null
        })
        return true
      }

      const deps: TeamDeps = {
        who: (ctx) => sync((d) => ({ me: d.botOf(ctx.sessionId), primary: d.primaryBot(), bots: d.listBots() })),

        startJob: (ctx, input) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const { me, bots } = deps.who(ctx)
              if (!me.isPrimary) {
                const primary = bots.find((b) => b.isPrimary)!
                return fail(`Only ${primary.name}, the primary bot, opens jobs, and you post only in the job you were given. If this needs a job of its own, ask ${primary.name} with message.`)
              }
              const doer = findBot(bots, input.bot)
              if (!doer) return fail(`There is no bot called “${input.bot}”. Your bots: ${nameList(bots.filter((b) => !b.isPrimary))}.`)
              if (doer.id === me.id) return fail("That's you: do it yourself, or hand it to one of your bots.")
              const task = input.task.trim()
              if (!task) return fail('The task is empty.')
              const title = titleFrom(input.title?.trim() || task)
              const { job } = sync((d) =>
                d.createJob({ title, botId: doer.id, threadBotId: me.id, parentJobId: input.subTask ? (ctx.jobId ?? null) : null })
              )
              const posted = post(job, me, task, { kind: 'task', to: doer.id, state: null })
              const thread = yield* deliver(job, me, doer, task, posted.seq, 'task')
              changed(job.threadId, thread?.id)
              pushPresence()
              return {
                ok: true,
                text: `Opened the job “${title}” (id ${job.id}) and handed it to ${doer.name}, who has started on it in its own thread. Call wait with thread "${job.id}" for its report, or carry on: the report reaches the user as a card either way.`,
                step: { tool: 'team_start_job', label: `Handed “${title}” to ${doer.name}`, ok: true }
              } satisfies TeamResult
            })
          ),

        message: (ctx, input, signal) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const { me, primary, bots } = deps.who(ctx)
              const job = sync((d) => jobFor(d, ctx, input.thread))
              if (!job?.threadId) return fail(input.thread ? `There is no job “${input.thread}”. list_jobs shows them.` : "This conversation isn't on a job: name one with thread.")
              if (!me.isPrimary && job.id !== ctx.jobId) return fail('You post only in the job you were given.')
              const text = input.text.trim()
              if (!text) return fail('The message is empty.')
              const everyone = !input.to?.trim() || /^(everyone|all|everybody)$/i.test(input.to.trim())
              const to = everyone ? null : findBot(bots, input.to!)
              if (!everyone && !to) return fail(`There is no bot called “${input.to}”. The bots: ${nameList(bots)}.`)
              if (to?.id === me.id) return fail("That's you.")
              const onJob = sync((d) => d.botsOnJob(job.id)).map((b) => b.botId)
              const recipients = (to ? [to] : bots.filter((b) => onJob.includes(b.id) && b.id !== me.id)).filter((b) => b.id !== me.id)

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
                      `${text.slice(0, 600)}\n\n${doers} may ${beyond.join(', ')}; ${me.name} may not. ${doers}’s own rules still apply.`
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
              for (const b of recipients) {
                if (b.isPrimary) continue
                if (!onJob.includes(b.id)) brought.push(b.name)
                const thread = yield* deliver(job, me, b, text, posted.seq, 'message')
                if (thread) threads.push(thread.id)
              }
              wake(job.id)
              changed(job.threadId, posted.via, ...threads)
              pushPresence()
              const who = to ? to.name : 'everyone on the job'
              return {
                ok: true,
                text: `Posted to ${who} in “${job.title}”.${brought.length ? ` ${brought.join(' and ')} joined the job and started on it.` : ''}${recipients.some((b) => !b.isPrimary) ? ' Call wait for the answer.' : ''}`,
                step: { tool: 'team_message', label: `Messaged ${who}`, ok: true, detail: text.slice(0, 120) }
              } satisfies TeamResult
            })
          ),

        wait: (ctx, input, signal) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const { me, bots } = deps.who(ctx)
              const job = sync((d) => jobFor(d, ctx, input.thread))
              if (!job?.threadId) return fail(input.thread ? `There is no job “${input.thread}”. list_jobs shows them.` : "This conversation isn't on a job: name one with thread.")
              if (!me.isPrimary && job.id !== ctx.jobId) return fail('You can only wait in the job you were given.')
              const from = input.bot?.trim() ? findBot(bots, input.bot) : null
              if (input.bot?.trim() && !from) return fail(`There is no bot called “${input.bot}”.`)
              const seconds = Math.max(1, Math.min(WAIT_MAX_S, Math.round(input.timeoutSeconds ?? WAIT_DEFAULT_S)))
              const key = cursorKey(job.id, me.id)
              const since = () => cursors.get(key) ?? sync((d) => d.lastPostSeq(job.threadId!, me.id))
              const read = () => sync((d) => d.postsFor(job.threadId!, me.id, since(), from?.id ?? null))
              const deadline = Date.now() + seconds * 1000
              let found = read()
              while (found.length === 0 && Date.now() < deadline && !signal.aborted) {
                yield* Effect.promise(
                  () =>
                    new Promise<void>((resolve) => {
                      const set = waiters.get(job.id) ?? new Set()
                      waiters.set(job.id, set)
                      const done = () => {
                        clearTimeout(timer)
                        set.delete(done)
                        signal.removeEventListener('abort', done)
                        resolve()
                      }
                      const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
                      set.add(done)
                      signal.addEventListener('abort', done)
                    })
                )
                found = read()
              }
              if (signal.aborted) return fail('The reply was stopped.')
              const who = from?.name ?? 'the bots on the job'
              if (found.length === 0) {
                const presence = currentPresence()
                const on = sync((d) => d.botsOnJob(job.id))
                  .filter((b) => b.botId !== me.id)
                  .map((b) => `${bots.find((x) => x.id === b.botId)?.name ?? 'a bot'} is ${presence[b.botId] ?? 'idle'}`)
                return {
                  ok: true,
                  text: `Nothing yet from ${who} after ${seconds} s${on.length ? ` (${on.join(', ')})` : ''}. Call wait again, or carry on: a report reaches the user as a card either way.`,
                  step: { tool: 'team_wait', label: `Waited for ${who}`, ok: true, detail: 'No report yet' }
                } satisfies TeamResult
              }
              advance(job.id, me.id, found.at(-1)!.seq)
              const name = (m: Message) => bots.find((b) => b.id === m.authorBotId)?.name ?? 'A bot'
              const text = found.map(({ message: m }) => `${name(m)} (${m.post?.kind === 'report' ? 'report' : 'message'}):\n${m.content}`).join('\n\n---\n\n')
              const authors = [...new Set(found.map(({ message: m }) => name(m)))].join(' and ')
              return { ok: true, text, step: { tool: 'team_wait', label: `Heard from ${authors}`, ok: true } } satisfies TeamResult
            })
          ),

        listJobs: async () => {
          const { jobs, bots, presence } = sync((d) => ({ jobs: d.listJobs(), bots: d.listBots(), presence: currentPresence() }))
          const name = (id: string | null) => bots.find((b) => b.id === id)?.name ?? 'nobody'
          const open = jobs.filter((j) => j.status === 'open').slice(0, ROUTE_OPEN)
          const lines = open.map((j) => {
            const on = sync((d) => d.botsOnJob(j.id)).map((b) => `${name(b.botId)} (${presence[b.botId] ?? 'idle'})`)
            return `- ${j.title} [id ${j.id}] · owner ${name(j.ownerBotId)} · bots: ${on.join(', ') || 'none'}${j.summary ? ` — ${j.summary}` : ''}`
          })
          return { ok: true, text: lines.length ? `Open jobs:\n${lines.join('\n')}` : 'There are no open jobs.', step: { tool: 'team_list_jobs', label: 'Looked over the jobs', ok: true } }
        }
      }

      // Every reply on a job gets the team tools once there is more than one bot.
      const module = teamModule(deps)
      chat.provideTools((session: Session) => (session.jobId && session.kind !== 'primary' && sync((d) => d.listBots().length) > 1 ? [module] : []))

      /**
       * A worker's reply ended: what it said goes back as a report to whoever wrote to it (in the
       * job's shared thread; to the primary, in its conversation too), then any message that came
       * meanwhile is answered.
       */
      const report = (messageId: string, status: string) =>
        Effect.gen(function* () {
          const info = sync((d) => {
            const reply = d.getMessage(messageId)
            const thread = reply ? d.getSession(reply.sessionId) : undefined
            if (!reply || !thread || thread.kind !== 'worker' || !thread.jobId || !thread.botId) return null
            const job = d.getJob(thread.jobId)
            const bot = d.getBot(thread.botId)
            // Who asked: the nearest turn that wasn't a report (answering a report reports to whoever asked before it).
            const asked = reply.parentId ? d.lineage(reply.parentId).findLast((m) => m.role === 'user' && m.post?.kind !== 'report') : undefined
            const requester = asked?.authorBotId ? d.getBot(asked.authorBotId) : undefined
            return job?.threadId && bot ? { reply, thread, job, bot, requester } : null
          })
          if (!info) return
          const { reply, thread, job, bot, requester } = info
          // Quitting cuts replies off; they report when continued.
          if (requester && status !== 'interrupted' && status !== 'streaming') {
            const said = reportText(reply.content)
            const text =
              status === 'complete'
                ? said || `${bot.name} finished without saying anything.`
                : status === 'paused'
                  ? `${bot.name} paused: ${reply.error ?? 'it seemed stuck.'}${said ? `\n\nSo far:\n${said}` : ''}`
                  : status === 'error'
                    ? `${bot.name} ran into an error: ${reply.error ?? 'something went wrong.'}`
                    : `${bot.name} was stopped.${said ? `\n\nSo far:\n${said}` : ''}`
            if (!requester.isPrimary && bounced(job, bot, requester, text, 'report')) {
              changed(job.threadId, sync((d) => d.primarySession().id))
            } else {
              const posted = post(job, bot, text, { kind: 'report', to: requester.id, state: null })
              // A report to another worker is its next turn.
              const back = requester.isPrimary ? null : yield* deliver(job, bot, requester, text, posted.seq, 'report')
              wake(job.id)
              changed(job.threadId, posted.via, back?.id)
            }
          }
          // What came while it worked and it didn't read, then anything else left unanswered.
          if ((yield* catchUp(job, bot, thread.id)) || (yield* chat.drain(thread.id))) changed(thread.id)
          pushPresence()
        }).pipe(
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`A worker's report failed: ${errorMessage(Cause.squash(cause))}`)))
        )
      const offEnd = chat.onReplyEnd(({ messageId, status }) => void Effect.runFork(report(messageId, status)))
      yield* Effect.addFinalizer(() => Effect.sync(offEnd))

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
          )
      })
    })
  )
}
