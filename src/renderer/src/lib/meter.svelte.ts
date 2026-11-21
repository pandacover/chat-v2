// The account's usage as the main process reports it (src/main/usage): the plan's windows or an
// API key's dollars, replies paused at a limit, and the notices worth a quiet word. Read once when
// the sidebar's meter mounts, then kept current by usage events; never polled.
import type { UsageEvent, UsagePause, UsageView } from '@shared/usage'
import { noticeText } from '@shared/usage'
import { app } from './store.svelte'

const api = window.api

class Meter {
  view = $state<UsageView | null>(null)
  /** Settings opens on its Usage tab next time (the meter's click). */
  wantTab = false
  private started = false

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
    // A paused reply runs again by itself: the chat showing it reloads, to stream it.
    if (e.type === 'resumed' && app.view?.session.id === e.sessionId) {
      app.liveIds.add(e.messageId)
      void app.open(e.sessionId)
    }
  }
}

export const meter = new Meter()
