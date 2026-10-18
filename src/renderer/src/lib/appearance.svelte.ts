// Font and text-size preferences, applied as CSS variables and kept in localStorage.

export interface FontOption {
  id: string
  label: string
  stack: string
}

export const READING_FONTS: FontOption[] = [
  { id: 'newsreader', label: 'Newsreader', stack: "'Newsreader Variable', Georgia, serif" },
  { id: 'literata', label: 'Literata', stack: "'Literata Variable', Georgia, serif" },
  { id: 'source-serif', label: 'Source Serif', stack: "'Source Serif 4 Variable', Georgia, serif" },
  { id: 'instrument-sans', label: 'Instrument Sans', stack: "'Instrument Sans Variable', system-ui, sans-serif" },
  { id: 'inter', label: 'Inter', stack: "'Inter Variable', system-ui, sans-serif" },
  { id: 'system', label: 'System', stack: 'ui-sans-serif, system-ui, sans-serif' }
]

export const UI_FONTS: FontOption[] = [
  { id: 'instrument-sans', label: 'Instrument Sans', stack: "'Instrument Sans Variable', system-ui, sans-serif" },
  { id: 'inter', label: 'Inter', stack: "'Inter Variable', system-ui, sans-serif" },
  { id: 'geist', label: 'Geist', stack: "'Geist Variable', system-ui, sans-serif" },
  { id: 'plex-sans', label: 'IBM Plex Sans', stack: "'IBM Plex Sans', system-ui, sans-serif" },
  { id: 'system', label: 'System', stack: 'ui-sans-serif, system-ui, sans-serif' }
]

export const CODE_FONTS: FontOption[] = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: "'JetBrains Mono Variable', ui-monospace, Consolas, monospace" },
  { id: 'geist-mono', label: 'Geist Mono', stack: "'Geist Mono Variable', ui-monospace, Consolas, monospace" },
  { id: 'plex-mono', label: 'IBM Plex Mono', stack: "'IBM Plex Mono', ui-monospace, Consolas, monospace" },
  { id: 'system', label: 'System', stack: 'ui-monospace, Consolas, monospace' }
]

export const READING_SIZES = [
  { id: 'compact', label: 'Compact', px: 15 },
  { id: 'default', label: 'Default', px: 16.5 },
  { id: 'large', label: 'Large', px: 18 }
] as const

export type ReadingSize = (typeof READING_SIZES)[number]['id']

interface Prefs {
  reading: string
  ui: string
  code: string
  size: ReadingSize
}

const KEY = 'chat-v2:appearance'
const DEFAULTS: Prefs = { reading: 'newsreader', ui: 'instrument-sans', code: 'jetbrains-mono', size: 'default' }

const load = (): Prefs => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) }
  } catch {
    return DEFAULTS
  }
}

const pick = (list: FontOption[], id: string) => list.find((f) => f.id === id) ?? list[0]!

class Appearance {
  prefs = $state<Prefs>(load())

  constructor() {
    this.apply()
    // Fires in every other window of the app (the computer-use overlay among them) on a change.
    addEventListener('storage', (e) => {
      if (e.key !== KEY && e.key !== null) return
      this.prefs = load()
      this.apply()
    })
  }

  set<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    this.prefs[key] = value
    localStorage.setItem(KEY, JSON.stringify(this.prefs))
    this.apply()
  }

  reset() {
    this.prefs = { ...DEFAULTS }
    localStorage.removeItem(KEY)
    this.apply()
  }

  private apply() {
    const root = document.documentElement.style
    root.setProperty('--font-reading', pick(READING_FONTS, this.prefs.reading).stack)
    root.setProperty('--font-ui', pick(UI_FONTS, this.prefs.ui).stack)
    root.setProperty('--font-code', pick(CODE_FONTS, this.prefs.code).stack)
    root.setProperty('--reading-size', `${(READING_SIZES.find((s) => s.id === this.prefs.size) ?? READING_SIZES[1]).px}px`)
  }
}

export const appearance = new Appearance()
