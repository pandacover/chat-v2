// Types shared by the main process, preload bridge and renderer.
import type { ComputerDoing, ComputerMode, ComputerWait } from './computer'

export type Role = 'root' | 'system' | 'user' | 'assistant'

/** Lifecycle of an assistant message. `interrupted` means the app stopped mid-stream. */
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'stopped' | 'error'

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'audio'

/** Tempo and beats of an audio upload, measured on this device. */
export interface AudioAnalysis {
  duration: number
  sampleRate: number
  channels: number
  /** From the app's own analysis (onset autocorrelation + beat tracking). */
  bpm: number | null
  confidence: number
  beats: number[]
  tempoMap: Array<{ start: number; bpm: number }>
  peaks: number[]
  /** Second opinion from web-audio-beat-detector; `offset` is the beat phase in seconds. */
  library: { bpm: number; offset: number } | null
  agreement: 'agree' | 'octave' | 'differ' | 'n/a'
}

export interface Attachment {
  id: string
  messageId: string | null
  name: string
  mime: string
  size: number
  kind: AttachmentKind
  createdAt: number
  /** Audio only: filled in once the file has been analysed. */
  analysis: AudioAnalysis | null
}

/**
 * Tokens and dollars for one reply, summed over every model call it made. Replies from before
 * Claude (OpenRouter) have no cacheWriteTokens, and their cost is in OpenRouter credits, which
 * were dollars too.
 */
export interface Usage {
  /** Every input token, cached or not. */
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Input read from the prompt cache. */
  cachedTokens: number
  /** Input written to the prompt cache. */
  cacheWriteTokens?: number
  /** Thinking, counted in completionTokens. */
  reasoningTokens: number
  /** US dollars, as Claude Code estimates them; null when not reported (a stopped reply). */
  cost: number | null
  /** Model calls behind the reply (more than one when it used tools). */
  requests: number
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
  usage: Usage | null
}

export interface Session {
  id: string
  title: string
  model: string | null
  /** Per-session override of the global system prompt; null means use the global one. */
  systemPrompt: string | null
  rootId: string
  forkedFromSessionId: string | null
  /** When on, the model gets browser tools for this chat. */
  browserEnabled: boolean
  /** When on, the model can see the screen and use the user's apps (Windows and macOS). */
  computerEnabled: boolean
  /**
   * What the chat's last message was read as: operate the computer (do), or show each step for the
   * user to do (teach). Decided from each message; a follow-up like "next" keeps it.
   */
  computerMode: ComputerMode
  /** When the chat was pinned to the top of the sidebar; null when it isn't. */
  pinnedAt: number | null
  createdAt: number
  updatedAt: number
}

/** What a profile or playbook record is about. */
export type MemoryRecordType = 'preference' | 'person' | 'project' | 'procedure'
/** What a bot on a job notes down: decisions, the state of things, what's left, files touched, progress. */
export type JobNoteKind = 'decision' | 'state' | 'left' | 'files' | 'progress'
/**
 * Whose a record is: the user's profile (every bot sees it), one bot's playbook, one job's notes,
 * or the archive of finished jobs and old conversations (searched with `recall`, never in a prompt).
 */
export type MemoryScope = 'profile' | 'bot' | 'job' | 'archive'
/**
 * Who wrote a version: the per-message extractor, the daily reconciler, the user in Settings, a bot
 * (job notes; computer use's `remember`), or the archiver when a job ends.
 */
export type MemoryWriter = 'extractor' | 'reconciler' | 'user' | 'bot' | 'archiver'

/**
 * One thing memory knows, with a stable id: an update is a new version of the same record, and a
 * restore brings an old version back under the same id. `body` is the current version.
 */
export interface MemoryRecord {
  id: number
  /** A MemoryRecordType for the profile and playbooks; a JobNoteKind for job notes; 'job' or 'conversation' in the archive. */
  type: string
  /** A short name (a person, a project); '' when the body says it all. */
  title: string
  /** Other names it goes by, which `recall` matches too. */
  aliases: string[]
  scope: MemoryScope
  /** The bot or job it belongs to, or the archived job or chat; null for the profile. */
  scopeId: string | null
  body: string
  /** Records the body links to with [[title]]. */
  links: Array<{ id: number; title: string }>
  /** How many versions it has had, this one included. */
  versions: number
  /** Who wrote the current version. */
  writer: MemoryWriter
  createdAt: number
  /** When the current version was written. */
  updatedAt: number
}

