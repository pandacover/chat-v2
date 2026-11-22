import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { parseContentCached, type ArtifactBlock } from '@shared/artifacts'
import type { ComputerDoing, ComputerMode, ComputerWait } from '@shared/computer'
import type { UpdateState } from '@shared/types'
import type {
  Attachment,
  Bot,
  BotPatch,
  BrowserEvent,
  BrowserOwner,
  Job,
  JobDetail,
  JobStatus,
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

/** A tab of the right panel: the built-in browser, or an artifact of the open chat at a version. */
export type PanelTab = { kind: 'browser' } | ({ kind: 'artifact' } & OpenArtifact)
export const tabKey = (t: PanelTab) => (t.kind === 'browser' ? 'browser' : `artifact:${t.identifier}`)

/** A chat's panel: its tabs, the one picked, and whether it shows. Each chat has its own. */
export interface PanelState {
  tabs: PanelTab[]
  active: string | null
  shown: boolean
}

/** An artifact of the open chat, with every complete version of it along the visible branch. */
export interface ChatArtifact {
  identifier: string
  /** Its newest title. */
  title: string
  versions: Array<{ messageId: string; block: ArtifactBlock }>
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

  // Bots and jobs. The user talks to the primary bot, in its own conversation; a job (and its thread)
  // opens when work is handed off, to a worker or to the primary itself.
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
  /** A message sent to the primary that is still on its way, shown until its turn lands. */
  pending = $state<{ text: string; attachments: Attachment[] } | null>(null)
  /** The job the open thread is on (a job's thread, or a bot's own thread on it); none in the primary's conversation. */
  currentJob = $derived.by<Job | null>(() => {
    const view = this.view
    if (!view || this.isPrimary) return null
    return this.jobByThread.get(view.session.id) ?? this.jobs.find((j) => j.id === view.session.jobId) ?? null
  })
  settings = $state<SettingsView | null>(null)
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
  /** The time, to the minute: what reads it (the sidebar's sections) is worked out again each minute. */
  minute = $state(Date.now())

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

  // The right panel: tabs, each the built-in browser (there is one) or an artifact of the open chat,
  // and whether it shows. Its toggle at the right of the app bar hides it with its tabs kept; the
  // + in its tab strip opens the browser or any of the chat's artifacts. Each chat has a panel of
  // its own: these are the open chat's, and the others wait in `panels` until their chat opens.
  panelTabs = $state<PanelTab[]>([])
  /** The tab picked, by its key (tabKey). */
  panelActive = $state<string | null>(null)
  panelShown = $state(false)
  /** The panels of the chats that aren't open, by chat id. */
  private panels = new Map<string, PanelState>()
  /**
   * The chat whose panel has the browser, or null while it is closed. There is one browser: it
   * opens in the chat it was opened in, or that the reply driving it runs in, and stays there
   * (running out of sight while another chat is open) until it is closed or moves to another.
   */
  browserSession = $state<string | null>(null)
  /** The browser is open in some chat's panel, so its page stays loaded (App.svelte keeps it mounted). */
  browserAlive = $derived(this.browserSession !== null)
  browser = $state({ url: '', title: '', loading: false, canBack: false, canForward: false })
  /** Set while the model is driving the browser; `by` is the reply driving it. */
  control = $state<{ active: boolean; label: string; by: BrowserOwner | null }>({ active: false, label: '', by: null })
  /** A reply of the open chat drives the browser, which is in this chat's panel. */
  browsingHere = $derived(this.control.active && this.browserSession !== null && this.browserSession === (this.view?.session.id ?? ''))
  /** What the browser is doing for reply `messageId`, if it is the one driving it. */
  browsingFor(messageId: string): string | null {
    return this.control.active && this.control.by?.messageId === messageId ? this.control.label || 'Working' : null
  }
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
        // Talking to Tomo, a message answers a Show-me step waiting in any thread (Jobs.send).
        this.isPrimary)
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

  private lastArtifacts: ChatArtifact[] = []
  /**
   * The artifacts along the open chat's visible branch, in the order each first appeared, each with
   * its complete versions, oldest first: what the panel's + offers, and what an artifact tab shows.
   */
  chatArtifacts = $derived.by((): ChatArtifact[] => {
    const byId = new Map<string, ChatArtifact>()
    for (const { message } of this.view?.path ?? []) {
      if (message.role !== 'assistant' || !/<artifact/i.test(message.content)) continue
      for (const b of parseContentCached(message.content, message.id)) {
        if (b.type !== 'artifact' || !b.complete) continue
        const a = byId.get(b.identifier) ?? { identifier: b.identifier, title: b.title, versions: [] }
        a.title = b.title
        a.versions.push({ messageId: message.id, block: b })
        byId.set(b.identifier, a)
      }
    }
    const out = [...byId.values()]
    // The same artifacts as before (a streamed line that changed none of them): the same array, so
    // nothing that shows them updates.
    const last = this.lastArtifacts
    const same =
      out.length === last.length &&
      out.every((a, i) => {
        const b = last[i]!
        return (
          a.identifier === b.identifier &&
          a.title === b.title &&
          a.versions.length === b.versions.length &&
          a.versions.every((v, j) => v.messageId === b.versions[j]!.messageId && v.block.content === b.versions[j]!.block.content)
        )
      })
    return same ? last : (this.lastArtifacts = out)
  })

  /** An artifact's complete versions along the open chat's visible branch, oldest first. */
  versionsOf(identifier: string): ChatArtifact['versions'] {
    return this.chatArtifacts.find((a) => a.identifier === identifier)?.versions ?? []
  }

  /** The open chat's settings, or what has been picked for the new chat. */
  chat = $derived({
    // The primary's conversation runs on its bot's model.
    model: this.view ? (this.isPrimary ? (this.primaryBot?.model ?? null) : this.view.session.model) : (this.fresh.model ?? null),
    systemPrompt: this.view ? this.view.session.systemPrompt : (this.fresh.systemPrompt ?? null),
    // What the chat's bot can use (Settings › Bots), not a switch of the chat's own.
    browserEnabled: this.currentBot?.modules.includes('browser') ?? false,
    computerEnabled: this.currentBot?.modules.includes('computer') ?? false
  })

  /** The panel's tabs that have something to show: an artifact not on this branch any more waits. */
  shownTabs = $derived(this.panelTabs.filter((t) => t.kind === 'browser' || this.versionsOf(t.identifier).length > 0))
  /** The tab on show: the one picked, or the first there is. */
  activeTab = $derived<PanelTab | null>(this.shownTabs.find((t) => tabKey(t) === this.panelActive) ?? this.shownTabs[0] ?? null)
  browserOpen = $derived(this.panelTabs.some((t) => t.kind === 'browser'))
  panelOpen = $derived(this.panelShown)
  /** The artifact on show in the panel, and which version: its card in the chat shows it open. */
  artifact = $derived<OpenArtifact | null>(
    this.panelShown && this.activeTab?.kind === 'artifact' ? { identifier: this.activeTab.identifier, messageId: this.activeTab.messageId } : null
  )

  /** Opens a tab (or goes to it, as given), on show in the panel. */
  private openTab(tab: PanelTab) {
    const key = tabKey(tab)
    const at = this.panelTabs.findIndex((t) => tabKey(t) === key)
    if (at === -1) this.panelTabs.push(tab)
    else this.panelTabs[at] = tab
    this.panelActive = key
    this.panelShown = true
    if (tab.kind === 'browser') this.browserSession = this.view?.session.id ?? ''
  }

  /**
   * Puts the browser in a chat's panel, on show there: the open chat's, or (a reply in another
   * chat drives it) that chat's, which shows it when the user opens it. It leaves the panel it
   * was in, so it never shows in a chat it has nothing to do with.
   */
  private placeBrowser(sessionId: string) {
    const here = this.view?.session.id ?? ''
    const was = this.browserSession
    if (was !== null && was !== sessionId) {
      if (was === here) this.closeTab('browser')
      else {
        const p = this.panels.get(was)
        if (p) {
          p.tabs = p.tabs.filter((t) => t.kind !== 'browser')
          if (p.active === 'browser') p.active = null
          if (p.tabs.length === 0) p.shown = false
        }
      }
    }
    if (sessionId === here) return this.openTab({ kind: 'browser' })
    const p = this.panels.get(sessionId) ?? { tabs: [], active: null, shown: false }
    if (!p.tabs.some((t) => t.kind === 'browser')) p.tabs.push({ kind: 'browser' })
    p.active = 'browser'
    p.shown = true
    this.panels.set(sessionId, p)
    this.browserSession = sessionId
  }

  /** Switches the panel to another chat's: the one open keeps its tabs for when it comes back. */
  private switchPanel(from: string, to: string) {
    if (from === to) return
    this.panels.set(from, { tabs: this.panelTabs, active: this.panelActive, shown: this.panelShown })
    const next = this.panels.get(to)
    this.panels.delete(to)
    this.panelTabs = next?.tabs ?? []
    this.panelActive = next?.active ?? null
    this.panelShown = next?.shown ?? false
  }

  /**
   * Forgets the panels of chats that were deleted; a browser left in one of them closes. Only
   * chats that were listed and aren't any more: a thread made a moment ago may not be listed yet.
   */
  private prunePanels(gone: ReadonlySet<string>) {
    for (const id of gone) this.panels.delete(id)
    const b = this.browserSession
    if (b !== null && gone.has(b) && b !== (this.view?.session.id ?? '')) this.browserSession = null
  }

  /** Opens an artifact of the open chat in a tab of its own, at the given version. */
  showArtifact(artifact: OpenArtifact) {
    this.openTab({ kind: 'artifact', identifier: artifact.identifier, messageId: artifact.messageId })
  }

  /** Which version of an open artifact its tab shows. */
  pickVersion(identifier: string, messageId: string) {
    const tab = this.panelTabs.find((t) => t.kind === 'artifact' && t.identifier === identifier)
    if (tab?.kind === 'artifact') tab.messageId = messageId
  }

  openBrowser() {
    this.openTab({ kind: 'browser' })
  }

  closeBrowser() {
    this.closeTab('browser')
  }

  selectTab(key: string) {
    this.panelActive = key
  }

  /** Closes a tab; the one next to it shows, and with none left the panel goes. */
  closeTab(key: string) {
    const shown = this.shownTabs.map(tabKey)
    const at = shown.indexOf(key)
    this.panelTabs = this.panelTabs.filter((t) => tabKey(t) !== key)
    if (this.panelActive === key || this.panelActive === null) this.panelActive = shown[at + 1] ?? shown[at - 1] ?? null
    if (this.panelTabs.length === 0) this.panelShown = false
    if (key === 'browser' && this.browserSession === (this.view?.session.id ?? '')) this.browserSession = null
  }

  /** The bar's panel toggle: shows or hides the panel, its tabs kept. Empty, it offers what to open. */
  togglePanel() {
    this.panelShown = !this.panelShown
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
    // The browser opens in the thread of the reply that needs it, not in whichever chat is open.
    if (e.type === 'open') this.placeBrowser(e.sessionId ?? this.view?.session.id ?? '')
    else if (e.type === 'control') {
      this.control = { active: e.active, label: e.label, by: e.by }
      if (e.active) this.placeBrowser(e.by?.sessionId ?? this.view?.session.id ?? '')
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
    setInterval(() => (this.minute = Date.now()), 60_000)
    const [, , , primary] = await Promise.all([this.refreshSessions(), this.loadSettings(), this.loadBots(), this.attempt(() => api.jobs.primary())])
    // The new chat's unsent draft (from before bots) is now said to the primary.
    const loose = this.drafts.get('')
    if (loose && primary && !this.drafts.has(primary.session.id)) this.drafts.set(primary.session.id, loose)
    // Drafts of chats that are gone (deleted elsewhere, or empty ones cleared at startup).
    for (const key of [...this.drafts.keys()])
      if (key !== primary?.session.id && !this.sessions.some((s) => s.id === key)) this.setDraft(key, '')
    // Tomo opens on the primary bot's conversation, where everything is said to it.
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

  /** Opens the primary bot's conversation. */
  async openPrimary() {
    if (this.isPrimary) return void (await this.reloadPrimary())
    const view = await this.attempt(() => api.jobs.primary())
    if (view) this.setView(view)
  }

  private async reloadPrimary() {
    const view = await this.attempt(() => api.jobs.primary())
    if (view && this.isPrimary) this.setView(view)
  }

  /**
   * The primary's own thread on a job it handed itself, where the work is: a job opens there. (A
   * job's shared thread then only holds the task and the report.)
   */
  ownThreadOf(job: Job): ListedSession | null {
    const primary = this.primaryBot
    if (!primary || job.ownerBotId !== primary.id) return null
    return this.sessions.find((s) => s.kind === 'worker' && s.jobId === job.id && s.botId === primary.id) ?? null
  }

  /** Opens a job: its thread, or the primary's own thread on it when it handed the job itself. */
  async openJob(job: Job) {
    const id = this.ownThreadOf(job)?.id ?? job.threadId
    if (id) await this.open(id)
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
    if (!list) return
    const now = new Set(list.map((s) => s.id))
    const gone = new Set(this.sessions.flatMap((s) => (now.has(s.id) ? [] : [s.id])))
    this.sessions = list
    if (gone.size > 0) this.prunePanels(gone)
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
    // Another chat: its own panel shows, with the artifacts and the browser opened in it; this
    // chat's waits for it to come back.
    this.switchPanel(this.view?.session.id ?? '', view.session.id)
    this.view = view
    // A job's thread, or a bot's own thread on it: the job bar shows its bots and notes.
    const jobId = view.session.kind === 'primary' ? null : view.session.jobId
    if (jobId !== this.jobDetail?.job.id) this.jobDetail = null
    if (jobId && this.team) void this.loadJobDetail(jobId)
    // An open thread is read: whatever ended in it is in front of the user. The primary's own
    // thread on a job it handed itself stands for the job, so its shared thread is read with it.
    if (view.session.kind !== 'primary') this.markRead(view.session.id)
    const job = view.session.kind === 'worker' && view.session.botId === this.primaryBot?.id ? this.jobs.find((j) => j.id === view.session.jobId) : undefined
    if (job?.threadId && job.threadId !== view.session.id) this.markRead(job.threadId)
    for (const node of view.path) {
      if (node.message.status === 'streaming') void this.backfill(node.message.id)
    }
  }

  async open(sessionId: string) {
    const view = await this.attempt(() => api.sessions.get(sessionId))
    if (view) this.setView(view)
  }

  /**
   * New topic: the primary's conversation, with a divider after which Tomo starts afresh (nothing
   * before it is resumed). Nothing happens to a conversation that is empty or just divided.
   */
  async newSession() {
    const view = await this.attempt(() => api.jobs.newTopic())
    if (view) this.setView(view)
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

  /** A message to the primary bot, in its own conversation. */
  private async sendToPrimary(text: string, attachments: Attachment[]) {
    this.pending = { text, attachments }
    try {
      const view = await this.attempt(() => api.jobs.send({ text, attachmentIds: attachments.map((a) => a.id) }))
      if (!view) return false
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

  /** Take over in the browser: the reply driving it stops, wherever it runs. */
  async takeOverBrowser() {
    const id = this.control.by?.messageId
    if (id) await this.attempt(() => api.chat.stop(id))
    else await this.stop()
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
