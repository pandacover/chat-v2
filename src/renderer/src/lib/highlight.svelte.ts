// highlight.js, loaded after the window is up rather than with it: its 37 languages are about
// 280 KB of script to parse, and most chats show no code at first. Until it arrives, code shows
// plain; reading `highlighter.hljs` in a $derived re-runs it once it has.
import type { HLJSApi } from 'highlight.js'

let api = $state.raw<HLJSApi | null>(null)
let loading: Promise<void> | null = null

export const loadHighlighter = (): Promise<void> =>
  (loading ??= import('highlight.js/lib/common').then((m) => {
    api = m.default
  }))

export const highlighter = {
  /** The library once loaded; reading it before then starts the load. */
  get hljs(): HLJSApi | null {
    if (!api) void loadHighlighter()
    return api
  }
}

/** Escapes code shown without highlighting. */
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
