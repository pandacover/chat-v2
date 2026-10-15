import { Cause, Context, Effect, Exit, FiberMap, Layer, Stream } from 'effect'
import { ARTIFACT_INSTRUCTIONS } from '@shared/artifacts'
import { makeLineBuffer } from '@shared/lines'
import type { Message, MessageStatus, SessionView, StreamEvent } from '@shared/types'
import { type DbError, InvalidInput, type NotFound, errorMessage } from '../errors'
import { WRITING_GUIDELINES } from '../guidelines'
import { Attachments } from './Attachments'
import { Db } from './Db'
import { type ChatMessage, type ContentPart, OpenRouter } from './OpenRouter'
import { SettingsStore } from './SettingsStore'

/** Pushes stream events to every open window. */
export class Broadcaster extends Context.Service<Broadcaster, { readonly send: (event: StreamEvent) => void }>()(
  'chat-v2/Broadcaster'
) {}

export const NEW_SESSION_TITLE = 'New chat'

export const titleFrom = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return NEW_SESSION_TITLE
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

type ChatError = DbError | NotFound | InvalidInput

export class Chat extends Context.Service<
  Chat,
  {
    readonly view: (sessionId: string) => Effect.Effect<SessionView, ChatError>
    readonly send: (input: {
      sessionId: string
      parentId: string
      text: string
      attachmentIds: string[]
    }) => Effect.Effect<SessionView, ChatError>
    readonly edit: (input: {
      sessionId: string
      messageId: string
      text: string
      attachmentIds: string[]
    }) => Effect.Effect<SessionView, ChatError>
    readonly regenerate: (input: { sessionId: string; assistantId: string }) => Effect.Effect<SessionView, ChatError>
    readonly continue: (input: { sessionId: string; assistantId: string }) => Effect.Effect<SessionView, ChatError>
    readonly stop: (messageId: string) => Effect.Effect<void>
    readonly switchBranch: (input: { sessionId: string; messageId: string }) => Effect.Effect<SessionView, ChatError>
    readonly linesSince: (
      messageId: string,
      fromIndex: number
    ) => Effect.Effect<{ lines: string[]; status: MessageStatus }, ChatError>
  }
