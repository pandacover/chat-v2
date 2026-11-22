<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { dimsBar } from '@/lib/theme.svelte'
  import { tick, untrack } from 'svelte'
  import { isClaudeModel } from '@shared/models'
  import { fade, fly, pop } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import { clock, voice } from '@/lib/voice.svelte'
  import type { PathNode } from '@shared/types'
  import Composer from './Composer.svelte'
  import ComputerWaitCard from './ComputerWaitCard.svelte'
  import JobBar from './JobBar.svelte'
  import JobChip from './JobChip.svelte'
  import Mascot from './Mascot.svelte'
  import Icon from './Icon.svelte'
  import MessageItem from './MessageItem.svelte'
  import SelectionReply from './SelectionReply.svelte'

  let canvas: HTMLElement | undefined = $state()
  let scroller: HTMLDivElement | undefined = $state()
  let dock: HTMLDivElement | undefined = $state()
  /** The docked composer floats over the thread (its glass frosts the lines under it): the thread keeps room for it. */
  let dockH = $state(0)
  let heroSlot: HTMLDivElement | undefined = $state()
  let stageSlot: HTMLDivElement | undefined = $state()
  let mascotHost: HTMLDivElement | undefined = $state()
  let composer: ReturnType<typeof Composer> | undefined = $state()
  let pinned = $state(true)
  let promptOpen = $state(false)
  let promptDraft = $state('')

  const view = $derived(app.view)
  // A message to Tomo still being routed shows at once, so the conversation isn't empty meanwhile.
  const empty = $derived((!view || view.path.length === 0) && !app.pending)
  /** The routed message, and Tomo thinking, until the turn lands in its job. */
  const pendingNodes = $derived.by<PathNode[]>(() => {
    const p = app.pending
    if (!p || !app.isPrimary) return []
    const base = { sessionId: '', parentId: null, activeChildId: null, lineCount: 0, model: null, error: null, createdAt: 0, usage: null, attachments: [], post: null }
    return [
      { message: { ...base, id: 'pending-user', role: 'user', content: p.text, status: 'complete', authorBotId: null, attachments: p.attachments }, siblingIds: [], siblingIndex: 0 },
      { message: { ...base, id: 'pending-reply', role: 'assistant', content: '', status: 'streaming', authorBotId: app.primaryBot?.id ?? null }, siblingIds: [], siblingIndex: 0 }
    ]
  })
  /** Voice on a new chat: the composer docks, the rest fades, and the mascot takes the centre. */
  const stage = $derived(empty && voice.home !== 'off')
  // A chat from before Claude keeps its old model id; it now runs on the default.
  const model = $derived(isClaudeModel(app.chat.model) ? app.chat.model : (app.settings?.settings.defaultModel ?? ''))
  const hasOverride = $derived(app.chat.systemPrompt != null)
  /** A bot's own thread on a job. */
  const worker = $derived(view?.session.kind === 'worker')
  /** Several bots write here: replies say whose they are. */
  const showAuthor = $derived(!app.isPrimary && !!view && (worker || view.path.some((n) => n.message.post)))
  /**
   * Approvals always come to you: one asked in a thread that isn't open (a bot's own, asking to
   * pass a request on) shows above the composer, saying where it is from.
   */
  const elsewhere = $derived.by(() => {
    const w = app.computerWait
    if (w?.kind !== 'approval' || view?.path.some((n) => n.message.id === w.messageId)) return null
    return w
  })
  const elsewhereFrom = $derived.by(() => {
    const s = elsewhere ? app.sessions.find((x) => x.id === elsewhere.sessionId) : undefined
    if (!s) return null
    const bot = app.bots.find((b) => b.id === s.botId)
    return { id: s.id, label: s.kind === 'worker' && bot ? `${bot.name}'s thread on “${s.title}”` : `“${s.title}”` }
  })

  /**
   * Scroll to end glides to the end and keeps chasing it until it gets there: messages far up the
   * chat take their real height as they come into view (app.css .msg.far), so the end moves while it
   * glides. A wheel or a press on the thread hands the scroll back.
   */
  let chasing = false
  let seenTop = 0
  let seenHeight = 0
  /**
   * Keep the newest line in view unless the user scrolled up to read. Only a move up lets go of
   * the end: the browser also scrolls when the thread gets shorter (the view is clamped) and to
   * keep what's on screen in place while messages above it are laid out, and neither is the user.
   */
  const onscroll = () => {
    const el = scroller
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    const up = el.scrollTop < seenTop && el.scrollHeight >= seenHeight
    seenTop = el.scrollTop
    seenHeight = el.scrollHeight
    if (chasing && !near) return
    chasing = false
    if (near) pinned = true
    else if (up) pinned = false
  }

  const toBottom = (behavior: ScrollBehavior = 'auto') => scroller?.scrollTo({ top: scroller.scrollHeight, behavior })
  const scrollToEnd = () => {
    pinned = true
    chasing = true
    toBottom('smooth')
  }

  /*
   * A chat opens with its last messages, and the earlier ones are added above them while the
   * window is idle, a chunk at a time. Making every message of a long chat at once held the
   * window for a quarter of a second at 60 turns, longer the longer the chat. Pinned to the end,
   * the view stays there as they arrive; scrolled up, what you read stays in place.
   */
  const FIRST = 24
  const CHUNK = 40
  const MIN_CHUNK = 6
  let mounted = $state<{ id: string; from: number } | null>(null)
  /** Index of the first message on screen. */
  const from = $derived.by(() => {
    if (!view) return 0
    const opening = Math.max(0, view.path.length - FIRST)
    // Never past the last few: a branch switched while it mounts can make the chat shorter.
    return mounted?.id === view.session.id ? Math.min(mounted.from, opening) : opening
  })
  $effect(() => {
    const id = view?.session.id
    const start = from
    if (!id) return
    if (untrack(() => mounted?.id) !== id) mounted = { id, from: start }
    if (start === 0) return
    const idle = requestIdleCallback(
      async (deadline) => {
        const el = scroller
        // As many as fit in the idle time left, at about a millisecond each, so a frame stays short.
        // Replies heavy with code or tables cost more; the cap of CHUNK is what bounds those.
        const count = deadline.didTimeout ? MIN_CHUNK : Math.max(MIN_CHUNK, Math.min(CHUNK, Math.floor(deadline.timeRemaining())))
        // Scrolled up: the message that was first stays where it was on screen. The browser's own
        // scroll anchoring does this, but not at the very top, where what you read would be pushed
        // down by all that was added; whatever it already moved is counted.
        const first = !pinned ? (thread?.firstElementChild as HTMLElement | null | undefined) : null
        const was = first?.getBoundingClientRect().top
        mounted = { id, from: Math.max(0, start - count) }
        if (!el || !first || was === undefined) return
        await tick()
        if (first.isConnected) el.scrollTop += first.getBoundingClientRect().top - was
      },
      { timeout: 400 }
    )
    return () => cancelIdleCallback(idle)
  })
  const shown = $derived(view ? (from > 0 ? view.path.slice(from) : view.path) : [])

  // The thread grows (a streamed line, an image loading, a message laid out for the first time as
  // it scrolls into view): follow it while pinned. Watching its size rather than every message's
  // text also scrolls before the frame paints, not a tick after.
  let thread: HTMLDivElement | undefined = $state()
  $effect(() => {
    const el = thread
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (pinned) toBottom()
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  // The column narrows when the artifact panel opens; stay on the newest line while it does.
  $effect(() => {
    const el = scroller
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (pinned) toBottom()
    })
    observer.observe(el)
    // The user scrolls (a wheel, the scrollbar, a key): Scroll to end stops chasing the end, and its
    // glide stops where it is (Chromium would carry a script's smooth scroll on through a wheel).
    const takeOver = () => {
      if (!chasing) return
      chasing = false
      el.scrollTo({ top: el.scrollTop })
      // Stopped short of the end: no longer following it, and Scroll to end is on offer again.
      pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    // The glide ended short of an end that moved meanwhile: finish the chase there.
    const ended = () => {
      if (chasing && el.scrollHeight - el.scrollTop - el.clientHeight >= 80) toBottom()
    }
    el.addEventListener('wheel', takeOver, { passive: true })
    el.addEventListener('pointerdown', takeOver)
    el.addEventListener('keydown', takeOver)
    el.addEventListener('scrollend', ended)
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', takeOver)
      el.removeEventListener('pointerdown', takeOver)
      el.removeEventListener('keydown', takeOver)
      el.removeEventListener('scrollend', ended)
    }
  })

  $effect(() => {
    void view?.session.id
    pinned = true
    seenTop = seenHeight = 0
    // A chat opens at its end, also when its thread is as tall as the last one's (a fork of its
    // last message), which the thread's size observer doesn't see.
    void tick().then(() => toBottom())
    untrack(() => voice.leaveHome())
    composer?.focus()
  })

  // The composer starts centred and glides to the bottom on the first message, and on the voice
  // stage (FLIP).
  let lastTop: number | null = null
  $effect.pre(() => {
    void empty
    void stage
    lastTop = dock?.getBoundingClientRect().top ?? null
  })
  $effect(() => {
    void empty
    void stage
    const el = dock
    if (!el || lastTop === null) return
    const dy = lastTop - el.getBoundingClientRect().top
    if (Math.abs(dy) < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: 650,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
    })
  })

  /**
   * The Home mascot floats over the canvas, over whichever slot holds it: the hero's, or the voice
   * stage's centre. It glides between them, growing as it goes.
   */
  let mascotAt = $state<{ x: number; y: number; s: number } | null>(null)
  let mascotGlides = $state(false)
  const place = () => {
    const slot = stage ? stageSlot : heroSlot
    if (!canvas || !slot) return
    const c = canvas.getBoundingClientRect()
    const r = slot.getBoundingClientRect()
    const s = stage ? 168 : 88
    mascotAt = { x: r.left - c.left + r.width / 2 - s / 2, y: r.top - c.top + r.height / 2 - s / 2, s }
  }
  $effect(() => {
    void stage
    void empty
    void heroSlot
    void stageSlot
    void tick().then(place)
  })
  $effect(() => {
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      mascotGlides = false
      place()
      requestAnimationFrame(() => (mascotGlides = true))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  })

  // A ring leaves the mascot on each spike in the voice.
  $effect(() => {
    void voice.spikes
    const host = untrack(() => mascotHost)
    if (!host || !untrack(() => stage) || untrack(() => voice.spikes) === 0) return
    const ring = document.createElement('span')
    ring.className = 'ripple'
    ring.style.setProperty('--rs', '168px')
    ring.style.setProperty('--rg', '1.55')
    host.append(ring)
    ring.addEventListener('animationend', () => ring.remove())
  })

  const mascotState = $derived(voice.phase === 'recording' || voice.phase === 'starting' ? 'listening' : voice.phase === 'transcribing' ? 'thinking' : '')
  const homeVoice = $derived(empty)

  const openPrompt = () => {
    promptDraft = app.chat.systemPrompt ?? app.primaryBot?.instructions ?? app.settings?.settings.systemPrompt ?? ''
    promptOpen = true
  }

  const savePrompt = async (value: string | null) => {
    promptOpen = false
    await app.updateSession({ systemPrompt: value })
  }