/** One version of a record, with where it came from ("Why does Tomo think this?"). */
export interface MemoryVersion {
  id: number
  recordId: number
  body: string
  addedRev: number
  /** The revision that replaced or hid it; null for the current version. */
  removedRev: number | null
  writer: MemoryWriter
  sourceJobId: string | null
  sourceSessionId: string | null
  /** The source chat's title; null without one, or once the chat is deleted. */
  sourceTitle: string | null
  createdAt: number
}

/** One change to memory. Every change is kept, so earlier versions can be restored. */
export interface MemoryRevision {
  rev: number
  kind: 'learned' | 'edited' | 'restored' | 'cleared' | 'purged' | 'noted' | 'archived'
  writer: MemoryWriter
  /** The chat a learned fact came from. */
  sessionId: string | null
  note: string | null
  createdAt: number
  added: string[]
  removed: string[]
}

/** What happened to the last message memory looked at, so Settings can show it. Not saved. */
export interface MemoryRun {
  at: number
  /** The start of the message. */
  message: string
  /** The memory model; null when the message was skipped before reaching it. */
  model: string | null
  outcome: 'skipped' | 'nothing' | 'saved' | 'unreadable' | 'error'
  added: string[]
  removed: string[]
  /** Facts the model gave that named things the message never mentioned. */
  dropped: string[]
  /** The error, or the start of a reply that wasn't JSON. */
  detail: string | null
}

export interface MemoryView {
  /** The profile now. */
  records: MemoryRecord[]
  revisions: MemoryRevision[]
  lastRun: MemoryRun | null
}

/** Per-chat settings a chat can change from its composer. */
export interface SessionPatch {
  model?: string | null
  systemPrompt?: string | null
  browserEnabled?: boolean
  computerEnabled?: boolean
  pinned?: boolean
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

/** How hard Claude thinks before it answers; higher is slower and costs more. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Settings {
  defaultModel: string
  systemPrompt: string
  effort: Effort
  /** Replies run on the Claude Code sign-in (`claude`, then /login), or on an Anthropic API key. */
  auth: 'login' | 'apiKey'
  sttModel: string
  sttLanguage: string
  artifactsEnabled: boolean
  /** Names new chats from their first message; '' keeps the start of the message as the title. */
  titleModel: string
  /** Picks facts about the user out of their messages; '' turns memory off (nothing learned or sent). */
  memoryModel: string
  /** Keeps the window above other apps on the same desktop. */
  alwaysOnTop: boolean
}

export interface SettingsView {
  settings: Settings
  hasAnthropicKey: boolean
  hasElevenLabsKey: boolean
  configPath: string
}

export interface SettingsPatch {
  settings?: Partial<Settings>
  /** `undefined` leaves the key untouched, `''` clears it. */
  anthropicKey?: string
  elevenLabsKey?: string
}

export type StreamEvent =
  | { type: 'line'; messageId: string; index: number; text: string }
  | { type: 'done'; messageId: string; status: MessageStatus; error: string | null; usage: Usage | null; model: string | null }
  /** A new chat's generated title, replacing the one taken from its first message. */
  | { type: 'title'; sessionId: string; title: string }
  /** Memory changed after a message (learned in the background, so this can arrive any time). */
  | { type: 'memory'; sessionId: string; added: string[]; removed: string[] }
  /** A file the assistant added to its reply mid-run (a screenshot it saved for the user). */
  | { type: 'attachment'; messageId: string; attachment: Attachment }
  /** What computer use waits on the user for (an approval, a Show-me step); null once nothing. */
  | { type: 'computer'; waiting: ComputerWait }
  /** The computer tool a reply is running now, live (null once it ends); never saved. */
  | { type: 'computerDoing'; messageId: string; doing: ComputerDoing | null }
  /** The mode a running computer reply works in: decided from the message, or switched by the user. */
  | { type: 'computerMode'; messageId: string; mode: ComputerMode }
  /** Point: the user is marking part of the screen (active), or finished; a finished mark brings its image and note for the next message. */
  | { type: 'point'; active: boolean; attachments: Attachment[]; error?: string }

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

/** App update status. `manual` is true on macOS, where the new DMG is opened instead of installed in place. */
export interface UpdateState {
  /**
   * idle: nothing newer as of the last check. checking: a check the user asked for. available:
   * `next` can be downloaded. downloading: `percent` done. downloaded: installs on restart (or the
   * next quit). installing: quitting to install.
   */
  status: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing'
  current: string
  next: string | null
  /** What changed in `next`: its release notes as plain text (the commit message). */
  notes: string | null
  percent: number | null
  /** Why the last check or download failed; cleared by the next one. */
  error: string | null
  /** When a check last got an answer (ms since the epoch). */
  checkedAt: number | null
}

