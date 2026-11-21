// The primary bot's conversation, and the jobs it opens (see jobs.ts and jobsDb.ts).
//
// The user talks to the primary bot; each message goes to a job's thread, picked by the router
// (or by the user with the job chip), and runs there as a chat turn always has: the thread's own
// Claude Code session, branches, artifacts. The primary's conversation is read back from those
// turns. After each reply the job's one-line summary is brought up to date by the small model.
import { Cause, Context, Effect, FiberMap, Layer } from 'effect'
import type { JobStatus, JobTarget, Session, SessionView, Settings } from '@shared/types'
import { type ConfigError, type DbError, InvalidInput, type MissingApiKey, type NotFound, ProviderError, errorMessage } from '../errors'
import { Agent, type Auth } from '../agent/driver'
import { ComputerUse } from '../computer'
import { ROUTER_INSTRUCTIONS, type Route, SUMMARY_INSTRUCTIONS, candidates, cleanSummary, parseRoute, routerPrompt, summaryPrompt } from '../jobs'
import { Attachments } from './Attachments'
import { Broadcaster, Chat, NEW_SESSION_TITLE, cleanTitle } from './Chat'
import { Db } from './Db'
import { SettingsStore } from './SettingsStore'

type JobsError = DbError | NotFound | InvalidInput

export class Jobs extends Context.Service<
  Jobs,
  {
    /** The primary bot's conversation. */
    readonly primary: Effect.Effect<SessionView, DbError>
    /** Sends the primary a message: routes it to a job (or the one asked for) and starts the reply there. */
    readonly send: (input: { text: string; attachmentIds: string[]; target: JobTarget }) => Effect.Effect<SessionView, JobsError>
    /** Moves the primary's newest turn to another job (or a new one), replies and all: a wrong guess put right. */
    readonly move: (input: { messageId: string; target: 'new' | { jobId: string } }) => Effect.Effect<SessionView, JobsError>
    readonly setStatus: (jobId: string, status: JobStatus) => Effect.Effect<void, DbError>
    /** Deletes a job, its threads and the files and Claude Code sessions only they used. */
    readonly remove: (jobId: string) => Effect.Effect<void, DbError>
  }
