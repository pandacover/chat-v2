// Light/dark theme: follows the OS unless the user picks one (kept in localStorage).

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'chat-v2:theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const root = document.documentElement

class Theme {
  pref = $state<ThemePref>((localStorage.getItem(KEY) as ThemePref | null) ?? 'system')
  resolved = $state<'light' | 'dark'>('light')

  constructor() {
    media.addEventListener('change', () => this.apply())
    this.apply()
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
    // Two frames: one to paint the new palette, one before transitions return.
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')))
  }
}

export const theme = new Theme()