/** Everything the renderer can call on `window.api`. */
export interface Api {
  sessions: {
    list(): Promise<Session[]>
    create(): Promise<SessionView>
    get(id: string): Promise<SessionView>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    update(id: string, patch: SessionPatch): Promise<void>
    fork(sessionId: string, messageId: string): Promise<SessionView>
  }
  memory: {
    get(): Promise<MemoryView>
    add(fact: string): Promise<MemoryView>
    edit(id: number, fact: string): Promise<MemoryView>
    /** Deletes a record and every version of it, for good (unlike clear, which hides). */
    purge(id: number): Promise<MemoryView>
    /** A record's versions, newest first, each with its source: "Why does Tomo think this?" */
    versions(id: number): Promise<MemoryVersion[]>
    clear(): Promise<MemoryView>
    /** Brings back the facts as they were after revision `rev` (as a new revision). */
    restore(rev: number): Promise<MemoryView>
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
    setAnalysis(id: string, analysis: AudioAnalysis): Promise<void>
    discard(id: string): Promise<void>
    /** Asks where to save a copy of the file and writes it; null when the user cancels. */
    saveAs(id: string, name: string): Promise<string | null>
    url(id: string): string
  }
  settings: {
    get(): Promise<SettingsView>
    update(patch: SettingsPatch): Promise<SettingsView>
    openConfigFile(): Promise<void>
  }
  stt: {
    /** Asks for microphone access where the OS requires it (macOS); false when it is off. */
    microphone(): Promise<boolean>
    transcribe(audio: ArrayBuffer, mime: string): Promise<string>
  }
  artifacts: {
    /** Registers HTML for the sandboxed artifact:// scheme and returns its URL. */
    publish(html: string): Promise<string>
  }
  browser: BrowserApi
  computer: {
    /** False on Linux, where there is no computer use. */
    supported(): Promise<boolean>
    /** What computer use waits on right now, for a window that just loaded. */
    waiting(): Promise<ComputerWait>
    approve(id: string, approved: boolean): Promise<void>
    /** Ends the Show-me step `id` as done. */
    teachDone(id: string): Promise<void>
    /** Switches a running computer reply between doing it and showing how, for the rest of it. */
    setMode(sessionId: string, messageId: string, mode: ComputerMode): Promise<void>
    /** Starts Point (the user marks a spot or box on screen for the next message), or cancels the one under way. True once it is on. */
    point(): Promise<boolean>
  }
  updates: {
    get(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<UpdateState>
    onEvent(listener: (state: UpdateState) => void): () => void
  }
}

/** What the element picker reports about the element under the pointer. */
export interface ElementInfo {
  selector: string
  tag: string
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
}

/** Main → renderer events for the built-in browser. */
export type BrowserEvent =
  | { type: 'open' }
  | { type: 'cursor'; x: number; y: number; click: boolean }
  | { type: 'control'; active: boolean; label: string }
  | { type: 'frame'; data: string }
  /** The assistant starts or stops recording the panel; the panel answers with recordReply. */
  | { type: 'record'; on: boolean }

/** The panel's answer to a `record` event: started, or the finished video of an assistant recording. */
export type RecordReply = { ok: true; data?: ArrayBuffer; seconds?: number } | { ok: false; error: string }

export interface BrowserApi {
  /** Registers the panel's <webview> so the main process (and the agent) can drive it. */
  attach(webContentsId: number): Promise<void>
  /** Saves a screenshot of the page (or a region, in page CSS pixels) as a pending attachment. */
  screenshot(rect?: { x: number; y: number; width: number; height: number }): Promise<Attachment>
  /** PNG data URL of a page region, for compositing annotations. */
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<string>
  elementAt(x: number, y: number): Promise<ElementInfo | null>
  screencast(on: boolean): Promise<void>
  /** Writes a finished recording to disk and returns its path. */
  saveRecording(data: ArrayBuffer): Promise<string>
  /** Answers a `record` event. With a finished video, saves it and returns its path. */
  recordReply(reply: RecordReply): Promise<string | null>
  reveal(path: string): Promise<void>
  onEvent(listener: (event: BrowserEvent) => void): () => void
}