>()('chat-v2/Jobs') {
  static readonly layer = Layer.effect(
    Jobs,
    Effect.gen(function* () {
      const db = yield* Db
      const chat = yield* Chat
      const settingsStore = yield* SettingsStore
      const agent = yield* Agent
      const broadcaster = yield* Broadcaster
      const computer = yield* ComputerUse
      const attachments = yield* Attachments

      // The primary starts out as Settings were: their instructions, model and effort.
      const startSettings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
      if (startSettings) yield* db.use((d) => d.seedPrimary(startSettings)).pipe(Effect.ignore)

      const changed = () => broadcaster.send({ type: 'jobs' })

      const authFor = (settings: Settings): Effect.Effect<Auth, MissingApiKey | ConfigError> =>
        settings.auth === 'apiKey'
          ? settingsStore.apiKey('anthropic').pipe(Effect.map((key): Auth => ({ kind: 'apiKey', key })))
          : Effect.succeed({ kind: 'login' })

      const ask = (model: string, system: string, prompt: string, timeout: `${number} seconds`) =>
        Effect.gen(function* () {
          const auth = yield* authFor(yield* settingsStore.get)
          return yield* Effect.tryPromise({
            try: (signal) => agent.ask({ model, system, prompt, auth }, signal),
            catch: (e) => new ProviderError({ provider: 'Claude', message: errorMessage(e) })
          }).pipe(Effect.timeout(timeout))
        })

      const primary = db.use((d): SessionView => {
        const session = d.primarySession()
        return { session, path: d.primaryPath(session.id) }
      })

      /**
       * Where a message to the primary goes. The job the last message went to is the current one; with
       * no small model, or when the router fails, the message stays there.
       */
      const decide = (primaryId: string, text: string, files: string[]) =>
        Effect.gen(function* () {
          const { jobs, last } = yield* db.use((d) => ({ jobs: d.listJobs(), last: d.lastRouted(primaryId) }))
          const currentId = last?.jobId && jobs.some((j) => j.id === last.jobId) ? last.jobId : null
          const list = candidates(jobs, currentId)
          const fallback: Route = currentId ? { kind: 'job', jobId: currentId } : { kind: 'new', title: null }
          if (list.length === 0) return fallback
          const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
          if (!settings?.titleModel) return fallback
          const exchange = last
            ? yield* db.use((d) => {
                const user = d.getMessage(last.messageId)
                const reply = user?.activeChildId ? d.getMessage(user.activeChildId) : undefined
                return user ? { user: user.content, reply: reply?.content ?? '' } : null
              })
            : null
          const attached = files.length > 0 ? `\n[Attached: ${files.join(', ')}]` : ''
          const reply = yield* ask(settings.titleModel, ROUTER_INSTRUCTIONS, routerPrompt(list, currentId, exchange, `${text}${attached}`), '20 seconds').pipe(
            Effect.tapError((e) => Effect.logWarning(`Routing failed: ${errorMessage(e)}`)),
            Effect.orElseSucceed(() => '')
          )
          return parseRoute(reply, list) ?? fallback
        })

      /** Puts a turn in a job's thread (made for it when the route is new) and starts its reply. */
      const deliver = (primarySession: Session, route: Route, input: { text: string; attachmentIds: string[] }) =>
        Effect.gen(function* () {
          const target = yield* db.use((d) => {
            const job = route.kind === 'job' ? d.getJob(route.jobId) : undefined
            const thread = job?.threadId ? d.getSession(job.threadId) : undefined
            if (thread) {
              // The toggles of the primary's composer go with what is said there.
              d.updateSession(thread.id, { browserEnabled: primarySession.browserEnabled, computerEnabled: primarySession.computerEnabled })
              return { thread, created: null as string | null, title: job!.title }
            }
            const title = (route.kind === 'new' && route.title ? cleanTitle(route.title) : null) ?? NEW_SESSION_TITLE
            const made = d.createJob({
              title,
              botId: d.primaryBot().id,
              browserEnabled: primarySession.browserEnabled,
              computerEnabled: primarySession.computerEnabled
            })
            return { thread: made.thread, created: made.job.id, title }
          })
          const busy = yield* db.use((d) => d.streamingIds(target.thread.id).length > 0)
          if (busy) return yield* new InvalidInput({ message: `Still answering in “${target.title}”. Wait for that reply or stop it, then send again.` })
          const parentId = yield* db.use((d) => d.activePath(target.thread).at(-1)?.message.id ?? target.thread.rootId)
          const view = yield* chat.send({ sessionId: target.thread.id, parentId, text: input.text, attachmentIds: input.attachmentIds }).pipe(
            // A job made for a message that didn't go through isn't left behind empty.
            Effect.tapError(() => (target.created ? db.use((d) => d.deleteJob(target.created!)).pipe(Effect.ignore) : Effect.void))
          )
          const user = view.path.findLast((n) => n.message.role === 'user')
          if (user) yield* db.use((d) => d.markVia(user.message.id, primarySession.id))
          changed()
        })

      const send = Effect.fn('Jobs.send')(function* (input: { text: string; attachmentIds: string[]; target: JobTarget }) {
        if (!input.text.trim() && input.attachmentIds.length === 0) return yield* new InvalidInput({ message: 'Message is empty' })
        const primarySession = yield* db.use((d) => d.primarySession())
        // A Show-me step waits in one of the bot's threads: the message answers it there (Chat.send does).
        const waiting = computer.waiting()
        if (waiting?.kind === 'teach' && input.text.trim()) {
          const thread = yield* db.use((d) => d.getSession(waiting.sessionId))
          if (thread) {
            const parentId = yield* db.use((d) => d.activePath(thread).at(-1)?.message.id ?? thread.rootId)
            yield* chat.send({ sessionId: thread.id, parentId, text: input.text, attachmentIds: [] })
            return yield* primary
          }
        }
        const files = yield* db.use((d) => input.attachmentIds.flatMap((id) => d.getAttachment(id)?.name ?? []))
        const route: Route =
          input.target === 'auto'
            ? yield* decide(primarySession.id, input.text, files)
            : input.target === 'new'
              ? { kind: 'new', title: null }
              : { kind: 'job', jobId: input.target.jobId }
        yield* deliver(primarySession, route, input)
        return yield* primary
      })

      const forget = (orphans: { files: string[]; agentSessions: string[] }) =>
        Effect.gen(function* () {
          yield* attachments.removeFiles(orphans.files)
          agent.forget(orphans.agentSessions)
        })

      const move = Effect.fn('Jobs.move')(function* (input: { messageId: string; target: 'new' | { jobId: string } }) {
        const primarySession = yield* db.use((d) => d.primarySession())
        const message = yield* db.require('Message', (d) => d.getMessage(input.messageId))
        const last = yield* db.use((d) => d.lastRouted(primarySession.id))
        if (message.role !== 'user' || last?.messageId !== message.id)
          return yield* new InvalidInput({ message: 'Only the last message you sent can be moved to another job.' })
        const from = yield* db.require('Session', (d) => d.getSession(message.sessionId))
        if (typeof input.target === 'object' && input.target.jobId === from.jobId) return yield* primary
        for (const id of yield* db.use((d) => d.streamingIds(from.id))) yield* chat.stop(id)
        const route: Route = input.target === 'new' ? { kind: 'new', title: null } : { kind: 'job', jobId: input.target.jobId }
        // Sent again first: its attachments are copied onto the new turn before the old one goes.
        yield* deliver(primarySession, route, { text: message.content, attachmentIds: message.attachments.map((a) => a.id) })
        const orphans = yield* db.use((d) => {
          const gone = d.removeTurn(message.id)
          // A job made for this message alone goes with it.
          if (from.jobId && d.threadEmpty(from.id)) {
            const job = d.deleteJob(from.jobId)
            return { files: [...gone.files, ...job.files], agentSessions: [...gone.agentSessions, ...job.agentSessions] }
          }
          return gone
        })
        yield* forget(orphans).pipe(Effect.ignore)
        changed()
        return yield* primary
      })

      const remove = (jobId: string) =>
        Effect.gen(function* () {
          const threads = yield* db.use((d) => d.listSessions().filter((s) => s.jobId === jobId))
          for (const t of threads) for (const id of yield* db.use((d) => d.streamingIds(t.id))) yield* chat.stop(id)
          const orphans = yield* db.use((d) => d.deleteJob(jobId))
          yield* forget(orphans).pipe(Effect.ignore)
          changed()
        })

      // One summary at a time per job; a newer reply's replaces one still being written.
      const summaries = yield* FiberMap.make<string>()
      const summarize = (messageId: string, status: string) =>
        Effect.gen(function* () {
          const info = yield* db.use((d) => {
            const reply = d.getMessage(messageId)
            const job = reply ? d.jobOfSession(reply.sessionId) : undefined
            if (!reply || !job) return null
            d.refreshJobUsage(job.id)
            const user = reply.parentId ? d.getMessage(reply.parentId) : undefined
            return { reply, job, user }
          })
          if (!info) return
          changed()
          const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
          if (status !== 'complete' || !settings?.titleModel) return
          const reply = yield* ask(settings.titleModel, SUMMARY_INSTRUCTIONS, summaryPrompt(info.job, info.user?.content ?? '', info.reply.content), '30 seconds')
          const summary = cleanSummary(reply)
          if (!summary) return
          yield* db.use((d) => d.setJobSummary(info.job.id, summary))
          changed()
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`Job summary failed: ${errorMessage(Cause.squash(cause))}`)
          )
        )
      const unsubscribe = chat.onReplyEnd(({ messageId, status }) => {
        const thread = Effect.runSync(db.use((d) => d.getMessage(messageId)?.sessionId ?? null).pipe(Effect.orElseSucceed(() => null)))
        if (thread) Effect.runFork(FiberMap.run(summaries, thread, summarize(messageId, status)))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

      return Jobs.of({
        primary,
        send,
        move,
        setStatus: (jobId, status) => db.use((d) => d.setJobStatus(jobId, status)).pipe(Effect.tap(() => Effect.sync(changed))),
        remove
      })
    })
  )
}
