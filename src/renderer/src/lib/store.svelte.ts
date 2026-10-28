import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { parseContent, type ArtifactBlock } from '@shared/artifacts'
import type { UpdateState } from '@shared/types'
import type {
  Attachment,
  BrowserEvent,
  MemoryView,
  Message,
  ModelInfo,
  Session,
  SessionPatch,
  SessionView,
  SettingsView,
  StreamEvent
} from '@shared/types'

const api = window.api

export interface Toast {
  id: number
  kind: 'error' | 'info'
  text: string
}

export interface OpenArtifact {
  identifier: string
  /** Which message's version is shown. */
  messageId: string
}

/** Unsent composer text, keyed by chat id ('' is the new chat). `at` orders drafts in the sidebar. */
export interface Draft {
  text: string
  at: number
}

const DRAFTS_KEY = 'chat-v2.drafts'

const loadDrafts = (): Array<[string, Draft]> => {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, Draft>
    return Object.entries(raw).filter(([, d]) => typeof d?.text === 'string' && d.text.trim() !== '')
  } catch {
    return []
  }
}

/** Cleans up the "Error invoking remote method" noise Electron sometimes adds. */
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

class AppState {
  sessions = $state<Session[]>([])
  view = $state<SessionView | null>(null)
  settings = $state<SettingsView | null>(null)
  models = $state<ModelInfo[]>([])
  modelsError = $state<string | null>(null)
  imageModels = $state<ModelInfo[]>([])
  imageModelsError = $state<string | null>(null)
  artifact = $state<OpenArtifact | null>(null)
  /** Settings is a modal over the chat; the chat stays mounted so drafts and scroll survive. */
  page = $state<'chat' | 'settings'>('chat')

  get settingsOpen(): boolean {
    return this.page === 'settings'
  }

  set settingsOpen(open: boolean) {
    this.page = open ? 'settings' : 'chat'
  }
  toasts = $state<Toast[]>([])
  /** Message ids whose replies started streaming in this window (artifacts auto-open for these). */
  liveIds = new SvelteSet<string>()
  sidebarOpen = $state(true)
  /** Dragged by the sidebar's edge; kept across launches. */
  sidebarWidth = $state(Number(localStorage.getItem('chat-v2:sidebar-width')) || 252)

  update = $state<UpdateState | null>(null)

  /** Pending composer attachments of the open chat. Shared so the browser panel can add captures. */
  draftAttachments = $state<Attachment[]>([])

  /** Unsent text per chat, saved on this device so it survives a restart. */
  drafts = new SvelteMap<string, Draft>(loadDrafts())
  /** Pending attachments of chats that aren't open (kept for this run only). */
  private parked = new SvelteMap<string, Attachment[]>()
  private draftsTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Model, instructions and browser access picked for the new chat before its first message.
   * A new chat has no database row until then, so these wait here.
   */
  fresh = $state<SessionPatch>({})

  /** Learned facts, loaded when Settings shows them. */
  memory = $state<MemoryView | null>(null)

  // The right panel holds artifacts and the built-in browser as tabs.
  browserOpen = $state(false)
  panelTab = $state<'artifact' | 'browser'>('artifact')
  browser = $state({ url: '', title: '', loading: false, canBack: false, canForward: false })
  /** Set while the model is driving the browser. */
  control = $state({ active: false, label: '' })
  /** Where the agent's pointer is, in page pixels; `clicks` increments per click for the ripple. */
  cursor = $state({ x: 0, y: 0, visible: false, clicks: 0 })

  private toastSeq = 0
  private backfilling = new Map<string, Promise<void>>()

  // Derived rather than getters: these are read all over the layout, and a getter would
  // re-scan (and for artifacts, re-parse) the whole conversation on every streamed line.
  streaming = $derived(this.view?.path.some((n) => n.message.status === 'streaming') ?? false)

  /** Every complete version of the open artifact along the visible branch. */
  artifactVersions = $derived.by(() => {
    const open = this.artifact
    if (!open || !this.view) return []
    const out: Array<{ messageId: string; block: ArtifactBlock }> = []
    for (const { message } of this.view.path) {
      if (message.role !== 'assistant') continue
      for (const b of parseContent(message.content)) {
        if (b.type === 'artifact' && b.complete && b.identifier === open.identifier) out.push({ messageId: message.id, block: b })
      }
    }
    return out
  })

  /** The open chat's settings, or what has been picked for the new chat. */
  chat = $derived({
    model: this.view ? this.view.session.model : (this.fresh.model ?? null),
    systemPrompt: this.view ? this.view.session.systemPrompt : (this.fresh.systemPrompt ?? null),
    browserEnabled: this.view ? this.view.session.browserEnabled : (this.fresh.browserEnabled ?? false),
    computerEnabled: this.view ? this.view.session.computerEnabled : (this.fresh.computerEnabled ?? false)
  })

