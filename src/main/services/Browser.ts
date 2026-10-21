// Type-only: the Electron lookup is injected, so this module loads outside Electron (tests).
import type { WebContents } from 'electron'
import { Context, Effect, Layer, Schema } from 'effect'
import type { BrowserEvent, ElementInfo } from '@shared/types'
import { errorMessage } from '../errors'

export class BrowserError extends Schema.TaggedError<BrowserError>()('BrowserError', {
  message: Schema.String
}) {}

export interface PageSnapshot {
  url: string
  title: string
  elements: string
  text: string
  scroll: { y: number; height: number; viewport: number }
}

/** A page's readable text: headings, paragraphs, lists, tables and code, in order. */
export interface Reading {
  url: string
  title: string
  text: string
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface Shot {
  /** JPEG data URL, downscaled for sending to a model. */
  dataUrl: string
  png: Uint8Array<ArrayBuffer>
}

/** A recording of the panel, saved as a video file. */
export interface Recording {
  path: string
  seconds: number
}

/** The panel's answer to a `record` event, once a finished video has been written to `path`. */
export type PanelReply = { ok: true; path?: string; seconds?: number } | { ok: false; error: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs in the page: tags visible interactive elements with refs and summarises the page. */
export const SNAPSHOT_JS = `(() => {
  const MAX = 300
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]'
  document.querySelectorAll('[data-agent-ref]').forEach((e) => e.removeAttribute('data-agent-ref'))
  const clip = (s, n) => String(s || '').trim().replace(/\\s+/g, ' ').slice(0, n)
  let n = 0
  const lines = []
  for (const el of document.querySelectorAll(sel)) {
    if (n >= MAX) break
    if (!visible(el)) continue
    const ref = 'e' + ++n
    el.setAttribute('data-agent-ref', ref)
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : tag)
    const name = clip(el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name, 80)
    const extra = []
    if ((tag === 'input' || tag === 'textarea') && el.value) extra.push('value="' + clip(el.value, 40) + '"')
    if (el.placeholder) extra.push('placeholder="' + clip(el.placeholder, 40) + '"')
    if (el.disabled) extra.push('disabled')
    if (el.checked) extra.push('checked')
    if (tag === 'a') extra.push('href="' + clip(el.getAttribute('href'), 80) + '"')
    const r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) extra.push('offscreen')
    lines.push('[' + ref + '] ' + role + ' "' + name + '"' + (extra.length ? ' ' + extra.join(' ') : ''))
  }
  return {
    url: location.href,
    title: document.title,
    elements: lines.join('\\n'),
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 5000),
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }
  }
})()`

/**
 * Runs in the page: the main content as plain lines, without navigation, headers, footers,
 * sidebars, cookie banners or ads. Headings keep their level; list items and table rows keep
 * their shape, so steps like "Settings > Controls > Camera" survive.
 */
export const READ_JS = `(() => {
  const SKIP = 'nav,header,footer,aside,script,style,noscript,template,svg,form,iframe,button,select,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=search],[aria-hidden=true],[hidden],.ad,.ads,.advert,[class*=cookie],[id*=cookie],[class*=consent],[class*=newsletter],[class*=related],[class*=share],[class*=comment]'
  const pickRoot = () => {
    const tries = ['article', 'main', '[role=main]', '#mw-content-text', '.mw-parser-output', '#content', '.content', '.post', '.entry-content', '#main']
    let best = null
    for (const sel of tries) {
      for (const el of document.querySelectorAll(sel)) {
        const n = (el.innerText || '').length
        if (n > 400 && (!best || n > (best.innerText || '').length * 0.6)) { best = el; break }
      }
      if (best) break
    }
    return best || document.body
  }
  const root = pickRoot()
  if (!root) return { url: location.href, title: document.title, text: '' }
  const BLOCK = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,dt,dd,figcaption,tr,caption'
  const clean = (s) => String(s || '').replace(/[ \\t\\u00a0]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim()
  const lines = []
  let last = ''
  for (const el of root.querySelectorAll(BLOCK)) {
    if (el.closest(SKIP) && !root.matches(SKIP)) continue
    // The innermost block holds the text; an outer one would repeat it.
    if (el.tagName !== 'TR' && el.tagName !== 'PRE' && el.querySelector(BLOCK)) continue
    if (el.closest('pre') && el.tagName !== 'PRE') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const tag = el.tagName
    let text
    if (tag === 'TR') text = [...el.children].map((c) => clean(c.innerText)).filter(Boolean).join(' | ')
    else if (tag === 'PRE') text = '\\x60\\x60\\x60\\n' + String(el.innerText || '').trim() + '\\n\\x60\\x60\\x60'
    else text = clean(el.innerText)
    if (!text || text === last) continue
    last = text
    if (/^H[1-6]$/.test(tag)) text = '#'.repeat(Number(tag[1])) + ' ' + text
    else if (tag === 'LI') text = (el.parentElement && el.parentElement.tagName === 'OL' ? ([...el.parentElement.children].indexOf(el) + 1) + '. ' : '- ') + text
    else if (tag === 'BLOCKQUOTE') text = '> ' + text
    lines.push(text)
  }
  let text = lines.join('\\n')
  // Pages built from divs alone: fall back to the rendered text of the content area.
  if (text.length < 300) text = clean(root.innerText)
  return { url: location.href, title: document.title, text }
})()`

/** Runs on a search results page (DuckDuckGo's HTML version, or Bing as a fallback). */
export const RESULTS_JS = `(() => {
  const out = []
  const real = (href) => {
    try {
      const u = new URL(href, location.href)
      const target = u.searchParams.get('uddg')
      return target ? decodeURIComponent(target) : u.href
    } catch { return href }
  }
  for (const r of document.querySelectorAll('.result:not(.result--ad), li.b_algo')) {
    const a = r.querySelector('.result__a, h2 a')
    if (!a) continue
    const snippet = r.querySelector('.result__snippet, .b_caption p, p')
    out.push({ title: (a.innerText || '').trim(), url: real(a.getAttribute('href')), snippet: ((snippet && snippet.innerText) || '').trim().replace(/\\s+/g, ' ').slice(0, 300) })
    if (out.length >= 8) break
  }
  return out
})()`

/** Scrolls a ref'd element into view and returns its centre in viewport CSS pixels. */
const centerJs = (ref: string) => `(() => {
  const el = document.querySelector('[data-agent-ref="${ref.replace(/[^\w-]/g, '')}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, editable: el.matches('input,textarea,[contenteditable],[contenteditable=true]') }
})()`

const selectAllJs = (ref: string) => `(() => {
  const el = document.querySelector('[data-agent-ref="${ref.replace(/[^\w-]/g, '')}"]')
  if (!el) return false
  el.focus()
  if (typeof el.select === 'function') el.select()
  else document.execCommand('selectAll')
  return true
})()`

const elementAtJs = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${x}, ${y})
  if (!el) return null
  const path = (node) => {
    const parts = []
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase()
      if (node.id) { parts.unshift(part + '#' + CSS.escape(node.id)); break }
      const cls = [...node.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('')
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part + cls)
      node = parent
    }
    return parts.join(' > ')
  }
  const r = el.getBoundingClientRect()
  return {
    selector: path(el),
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
    html: el.outerHTML.slice(0, 1500),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height }
  }
})()`

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' }
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }

export const normalizeUrl = (input: string): string => {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`.replace('https://localhost', 'http://localhost')
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

