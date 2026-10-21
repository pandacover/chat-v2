<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import type { ElementInfo } from '@shared/types'
  import { fade, fly, pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { tip } from '@/lib/tooltip'
  import Icon from './Icon.svelte'

  type WebviewEl = HTMLElement & {
    getWebContentsId(): number
    getURL(): string
    getTitle(): string
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
    reload(): void
    stop(): void
    loadURL(url: string): Promise<void>
    isLoading(): boolean
  }

  let view: WebviewEl | undefined = $state()
  let stage: HTMLDivElement | undefined = $state()
  let address = $state('')
  let editingAddress = $state(false)
  let attached = false
  // Read once: rebinding src on every navigation would reload the page.
  const initialSrc = untrack(() => app.browser.url || 'about:blank')

  // Annotation: freehand marks become a cropped screenshot; element picks become text context.
  let mode = $state<'none' | 'draw' | 'select'>('none')
  let strokes = $state<Array<Array<{ x: number; y: number }>>>([])
  let drawing = false
  let hovered = $state<ElementInfo | null>(null)
  let pending = $state<{ kind: 'draw'; rect: Rect } | { kind: 'select'; element: ElementInfo } | null>(null)
  let note = $state('')
  let busyCapture = $state(false)

  // Recording: screencast frames are painted to a canvas that MediaRecorder captures.
  let recorder: MediaRecorder | null = null
  let recording = $state(false)
  let recStart = 0
  let recElapsed = $state(0)
  let recTimer: ReturnType<typeof setInterval> | undefined
  let paintTimer: ReturnType<typeof setInterval> | undefined
  let lastFrame: HTMLImageElement | null = null
  let offFrames: (() => void) | null = null
  // Who started the recording: the user's goes into their message, the assistant's back to its reply.
  let recordingFor: 'user' | 'agent' = 'user'
  let recLimit: ReturnType<typeof setTimeout> | undefined
  /** How long the assistant may record before the panel stops it. */
  const AGENT_RECORDING_MS = 5 * 60_000

  type Rect = { x: number; y: number; width: number; height: number }

  const isBlank = $derived(!app.browser.url || app.browser.url === 'about:blank')
  const host = $derived.by(() => {
    try {
      return new URL(app.browser.url).host
    } catch {
      return ''
    }
  })

  const sync = () => {
    if (!view) return
    const url = view.getURL()
    app.browser.url = url
    app.browser.title = view.getTitle()
    app.browser.canBack = view.canGoBack()
    app.browser.canForward = view.canGoForward()
    if (!editingAddress) address = url === 'about:blank' ? '' : url
  }

  onMount(() => {
    const el = view
    if (!el) return
    const onReady = () => {
      if (!attached) {
        attached = true
        void window.api.browser.attach(el.getWebContentsId())
      }
      sync()
    }
    const start = () => (app.browser.loading = true)
    const stop = () => {
      app.browser.loading = false
      sync()
    }
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-navigate', sync)
    el.addEventListener('did-navigate-in-page', sync)
    el.addEventListener('page-title-updated', sync)
    el.addEventListener('did-start-loading', start)
    el.addEventListener('did-stop-loading', stop)
    const offRecord = window.api.browser.onEvent((e) => {
      if (e.type === 'record') void (e.on ? agentStart() : agentStop())
    })
    return () => {
      offRecord()
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-navigate', sync)
      el.removeEventListener('did-navigate-in-page', sync)
      el.removeEventListener('page-title-updated', sync)
      el.removeEventListener('did-start-loading', start)
      el.removeEventListener('did-stop-loading', stop)
    }
  })

  onDestroy(() => {
    if (recording) void stopRecording()
  })

  const normalize = (s: string) => {
    const v = s.trim()
    if (/^https?:\/\//i.test(v)) return v
    if (/^localhost(:\d+)?/.test(v)) return `http://${v}`
    if (/^[\w-]+(\.[\w-]+)+/.test(v)) return `https://${v}`
    return `https://duckduckgo.com/?q=${encodeURIComponent(v)}`
  }

  const go = () => {
    if (!view || !address.trim()) return
    editingAddress = false
    void view.loadURL(normalize(address)).catch(() => undefined)
    view.focus()
  }

  const setMode = (next: typeof mode) => {
    mode = mode === next ? 'none' : next
    strokes = []
    hovered = null
    pending = null
    note = ''
  }

  // ── Freehand ────────────────────────────────────────────────────────────
  const local = (e: PointerEvent) => {
    const r = stage!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const drawDown = (e: PointerEvent) => {
    if (pending) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drawing = true
    strokes.push([local(e)])
  }
  const drawMove = (e: PointerEvent) => {
    if (!drawing) return
    strokes[strokes.length - 1]!.push(local(e))
  }
  const drawUp = () => {
    if (!drawing) return
    drawing = false
    const points = strokes.flat()
    if (points.length < 2) return
    const pad = 18
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const bounds = stage!.getBoundingClientRect()
    const x = Math.max(0, Math.min(...xs) - pad)
    const y = Math.max(0, Math.min(...ys) - pad)
    pending = {
      kind: 'draw',
      rect: { x, y, width: Math.min(bounds.width, Math.max(...xs) + pad) - x, height: Math.min(bounds.height, Math.max(...ys) + pad) - y }
    }
  }

  const path = (pts: Array<{ x: number; y: number }>) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')

  /** Crops the page to the marked area and paints the marks on top. */
  const composite = async (rect: Rect) => {
    // Plain copy: reactive proxies cannot cross IPC.
    const dataUrl = await window.api.browser.capture($state.snapshot(rect))
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    // capturePage takes CSS pixels and returns device pixels.
    const scale = img.naturalWidth / rect.width
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e5703f'
    ctx.lineWidth = 3 * scale
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of strokes) {
      ctx.beginPath()
      s.forEach((p, i) => {
        const px = (p.x - rect.x) * scale
        const py = (p.y - rect.y) * scale
        if (i) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
      })
      ctx.stroke()
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    return blob.arrayBuffer()
  }

  // ── Element picker ──────────────────────────────────────────────────────
  let probing = false
  let queued: { x: number; y: number } | null = null
  const probe = async (x: number, y: number) => {
    if (probing) {
      queued = { x, y }
      return
    }
    probing = true
    try {
      hovered = await window.api.browser.elementAt(x, y)
    } catch {
      hovered = null
    } finally {
      probing = false
      if (queued) {
        const next = queued
        queued = null
        void probe(next.x, next.y)
      }
    }
  }
  const selectMove = (e: PointerEvent) => {
    if (pending) return
    const p = local(e)
    void probe(p.x, p.y)
  }
  const selectClick = () => {
    if (pending || !hovered) return
    pending = { kind: 'select', element: hovered }
  }

  const stamp = () => new Date().toISOString().slice(11, 19).replace(/:/g, '')

  const attachAnnotation = async () => {
    if (!pending) return
    busyCapture = true
    try {
      const page = `${app.browser.title || host} (${app.browser.url})`
      if (pending.kind === 'draw') {
        const data = await composite(pending.rect)
        const image = await window.api.attachments.add({ name: `annotation-${stamp()}.png`, mime: 'image/png', data })
        app.addDraftAttachment(image)
        if (note.trim()) {
          const body = `Comment on ${image.name}, marked on ${page}:\n\n${note.trim()}\n`
          app.addDraftAttachment(await window.api.attachments.add({ name: `comment-${stamp()}.md`, mime: 'text/markdown', data: new TextEncoder().encode(body).buffer }))
        }
      } else {
        const el = pending.element
        const body = [
          `Comment on an element on ${page}`,
          `Selector: ${el.selector}`,
          `Element: <${el.tag}>${el.text ? ` "${el.text}"` : ''}`,
          note.trim() ? `\nNote: ${note.trim()}` : '',
          '\nHTML:\n```html\n' + el.html + '\n```\n'
        ].join('\n')
        app.addDraftAttachment(await window.api.attachments.add({ name: `element-${el.tag}-${stamp()}.md`, mime: 'text/markdown', data: new TextEncoder().encode(body).buffer }))
      }
      app.toast('Added to your message', 'info')
      setMode('none')
    } catch (e) {
      app.toast(`Could not capture: ${e instanceof Error ? e.message : e}`)
    } finally {
      busyCapture = false
    }
  }

  const popoverAt = $derived.by(() => {
    if (!pending || !stage) return null
    const r = pending.kind === 'draw' ? pending.rect : pending.element.rect
    const bounds = stage.getBoundingClientRect()
    const width = 300
    const left = Math.min(bounds.width - width - 8, Math.max(8, r.x))
    const below = r.y + r.height + 8
    const top = below + 150 < bounds.height ? below : Math.max(8, r.y - 158)
    return { left, top, width }
  })

  // ── Screenshot & recording ──────────────────────────────────────────────
  const screenshot = async () => {
    busyCapture = true
    const shot = await app.attempt(() => window.api.browser.screenshot())
    busyCapture = false
    if (shot) {
      app.addDraftAttachment(shot)
      app.toast('Screenshot added to your message', 'info')
    }
  }

  const startRecording = async (by: 'user' | 'agent' = 'user') => {
    recordingFor = by
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    const sizeFrom = stage!.getBoundingClientRect()
    canvas.width = Math.round(sizeFrom.width * devicePixelRatio)
    canvas.height = Math.round(sizeFrom.height * devicePixelRatio)
    offFrames = window.api.browser.onEvent((e) => {
      if (e.type !== 'frame') return
      const img = new Image()
      img.onload = () => {
        if (canvas.width !== img.naturalWidth) {
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
        }
        lastFrame = img
      }
      img.src = `data:image/jpeg;base64,${e.data}`
    })
    // Frames only arrive when the page repaints, so repaint the latest one on a steady tick.
    paintTimer = setInterval(() => {
      if (lastFrame) ctx.drawImage(lastFrame, 0, 0, canvas.width, canvas.height)
    }, 1000 / 30)
    await app.attempt(() => window.api.browser.screencast(true))
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
    const chunks: Blob[] = []
    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6_000_000 })
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const seconds = Math.round((Date.now() - recStart) / 1000)
      if (by === 'agent') {
        // The reply that asked for it is told where it went; the user sees it here.
        const path = await app.attempt(async () => window.api.browser.recordReply({ ok: true, data: await blob.arrayBuffer(), seconds }))
        if (path) app.toast(`Recording saved to ${path}`, 'info')
        return
      }
      const path = await app.attempt(async () => window.api.browser.saveRecording(await blob.arrayBuffer()))
      if (!path) return
      const body = `Screen recording of ${app.browser.title || host} (${app.browser.url}), ${seconds}s.\nSaved to: ${path}\n`
      const note = await app.attempt(() =>
        window.api.attachments.add({ name: `recording-${stamp()}.md`, mime: 'text/markdown', data: new TextEncoder().encode(body).buffer })
      )
      if (note) app.addDraftAttachment(note)
      app.toast(`Recording saved to ${path}`, 'info')
    }
    recorder.start(1000)
    recStart = Date.now()
    recElapsed = 0
    recTimer = setInterval(() => (recElapsed = Math.floor((Date.now() - recStart) / 1000)), 250)
    if (by === 'agent') recLimit = setTimeout(() => void stopRecording(), AGENT_RECORDING_MS)
    recording = true
  }

  const stopRecording = async () => {
    recording = false
    clearTimeout(recLimit)
    clearInterval(recTimer)
    clearInterval(paintTimer)
    offFrames?.()
    offFrames = null
    lastFrame = null
    await window.api.browser.screencast(false).catch(() => undefined)
    if (recorder?.state !== 'inactive') recorder?.stop()
    recorder = null
  }

  // The assistant's browser_record: each start and stop is answered, a stop with the finished video (see onstop).
  const agentStart = async () => {
    if (recording) {
      const reply = recordingFor === 'agent' ? { ok: true as const } : { ok: false as const, error: 'The user is already recording the browser.' }
      return void window.api.browser.recordReply(reply).catch(() => undefined)
    }
    try {
      await startRecording('agent')
      await window.api.browser.recordReply({ ok: true })
    } catch (e) {
      await window.api.browser.recordReply({ ok: false, error: e instanceof Error ? e.message : String(e) }).catch(() => undefined)
    }
  }
  const agentStop = async () => {
    if (recording && recordingFor === 'agent') return stopRecording()
    // No recording of the assistant's is running (it already ended, or this one is the user's): no video to send.
    await window.api.browser.recordReply({ ok: true }).catch(() => undefined)
  }

  const clock = $derived(`${Math.floor(recElapsed / 60)}:${String(recElapsed % 60).padStart(2, '0')}`)

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (mode !== 'none') {
      e.preventDefault()
      setMode('none')
    }
  }
