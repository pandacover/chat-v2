// The primary bot's conversation, and the jobs work is handed off to (see jobs.ts and jobsDb.ts).
//
// Tomo has one continuous chat with the user: everything the user says to Tomo is a turn in the
// primary's own conversation (queued while a reply runs there), which Tomo answers itself or hands
// off with start_job (services/Team.ts). A job, and its thread, opens only then; the work runs in
// the thread, and its report comes back into the chat as a turn. New topic puts a divider in the
// chat, after which Tomo starts a fresh Claude Code session. After each reply in a job's thread
// the job's one-line summary is brought up to date by the small model.
import { Cause, Context, Effect, FiberMap, Layer } from 'effect'
import type { JobStatus, SessionView, Settings } from '@shared/types'
import { type ConfigError, type DbError, InvalidInput, type MissingApiKey, type NotFound, ProviderError, errorMessage } from '../errors'
import { Agent, type Auth } from '../agent/driver'
import { ComputerUse } from '../computer'
import { SUMMARY_INSTRUCTIONS, cleanSummary, summaryPrompt } from '../jobs'
import { Attachments } from './Attachments'
import { Broadcaster, Chat } from './Chat'
import { Db } from './Db'
import { SettingsStore } from './SettingsStore'

type JobsError = DbError | NotFound | InvalidInput

export class Jobs extends Context.Service<
  Jobs,
  {
    /** The primary bot's conversation. */
    readonly primary: Effect.Effect<SessionView, DbError>
    /** Sends the primary a message, in its own conversation; answered at once, or after the reply running there. */
    readonly send: (input: { text: string; attachmentIds: string[] }) => Effect.Effect<SessionView, JobsError>
    /** New topic: a divider in the primary's conversation, after which its next reply starts afresh. */
    readonly newTopic: Effect.Effect<SessionView, DbError>
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

      const send = Effect.fn('Jobs.send')(function* (input: { text: string; attachmentIds: string[] }) {
        if (!input.text.trim() && input.attachmentIds.length === 0) return yield* new InvalidInput({ message: 'Message is empty' })
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
        // Everything else is a turn in Tomo's own conversation, waiting there while a reply runs.
        const session = yield* db.use((d) => d.primarySession())
        const parentId = yield* db.use((d) => d.activePath(session).at(-1)?.message.id ?? session.rootId)
        yield* chat.send({ sessionId: session.id, parentId, text: input.text, attachmentIds: input.attachmentIds, via: session.id })
        return yield* primary
      })

      const newTopic = Effect.gen(function* () {
        const made = yield* db.use((d) => d.newTopic(d.primarySession().id))
        if (made) {
          broadcaster.send({ type: 'thread', sessionId: made.sessionId })
          // The stretch of chat it ends goes into memory, where recall finds it.
          yield* chat.topicMade(made.id)
        }
        return yield* primary
      })

      const forget = (orphans: { files: string[]; agentSessions: string[] }) =>
        Effect.gen(function* () {
          yield* attachments.removeFiles(orphans.files)
          agent.forget(orphans.agentSessions)
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

      const unsubscribe = chat.onReplyEnd(({ messageId, status }) => {
        const thread = Effect.runSync(db.use((d) => d.getMessage(messageId)?.sessionId ?? null).pipe(Effect.orElseSucceed(() => null)))
        if (thread) Effect.runFork(FiberMap.run(summaries, thread, summarize(messageId, status)))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

      return Jobs.of({
        primary,
        send,
        newTopic,
        setStatus,
        remove
      })
    })
  )
}
