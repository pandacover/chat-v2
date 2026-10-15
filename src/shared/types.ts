// Types shared by the main process, preload bridge and renderer.

export type Role = 'root' | 'system' | 'user' | 'assistant'

/** Lifecycle of an assistant message. `interrupted` means the app stopped mid-stream. */
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'stopped' | 'error'

export type AttachmentKind = 'image' | 'pdf' | 'text'

export interface Attachment {
  id: string
  messageId: string | null
  name: string
  mime: string
  size: number
  kind: AttachmentKind
  createdAt: number
}

export interface Message {
  id: string
  sessionId: string
  parentId: string | null
  /** Which child is shown when walking the active branch down from this node. */
  activeChildId: string | null
  role: Role
  content: string
  status: MessageStatus
  /** Number of complete lines persisted for a streaming message (the durable offset). */
  lineCount: number
  model: string | null
  error: string | null
  createdAt: number
  attachments: Attachment[]
}

export interface Session {
  id: string
  title: string
  model: string | null
  /** Per-session override of the global system prompt; null means use the global one. */
  systemPrompt: string | null
  rootId: string
  forkedFromSessionId: string | null
  createdAt: number
  updatedAt: number
}

/** A node on the visible path, with its position among siblings for the ‹ 1/3 › switcher. */
export interface PathNode {
  message: Message
  siblingIds: string[]
  siblingIndex: number
}

export interface SessionView {
  session: Session
  path: PathNode[]
}

export interface Settings {
  defaultModel: string
  systemPrompt: string
  temperature: number
  sttModel: string
  sttLanguage: string
  pdfEngine: 'cloudflare-ai' | 'mistral-ocr' | 'native'
  artifactsEnabled: boolean
}

export interface SettingsView {
  settings: Settings
  hasOpenRouterKey: boolean
  hasElevenLabsKey: boolean
  configPath: string
}

export interface SettingsPatch {
  settings?: Partial<Settings>
  /** `undefined` leaves the key untouched, `''` clears it. */
  openRouterKey?: string
  elevenLabsKey?: string
}

export interface ModelInfo {
  id: string
  name: string
  contextLength: number | null
  inputModalities: string[]
}

export type StreamEvent =
  | { type: 'line'; messageId: string; index: number; text: string }
  | { type: 'done'; messageId: string; status: MessageStatus; error: string | null }

export interface AppError {
  tag: string
  message: string
}

export type IpcResult<A> = { ok: true; value: A } | { ok: false; error: AppError }

export interface NewAttachmentInput {
  name: string
  mime: string
  data: ArrayBuffer
}

/** Everything the renderer can call on `window.api`. */
export interface Api {
  sessions: {
    list(): Promise<Session[]>
    create(): Promise<SessionView>
    get(id: string): Promise<SessionView>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    update(id: string, patch: { model?: string | null; systemPrompt?: string | null }): Promise<void>
    fork(sessionId: string, messageId: string): Promise<SessionView>
  }
  chat: {
    send(input: { sessionId: string; parentId: string; text: string; attachmentIds: string[] }): Promise<SessionView>
    edit(input: { sessionId: string; messageId: string; text: string; attachmentIds: string[] }): Promise<SessionView>
    regenerate(input: { sessionId: string; assistantId: string }): Promise<SessionView>
    continue(input: { sessionId: string; assistantId: string }): Promise<SessionView>
    stop(messageId: string): Promise<void>
    switchBranch(input: { sessionId: string; messageId: string }): Promise<SessionView>
    /** Lines persisted at or after `fromIndex`, for re-attaching after a reload. */
    linesSince(messageId: string, fromIndex: number): Promise<{ lines: string[]; status: MessageStatus }>
    onEvent(listener: (event: StreamEvent) => void): () => void
  }
  attachments: {
    add(input: NewAttachmentInput): Promise<Attachment>
    discard(id: string): Promise<void>
    url(id: string): string
  }
  settings: {
    get(): Promise<SettingsView>
    update(patch: SettingsPatch): Promise<SettingsView>
    openConfigFile(): Promise<void>
  }
  models: {
    list(): Promise<ModelInfo[]>
  }
  stt: {
    transcribe(audio: ArrayBuffer, mime: string): Promise<string>
  }
  artifacts: {
    /** Registers HTML for the sandboxed artifact:// scheme and returns its URL. */
    publish(html: string): Promise<string>
  }
}
