// Tomo's chat starting afresh by itself (see rollover.ts): the decision before each new turn there,
// the running summary the small model keeps, and filing each stretch that ends in memory.
//
// The summary is written in the background once a reply leaves the chat past its budget (a while
// after it ends, so a quick back-and-forth doesn't pay for one each turn), and the latest is kept
// for the turn that starts afresh. Only when none is ready is it written then. Without a small
// model, or when the call fails, the fresh session gets the last exchanges alone.
import { Cause, Deferred, Effect, FiberMap } from 'effect'
import type { Message, Session, Settings } from '@shared/types'
import { errorMessage } from '../errors'
import { type NameOf, isRollover, topicStart, transcriptText } from '../agent/history'
import {
  CHAT_SUMMARY_INSTRUCTIONS,
  carryText,
  chatSummaryPrompt,
  cleanChatSummary,
  isReply,
  overBudget,
  recentExchanges,
  rolloverLimits,
  segmentRecord,
  shouldRollOver,
  summaryIn
} from '../rollover'
import type { Db } from './Db'

/** How long after a reply ends its summary waits, so the next turn of a quick exchange can start first. */
const SUMMARY_DELAY_MS = 60_000

export interface RolloverDeps {
  db: Db['Service']
  settings: Effect.Effect<Settings | null>
  ask: (model: string, system: string, prompt: string, timeout: `${number} seconds`) => Effect.Effect<string, unknown>
}

/** The stretch of chat `lineage` (root first) ends: what came after its last boundary, and that boundary. */
const stretchOf = (lineage: readonly Message[]) => {
  const start = topicStart(lineage)
  return { boundary: start >= 0 ? lineage[start]! : null, turns: lineage.slice(start + 1) }
}

const quiet = <A>(what: string, fallback: A) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) ? Effect.succeed(fallback) : Effect.logWarning(`${what}: ${errorMessage(Cause.squash(cause))}`).pipe(Effect.as(fallback))
  )

