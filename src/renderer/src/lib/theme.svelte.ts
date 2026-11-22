// Light/dark theme: follows the OS unless the user picks one (kept in localStorage).

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'chat-v2:theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const root = document.documentElement
// The app bar leaves room for a Mac's traffic lights at its left end (app.css --bar-left).
root.dataset.platform = /Mac/i.test(navigator.platform) ? 'mac' : 'other'

class Theme {
  pref = $state<ThemePref>((localStorage.getItem(KEY) as ThemePref | null) ?? 'system')
  resolved = $state<'light' | 'dark'>('light')
  /** Scrims open over the page (modals): the window's buttons in the app bar dim with it. */
  private scrims = 0

  constructor() {
    media.addEventListener('change', () => this.apply())
    this.apply()
  }

  /** A scrim came or went (`dimsBar`). */
  scrim(delta: 1 | -1) {
    const was = this.scrims > 0
    this.scrims = Math.max(0, this.scrims + delta)
    if (was !== this.scrims > 0) this.tellWindow()
  }

  // The window's buttons in the app bar take the page's colours (src/main/index.ts).
  private tellWindow() {
    window.api?.appWindow?.setTheme(this.resolved, this.scrims > 0)
  }

  set(pref: ThemePref) {
    this.pref = pref
    localStorage.setItem(KEY, pref)
    this.apply()
  }

  private apply() {
    const next = this.pref === 'system' ? (media.matches ? 'dark' : 'light') : this.pref
    if (root.dataset.theme === next) return
    this.resolved = next
    root.classList.add('theme-swap')
    root.dataset.theme = next
    this.tellWindow()
    // Two frames: one to paint the new palette, one before transitions return.
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')))
  }
}

export const theme = new Theme()

/** On a modal's scrim: while it is there, the window's buttons in the app bar dim as the page does. */
export const dimsBar = (_node: Element) => {
  theme.scrim(1)
  return { destroy: () => theme.scrim(-1) }
}
