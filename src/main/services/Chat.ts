import { Cause, Context, Effect, Exit, FiberMap, Layer, Stream } from 'effect'
import { ARTIFACT_INSTRUCTIONS, replaceArtifacts } from '@shared/artifacts'
import { MOODBOARD_INSTRUCTIONS, docToSpec, parseBoardDoc, specToJson } from '@shared/moodboard'
import { makeLineBuffer } from '@shared/lines'
import type { Message, MessageStatus, SessionView, StreamEvent, Usage } from '@shared/types'
import { type DbError, InvalidInput, type NotFound, errorMessage } from '../errors'
import { WRITING_GUIDELINES } from '../guidelines'
import { BROWSER_INSTRUCTIONS, BROWSER_TOOLS, MAX_AGENT_STEPS, runTool } from '../agent'
import { stepLine, summarizeSteps } from '@shared/steps'
import { Attachments } from './Attachments'
import { Db } from './Db'
import { type ChatMessage, type ChatRequest, type ContentPart, OpenRouter } from './OpenRouter'
import { Browser } from './Browser'
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
      const browser = yield* Browser

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
        const boards = yield* db.use((d) => d.boardsFor(history.map((m) => m.id)))
        // A mood board the user edited by hand goes back to the model as edited.
        const withEdits = (m: Message) => {
          const edited = boards.get(m.id)
          if (!edited) return m.content
          return replaceArtifacts(m.content, ({ identifier, kind }) => {
            const doc = kind === 'moodboard' ? parseBoardDoc(edited.get(identifier)) : null
            return doc ? specToJson(docToSpec(doc)) : null
          })
        }

        // User instructions first so they win any conflict; the writing guideline is hidden from Settings.
        const system = [
          session.systemPrompt ?? settings.systemPrompt,
          WRITING_GUIDELINES,
          settings.artifactsEnabled ? ARTIFACT_INSTRUCTIONS : '',
          settings.artifactsEnabled ? MOODBOARD_INSTRUCTIONS : '',
          session.browserEnabled ? BROWSER_INSTRUCTIONS : ''
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
            messages.push({ role: 'assistant', content: summarizeSteps(withEdits(m)) })
          }
        }
        // Assistant prefill: the model continues the partial reply instead of starting over.
        // Some providers reject a prefill ending in whitespace.
        if (prefill) messages.push({ role: 'assistant', content: summarizeSteps(prefill).trimEnd() })
        return {
          model: assistant.model ?? session.model ?? settings.defaultModel,
          messages,
          temperature: settings.temperature,
          ...(hasPdf ? { plugins: [{ id: 'file-parser', pdf: { engine: settings.pdfEngine } }] } : {}),
          ...(session.browserEnabled ? { tools: BROWSER_TOOLS } : {})
        } satisfies ChatRequest as ChatRequest
      })

      const finish = (
        messageId: string,
        status: MessageStatus,
        error: string | null,
        tailPartial: boolean,
        usage: Usage | null,
        model: string | null
      ) =>
        db
          .use((d) => {
            d.setStatus(messageId, status, error, tailPartial)
            if (usage) d.setUsage(messageId, usage)
            if (model) d.setModel(messageId, model)
          })
          .pipe(
            Effect.andThen(Effect.sync(() => broadcaster.send({ type: 'done', messageId, status, error, usage, model }))),
            Effect.ignore
          )

      /** Whether a model accepts images, from OpenRouter's list (unknown models are assumed to). */
      const seesImages = (model: string) =>
        openRouter.listModels.pipe(
          Effect.map((models) => models.find((m) => m.id === model)?.inputModalities.includes('image') ?? true),
          Effect.orElseSucceed(() => true)
        )

      const hasImages = (messages: ChatMessage[]) =>
        messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))

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
        // Flushes a half-finished text line so a step line never lands in the middle of it.
        const endLine = Effect.suspend(() => Effect.forEach(buffer.flush(), emit, { discard: true }))
        let usedBrowser = false
        // A continued reply keeps counting from what it already used.
        let usage: Usage | null = assistant.usage ? { ...assistant.usage } : null
        let answeredBy: string | null = null
        const addUsage = (u: Omit<Usage, 'requests'>) => {
          const prev = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: null, requests: 0 }
          usage = {
            promptTokens: prev.promptTokens + u.promptTokens,
            completionTokens: prev.completionTokens + u.completionTokens,
            totalTokens: prev.totalTokens + u.totalTokens,
            cachedTokens: prev.cachedTokens + u.cachedTokens,
            reasoningTokens: prev.reasoningTokens + u.reasoningTokens,
            cost: u.cost === null ? prev.cost : (prev.cost ?? 0) + u.cost,
            requests: prev.requests + 1
          }
        }

        return Effect.gen(function* () {
          const request = yield* buildRequest(assistant, prefill)
          const chatModel = request.model
          const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
          const refs = new Map<string, string>()
          for (let step = 0; ; step++) {
            const calls = new Map<number, { id: string; name: string; args: string }>()
            let text = ''
            // Images (uploads or browser screenshots) go to the vision model if this one is blind.
            const vision = settings?.visionModel
            request.model =
              vision && vision !== chatModel && hasImages(request.messages) && !(yield* seesImages(chatModel)) ? vision : chatModel
            if (request.model !== chatModel) answeredBy = request.model
            yield* openRouter.streamChat(request).pipe(
              Stream.runForEach((delta) => {
                if (delta.type === 'usage') {
                  addUsage(delta.usage)
                  return Effect.void
                }
                if (delta.type === 'text') {
                  text += delta.text
                  return Effect.forEach(buffer.push(delta.text), emit, { discard: true })
                }
                const call = calls.get(delta.index) ?? { id: '', name: '', args: '' }
                if (delta.id) call.id = delta.id
                if (delta.name) call.name += delta.name
                if (delta.args) call.args += delta.args
                calls.set(delta.index, call)
                return Effect.void
              })
            )
            if (calls.size === 0 || !request.tools) return
            if (step >= MAX_AGENT_STEPS) {
              yield* endLine
              yield* emit(`Stopped after ${MAX_AGENT_STEPS} browser steps. Ask me to keep going if you want me to continue.`)
              return
            }

            yield* endLine
            const toolCalls = [...calls.values()].map((c, i) => ({
              id: c.id || `call_${step}_${i}`,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args || '{}' }
            }))
            request.messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
            const images: string[] = []
            for (const call of toolCalls) {
              usedBrowser = true
              const outcome = yield* runTool(browser, refs, call.function.name, call.function.arguments)
              yield* emit(stepLine(outcome.step))
              request.messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text })
              if (outcome.image) images.push(outcome.image)
            }
            // Tool results are text-only on most providers, so screenshots follow as a user turn.
            if (images.length > 0) {
              request.messages.push({
                role: 'user',
                content: [
                  { type: 'text', text: 'Screenshot of the browser viewport you asked for:' },
                  ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
                ]
              })
            }
          }
        }).pipe(
          // Hand the browser back however the reply ends (done, error, Stop, Take over).
          Effect.ensuring(Effect.suspend(() => (usedBrowser ? browser.release : Effect.void))),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              // The unfinished line is kept (and marked partial) so nothing received is lost.
              const tail = buffer.flush()
              yield* Effect.forEach(tail, emit, { discard: true }).pipe(Effect.ignore)
              const partial = tail.length > 0
              const stopped = stopRequested.delete(assistant.id)
              if (Exit.isSuccess(exit)) return yield* finish(assistant.id, 'complete', null, false, usage, answeredBy)
              if (Cause.hasInterruptsOnly(exit.cause))
                return yield* finish(assistant.id, stopped ? 'stopped' : 'interrupted', null, partial, usage, answeredBy)
              const error = Cause.squash(exit.cause)
              return yield* finish(assistant.id, 'error', errorMessage(error), partial, usage, answeredBy)
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
