// The primary bot's conversation, and the jobs it opens (see jobs.ts and jobsDb.ts).
//
// The user talks to the primary bot; each message goes to a job's thread, picked by the router
// (or by the user with the job chip), and runs there as a chat turn always has: the thread's own
// Claude Code session, branches, artifacts. Small talk goes to no job: it runs in the primary's
// own conversation, and is filed as a new job once a reply there does work. The primary's
// conversation is read back from all those turns. After each reply the job's one-line summary is
// brought up to date by the small model.
import { Cause, Context, Effect, FiberMap, Layer } from 'effect'
import type { JobStatus, JobTarget, Session, SessionView, Settings } from '@shared/types'
import { type ConfigError, type DbError, InvalidInput, type MissingApiKey, type NotFound, ProviderError, errorMessage } from '../errors'
import { Agent, type Auth } from '../agent/driver'
import { ComputerUse } from '../computer'
import { ROUTER_INSTRUCTIONS, type Route, SUMMARY_INSTRUCTIONS, candidates, cleanSummary, didWork, parseRoute, routerPrompt, summaryPrompt } from '../jobs'
import { Attachments } from './Attachments'
import { Broadcaster, Chat, NEW_SESSION_TITLE, TITLE_INSTRUCTIONS, TITLE_SOURCE_CHARS, cleanTitle, titleFrom } from './Chat'
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
    /** Files the primary's newest turn in another job (or a new one), replies and all, without answering it again: a wrong guess put right. */
    readonly move: (input: { messageId: string; target: 'new' | { jobId: string } }) => Effect.Effect<SessionView, JobsError>
    /** Marks a job finished (filing it in memory's archive) or open again. */
    readonly setStatus: (jobId: string, status: JobStatus) => Effect.Effect<void, DbError>
    /** Deletes a job, its threads, its notes and archive record, and the files and Claude Code sessions only they used. */
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
       * no small model, or when the router fails, the message stays there. Even with no jobs yet the
       * router is asked, as a first "Hi" belongs to no job.
       */
      const decide = (primaryId: string, text: string, files: string[]) =>
        Effect.gen(function* () {
          const { jobs, last } = yield* db.use((d) => ({ jobs: d.listJobs(), last: d.lastRouted(primaryId) }))
          const currentId = last?.jobId && jobs.some((j) => j.id === last.jobId) ? last.jobId : null
          const list = candidates(jobs, currentId)
          const fallback: Route = currentId ? { kind: 'job', jobId: currentId } : { kind: 'new', title: null }
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

      // Names a job made without a title (from the start of its first message until the small model replies).
      const naming = yield* FiberMap.make<string>()
      const nameJob = (threadId: string, placeholder: string, text: string) =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
          if (!settings?.titleModel) return
          const reply = yield* ask(settings.titleModel, TITLE_INSTRUCTIONS, `<message>\n${text.slice(0, TITLE_SOURCE_CHARS)}\n</message>`, '30 seconds')
          const title = cleanTitle(reply)
          if (!title || !(yield* db.use((d) => d.retitle(threadId, placeholder, title)))) return
          broadcaster.send({ type: 'title', sessionId: threadId, title })
          changed()
        }).pipe(Effect.ignore)

      /** A new job for a turn that is already written (moved or filed), named after its message. */
      const jobFor = (text: string) =>
        Effect.gen(function* () {
          const placeholder = titleFrom(text || 'Attachment')
          const made = yield* db.use((d) => d.createJob({ title: placeholder, botId: d.primaryBot().id }))
          yield* FiberMap.run(naming, made.thread.id, nameJob(made.thread.id, placeholder, text))
          return made
        })

      /** Puts a turn in a job's thread (made for it when the route is new), or the primary's own, and starts its reply. */
      const deliver = (primarySession: Session, route: Route, input: { text: string; attachmentIds: string[] }) =>
        Effect.gen(function* () {
          const target = yield* db.use((d) => {
            // No job: the primary's own conversation, unless a reply still runs there (then it gets a job).
            if (route.kind === 'chat' && d.streamingIds(primarySession.id).length === 0)
              return { thread: primarySession, created: null as string | null, title: primarySession.title }
            const job = route.kind === 'job' ? d.getJob(route.jobId) : undefined
            const thread = job?.threadId ? d.getSession(job.threadId) : undefined
            if (thread) return { thread, created: null as string | null, title: job!.title }
            const title = (route.kind === 'new' && route.title ? cleanTitle(route.title) : null) ?? NEW_SESSION_TITLE
            const made = d.createJob({ title, botId: d.primaryBot().id })
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
        const into =
          typeof input.target === 'object'
            ? yield* db.use((d) => {
                const job = d.getJob((input.target as { jobId: string }).jobId)
                return job?.threadId ? (d.getSession(job.threadId) ?? null) : null
              })
            : null
        if (typeof input.target === 'object') {
          if (!into) return yield* new InvalidInput({ message: 'That job is gone.' })
          const busy = yield* db.use((d) => d.streamingIds(into.id).length > 0)
          if (busy) return yield* new InvalidInput({ message: `Still answering in “${into.title}”. Wait for that reply or stop it, then move your message.` })
        }
        // A reply still running stops where it is, and moves as it is.
        for (const id of yield* db.use((d) => d.streamingIds(from.id))) yield* chat.stop(id)
        // Stopping it may have filed it as a job already (fileWork): moved from where it is now.
        const at = yield* db.require('Session', (d) => d.getSession(d.getMessage(message.id)?.sessionId ?? from.id))
        if (at.id === into?.id) return yield* primary
        yield* fileTurn(message.id, at, into ?? (yield* jobFor(message.content)).thread)
        yield* resummarize(message.id)
        return yield* primary
      })

      const remove = (jobId: string) =>
        Effect.gen(function* () {
          const threads = yield* db.use((d) => d.listSessions().filter((s) => s.jobId === jobId))
          for (const t of threads) for (const id of yield* db.use((d) => d.streamingIds(t.id))) yield* chat.stop(id)
          // The job's notes and its archive record go with it, for good.
          const orphans = yield* db.use((d) => {
            const gone = d.deleteJob(jobId)
            d.forgetJob(jobId)
            return gone
          })
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
      /**
       * Files a finished job in memory's archive, where `recall` finds it later: its one-line
       * summary, or one the small model writes from the last exchange when it has none yet. Nothing
       * is kept while memory is off.
       */
      const archiving = yield* FiberMap.make<string>()
      const archive = (jobId: string) =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
          if (!settings?.memoryModel) return
          const info = yield* db.use((d) => {
            const job = d.getJob(jobId)
            const thread = job?.threadId ? d.getSession(job.threadId) : undefined
            if (!job || job.status !== 'done' || !thread) return null
            const path = d.activePath(thread)
            const reply = path.findLast((n) => n.message.role === 'assistant')?.message
            const user = path.findLast((n) => n.message.role === 'user')?.message
            return { job, thread, user, reply }
          })
          if (!info) return
          let summary = info.job.summary
          if (!summary && settings.titleModel && info.reply) {
            const reply = yield* ask(settings.titleModel, SUMMARY_INSTRUCTIONS, summaryPrompt(info.job, info.user?.content ?? '', info.reply.content), '30 seconds')
            summary = cleanSummary(reply)
            if (summary) yield* db.use((d) => d.setJobSummary(jobId, summary!))
          }
          yield* db.use((d) => d.archiveJob(jobId, summary ?? info.job.title, { title: info.job.title, sessionId: info.thread.id }))
          changed()
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`Archiving a job failed: ${errorMessage(Cause.squash(cause))}`)
          )
        )

      const setStatus = (jobId: string, status: JobStatus) =>
        Effect.gen(function* () {
          yield* db.use((d) => d.setJobStatus(jobId, status))
          changed()
          if (status === 'done') yield* FiberMap.run(archiving, jobId, archive(jobId))
        })

      /**
       * Files a turn at the end of another thread as it is (see refileTurn). Out of the primary's own
       * conversation into a new job, it keeps its Claude Code session: all that came before it there
       * was small talk, and the job carries on from what the reply did. A job left with nothing in it
       * goes.
       */
      const fileTurn = (messageId: string, from: Session, into: Session) =>
        Effect.gen(function* () {
          const orphans = yield* db.use((d) => {
            d.refileTurn(messageId, into.id, from.kind === 'primary' && d.threadEmpty(into.id))
            if (from.jobId && d.threadEmpty(from.id)) {
              const gone = d.deleteJob(from.jobId)
              d.forgetJob(from.jobId)
              return gone
            }
            if (from.jobId) d.refreshJobUsage(from.jobId)
            return null
          })
          if (orphans) yield* forget(orphans).pipe(Effect.ignore)
          changed()
          broadcaster.send({ type: 'thread', sessionId: into.id })
        })

      /** The reply a moved turn shows, summarized again in the job it landed in. */
      const resummarize = (userId: string) =>
        Effect.gen(function* () {
          const reply = yield* db.use((d) => {
            const id = d.getMessage(userId)?.activeChildId
            return id ? (d.getMessage(id) ?? null) : null
          })
          if (reply && reply.status !== 'streaming') yield* FiberMap.run(summaries, reply.sessionId, summarize(reply.id, reply.status))
        })

      /**
       * A reply in the primary's own conversation that did work (a tool, a file, an artifact): its
       * turn is filed as a new job, named after the message. Only the newest turn, still on show.
       */
      const fileWork = (replyId: string) =>
        Effect.gen(function* () {
          const info = yield* db.use((d) => {
            const reply = d.getMessage(replyId)
            const thread = reply ? d.getSession(reply.sessionId) : undefined
            if (!reply?.parentId || thread?.kind !== 'primary' || !didWork(reply.content, reply.attachments.length)) return null
            const user = d.getMessage(reply.parentId)
            if (user?.role !== 'user' || d.activePath(thread).at(-1)?.message.id !== reply.id) return null
            return { thread, user }
          })
          if (!info) return
          const made = yield* jobFor(info.user.content)
          yield* fileTurn(info.user.id, info.thread, made.thread)
        })

      const unsubscribe = chat.onReplyEnd(({ messageId, status }) => {
        const thread = Effect.runSync(db.use((d) => d.getMessage(messageId)?.sessionId ?? null).pipe(Effect.orElseSucceed(() => null)))
        if (!thread) return
        const after = fileWork(messageId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`Filing a reply as a job failed: ${errorMessage(Cause.squash(cause))}`)
          ),
          Effect.andThen(summarize(messageId, status))
        )
        Effect.runFork(FiberMap.run(summaries, thread, after))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

      return Jobs.of({
        primary,
        send,
        move,
        setStatus,
        remove
      })
    })
  )
}