/** The search page the agent reads results from: DuckDuckGo without scripts, which loads fast and has no consent wall. */
const searchUrl = (query: string) =>
  `${process.env.CHAT_V2_SEARCH_URL ?? 'https://html.duckduckgo.com/html/?q='}${encodeURIComponent(query)}`
const fallbackSearchUrl = (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`

type Emit = (event: BrowserEvent) => void

export interface BrowserApi {
  readonly attach: (webContentsId: number) => Effect.Effect<void, BrowserError>
  readonly navigate: (url: string) => Effect.Effect<PageSnapshot, BrowserError>
  readonly history: (direction: 'back' | 'forward' | 'reload') => Effect.Effect<PageSnapshot, BrowserError>
  readonly snapshot: Effect.Effect<PageSnapshot, BrowserError>
  /** Searches the web in the visible browser and returns the results. */
  readonly search: (query: string) => Effect.Effect<SearchResult[], BrowserError>
  /** Opens `url` (or stays on the current page) and returns its main text. */
  readonly read: (url: string | null) => Effect.Effect<Reading, BrowserError>
  readonly click: (target: { ref?: string; x?: number; y?: number }) => Effect.Effect<PageSnapshot, BrowserError>
  readonly type: (ref: string, text: string, submit: boolean) => Effect.Effect<PageSnapshot, BrowserError>
  readonly press: (keys: string) => Effect.Effect<PageSnapshot, BrowserError>
  readonly scroll: (dy: number) => Effect.Effect<PageSnapshot, BrowserError>
  readonly screenshot: (rect?: { x: number; y: number; width: number; height: number }) => Effect.Effect<Shot, BrowserError>
  readonly evaluate: (code: string) => Effect.Effect<string, BrowserError>
  readonly elementAt: (x: number, y: number) => Effect.Effect<ElementInfo | null, BrowserError>
  readonly screencast: (on: boolean) => Effect.Effect<void, BrowserError>
  /** Starts recording the panel for the assistant (the panel encodes the video). */
  readonly startRecording: Effect.Effect<void, BrowserError>
  /** Stops the assistant's recording and returns the saved file; null when none was made. */
  readonly stopRecording: Effect.Effect<Recording | null, BrowserError>
  /** The panel answering a `record` event, or reporting an assistant recording that ended on its own. */
  readonly recordReply: (reply: PanelReply) => Effect.Effect<void>
  /** Marks the agent as driving (misty border on) and says what it is doing. */
  readonly status: (label: string) => Effect.Effect<void>
  /** Hands the browser back to the user, saving a recording the assistant left running. Safe to call when not in control. */
  readonly release: Effect.Effect<void>
}

export class Browser extends Context.Service<Browser, BrowserApi>()('chat-v2/Browser') {
  static readonly layer = (emit: Emit, fromId: (id: number) => WebContents | undefined) =>
    Layer.sync(Browser, () => {
      let guest: WebContents | null = null
      let waiting: Array<() => void> = []
      let casting = false
      // Whether the panel is recording for the assistant, and a recording of its that ended
      // without being asked to (the user pressed stop, or it ran out of time).
      let agentRecording = false
      let unclaimed: Recording | null = null
      let answer: ((reply: PanelReply) => void) | null = null

      const fail = (message: string) => new BrowserError({ message })
      const attempt = <A>(what: string, f: () => Promise<A>) =>
        Effect.tryPromise({ try: f, catch: (cause) => fail(`${what}: ${errorMessage(cause)}`) })

      const live = () => (guest && !guest.isDestroyed() ? guest : null)

      /** The browser panel may be closed; ask the window to open it and wait for the page. */
      const ensure = Effect.suspend(() => {
        const wc = live()
        if (wc) return Effect.succeed(wc)
        emit({ type: 'open' })
        return attempt('Opening the browser', () =>
          new Promise<WebContents>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the browser panel did not open')), 12000)
            waiting.push(() => {
              clearTimeout(timer)
              resolve(live()!)
            })
          })
        )
      })

      const cdp = (wc: WebContents, method: string, params: object = {}) =>
        attempt(method, async () => {
          if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
          return (await wc.debugger.sendCommand(method, params)) as unknown
        })

      // On the main frame, not the WebContents: WebContents.executeJavaScript holds every script until
      // the page has fully loaded, which an ad frame that never finishes can put off for good.
      const run = <A>(wc: WebContents, js: string) => wc.mainFrame.executeJavaScript(js, true) as Promise<A>
      const exec = <A>(wc: WebContents, js: string) => attempt('Page script', () => run<A>(wc, js))

      /** Waits up to 4 s for a page that renders with script to stop adding text. */
      const textSettled = async (wc: WebContents) => {
        let last = -1
        const started = Date.now()
        while (Date.now() - started < 4000) {
          const size = await run<number>(wc, 'document.body ? document.body.innerText.length : 0').catch(() => 0)
          if (size > 200 && size === last) break
          if (!wc.isLoading() && size === last) break
          last = size
          await sleep(250)
        }
      }

      /**
       * After an action: waits for a navigation it started to reach a parsed document, then for the
       * text to settle. Not for wc.isLoading(), which counts ad and tracker frames and kept every
       * action on a busy page waiting up to 12 s.
       */
      const settle = (wc: WebContents, ms = 500) =>
        attempt('Waiting for the page', async () => {
          await sleep(ms)
          if (!wc.isLoading()) return
          const started = Date.now()
          const parsing = async () =>
            wc.isWaitingForResponse() || (await run<string>(wc, 'document.readyState').catch(() => 'loading')) === 'loading'
          while (Date.now() - started < 12000 && (await parsing())) await sleep(150)
          if (wc.isLoading()) await textSettled(wc)
        })

      /**
       * Loads a page: done once its own document is parsed and its text stops
       * growing, without waiting for the ads and trackers in its frames, which can take many
       * seconds or never finish.
       */
      const loadPage = (wc: WebContents, url: string) =>
        attempt('Navigation', async () => {
          let ready: () => void = () => {}
          const parsed = new Promise<void>((resolve) => (ready = resolve))
          wc.once('dom-ready', ready)
          // The full load carries on in the background; only a failure of the page itself counts.
          const loaded = wc.loadURL(url).then(
            () => undefined,
            (e: Error) => {
              // Redirects abort the first load, and so does moving on to the next page.
              if (!/ERR_ABORTED/.test(e.message)) throw e
            }
          )
          loaded.catch(() => undefined)
          try {
            await Promise.race([parsed, loaded, sleep(15000)])
          } finally {
            wc.off('dom-ready', ready)
          }
          // A load that already failed is reported; one still going is fine.
          await Promise.race([loaded, sleep(0)])
          // Pages that render their article with script fill in after parsing: wait for the text to hold still.
          await textSettled(wc)
        })

      const snapshotOf = (wc: WebContents) => exec<PageSnapshot>(wc, SNAPSHOT_JS)

      // The overlay cursor glides to the point before the real event fires.
      const moveCursor = (x: number, y: number) =>
        Effect.promise(async () => {
          emit({ type: 'cursor', x, y, click: false })
          await sleep(360)
        })

      const mouseClick = (wc: WebContents, x: number, y: number) =>
        Effect.gen(function* () {
          yield* moveCursor(x, y)
          yield* cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
          yield* cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          emit({ type: 'cursor', x, y, click: true })
          yield* cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        })

      const center = (wc: WebContents, ref: string) =>
        exec<{ x: number; y: number; editable: boolean } | null>(wc, centerJs(ref)).pipe(
          Effect.flatMap((c) => (c ? Effect.succeed(c) : Effect.fail(fail(`No element ${ref}. Take a new snapshot.`))))
        )

      const pressKeys = (wc: WebContents, combo: string) =>
        Effect.gen(function* () {
          const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
          const keyName = parts.pop() ?? ''
          const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? 0), 0)
          const known = KEYS[keyName]
          const key = known ? (keyName === 'Space' ? ' ' : keyName) : keyName
          const code = known?.code ?? (key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : key)
          const vk = known?.vk ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
          const text = modifiers & ~8 ? undefined : (known?.text ?? (key.length === 1 ? key : undefined))
          const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
          yield* cdp(wc, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
          yield* cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
        })

      const shoot = (wc: WebContents, rect?: { x: number; y: number; width: number; height: number }) =>
        attempt('Screenshot', async () => {
          const r = rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) } : undefined
          const image = await wc.capturePage(r)
          // Each caller wants one of the two, and encoding blocks the main process
          // (a full-size PNG especially), so neither is encoded until it is read.
          let dataUrl: string | undefined
          let png: Uint8Array<ArrayBuffer> | undefined
          return {
            get dataUrl() {
              return (dataUrl ??= `data:image/jpeg;base64,${(image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image).toJPEG(72).toString('base64')}`)
            },
            get png() {
              return (png ??= Uint8Array.from(image.toPNG()))
            }
          }
        })

      /** Asks the panel to start or stop recording and waits for its answer (saving a video takes a moment). */
      const askPanel = (on: boolean) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<PanelReply>((resolve, reject) => {
              const done = () => {
                clearTimeout(timer)
                if (answer === waiter) answer = null
              }
              const waiter = (reply: PanelReply) => {
                done()
                resolve(reply)
              }
              const timer = setTimeout(() => {
                done()
                reject(new Error('the browser panel did not answer'))
              }, on ? 8000 : 30000)
              // A reply that stops waiting (the user pressed Stop) leaves no waiter behind.
              signal.addEventListener('abort', done)
              answer = waiter
              emit({ type: 'record', on })
            }),
          catch: (cause) => fail(`${on ? 'Starting the recording' : 'Saving the recording'}: ${errorMessage(cause)}`)
        }).pipe(Effect.flatMap((reply) => (reply.ok ? Effect.succeed(reply) : Effect.fail(fail(reply.error)))))

      const stopRecording = Effect.gen(function* () {
        const ended = unclaimed
        unclaimed = null
        if (!agentRecording) return ended
        agentRecording = false
        // A closed panel took its recording with it.
        if (!live()) return ended
        const reply = yield* askPanel(false)
        return reply.ok && reply.path ? { path: reply.path, seconds: reply.seconds ?? 0 } : ended
      })

      const api: BrowserApi = {
        attach: (id) =>
          Effect.suspend(() => {
            const wc = fromId(id)
            if (!wc || wc.getType() !== 'webview') return Effect.fail(fail('Not a browser view'))
            guest = wc
            casting = false
            // A new panel isn't recording.
            agentRecording = false
            wc.debugger.on('message', (_e, method, params) => {
              if (method !== 'Page.screencastFrame') return
              // Every frame must be acknowledged or Chromium stops sending them.
              void wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
              emit({ type: 'frame', data: params.data as string })
            })
            wc.once('destroyed', () => {
              if (guest === wc) guest = null
            })
            for (const resolve of waiting.splice(0)) resolve()
            return Effect.void
          }),

        navigate: (url) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            yield* loadPage(wc, normalizeUrl(url))
            return yield* snapshotOf(wc)
          }),

        history: (direction) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            if (direction === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
            else if (direction === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
            else if (direction === 'reload') wc.reload()
            yield* settle(wc)
            return yield* snapshotOf(wc)
          }),

        snapshot: Effect.flatMap(ensure, snapshotOf),

        search: (query) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            const load = (url: string) =>
              Effect.gen(function* () {
                yield* loadPage(wc, url)
                return yield* exec<SearchResult[]>(wc, RESULTS_JS)
              })
            const results = yield* load(searchUrl(query))
            // DuckDuckGo sometimes answers automated traffic with a challenge page instead.
            if (results.length > 0 || process.env.CHAT_V2_SEARCH_URL) return results
            return yield* load(fallbackSearchUrl(query))
          }),

        read: (url) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            if (url) yield* loadPage(wc, normalizeUrl(url))
            return yield* exec<Reading>(wc, READ_JS)
          }),

        click: (target) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            const point = target.ref
              ? yield* center(wc, target.ref)
              : target.x !== undefined && target.y !== undefined
                ? { x: target.x, y: target.y }
                : yield* Effect.fail(fail('click needs a ref or x and y'))
            yield* mouseClick(wc, point.x, point.y)
            yield* settle(wc)
            return yield* snapshotOf(wc)
          }),

        type: (ref, text, submit) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            const point = yield* center(wc, ref)
            yield* mouseClick(wc, point.x, point.y)
            yield* exec(wc, selectAllJs(ref))
            yield* cdp(wc, 'Input.insertText', { text })
            if (submit) yield* pressKeys(wc, 'Enter')
            yield* settle(wc, submit ? 700 : 150)
            return yield* snapshotOf(wc)
          }),

        press: (keys) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            yield* pressKeys(wc, keys)
            yield* settle(wc, 300)
            return yield* snapshotOf(wc)
          }),

        scroll: (dy) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            const [w, h] = (yield* exec<[number, number]>(wc, '[innerWidth, innerHeight]'))
            yield* moveCursor(w / 2, h / 2)
            yield* cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: w / 2, y: h / 2, deltaX: 0, deltaY: dy })
            yield* settle(wc, 350)
            return yield* snapshotOf(wc)
          }),

        screenshot: (rect) => Effect.flatMap(ensure, (wc) => shoot(wc, rect)),

        evaluate: (code) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            const result = yield* exec<unknown>(wc, `(async () => { ${code} })()`)
            const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
            return text.length > 8000 ? `${text.slice(0, 8000)}…[truncated]` : text
          }),

        elementAt: (x, y) => Effect.flatMap(ensure, (wc) => exec<ElementInfo | null>(wc, elementAtJs(x, y))),

        screencast: (on) =>
          Effect.gen(function* () {
            const wc = yield* ensure
            if (on === casting) return
            casting = on
            if (on) yield* cdp(wc, 'Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 })
            else yield* cdp(wc, 'Page.stopScreencast')
          }),

        startRecording: Effect.gen(function* () {
          yield* ensure
          if (agentRecording) return
          unclaimed = null
          yield* askPanel(true)
          agentRecording = true
        }),

        stopRecording,

        recordReply: (reply) =>
          Effect.sync(() => {
            if (answer) return answer(reply)
            if (reply.ok && reply.path) {
              agentRecording = false
              unclaimed = { path: reply.path, seconds: reply.seconds ?? 0 }
            }
          }),

        status: (label) => Effect.sync(() => emit({ type: 'control', active: true, label })),

        // A recording left running is stopped without waiting: the panel saves it and says where.
        release: Effect.sync(() => {
          if (agentRecording) {
            agentRecording = false
            emit({ type: 'record', on: false })
          }
          emit({ type: 'control', active: false, label: '' })
        })
      }
      return Browser.of(api)
    })
}
