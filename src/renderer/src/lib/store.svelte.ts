import { SvelteSet } from 'svelte/reactivity'
import { parseContent, type ArtifactBlock } from '@shared/artifacts'
import type { UpdateState } from '@shared/types'
import type { Attachment, BrowserEvent, Message, ModelInfo, Session, SessionView, SettingsView, StreamEvent } from '@shared/types'

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

/** Cleans up the "Error invoking remote method" noise Electron sometimes adds. */
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

class AppState {
  sessions = $state<Session[]>([])
  view = $state<SessionView | null>(null)
  settings = $state<SettingsView | null>(null)
  models = $state<ModelInfo[]>([])
  modelsError = $state<string | null>(null)
  artifact = $state<OpenArtifact | null>(null)
  /** Settings is a page over the chat; the chat stays mounted so drafts and scroll survive. */
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

  update = $state<UpdateState | null>(null)

  /** Pending composer attachments. Shared so the browser panel can add captures. */
  draftAttachments = $state<Attachment[]>([])

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

  get streaming(): boolean {
    return this.view?.path.some((n) => n.message.status === 'streaming') ?? false
  }

  get hasArtifact(): boolean {
    return this.artifact !== null && this.artifactVersions.length > 0
  }

  get panelOpen(): boolean {
    return this.browserOpen || this.hasArtifact
  }

  /** The visible tab, falling back to whichever one exists. */
  get activeTab(): 'artifact' | 'browser' {
    if (this.panelTab === 'browser' && this.browserOpen) return 'browser'
    return this.hasArtifact ? 'artifact' : 'browser'
  }

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

  /** Every complete version of the open artifact along the visible branch. */
  get artifactVersions(): Array<{ messageId: string; block: ArtifactBlock }> {
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
  }

  async init() {
    api.chat.onEvent((e) => this.onEvent(e))
    api.browser.onEvent((e) => this.onBrowserEvent(e))
    api.updates.onEvent((s) => (this.update = s))
    void api.updates.get().then((s) => (this.update = s))
    await Promise.all([this.refreshSessions(), this.loadSettings()])
    const first = this.sessions[0]
    if (first) await this.open(first.id)
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

  async loadModels() {
    try {
      this.models = await api.models.list()
      this.modelsError = null
    } catch (e) {
      this.modelsError = describe(e)
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

  async newSession() {
    // Reuse an untouched empty chat instead of piling up blank sessions.
    if (this.view && this.view.path.length === 0) return
    const view = await this.attempt(() => api.sessions.create())
    if (!view) return
    this.setView(view)
    await this.refreshSessions()
  }

  async rename(id: string, title: string) {
    await this.attempt(() => api.sessions.rename(id, title))
    if (this.view?.session.id === id) this.view.session.title = title
    await this.refreshSessions()
  }

  async remove(id: string) {
    await this.attempt(() => api.sessions.remove(id))
    await this.refreshSessions()
    if (this.view?.session.id === id) {
      this.view = null
      const next = this.sessions[0]
      if (next) await this.open(next.id)
    }
  }

  async updateSession(patch: { model?: string | null; systemPrompt?: string | null; browserEnabled?: boolean }) {
    let view = this.view
    // Picking a model or instructions before the first message starts the chat.
    if (!view) {
      view = (await this.attempt(() => api.sessions.create())) ?? null
      if (!view) return
      this.setView(view)
      await this.refreshSessions()
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
    if (!view) {
      view = (await this.attempt(() => api.sessions.create())) ?? null
      if (!view) return false
      this.setView(view)
    }
    const parentId = view.path.at(-1)?.message.id ?? view.session.rootId
    const result = await this.attempt(() =>
      api.chat.send({ sessionId: view.session.id, parentId, text, attachmentIds: attachments.map((a) => a.id) })
    )
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

  private onEvent(e: StreamEvent) {
    const message = this.find(e.messageId)
    if (!message) return
    if (e.type === 'line') {
      if (e.index < message.lineCount) return // already have it
      if (e.index > message.lineCount) return void this.backfill(e.messageId) // missed some
      this.appendLine(message, e.text)
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