</script>

<section
  bind:this={canvas}
  class="canvas relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--r-card)] shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)]"
  style="background: var(--canvas-glow), var(--canvas)"
  class:voice={stage}
>
  <!-- The top bar keeps room for the panel's fixed toggle at the right while the panel is shut (the
       sidebar's sits in the app bar above). It names the job a thread is on, never the bot: the
       sidebar shows whose conversation is open, and the app bar does while the sidebar is shut. -->
  <header
    class="topbar flex h-[52px] shrink-0 items-center gap-1 pl-4 transition-[opacity,padding] duration-300 ease-out"
    style="padding-right: {app.panelToggle && !app.panelOpen ? 46 : 12}px"
  >
    {#if !app.isPrimary}
      <span class="min-w-0 truncate pl-1 font-medium" data-chat-title>{view?.session.title ?? ''}</span>
    {/if}
    <span class="flex-1"></span>
    <!-- The primary's instructions are its bot's, in Settings; a job's thread can have its own. -->
    {#if !app.isPrimary}
      <button class="icon-btn relative size-8 {hasOverride ? '!text-fg' : ''}" use:tip={'Instructions for this job'} onclick={openPrompt}>
        <Icon name="settings" size={16} />
        {#if hasOverride}<span class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-fg"></span>{/if}
      </button>
    {/if}
    {#if app.settings}
      {@const onTop = app.settings.settings.alwaysOnTop}
      <button
        class="icon-btn size-8 {onTop ? '!text-fg' : ''}"
        aria-pressed={onTop}
        use:tip={onTop ? 'Unpin window' : 'Keep on top of other apps'}
        onclick={() => app.setPinned(!onTop)}
      >
        <Icon name="pin" size={16} class="transition-transform duration-200 {onTop ? '' : 'rotate-45'}" />
      </button>
    {/if}
    <button
      class="icon-btn relative size-8 {app.browserOpen ? '!text-fg' : ''}"
      use:tip={app.browserOpen ? 'Hide browser' : 'Open browser'}
      onclick={() => (app.browserOpen && app.activeTab === 'browser' ? app.closeBrowser() : app.openBrowser())}
    >
      <Icon name="globe" size={16} />
      {#if app.control.active}<span class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-blue"></span>{/if}
    </button>
  </header>

  {#if app.team && !app.isPrimary && view}<JobBar />{/if}

  {#if empty}
    <div class="min-h-0 flex-1"></div>
    <!-- Home: one screen, no scroll. -->
    <div class="hero flex w-full flex-col items-center px-8 text-center {stage ? 'pointer-events-none absolute inset-x-0 top-[30%]' : ''}" in:fade={{ duration: 260 }}>
      <div bind:this={heroSlot} class="size-[88px]"></div>
      <div class="fadeable">
        <h1 class="mt-[26px] mb-2.5 font-display text-[42px] leading-[1.05] font-light tracking-[-0.035em] text-balance">What are we working on?</h1>
        <p class="mb-7 text-[15.5px] text-fg-3">
          Type, talk, or let Claude use your browser{app.computerSupported ? ' and computer' : ''}.
          {#if app.settings && app.settings.settings.auth === 'apiKey' && !app.settings.hasAnthropicKey}
            <button class="ml-1 text-fg-2 underline decoration-fg-4 underline-offset-4 hover:decoration-fg" onclick={() => (app.settingsOpen = true)}>
              Add your Anthropic API key to begin.
            </button>
          {/if}
        </p>
      </div>
    </div>
  {:else if view}
    <div class="relative min-h-0 flex-1">
      <!-- The thread runs on under the composer's glass, and fades out in the strip below it. -->
      <div bind:this={scroller} {onscroll} class="h-full overflow-y-auto thread-fade">
        <div bind:this={thread} class="mx-auto flex max-w-[760px] flex-col gap-6 px-8 pt-4" style="padding-bottom: {dockH + 24}px">
          {#each shown as node, i (node.message.id)}
            <!-- The last few always render, so a chat opens at its true end. -->
            <MessageItem
              {node}
              last={from + i === view.path.length - 1 && pendingNodes.length === 0}
              far={from + i < view.path.length - 4}
              primary={app.isPrimary}
              job={app.isPrimary ? (app.jobByThread.get(node.message.sessionId) ?? null) : null}
              {showAuthor}
            />
          {/each}
          {#each pendingNodes as node (node.message.id)}
            <MessageItem {node} primary />
          {/each}
        </div>
      </div>

      {#if !pinned}
        <!-- Centred by a wrapper so the fly transition's transform doesn't fight the centring. -->
        <!-- Under the composer's layer, so the composer's popovers (the model list) cover it. -->
        <div class="pointer-events-none absolute inset-x-0 z-[2] flex justify-center" style="bottom: {dockH + 12}px" transition:fly={{ y: 6, duration: 160 }}>
          <button class="btn glass-float pointer-events-auto !shadow-[inset_0_1px_0_var(--glass-edge),0_0_0_1px_var(--glass-ring),var(--shadow-float)]" onclick={scrollToEnd}>
            <Icon name="arrowDown" size={14} /> Scroll to end
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <div
    bind:this={dock}
    bind:clientHeight={dockH}
    class="z-[3] mx-auto w-full max-w-[824px] shrink-0 px-8 {empty ? 'relative' : 'absolute inset-x-0 bottom-0'} {empty && !stage ? '' : 'pb-[18px]'}"
  >
    {#if elsewhere}
      <div class="mb-2.5" data-approval-elsewhere>
        {#if elsewhereFrom}
          <button class="mb-1.5 inline-flex max-w-full items-center gap-1 px-1 text-[12.5px] text-fg-3 transition-colors hover:text-fg" onclick={() => app.open(elsewhereFrom.id)}>
            <span class="truncate">From {elsewhereFrom.label}</span><Icon name="chevronRight" size={12} class="shrink-0" />
          </button>
        {/if}
        <ComputerWaitCard wait={elsewhere} />
      </div>
    {/if}
    <div class="mb-2 flex min-h-7 items-center px-1 empty:hidden"><JobChip /></div>
    <Composer
      bind:this={composer}
      tall={empty && !stage}
      inChat={!homeVoice}
      placeholder={empty ? 'Ask anything' : 'Reply'}
      {model}
      onmodel={(id) => app.updateSession({ model: id })}
    />
  </div>

  {#if empty}
    <div class="min-h-0 transition-[flex-grow] duration-500 {stage ? 'flex-[0]' : 'flex-1 pb-[52px]'}"></div>

    <!-- The voice stage on a new chat. -->
    <div
      class="vstage pointer-events-none absolute inset-x-0 top-[52px] bottom-[150px] flex flex-col items-center justify-center transition-opacity duration-[400ms] ease-out {stage ? 'opacity-100' : 'opacity-0'}"
      aria-hidden={!stage}
    >
      <div bind:this={stageSlot} class="size-[176px]"></div>
      <div class="mt-[34px] h-[30px] font-display text-[26px] leading-[1.1] font-light tracking-[-0.02em]" aria-live="polite">
        {#if voice.home === 'ready' && voice.phase === 'idle'}Ready when you are{:else if voice.phase === 'transcribing'}<span class="thinking">Transcribing</span>{:else}<span class="thinking">Listening</span>{/if}
      </div>
      <div class="mt-2.5 flex h-[18px] items-center gap-2.5 text-[13px] text-fg-3">
        {#if voice.home === 'ready' && voice.phase === 'idle'}
          <span>Enter to send · {shortcut('M')} to keep talking · Esc to start over</span>
        {:else if voice.phase !== 'transcribing'}
          <span class="font-label text-[12.5px] font-medium text-fg-2 tabular-nums">{clock(voice.elapsed)}</span>
          <span>{voice.held ? 'Release to transcribe' : `${shortcut('M')} or the mic to finish · Esc to cancel`}</span>
        {/if}
      </div>
    </div>

    {#if mascotAt}
      <!-- Not a control: voice starts and stops from the composer's mic and Ctrl+M (Cmd+M). -->
      <div
        bind:this={mascotHost}
        class="pointer-events-none absolute z-[2] {mascotGlides ? 'mascot-glide' : ''}"
        style="left: {mascotAt.x}px; top: {mascotAt.y}px; width: {mascotAt.s}px; height: {mascotAt.s}px"
        in:fade={{ duration: 260 }}
        onintroend={() => (mascotGlides = true)}
      >
        <Mascot size="100%" state={stage ? mascotState : ''} level={stage && voice.recording ? voice.level : undefined} />
      </div>
    {/if}
  {/if}
</section>

<SelectionReply {scroller} onreply={(block) => composer?.append(block)} />

{#if promptOpen}
  <div class="fixed inset-0 z-50 grid place-items-center p-6" role="dialog" aria-modal="true" aria-label="Chat instructions">
    <button use:dimsBar class="absolute inset-0 bg-scrim backdrop-blur-[4px]" aria-label="Close" transition:fade={{ duration: 150 }} onclick={() => (promptOpen = false)}></button>
    <div class="glass-strong relative w-full max-w-lg rounded-[20px] p-6" transition:pop>
      <h2 class="font-display text-[22px] leading-tight font-normal tracking-[-0.02em]">Instructions for this job</h2>
      <p class="mt-1 text-[13.5px] text-fg-3">Replace {app.primaryBot?.name ?? 'Tomo'}'s instructions in this job only.</p>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        autofocus
        bind:value={promptDraft}
        rows="9"
        class="mt-4 w-full resize-y rounded-[10px] bg-[var(--glass-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed shadow-[inset_0_0_0_1px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--line-2)]"
        onkeydown={(e) => e.key === 'Escape' && (promptOpen = false)}
      ></textarea>
      <div class="mt-4 flex items-center gap-2">
        {#if hasOverride}
          <button class="btn quiet" onclick={() => savePrompt(null)}>Use {app.primaryBot?.name ?? 'Tomo'}'s</button>
        {/if}
        <button class="btn ml-auto" onclick={() => (promptOpen = false)}>Cancel</button>
        <button class="btn solid" onclick={() => savePrompt(promptDraft)}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .fadeable {
    transition:
      opacity 0.35s var(--ease-studio),
      transform 0.5s var(--ease-studio);
  }
  .canvas.voice .fadeable {
    opacity: 0;
    transform: translateY(-8px);
  }
  .canvas.voice .topbar {
    opacity: 0;
    pointer-events: none;
  }
  /* Lines that scroll past the composer fade out in the strip below it. */
  .thread-fade {
    mask-image: linear-gradient(to bottom, #000 calc(100% - 46px), transparent calc(100% - 16px));
  }
  .mascot-glide {
    transition:
      left 650ms var(--ease-studio),
      top 650ms var(--ease-studio),
      width 650ms var(--ease-studio),
      height 650ms var(--ease-studio);
  }
</style>