  hasArtifact = $derived(this.artifact !== null && this.artifactVersions.length > 0)

  panelOpen = $derived(this.browserOpen || this.hasArtifact)

  /** The visible tab, falling back to whichever one exists. */
  activeTab = $derived<'artifact' | 'browser'>(
    this.panelTab === 'browser' && this.browserOpen ? 'browser' : this.hasArtifact ? 'artifact' : 'browser'
  )

  showArtifact(artifact: OpenArtifact) {
    this.artifact = artifact
    this.panelTab = 'artifact'
  }

  openBrowser() {
    this.browserOpen = true
    this.panelTab = 'browser'
  }

  closeBrowser() {
    this.browserOpen = false
    this.panelTab = 'artifact'
  }

  addDraftAttachment(attachment: Attachment) {
    this.draftAttachments.push(attachment)
  }

  /** Audio uploads being measured; sending waits for these. */
  analyzing = new SvelteSet<string>()

  /** Measures tempo and beats of an audio upload, then stores the result with it. */
  async analyzeDraft(attachment: Attachment, data: ArrayBuffer) {
    this.analyzing.add(attachment.id)
    try {
      const { analyzeAudio } = await import('./analyzeAudio')
      const analysis = await analyzeAudio(data)
      await api.attachments.setAnalysis(attachment.id, analysis)
      const draft = this.draftAttachments.find((a) => a.id === attachment.id)
      if (draft) draft.analysis = analysis
    } catch (e) {
      this.toast(`Couldn't analyse ${attachment.name}: ${describe(e)}`)
    } finally {
      this.analyzing.delete(attachment.id)
    }
  }

  draftText(key: string) {
    return this.drafts.get(key)?.text ?? ''
  }

  /** Whether a chat has anything unsent: text, or attachments waiting in its composer. */
  hasDraft(key: string) {
    if (this.drafts.has(key)) return true
    const open = (this.view?.session.id ?? '') === key
    return open ? this.draftAttachments.length > 0 : (this.parked.get(key)?.length ?? 0) > 0
  }

  setDraft(key: string, text: string) {
    const prev = this.drafts.get(key)
    if (prev?.text === text) return
    if (text.trim() === '') {
      if (!prev) return
      this.drafts.delete(key)
    } else {
      this.drafts.set(key, { text, at: Date.now() })
    }
    clearTimeout(this.draftsTimer)
    this.draftsTimer = setTimeout(() => this.saveDrafts(), 300)
  }

