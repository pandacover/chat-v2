import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { parseContentCached, type ArtifactBlock } from '@shared/artifacts'
import type { ComputerDoing, ComputerMode, ComputerWait } from '@shared/computer'
import type { UpdateState } from '@shared/types'
import type {
  Attachment,
  Bot,
  BotPatch,
  BrowserEvent,
  Job,
  JobDetail,
  JobStatus,
  JobTarget,
  ListedSession,
  MemoryView,
  Message,
  Presence,
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

/** The new chat has no title yet; its draft's first line stands in. */
export const draftTitle = (text: string) => {
  // The start is enough for 60 characters: a pasted draft can be megabytes. (Only a start that is
  // mostly whitespace inside the text could make the title shorter than the whole would.)
  const line = text.trimStart().slice(0, 400).replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New chat'
}

/** Cleans up the "Error invoking remote method" noise Electron sometimes adds. */
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

class AppState {
  /** Every thread but the primary's conversation, each with where it stands (running, unread…). */
  sessions = $state<ListedSession[]>([])
  /** The open conversation: the primary bot's (kind 'primary'), or a job's thread. */
  view = $state<SessionView | null>(null)

  // Bots and jobs. The user talks to the primary bot; each message goes to a job's thread.
  bots = $state<Bot[]>([])
  jobs = $state<Job[]>([])
  primaryBot = $derived(this.bots.find((b) => b.isPrimary) ?? null)
  /** The bot of the open conversation (a new chat is the primary's): what it can use comes from it. */
  currentBot = $derived((this.view?.session.botId ? this.bots.find((b) => b.id === this.view!.session.botId) : undefined) ?? this.primaryBot)
  /** The id of the primary bot's conversation, once loaded. */
  primaryId = $state<string | null>(null)
  /** What each bot is doing (its avatar shows it), by bot id. */
  presence = $state<Record<string, Presence>>({})
  /** More than one bot: the roster, owners and the bots on each job show. */
  team = $derived(this.bots.length > 1)
  /** The open job's bots, threads and notes, when a job's thread (or a bot's own thread on it) is open. */
  jobDetail = $state<JobDetail | null>(null)
  /** The primary bot's conversation is open (rather than a job's thread). */
  isPrimary = $derived(this.view?.session.kind === 'primary')
  /** Each job by its thread, for labelling turns and finding a thread's job. */
  jobByThread = $derived(new Map(this.jobs.flatMap((j) => (j.threadId ? [[j.threadId, j] as const] : []))))
  /** Where the next message to the primary goes; the job chip sets it, and it is 'auto' again after a send. */
  target = $state<JobTarget>('auto')
  /** A message sent to the primary that is still being routed, shown until its turn lands. */
  pending = $state<{ text: string; attachments: Attachment[] } | null>(null)
  /** The job the open conversation is on: the thread's, or in the primary's the one picked or last used. */
  currentJob = $derived.by<Job | null>(() => {
    const view = this.view
    if (!view) return null
    // A job's thread, or a bot's own thread on it.
    if (!this.isPrimary) return this.jobByThread.get(view.session.id) ?? this.jobs.find((j) => j.id === view.session.jobId) ?? null
    const t = this.target
    if (typeof t === 'object') return this.jobs.find((j) => j.id === t.jobId) ?? null
    const last = view.path.at(-1)?.message
    return last ? (this.jobByThread.get(last.sessionId) ?? null) : null
  })
  settings = $state<SettingsView | null>(null)
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
  /** The search modal (Ctrl K). */
  findOpen = $state(false)
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

  /** Whether this computer has computer use (Windows and macOS). */
  computerSupported = $state(false)
  /** What computer use waits on the user for, in whichever chat. */
  computerWait = $state<ComputerWait>(null)
  /** The computer tool each running reply is using now, by message id (live only; never saved). */
  computerDoing = new SvelteMap<string, ComputerDoing>()
  /** The mode each running computer reply works in, by message id: doing it, or showing how. */
  computerModes = new SvelteMap<string, ComputerMode>()
  /** A Show-me step of the open chat waits: a message sent now answers it. */
  teaching = $derived(
    this.computerWait?.kind === 'teach' &&
      (this.computerWait.sessionId === this.view?.session.id ||
        (this.isPrimary && this.view!.path.some((n) => n.message.sessionId === this.computerWait!.sessionId)))
  )
  /** Point is under way: the user is marking part of the screen for their next message. */
  pointing = $state(false)
  /** Bumped each time a finished Point adds its attachments, so the composer can take focus. */
  pointAdded = $state(0)
  /** Point's image and note belong together: removing one from the draft removes the other. */
  private pointPairs = new Map<string, string>()
  /** The attachment that came with `id` from the same Point, if any. */
  pointPartner(id: string): string | undefined {
    return this.pointPairs.get(id)
  }

  private toastSeq = 0
  private backfilling = new Map<string, Promise<void>>()

  // Derived rather than getters: these are read all over the layout, and a getter would
  // re-scan (and for artifacts, re-parse) the whole conversation on every streamed line.
  streaming = $derived(this.view?.path.some((n) => n.message.status === 'streaming') ?? false)

  private lastVersions: Array<{ messageId: string; block: ArtifactBlock }> = []
  /** Every complete version of the open artifact along the visible branch. */
  artifactVersions = $derived.by(() => {
    const open = this.artifact
    if (!open || !this.view) return (this.lastVersions = [])
    const out: Array<{ messageId: string; block: ArtifactBlock }> = []
    for (const { message } of this.view.path) {
      if (message.role !== 'assistant') continue
      for (const b of parseContentCached(message.content, message.id)) {
        if (b.type === 'artifact' && b.complete && b.identifier === open.identifier) out.push({ messageId: message.id, block: b })
      }
    }
    // The same versions as before (a streamed line that changed none of them): the same array, so
    // nothing that shows them updates.
    const last = this.lastVersions
    const same =
      out.length === last.length &&
      out.every((v, i) => v.messageId === last[i]!.messageId && v.block.content === last[i]!.block.content && v.block.title === last[i]!.block.title)
    return same ? last : (this.lastVersions = out)
  })

  /** The open chat's settings, or what has been picked for the new chat. */
  chat = $derived({
    // The primary's conversation runs on its bot's model.
    model: this.view ? (this.isPrimary ? (this.primaryBot?.model ?? null) : this.view.session.model) : (this.fresh.model ?? null),
    systemPrompt: this.view ? this.view.session.systemPrompt : (this.fresh.systemPrompt ?? null),
    // What the chat's bot can use (Settings › Bots), not a switch of the chat's own.
    browserEnabled: this.currentBot?.modules.includes('browser') ?? false,
    computerEnabled: this.currentBot?.modules.includes('computer') ?? false
  })

  hasArtifact = $derived(this.artifact !== null && this.artifactVersions.length > 0)

  panelOpen = $derived(this.browserOpen || this.hasArtifact)

  /** The visible tab, falling back to whichever one exists. */
  activeTab = $derived<'artifact' | 'browser'>(
    this.panelTab === 'browser' && this.browserOpen ? 'browser' : this.hasArtifact ? 'artifact' : 'browser'
  )

  /** The newest finished artifact in the open chat's visible branch, if any. */
  latestArtifact = $derived.by<OpenArtifact | null>(() => {
    const path = this.view?.path ?? []
    for (let i = path.length - 1; i >= 0; i--) {
      const m = path[i]!.message
      if (m.role !== 'assistant' || !/<artifact/i.test(m.content)) continue
      const found = parseContentCached(m.content, m.id).findLast((b) => b.type === 'artifact' && b.complete)
      if (found && found.type === 'artifact') return { identifier: found.identifier, messageId: m.id }
    }
    return null
  })

  /** What the panel showed when its toggle closed it, so the toggle can bring it back. */
  private closedPanel = $state<{ sessionId: string; artifact: OpenArtifact | null; browser: boolean; tab: 'artifact' | 'browser' } | null>(null)

  /** The panel toggle (top right) shows while the panel is open, or there's something to open. */
  panelToggle = $derived(
    this.panelOpen || this.latestArtifact !== null || (this.closedPanel !== null && this.closedPanel.sessionId === (this.view?.session.id ?? ''))
  )

  /** The panel toggle: closes the panel (artifact and browser), or brings back what it showed. */
  togglePanel() {
    const id = this.view?.session.id ?? ''
    if (this.panelOpen) {
      this.closedPanel = { sessionId: id, artifact: this.hasArtifact ? this.artifact : null, browser: this.browserOpen, tab: this.activeTab }
      this.artifact = null
      this.browserOpen = false
      return
    }
    const last = this.closedPanel?.sessionId === id ? this.closedPanel : null
    this.closedPanel = null
    if (last?.browser) this.browserOpen = true
    const artifact = last?.artifact ?? (last?.browser ? null : this.latestArtifact)
    if (artifact) this.artifact = artifact
    this.panelTab = last?.tab ?? 'artifact'
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
    if (!/\S/.test(text)) {
      if (!prev) return
      this.drafts.delete(key)
    } else if (prev && this.newestDraft() === key && (key !== '' || draftTitle(prev.text) === draftTitle(text))) {
      // Typing on: the sidebar shows nothing new (the row is there, first among drafts, and the
      // new chat's title is the same), so the draft changes in place. Setting it re-rendered the
      // whole chat list on every key.
      prev.text = text
      prev.at = Date.now()
    } else {
      this.drafts.set(key, { text, at: Date.now() })
    }
    clearTimeout(this.draftsTimer)
    this.draftsTimer = setTimeout(() => this.saveDrafts(), 300)
  }

  /** The draft edited last, which the sidebar lists first. */
  private newestDraft(): string | null {
    let key: string | null = null
    let at = -Infinity
    for (const [k, d] of this.drafts) if (d.at > at) [key, at] = [k, d.at]
    return key
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
    void api.computer.supported().then((on) => (this.computerSupported = on))
    void api.computer.waiting().then((w) => (this.computerWait = w))
    void api.updates.get().then((s) => (this.update = s))
    void api.bots.presence().then((p) => (this.presence = p)).catch(() => {})
    addEventListener('beforeunload', () => this.saveDrafts())
    const [, , , primary] = await Promise.all([this.refreshSessions(), this.loadSettings(), this.loadBots(), this.attempt(() => api.jobs.primary())])
    // The new chat's unsent draft (from before bots) is now said to the primary.
    const loose = this.drafts.get('')
    if (loose && primary && !this.drafts.has(primary.session.id)) this.drafts.set(primary.session.id, loose)
    // Drafts of chats that are gone (deleted elsewhere, or empty ones cleared at startup).
    for (const key of [...this.drafts.keys()])
      if (key !== primary?.session.id && !this.sessions.some((s) => s.id === key)) this.setDraft(key, '')
    // Tomo opens on the primary bot's conversation: everything said there goes to the right job.
    if (primary) this.setView(primary)
  }

  async loadBots() {
    const bots = await this.attempt(() => api.bots.list())
    if (bots) this.bots = bots
  }

  async updateBot(id: string, patch: BotPatch) {
    const bots = await this.attempt(() => api.bots.update(id, patch))
    if (bots) this.bots = bots
    return bots !== undefined
  }

  /** A new worker bot; resolves to it. */
  async createBot(patch: BotPatch = {}) {
    const bots = await this.attempt(() => api.bots.create(patch))
    if (!bots) return null
    this.bots = bots
    return bots.at(-1) ?? null
  }

  async removeBot(id: string) {
    const bots = await this.attempt(() => api.bots.remove(id))
    if (bots) this.bots = bots
    await this.refreshSessions()
  }

  async setPrimary(id: string) {
    const bots = await this.attempt(() => api.bots.setPrimary(id))
    if (bots) this.bots = bots
    await this.refreshSessions()
    if (this.isPrimary) await this.reloadPrimary()
  }

  /** A bot's latest thread of its own (on its newest job), or null when it has none yet. */
  latestThreadOf(botId: string): ListedSession | null {
    return this.sessions.filter((s) => s.kind === 'worker' && s.botId === botId).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  private jobsTimer: ReturnType<typeof setTimeout> | undefined
  async refreshJobs() {
    clearTimeout(this.jobsTimer)
    const jobs = await this.attempt(() => api.jobs.list())
    if (jobs) this.jobs = jobs
  }

  /** Opens the primary bot's conversation; `target` picks where its next message goes. */
  async openPrimary(target: JobTarget = 'auto') {
    this.target = target
    if (this.isPrimary) return void (await this.reloadPrimary())
    const view = await this.attempt(() => api.jobs.primary())
    if (view) this.setView(view)
  }

  private async reloadPrimary() {
    const view = await this.attempt(() => api.jobs.primary())
    if (view && this.isPrimary) this.setView(view)
  }

  /** Opens a job's thread. */
  async openJob(job: Job) {
    if (job.threadId) await this.open(job.threadId)
  }

  /** Puts the primary's last turn in another job (or a new one): a wrong guess put right. */
  async moveLast(target: 'new' | { jobId: string }) {
    const last = this.isPrimary ? this.view?.path.findLast((n) => n.message.role === 'user')?.message : undefined
    if (!last) return
    const view = await this.attempt(() => api.jobs.move({ messageId: last.id, target: $state.snapshot(target) as typeof target }))
    if (!view) return
    const reply = view.path.at(-1)?.message
    if (reply?.status === 'streaming') this.liveIds.add(reply.id)
    this.setView(view)
    await this.refreshSessions()
  }

  async setJobStatus(id: string, status: JobStatus) {
    await this.attempt(() => api.jobs.setStatus(id, status))
    await this.refreshJobs()
  }

  async renameJob(id: string, title: string) {
    await this.attempt(() => api.jobs.rename(id, title))
    const job = this.jobs.find((j) => j.id === id)
    if (job?.threadId && this.view?.session.id === job.threadId) this.view.session.title = title
    await this.refreshSessions()
  }

  async removeJob(id: string) {
    const job = this.jobs.find((j) => j.id === id)
    if (job?.threadId) this.discardDraft(job.threadId)
    const open = !!job?.threadId && this.view?.session.id === job.threadId
    await this.attempt(() => api.jobs.remove(id))
    await this.refreshSessions()
    if (open) await this.openPrimary()
    else if (this.isPrimary) await this.reloadPrimary()
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
    clearTimeout(this.sessionsTimer)
    const [list] = await Promise.all([this.attempt(() => api.sessions.list()), this.refreshJobs()])
    if (list) this.sessions = list
  }

  /** Replies start and end in bursts (a job's bots, a reply and its report): one reload for them all. */
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined
  private refreshSessionsSoon() {
    clearTimeout(this.sessionsTimer)
    this.sessionsTimer = setTimeout(() => void this.refreshSessions(), 150)
  }

  /** The user has seen what is in a thread: it isn't unread any more. */
  markRead(id: string) {
    const s = this.sessions.find((x) => x.id === id)
    if (s) s.state.readAt = Date.now()
    void api.sessions.markRead(id).catch(() => {})
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

  /** Installs a fresh view and catches up any replies that are still streaming. */
  setView(view: SessionView) {
    if (view.session.kind === 'primary') this.primaryId = view.session.id
    if (this.view?.session.id !== view.session.id) this.artifact = null
    this.view = view
    // A job's thread, or a bot's own thread on it: the job bar shows its bots and notes.
    const jobId = view.session.kind === 'primary' ? null : view.session.jobId
    if (jobId !== this.jobDetail?.job.id) this.jobDetail = null
    if (jobId && this.team) void this.loadJobDetail(jobId)
    // An open thread is read: whatever ended in it is in front of the user.
    if (view.session.kind !== 'primary') this.markRead(view.session.id)
    for (const node of view.path) {
      if (node.message.status === 'streaming') void this.backfill(node.message.id)
    }
  }

  async open(sessionId: string) {
    const view = await this.attempt(() => api.sessions.get(sessionId))
    if (view) this.setView(view)
  }

  /** A new topic: the primary's conversation, with its next message going to a new job. */
  newSession() {
    void this.openPrimary('new')
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

  /** Deletes a thread's job (and so the thread). */
  async remove(id: string) {
    const job = this.jobByThread.get(id)
    if (job) return this.removeJob(job.id)
    this.discardDraft(id)
    await this.attempt(() => api.sessions.remove(id))
    await this.refreshSessions()
    if (this.view?.session.id === id) await this.openPrimary()
  }

  async updateSession(patch: SessionPatch) {
    const view = this.view
    // The new chat isn't saved yet; its settings are applied when it is.
    if (!view) {
      this.fresh = { ...this.fresh, ...patch }
      return
    }
    // In the primary's conversation the model is its bot's; its toggles are its own, and go with each message to its job.
    const { model, ...rest } = patch
    if (this.isPrimary && model !== undefined && this.primaryBot) {
      await this.updateBot(this.primaryBot.id, { model })
      if (Object.keys(rest).length === 0) return
      patch = rest
    }
    await this.attempt(() => api.sessions.update(view.session.id, patch))
    if (this.isPrimary) await this.reloadPrimary()
    else await this.open(view.session.id)
  }

  /** The thread a message is in: in the primary's conversation, each turn is in its job's. */
  private sessionOf(messageId: string) {
    return this.find(messageId)?.sessionId ?? this.view?.session.id ?? ''
  }

  private async afterTurn(view: SessionView | undefined) {
    if (!view) return
    const last = view.path.at(-1)?.message
    if (last?.status === 'streaming') this.liveIds.add(last.id)
    // An action on a turn of the primary's conversation answers with its thread; the conversation stays open.
    if (this.isPrimary && view.session.kind !== 'primary') {
      for (const n of view.path) if (n.message.status === 'streaming') this.liveIds.add(n.message.id)
      await this.reloadPrimary()
    } else this.setView(view)
    await this.refreshSessions()
  }

  /** A message to the primary bot: routed to a job (or the one the chip picked). */
  private async sendToPrimary(text: string, attachments: Attachment[]) {
    const target = $state.snapshot(this.target) as JobTarget
    this.pending = { text, attachments }
    try {
      const view = await this.attempt(() => api.jobs.send({ text, attachmentIds: attachments.map((a) => a.id), target }))
      if (!view) return false
      this.target = 'auto'
      const reply = view.path.at(-1)?.message
      if (reply?.status === 'streaming') this.liveIds.add(reply.id)
      if (this.isPrimary) this.setView(view)
      await this.refreshSessions()
      return true
    } finally {
      this.pending = null
    }
  }

  async send(text: string, attachments: Attachment[]) {
    if (this.isPrimary) return this.sendToPrimary(text, attachments)
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
    await this.afterTurn(await this.attempt(() => api.chat.edit({ sessionId: this.sessionOf(messageId), messageId, text, attachmentIds })))
  }

  async regenerate(assistantId: string) {
    const view = this.view
    if (!view) return
    await this.afterTurn(await this.attempt(() => api.chat.regenerate({ sessionId: this.sessionOf(assistantId), assistantId })))
  }

  async continueReply(assistantId: string) {
    const view = this.view
    if (!view) return
    await this.afterTurn(await this.attempt(() => api.chat.continue({ sessionId: this.sessionOf(assistantId), assistantId })))
  }

  async stop() {
    const id = this.view?.path.findLast((n) => n.message.status === 'streaming')?.message.id
    if (id) await this.attempt(() => api.chat.stop(id))
  }

  async approve(id: string, approved: boolean) {
    await this.attempt(() => api.computer.approve(id, approved))
  }

  async teachDone(id: string) {
    await this.attempt(() => api.computer.teachDone(id))
  }

  /** Switches a running computer reply between doing it and showing how. */
  async setComputerMode(messageId: string, mode: ComputerMode) {
    const view = this.view
    if (!view) return
    await this.attempt(() => api.computer.setMode(this.sessionOf(messageId), messageId, mode))
  }

  async switchBranch(messageId: string) {
    const view = this.view
    if (!view) return
    const next = await this.attempt(() => api.chat.switchBranch({ sessionId: this.sessionOf(messageId), messageId }))
    if (next) this.setView(next)
  }

  async fork(messageId: string) {
    const view = this.view
    if (!view) return
    const next = await this.attempt(() => api.sessions.fork(this.sessionOf(messageId), messageId))
    if (!next) return
    this.setView(next)
    await this.refreshSessions()
    this.toast('Forked into a new job', 'info')
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
      // A number, not the message: the message is live state that events change meanwhile.
      const from = message.lineCount
      const { lines, status } = await api.chat.linesSince(messageId, from)
      const current = this.find(messageId)
      // A view set meanwhile holds fewer lines than were asked for; its own backfill runs next.
      if (!current || current.lineCount < from) return
      // Events may have advanced the message while the request was in flight.
      const fresh = lines.slice(current.lineCount - from)
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

  /** Threads a bot changed, reloaded together a moment later. */
  private touched = new Set<string>()
  private touchTimer: ReturnType<typeof setTimeout> | undefined
  private threadChanged(sessionId: string) {
    this.touched.add(sessionId)
    clearTimeout(this.touchTimer)
    this.touchTimer = setTimeout(() => {
      const ids = [...this.touched]
      this.touched.clear()
      const open = this.view?.session
      if (open?.kind === 'primary') void this.reloadPrimary()
      else if (open && ids.includes(open.id)) void this.reloadThread(open.id)
      if (this.jobDetail) void this.loadJobDetail(this.jobDetail.job.id)
      void this.refreshSessions()
    }, 80)
  }

  /** Reloads the open thread if it is still open, keeping replies that stream in it live. */
  private async reloadThread(id: string) {
    const view = await this.attempt(() => api.sessions.get(id))
    if (!view || this.view?.session.id !== id) return
    for (const n of view.path) if (n.message.status === 'streaming') this.liveIds.add(n.message.id)
    this.setView(view)
  }

  async loadJobDetail(jobId: string | null) {
    if (!jobId) return void (this.jobDetail = null)
    const detail = await this.attempt(() => api.jobs.detail(jobId))
    const open = this.view?.session
    if (detail && open && open.kind !== 'primary' && open.jobId === jobId) this.jobDetail = detail
  }

  /** The job a bot's own thread is on, when one is open. */
  workerJobId = $derived(this.view?.session.kind === 'worker' ? this.view.session.jobId : null)

  private onEvent(e: StreamEvent) {
    if (e.type === 'presence') {
      this.presence = e.presence
      // A reply started or ended somewhere: what runs (Working) and what is new change with it.
      this.refreshSessionsSoon()
      return
    }
    if (e.type === 'thread') {
      this.threadChanged(e.sessionId)
      return
    }
    if (e.type === 'jobs') {
      // Summaries and usage land in bursts after each reply: one reload for them all.
      clearTimeout(this.jobsTimer)
      this.jobsTimer = setTimeout(() => void this.refreshJobs(), 120)
      return
    }
    if (e.type === 'memory') {
      if (this.memory) void this.loadMemory()
      const quote = (fact: string) => `“${fact.replace(/\.$/, '')}”`
      if (e.added.length > 0)
        this.toast(`Remembered ${e.added.length === 1 ? quote(e.added[0]!) : `${e.added.length} things about you`}`, 'info')
      else if (e.removed.length > 0)
        this.toast(`Forgot ${e.removed.length === 1 ? quote(e.removed[0]!) : `${e.removed.length} things about you`}`, 'info')
      return
    }
    if (e.type === 'computer') {
      this.computerWait = e.waiting
      return
    }
    if (e.type === 'computerDoing') {
      if (e.doing) this.computerDoing.set(e.messageId, e.doing)
      else this.computerDoing.delete(e.messageId)
      return
    }
    if (e.type === 'computerMode') {
      this.computerModes.set(e.messageId, e.mode)
      return
    }
    if (e.type === 'point') {
      this.pointing = e.active
      for (const a of e.attachments) this.addDraftAttachment(a)
      const [first, second] = e.attachments
      if (first && second) {
        this.pointPairs.set(first.id, second.id)
        this.pointPairs.set(second.id, first.id)
      }
      // A mark's own chips and the composer taking focus say it was added; a toast would sit over
      // the composer's controls meanwhile.
      if (e.error) this.toast(e.error)
      if (e.attachments.length) this.pointAdded++
      return
    }
    if (e.type === 'title') {
      const session = this.sessions.find((s) => s.id === e.sessionId)
      if (session) session.title = e.title
      const job = this.jobByThread.get(e.sessionId)
      if (job) job.title = e.title
      if (this.view?.session.id === e.sessionId) this.view.session.title = e.title
      return
    }
    const message = this.find(e.messageId)
    if (e.type === 'done') {
      // A reply that ended where the user is looking (its thread, or Tomo's conversation it shows
      // in) is seen; one that ended elsewhere makes its thread unread.
      if (message) this.markRead(message.sessionId)
      this.refreshSessionsSoon()
    }
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
      this.computerDoing.delete(e.messageId)
      this.computerModes.delete(e.messageId)
    })
  }
}

export const app = new AppState()