</script>

<svelte:window {onkeydown} />

<section class="flex h-full min-w-0 flex-col bg-side" aria-label="Browser">
  <header class="flex h-12 shrink-0 items-center gap-0.5 pr-2 pl-2">
    <button class="icon-btn" use:tip={'Back'} disabled={!app.browser.canBack || app.control.active} onclick={() => view?.goBack()}><Icon name="chevronLeft" size={16} /></button>
    <button class="icon-btn" use:tip={'Forward'} disabled={!app.browser.canForward || app.control.active} onclick={() => view?.goForward()}><Icon name="chevronRight" size={16} /></button>
    <button class="icon-btn" use:tip={app.browser.loading ? 'Stop loading' : 'Reload'} disabled={app.control.active} onclick={() => (app.browser.loading ? view?.stop() : view?.reload())}>
      <Icon name={app.browser.loading ? 'x' : 'refresh'} size={15} />
    </button>

    <form
      class="mx-1 flex h-8 min-w-0 flex-1 items-center rounded-md bg-surface px-2.5 shadow-[0_0_0_1px_var(--line)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--muted)]"
      onsubmit={(e) => {
        e.preventDefault()
        go()
      }}
    >
      {#if app.browser.loading}<span class="mr-2 size-1.5 shrink-0 animate-pulse rounded-full bg-muted"></span>{/if}
      <input
        bind:value={address}
        onfocus={(e) => {
          editingAddress = true
          e.currentTarget.select()
        }}
        onblur={() => (editingAddress = false)}
        disabled={app.control.active}
        placeholder="Search or enter address"
        aria-label="Address"
        spellcheck="false"
        class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-muted"
      />
    </form>

    <button class="icon-btn" use:tip={'Screenshot to message'} disabled={isBlank || busyCapture} onclick={screenshot}><Icon name="camera" size={16} /></button>
    <button
      class="icon-btn {recording ? '!bg-accent !text-on-accent' : ''}"
      use:tip={recording ? 'Stop recording' : 'Record video'}
      disabled={isBlank && !recording}
      onclick={() => (recording ? stopRecording() : startRecording())}
    >
      <Icon name={recording ? 'stop' : 'record'} size={16} />
    </button>
    {#if recording}<span class="px-1 font-mono text-[12px] text-fg-2 tabular-nums" in:fade>{clock}</span>{/if}
    <span class="mx-1 h-4 w-px bg-line"></span>
    <button class="icon-btn {mode === 'draw' ? '!bg-hover !text-fg' : ''}" use:tip={'Draw to comment'} disabled={isBlank || app.control.active} onclick={() => setMode('draw')}>
      <Icon name="pen" size={16} />
    </button>
    <button class="icon-btn {mode === 'select' ? '!bg-hover !text-fg' : ''}" use:tip={'Comment on an element'} disabled={isBlank || app.control.active} onclick={() => setMode('select')}>
      <Icon name="pointer" size={16} />
    </button>
    <button class="icon-btn" use:tip={'Close browser'} onclick={() => app.closeBrowser()}><Icon name="x" size={15} /></button>
  </header>

  {#if app.control.active}
    <div class="mx-2 mb-2 flex items-center gap-2 rounded-md bg-accent-wash px-3 py-1.5 text-[12.5px]" transition:fly={{ y: -4, duration: 180 }}>
      <span class="size-1.5 rounded-full bg-accent [animation:rec-pulse_1.4s_ease-in-out_infinite]"></span>
      <span class="min-w-0 flex-1 truncate text-fg">{app.control.label || 'The assistant is using the browser'}</span>
      <button class="rounded-md bg-fg px-2.5 py-0.5 font-medium text-bg" onclick={() => app.stop()}>Take over</button>
    </div>
  {:else if mode !== 'none'}
    <div class="mx-2 mb-2 flex items-center gap-2 rounded-md bg-hover/70 px-3 py-1.5 text-[12.5px] text-fg-2" transition:fly={{ y: -4, duration: 160 }}>
      {mode === 'draw' ? 'Draw around what you want to point at.' : 'Click an element to comment on it.'}
      <button class="ml-auto text-muted hover:text-fg" onclick={() => setMode('none')}>Done</button>
    </div>
  {/if}

  <div class="relative min-h-0 flex-1 px-2 pb-2">
    <div bind:this={stage} class="relative h-full overflow-hidden rounded-md bg-white shadow-[0_0_0_1px_var(--line)]">
      <webview bind:this={view} src={initialSrc} partition="persist:browser" class="absolute inset-0 size-full"></webview>

      {#if isBlank && !app.control.active}
        <div class="absolute inset-0 grid place-items-center bg-surface" transition:fade={{ duration: 150 }}>
          <div class="text-center">
            <div class="font-serif text-[22px]">Browser</div>
            <p class="mt-1 max-w-[30ch] text-[13px] text-muted">Enter an address above, or turn on Browser in the composer to let the assistant use it.</p>
          </div>
        </div>
      {/if}

      {#if app.control.active}
        <!-- The agent has the page: block stray input and show where it acts. -->
        <div class="absolute inset-0 cursor-not-allowed" aria-hidden="true"></div>
        <div class="agent-mist pointer-events-none absolute inset-0" transition:fade={{ duration: 300 }}></div>
      {/if}

      {#if app.cursor.visible && app.control.active}
        <div class="agent-cursor pointer-events-none absolute top-0 left-0" style="transform: translate({app.cursor.x}px, {app.cursor.y}px)" transition:fade={{ duration: 150 }}>
          {#key app.cursor.clicks}
            {#if app.cursor.clicks > 0}<span class="agent-ripple"></span>{/if}
          {/key}
          <svg width="20" height="20" viewBox="0 0 20 20" class="drop-shadow"><path d="M3 2l13 7-5.6 1.4L8 16z" fill="var(--fg)" stroke="var(--bg)" stroke-width="1.4" stroke-linejoin="round" /></svg>
        </div>
      {/if}

      {#if mode === 'draw'}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="absolute inset-0 cursor-crosshair" onpointerdown={drawDown} onpointermove={drawMove} onpointerup={drawUp}>
          <svg class="size-full">
            {#each strokes as s, i (i)}
              <path d={path(s)} fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            {/each}
            {#if pending?.kind === 'draw'}
              <rect x={pending.rect.x} y={pending.rect.y} width={pending.rect.width} height={pending.rect.height} rx="6" fill="none" stroke="var(--fg-2)" stroke-dasharray="4 4" />
            {/if}
          </svg>
        </div>
      {:else if mode === 'select'}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="absolute inset-0 cursor-default" onpointermove={selectMove} onpointerleave={() => !pending && (hovered = null)} onclick={selectClick}>
          {#if (pending?.kind === 'select' ? pending.element : hovered)?.rect}
            {@const r = (pending?.kind === 'select' ? pending.element : hovered)!.rect}
            <div class="pointer-events-none absolute rounded-sm bg-accent-wash shadow-[0_0_0_1.5px_var(--accent)] transition-[transform,width,height] duration-75" style="transform: translate({r.x}px, {r.y}px); width: {r.width}px; height: {r.height}px"></div>
            {#if !pending && hovered}
              <div class="pointer-events-none absolute rounded-sm bg-fg px-1.5 py-0.5 font-mono text-[11px] text-bg" style="transform: translate({r.x}px, {Math.max(0, r.y - 22)}px)">{hovered.tag}</div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if pending && popoverAt}
        <div
          class="absolute z-10 rounded-lg bg-surface p-3 shadow-[0_0_0_1px_var(--line),var(--shadow)]"
          style="left: {popoverAt.left}px; top: {popoverAt.top}px; width: {popoverAt.width}px"
          transition:pop={{ duration: 150 }}
        >
          {#if pending.kind === 'select'}
            <div class="mb-2 truncate font-mono text-[11.5px] text-muted" use:tip={pending.element.selector}>{pending.element.selector}</div>
          {/if}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            autofocus
            bind:value={note}
            rows="2"
            placeholder="Add a comment (optional)"
            class="w-full resize-none rounded-md bg-bg px-2.5 py-2 text-[13px] outline-none placeholder:text-muted focus:shadow-[0_0_0_1px_var(--muted)]"
            onkeydown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void attachAnnotation()
              }
            }}
          ></textarea>
          <div class="mt-2 flex items-center justify-end gap-1 text-[12.5px]">
            <button class="rounded-md px-2.5 py-1 text-fg-2 hover:bg-hover hover:text-fg" onclick={() => ((pending = null), (strokes = []), (note = ''))}>Discard</button>
            <button class="rounded-md bg-fg px-3 py-1 font-medium text-bg disabled:opacity-50" disabled={busyCapture} onclick={attachAnnotation}>
              {busyCapture ? 'Adding…' : 'Add to message'}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</section>