>()('chat-v2/Chat') {
  static readonly layer = Layer.effect(
    Chat,
    Effect.gen(function* () {
      const db = yield* Db
      const settingsStore = yield* SettingsStore
      const openRouter = yield* OpenRouter
      const attachments = yield* Attachments
      const broadcaster = yield* Broadcaster

      // One fiber per streaming assistant message. Closing the layer (app quit)
      // interrupts them all, which marks their messages `interrupted`.
      const generations = yield* FiberMap.make<string>()
      const stopRequested = new Set<string>()

      const view = Effect.fn('Chat.view')(function* (sessionId: string) {
        const session = yield* db.require('Session', (d) => d.getSession(sessionId))
        const path = yield* db.use((d) => d.activePath(session))
        return { session, path }
      })

      const messageIn = Effect.fn('Chat.messageIn')(function* (sessionId: string, messageId: string) {
        const message = yield* db.require('Message', (d) => d.getMessage(messageId))
        if (message.sessionId !== sessionId)
          return yield* new InvalidInput({ message: 'Message belongs to another session' })
        return message
      })

      /** Builds the OpenRouter request from the lineage that ends at `parentId`. */
      const buildRequest = Effect.fn('Chat.buildRequest')(function* (assistant: Message, prefill: string | null) {
        const settings = yield* settingsStore.get
        const session = yield* db.require('Session', (d) => d.getSession(assistant.sessionId))
        const history = yield* db.use((d) => d.lineage(assistant.parentId!))
        const stored = yield* db.use((d) => d.storedAttachmentsFor(history.map((m) => m.id)))

        // User instructions first so they win any conflict; the writing guideline is hidden from Settings.
        const system = [
          session.systemPrompt ?? settings.systemPrompt,
          WRITING_GUIDELINES,
          settings.artifactsEnabled ? ARTIFACT_INSTRUCTIONS : ''
        ]
          .map((s) => s.trim())
          .filter(Boolean)
          .join('\n\n')
        const messages: ChatMessage[] = system ? [{ role: 'system', content: system }] : []
        let hasPdf = false
        for (const m of history) {
          if (m.role === 'user') {
            const files = yield* attachments.toParts(stored.get(m.id) ?? [])
            hasPdf ||= files.hasPdf
            const parts: ContentPart[] = [...files.parts, { type: 'text', text: m.content }]
            messages.push({ role: 'user', content: files.parts.length > 0 ? parts : m.content })
          } else if (m.role === 'assistant' && m.content.trim() !== '') {
            messages.push({ role: 'assistant', content: m.content })
          }
        }
        // Assistant prefill: the model continues the partial reply instead of starting over.
        // Some providers reject a prefill ending in whitespace.
        if (prefill) messages.push({ role: 'assistant', content: prefill.trimEnd() })
        return {
          model: assistant.model ?? session.model ?? settings.defaultModel,
          messages,
          temperature: settings.temperature,
          ...(hasPdf ? { plugins: [{ id: 'file-parser', pdf: { engine: settings.pdfEngine } }] } : {})
        }
      })

      const finish = (messageId: string, status: MessageStatus, error: string | null, tailPartial: boolean) =>
        db.use((d) => d.setStatus(messageId, status, error, tailPartial)).pipe(
          Effect.andThen(Effect.sync(() => broadcaster.send({ type: 'done', messageId, status, error }))),
          Effect.ignore
        )

      /**
       * Streams a reply into `assistant`, durably: every completed line is appended
       * to the row before it is broadcast, so a reloaded window can re-read it and
       * an app crash loses at most the line in flight.
       *
       * `carry` is a partial last line taken back out of the row (see `reopenTail`);
       * it seeds the buffer so the continuation completes that line instead of
       * starting a new one.
       */
      const generate = (assistant: Message, prefill: string | null, carry: string | null) => {
        const buffer = makeLineBuffer()
        if (carry !== null) buffer.push(carry)
        // Continuing after a complete line: a leading newline would add a blank line.
        let skipLeadingBlank = prefill !== null && carry === null
        const emit = (text: string) => {
          if (skipLeadingBlank) {
            skipLeadingBlank = false
            if (text.trim() === '') return Effect.void
          }
          return db.use((d) => d.appendLine(assistant.id, text)).pipe(
            Effect.map((index) => broadcaster.send({ type: 'line', messageId: assistant.id, index, text }))
          )
        }
        return Effect.gen(function* () {
          const request = yield* buildRequest(assistant, prefill)
          yield* openRouter
            .streamChat(request)
            .pipe(Stream.runForEach((delta) => Effect.forEach(buffer.push(delta), emit, { discard: true })))
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              // The unfinished line is kept (and marked partial) so nothing received is lost.
              const tail = buffer.flush()
              yield* Effect.forEach(tail, emit, { discard: true }).pipe(Effect.ignore)
              const partial = tail.length > 0
              const stopped = stopRequested.delete(assistant.id)
              if (Exit.isSuccess(exit)) return yield* finish(assistant.id, 'complete', null, false)
              if (Cause.hasInterruptsOnly(exit.cause))
                return yield* finish(assistant.id, stopped ? 'stopped' : 'interrupted', null, partial)
              const error = Cause.squash(exit.cause)
              return yield* finish(assistant.id, 'error', errorMessage(error), partial)
            })
          )
        )
      }

      const start = (assistant: Message, prefill: string | null = null, carry: string | null = null) =>
        FiberMap.run(generations, assistant.id, generate(assistant, prefill, carry), { onlyIfMissing: true }).pipe(
          Effect.asVoid
        )

      const insertUserTurn = Effect.fn('Chat.insertUserTurn')(function* (input: {
        sessionId: string
        parentId: string
        text: string
        attachmentIds: string[]
      }) {
        if (!input.text.trim() && input.attachmentIds.length === 0)
          return yield* new InvalidInput({ message: 'Message is empty' })
        const session = yield* db.require('Session', (d) => d.getSession(input.sessionId))
        const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
        const assistant = yield* db.use((d) => {
          const user = d.insertMessage({
            sessionId: input.sessionId,
            parentId: input.parentId,
            role: 'user',
            content: input.text,
            status: 'complete'
          })
          d.bindAttachments(input.attachmentIds, user.id)
          if (session.title === NEW_SESSION_TITLE && !session.forkedFromSessionId)
            d.updateSession(session.id, { title: titleFrom(input.text || 'Attachment') })
          return d.insertMessage({
            sessionId: input.sessionId,
            parentId: user.id,
            role: 'assistant',
            content: '',
            status: 'streaming',
            model: session.model ?? settings?.defaultModel ?? null
          })
        })
        yield* start(assistant)
        return yield* view(input.sessionId)
      })

      const send = Effect.fn('Chat.send')(function* (input: {
        sessionId: string
        parentId: string
        text: string
        attachmentIds: string[]
      }) {
        yield* messageIn(input.sessionId, input.parentId)
        return yield* insertUserTurn(input)
      })

      // Editing never mutates history: it adds a sibling user turn, creating a branch.
      const edit = Effect.fn('Chat.edit')(function* (input: {
        sessionId: string
        messageId: string
        text: string
        attachmentIds: string[]
      }) {
        const original = yield* messageIn(input.sessionId, input.messageId)
        if (original.role !== 'user' || !original.parentId)
          return yield* new InvalidInput({ message: 'Only user messages can be edited' })
        return yield* insertUserTurn({ ...input, parentId: original.parentId })
      })

      const regenerate = Effect.fn('Chat.regenerate')(function* (input: { sessionId: string; assistantId: string }) {
        const original = yield* messageIn(input.sessionId, input.assistantId)
        if (original.role !== 'assistant' || !original.parentId)
          return yield* new InvalidInput({ message: 'Only assistant replies can be regenerated' })
        const session = yield* db.require('Session', (d) => d.getSession(input.sessionId))
        const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
        const assistant = yield* db.use((d) =>
          d.insertMessage({
            sessionId: input.sessionId,
            parentId: original.parentId!,
            role: 'assistant',
            content: '',
            status: 'streaming',
            model: session.model ?? settings?.defaultModel ?? null
          })
        )
        yield* start(assistant)
        return yield* view(input.sessionId)
      })

      const continueReply = Effect.fn('Chat.continue')(function* (input: { sessionId: string; assistantId: string }) {
        const message = yield* messageIn(input.sessionId, input.assistantId)
        if (message.role !== 'assistant') return yield* new InvalidInput({ message: 'Not an assistant reply' })
        if (message.status === 'streaming') return yield* view(input.sessionId)
        const carry = yield* db.use((d) => {
          const tail = d.reopenTail(message.id)
          d.setStatus(message.id, 'streaming', null)
          return tail
        })
        yield* start(message, message.content.trim() ? message.content : null, carry)
        return yield* view(input.sessionId)
      })

      const stop = (messageId: string) =>
        Effect.gen(function* () {
          if (!(yield* FiberMap.has(generations, messageId))) return
          stopRequested.add(messageId)
          yield* FiberMap.remove(generations, messageId)
        })

      const switchBranch = Effect.fn('Chat.switchBranch')(function* (input: { sessionId: string; messageId: string }) {
        yield* messageIn(input.sessionId, input.messageId)
        yield* db.use((d) => d.activate(input.messageId))
        return yield* view(input.sessionId)
      })

      const linesSince = Effect.fn('Chat.linesSince')(function* (messageId: string, fromIndex: number) {
        const message = yield* db.require('Message', (d) => d.getMessage(messageId))
        const lines = message.lineCount === 0 ? [] : message.content.split('\n').slice(Math.max(0, fromIndex))
        return { lines, status: message.status }
      })

      return Chat.of({
        view,
        send,
        edit,
        regenerate,
        continue: continueReply,
        stop,
        switchBranch,
        linesSince
      })
    })
  )
}