  saveDrafts() {
    clearTimeout(this.draftsTimer)
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(this.drafts)))
    } catch {
      // Storage full or unavailable: drafts still last until the app closes.
    }
  }

  /** Called when the composer leaves a chat: its attachments wait until it comes back. */
  parkAttachments(key: string) {
    if (this.draftAttachments.length > 0) this.parked.set(key, this.draftAttachments)
    else this.parked.delete(key)
    this.draftAttachments = []
  }

  unparkAttachments(key: string) {
    this.draftAttachments = this.parked.get(key) ?? []
    this.parked.delete(key)
  }

  /** Throws away a chat's unsent text and attachments. */
  discardDraft(key: string) {
    const open = (this.view?.session.id ?? '') === key
    const files = open ? this.draftAttachments : (this.parked.get(key) ?? [])
    for (const a of files) void api.attachments.discard(a.id).catch(() => {})
    if (open) this.draftAttachments = []
    this.parked.delete(key)
    this.setDraft(key, '')
  }

  private onBrowserEvent(e: BrowserEvent) {
    if (e.type === 'open') this.openBrowser()
    else if (e.type === 'control') {
      this.control = { active: e.active, label: e.label }
      if (e.active) this.openBrowser()
      else this.cursor.visible = false
    } else if (e.type === 'cursor') {
      this.cursor.x = e.x
      this.cursor.y = e.y
      this.cursor.visible = true
      if (e.click) this.cursor.clicks += 1
    }
  }

  async init() {
    api.chat.onEvent((e) => this.onEvent(e))
    api.browser.onEvent((e) => this.onBrowserEvent(e))
    api.updates.onEvent((s) => (this.update = s))
    void api.updates.get().then((s) => (this.update = s))
    addEventListener('beforeunload', () => this.saveDrafts())
    await Promise.all([this.refreshSessions(), this.loadSettings()])
    // Drafts of chats that are gone (deleted elsewhere, or empty ones cleared at startup).
    for (const key of [...this.drafts.keys()]) if (key && !this.sessions.some((s) => s.id === key)) this.setDraft(key, '')
    // An unsent new chat is where the user left off; otherwise reopen the latest chat.
    const first = this.sessions[0]
    if (first && !this.drafts.has('')) await this.open(first.id)
    void this.loadModels()
  }

  toast(text: string, kind: Toast['kind'] = 'error') {
    const id = ++this.toastSeq
    this.toasts.push({ id, kind, text })
    setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3500)
  }

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id)
  }

  /** Runs an API call, surfacing failures as a toast. */
  async attempt<A>(f: () => Promise<A>): Promise<A | undefined> {
    try {
      return await f()
    } catch (e) {
      this.toast(describe(e))
      return undefined
    }
  }

  async refreshSessions() {
    const list = await this.attempt(() => api.sessions.list())
    if (list) this.sessions = list
  }

  async loadSettings() {
    const s = await this.attempt(() => api.settings.get())
    if (s) this.settings = s
  }

  /** Keeps the window above other apps (saved, and applied by the main process). */
  async setPinned(on: boolean) {
    const view = await this.attempt(() => api.settings.update({ settings: { alwaysOnTop: on } }))
    if (view) this.settings = view
  }

  async loadModels() {
    try {
      this.models = await api.models.list()
      this.modelsError = null
    } catch (e) {
      this.modelsError = describe(e)
    }
  }

  async loadImageModels() {
    try {
      this.imageModels = await api.models.images()
      this.imageModelsError = null
    } catch (e) {
      this.imageModelsError = describe(e)
    }
  }

  /** Installs a fresh view and catches up any replies that are still streaming. */
  setView(view: SessionView) {
    if (this.view?.session.id !== view.session.id) this.artifact = null
    this.view = view
    for (const node of view.path) {
      if (node.message.status === 'streaming') void this.backfill(node.message.id)
    }
  }

  async open(sessionId: string) {
    const view = await this.attempt(() => api.sessions.get(sessionId))
    if (view) this.setView(view)
  }

  /**
   * Opens the new chat. It is saved when its first message is sent; until then the sidebar
   * lists it only while its composer holds a draft.
   */
  newSession() {
    if (!this.view) return
    this.view = null
    this.artifact = null
  }

  async rename(id: string, title: string) {
    await this.attempt(() => api.sessions.rename(id, title))
    if (this.view?.session.id === id) this.view.session.title = title
    await this.refreshSessions()
  }

  async pin(id: string, pinned: boolean) {
    await this.attempt(() => api.sessions.update(id, { pinned }))
    await this.refreshSessions()
  }

  async remove(id: string) {
    this.discardDraft(id)
    await this.attempt(() => api.sessions.remove(id))
    await this.refreshSessions()
    if (this.view?.session.id === id) {
      this.view = null
      const next = this.sessions[0]
      if (next) await this.open(next.id)
    }
  }

  async updateSession(patch: SessionPatch) {
    const view = this.view
    // The new chat isn't saved yet; its settings are applied when it is.
    if (!view) {
      this.fresh = { ...this.fresh, ...patch }
      return
    }
    await this.attempt(() => api.sessions.update(view.session.id, patch))
    await this.open(view.session.id)
  }

  private async afterTurn(view: SessionView | undefined) {
    if (!view) return
    const last = view.path.at(-1)?.message
    if (last?.status === 'streaming') this.liveIds.add(last.id)
    this.setView(view)
    await this.refreshSessions()
  }

  async send(text: string, attachments: Attachment[]) {
    let view = this.view
    // The new chat gets its row now, with whatever was picked for it.
    const created = !view
    if (!view) {
      view = (await this.attempt(() => api.sessions.create())) ?? null
      if (!view) return false
      const fresh = $state.snapshot(this.fresh)
      const id = view.session.id
      if (Object.keys(fresh).length > 0) await this.attempt(() => api.sessions.update(id, fresh))
    }
    const parentId = view.path.at(-1)?.message.id ?? view.session.rootId
    const sessionId = view.session.id
    const result = await this.attempt(() =>
      api.chat.send({ sessionId, parentId, text, attachmentIds: attachments.map((a) => a.id) })
    )
    if (created) {
      // Don't leave an empty chat behind when the first message didn't go through.
      if (!result) void api.sessions.remove(sessionId).catch(() => {})
      else this.fresh = {}
    }
    await this.afterTurn(result)
    return result !== undefined
  }

  async edit(messageId: string, text: string, attachmentIds: string[]) {
    const view = this.view
    if (!view) return
    await this.afterTurn(await this.attempt(() => api.chat.edit({ sessionId: view.session.id, messageId, text, attachmentIds })))
  }

  async regenerate(assistantId: string) {
    const view = this.view
    if (!view) return
    await this.afterTurn(await this.attempt(() => api.chat.regenerate({ sessionId: view.session.id, assistantId })))
  }

  async continueReply(assistantId: string) {
    const view = this.view
    if (!view) return
    await this.afterTurn(await this.attempt(() => api.chat.continue({ sessionId: view.session.id, assistantId })))
  }

  async stop() {
    const id = this.view?.path.find((n) => n.message.status === 'streaming')?.message.id
    if (id) await this.attempt(() => api.chat.stop(id))
  }

  async switchBranch(messageId: string) {
    const view = this.view
    if (!view) return
    const next = await this.attempt(() => api.chat.switchBranch({ sessionId: view.session.id, messageId }))
    if (next) this.setView(next)
  }

  async fork(messageId: string) {
    const view = this.view
    if (!view) return
    const next = await this.attempt(() => api.sessions.fork(view.session.id, messageId))
    if (!next) return
    this.setView(next)
    await this.refreshSessions()
    this.toast('Forked into a new session', 'info')
  }

  private find(messageId: string): Message | undefined {
    return this.view?.path.find((n) => n.message.id === messageId)?.message
  }

  /**
   * Durable-stream reattach: fetch every persisted line past what this window has.
   * Called after loading a view and whenever a gap shows up in the event sequence.
   */
  async backfill(messageId: string): Promise<void> {
    const inFlight = this.backfilling.get(messageId)
    if (inFlight) {
      // Re-run once the current request lands, so lines persisted after it was sent are not missed.
      await inFlight
      return this.backfill(messageId)
    }
    const run = this.fetchMissing(messageId)
    this.backfilling.set(messageId, run)
    try {
      await run
    } finally {
      this.backfilling.delete(messageId)
    }
  }

  private async fetchMissing(messageId: string) {
    try {
      const message = this.find(messageId)
      if (!message) return
      const { lines, status } = await api.chat.linesSince(messageId, message.lineCount)
      const current = this.find(messageId)
      if (!current) return
      // Events may have advanced the message while the request was in flight.
      const fresh = lines.slice(current.lineCount - message.lineCount)
      for (const line of fresh) this.appendLine(current, line)
      current.status = status
    } catch {
      // The next event or a reload will retry.
    }
  }

  private appendLine(message: Message, text: string) {
    message.content = message.lineCount === 0 ? text : `${message.content}\n${text}`
    message.lineCount += 1
  }

  async loadMemory() {
    const m = await this.attempt(() => api.memory.get())
    if (m) this.memory = m
  }

  /** Runs a change to memory from Settings and shows the result. */
  async editMemory(f: () => Promise<MemoryView>) {
    const m = await this.attempt(f)
    if (m) this.memory = m
    return m !== undefined
  }

  private onEvent(e: StreamEvent) {
    if (e.type === 'memory') {
      if (this.memory) void this.loadMemory()
      const quote = (fact: string) => `“${fact.replace(/\.$/, '')}”`
      if (e.added.length > 0)
        this.toast(`Remembered ${e.added.length === 1 ? quote(e.added[0]!) : `${e.added.length} things about you`}`, 'info')
      else if (e.removed.length > 0)
        this.toast(`Forgot ${e.removed.length === 1 ? quote(e.removed[0]!) : `${e.removed.length} things about you`}`, 'info')
      return
    }
    if (e.type === 'title') {
      const session = this.sessions.find((s) => s.id === e.sessionId)
      if (session) session.title = e.title
      if (this.view?.session.id === e.sessionId) this.view.session.title = e.title
      return
    }
    const message = this.find(e.messageId)
    if (!message) return
    if (e.type === 'line') {
      if (e.index < message.lineCount) return // already have it
      if (e.index > message.lineCount) return void this.backfill(e.messageId) // missed some
      this.appendLine(message, e.text)
      return
    }
    if (e.type === 'attachment') {
      if (!message.attachments.some((a) => a.id === e.attachment.id)) message.attachments.push(e.attachment)
      return
    }
    // A final backfill picks up anything flushed at the very end.
    void this.backfill(e.messageId).then(() => {
      const m = this.find(e.messageId)
      if (!m) return
      m.status = e.status
      m.error = e.error
      if (e.usage) m.usage = e.usage
      if (e.model) m.model = e.model
      if (e.status === 'error' && e.error) this.toast(e.error)
      this.liveIds.delete(e.messageId)
    })
  }
}

export const app = new AppState()
