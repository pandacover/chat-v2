// The account's usage as the main process reports it (src/main/usage): the plan's windows or an
// API key's dollars, replies paused at a limit, and the notices worth a quiet word. Read once when
// the sidebar's meter mounts, then kept current by usage events; never polled.
import { SvelteMap } from 'svelte/reactivity'
import type { UsageEvent, UsagePause, UsageShare, UsageView } from '@shared/usage'
import { noticeText } from '@shared/usage'
import { app } from './store.svelte'

const api = window.api

class Meter {
  view = $state<UsageView | null>(null)
  /** Settings opens on its Usage tab next time (the meter's click). */
  wantTab = false
  private started = false
  /** Each job's estimated shares, by job id, for the jobs shown; read again after usage changes. */
  shares = new SvelteMap<string, UsageShare[]>()
  private sharesTimer: ReturnType<typeof setTimeout> | undefined

  /** Reads a job's shares (a view of the job is showing it). */
  async loadJob(jobId: string) {
    const shares = await api.usage.jobShare(jobId).catch(() => null)
    if (shares) this.shares.set(jobId, shares)
  }

  /** The message is in the conversation open now: a job's thread, or a turn of Tomo's conversation. */
  private inView(messageId: string) {
    return app.view?.path.some((n) => n.message.id === messageId) ?? false
  }

  /** Continues a paused reply now, wherever it is. */
  async continueNow(pause: UsagePause) {
    if (this.inView(pause.messageId)) return app.continueReply(pause.messageId)
    await app.attempt(() => api.chat.continue({ sessionId: pause.sessionId, assistantId: pause.messageId }))
  }

  start() {
    if (this.started) return
    this.started = true
    api.usage.onEvent((e) => this.on(e))
    void api.usage.get().then(
      (v) => (this.view = v),
      () => undefined
    )
  }

  pauseFor(messageId: string): UsagePause | null {
    return this.view?.pauses.find((p) => p.messageId === messageId) ?? null
  }

  /** Reads the meter again (a view of it opened). */
  async refresh() {
    const v = await app.attempt(() => api.usage.refresh())
    if (v) this.view = v
  }

  /** The paused reply stays stopped, to continue by hand. */
  async cancel(messageId: string) {
    const v = await app.attempt(() => api.usage.cancelPause(messageId))
    if (v) this.view = v
  }

  openSettings() {
    this.wantTab = true
    app.settingsOpen = true
  }

  /** Settings asks which tab to open on. */
  takeTab() {
    const want = this.wantTab
    this.wantTab = false
    return want
  }

  private on(e: UsageEvent) {
    this.view = e.view
    if (e.type === 'view' && e.notice) app.toast(noticeText(e.notice), 'info')
    // A paused reply runs again by itself: the conversation showing it reloads, to stream it. In
    // Tomo's conversation the reply is a turn of a job's thread, so it's found by message.
    if (e.type === 'resumed' && app.view && this.inView(e.messageId)) {
      app.liveIds.add(e.messageId)
      if (app.isPrimary) void app.openPrimary(app.target)
      else void app.open(app.view.session.id)
    }
    // Usage moved (a reply ended, a reading came): the shares shown are read again, once it settles.
    clearTimeout(this.sharesTimer)
    this.sharesTimer = setTimeout(() => {
      for (const id of [...this.shares.keys()]) void this.loadJob(id)
    }, 800)
  }
}

export const meter = new Meter()