export const makeRollover = ({ db, settings, ask }: RolloverDeps) =>
  Effect.gen(function* () {
    // One summary in the making per conversation; a newer reply's replaces it.
    const summarizing = yield* FiberMap.make<string>()
    const filing = yield* FiberMap.make<string>()
    /** The latest summary per conversation, and the reply its stretch ends with. */
    const ready = new Map<string, { upTo: string; done: Deferred.Deferred<string | null> }>()

    /** How the turns of a stretch read in a prompt: bots' turns with who sent them and the job they are about. */
    const renderer = (turns: readonly Message[]) =>
      db.use((d) => {
        const names = new Map(d.listBots().map((b) => [b.id, b.name]))
        const nameOf: NameOf = (id) => (id ? names.get(id) : undefined) ?? 'a bot'
        const jobs = turns.map((m) => (m.role === 'user' && m.authorBotId ? d.jobOfTurn(m.id) : null))
        return {
          nameOf,
          jobs,
          botName: d.primaryBot().name,
          text: (list: readonly Message[]) =>
            list.flatMap((m) => {
              const t = transcriptText(m, nameOf, jobs[turns.indexOf(m)] ?? null)
              return t ? [t] : []
            })
        }
      })

    /** A new running summary for the stretch that ends with reply `replyId`: the previous one's, carried on. Null without a small model or when it fails. */
    const writeSummary = (replyId: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const model = (yield* settings)?.titleModel
        if (!model) return null
        const { boundary, turns } = stretchOf(yield* db.use((d) => d.lineage(replyId)))
        const previous = boundary && isRollover(boundary) ? summaryIn(boundary.content) : null
        const text = (yield* renderer(turns)).text(turns).join('\n')
        if (!text) return previous
        return cleanChatSummary(yield* ask(model, CHAT_SUMMARY_INSTRUCTIONS, chatSummaryPrompt(previous, text), '45 seconds'))
      }).pipe(quiet('Summing up Tomo’s chat failed', null))

    /** The summary for the stretch ending with `replyId`: the one written after it, if that was, else one written now. */
    const summaryFor = (sessionId: string, replyId: string): Effect.Effect<string | null> => {
      const kept = ready.get(sessionId)
      return kept?.upTo === replyId ? Deferred.await(kept.done).pipe(Effect.timeout('45 seconds'), Effect.orElseSucceed(() => null)) : writeSummary(replyId)
    }

    /** After a reply in Tomo's chat ends past the budget, its summary is written, in a while, for the turn that starts afresh. */
    const afterReply = (messageId: string) =>
      Effect.gen(function* () {
        const reply = yield* db.use((d) => {
          const m = d.getMessage(messageId)
          return m && isReply(m) && m.status === 'complete' && d.getSession(m.sessionId)?.kind === 'primary' ? m : null
        })
        const limits = rolloverLimits()
        if (!reply || !overBudget(reply.usage?.contextTokens, limits) || !(yield* settings)?.titleModel) return
        const done = yield* Deferred.make<string | null>()
        ready.set(reply.sessionId, { upTo: reply.id, done })
        const write = Effect.sleep(Math.min(SUMMARY_DELAY_MS, limits.gapMs / 2)).pipe(
          Effect.andThen(writeSummary(reply.id)),
          Effect.flatMap((s) => Deferred.succeed(done, s)),
          Effect.ensuring(Deferred.succeed(done, null))
        )
        yield* FiberMap.run(summarizing, reply.sessionId, write)
      }).pipe(quiet('Planning Tomo’s chat summary failed', undefined))

    /**
     * Files the stretch of Tomo's chat that boundary `markId` ends in memory, where recall finds it:
     * its summary (`summary`, or the latest kept or written for it) and its turns. Nothing is kept
     * while memory is off.
     */
    const fileNow = (markId: string, summary: string | null | undefined) =>
      Effect.gen(function* () {
        if (!(yield* settings)?.memoryModel) return
        const info = yield* db.use((d) => {
          const mark = d.getMessage(markId)
          return mark?.parentId ? { mark, ...stretchOf(d.lineage(mark.parentId)) } : null
        })
        if (!info || info.turns.length === 0) return
        const last = info.turns.findLast(isReply)
        const said = summary !== undefined ? summary : last ? yield* summaryFor(info.mark.sessionId, last.id) : null
        const r = yield* renderer(info.turns)
        const record = segmentRecord({ botName: r.botName, turns: info.turns, summary: said, nameOf: r.nameOf, jobOf: (i) => r.jobs[i] ?? null })
        if (!record) return
        yield* db.use((d) => d.archiveChat(d.primaryBot().id, record, { sessionId: info.mark.sessionId }))
      }).pipe(quiet('Filing Tomo’s chat in memory failed', undefined))

    const file = (markId: string, summary?: string | null) => FiberMap.run(filing, markId, fileNow(markId, summary)).pipe(Effect.asVoid)

    /**
     * Before a new turn in a conversation: in Tomo's own, past the budget after a pause, an
     * automatic boundary goes in before the turns being answered (all of them: held ones too),
     * carrying the summary and the last exchanges. Returns the lineage to plan from, the same when
     * nothing changed. Never fails: the turn runs as before if anything here does.
     */
    const check = (session: Session, lineage: readonly Message[]): Effect.Effect<readonly Message[]> =>
      Effect.gen(function* () {
        if (session.kind !== 'primary') return lineage
        let at = lineage.length
        while (at > 0 && lineage[at - 1]!.role === 'user') at--
        const before = lineage[at - 1]
        const first = lineage[at]
        if (!before || !first || !isReply(before)) return lineage
        if (!shouldRollOver({ kind: session.kind, endedAt: before.usage?.endedAt, contextTokens: before.usage?.contextTokens, now: Date.now() })) return lineage
        const summary = yield* summaryFor(session.id, before.id)
        ready.delete(session.id)
        const { turns } = stretchOf(lineage.slice(0, at))
        const recent = recentExchanges(turns)
        const carry = carryText(summary, (yield* renderer(turns)).text(recent))
        const mark = yield* db.use((d) => d.rollOver(session.id, before.id, first.id, carry))
        if (!mark) return lineage
        yield* file(mark.id, summary)
        return yield* db.use((d) => d.lineage(lineage.at(-1)!.id))
      }).pipe(quiet('Starting Tomo’s chat afresh failed', lineage))

    return { check, afterReply, file }
  })
