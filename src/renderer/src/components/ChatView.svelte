<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { tick } from 'svelte'
  import { fade, fly, pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Composer from './Composer.svelte'
  import Icon from './Icon.svelte'
  import Logo from './Logo.svelte'
  import MessageItem from './MessageItem.svelte'

  let scroller: HTMLDivElement | undefined = $state()
  let dock: HTMLDivElement | undefined = $state()
  let composer: ReturnType<typeof Composer> | undefined = $state()
  let pinned = $state(true)
  let scrolled = $state(false)
  let promptOpen = $state(false)
  let promptDraft = $state('')

  const view = $derived(app.view)
  const empty = $derived(!view || view.path.length === 0)
  const model = $derived(view?.session.model ?? app.settings?.settings.defaultModel ?? '')
  const hasOverride = $derived(view?.session.systemPrompt != null)

  const greeting = (() => {
    const h = new Date().getHours()
    return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  })()

  // Keep the newest line in view unless the user scrolled up to read.
  const onscroll = () => {
    if (!scroller) return
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
    scrolled = scroller.scrollTop > 4
  }

  const toBottom = (behavior: ScrollBehavior = 'auto') => scroller?.scrollTo({ top: scroller.scrollHeight, behavior })

  $effect(() => {
    void view?.path.map((n) => n.message.content.length).join()
    if (pinned) void tick().then(() => toBottom())
  })

  // The column narrows when the artifact panel opens; stay on the newest line while it does.
  $effect(() => {
    const el = scroller
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (pinned) toBottom()
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  $effect(() => {
    void view?.session.id
    pinned = true
    composer?.focus()
  })

  // The composer starts centred and glides to the bottom on the first message (FLIP).
  let lastTop: number | null = null
  $effect.pre(() => {
    void empty
    lastTop = dock?.getBoundingClientRect().top ?? null
  })
  $effect(() => {
    void empty
    const el = dock
    if (!el || lastTop === null) return
    const dy = lastTop - el.getBoundingClientRect().top
    if (Math.abs(dy) < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: 380,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
    })
  })

  const toggleBrowser = async () => {
    const next = !(view?.session.browserEnabled ?? false)
    await app.updateSession({ browserEnabled: next })
    if (!next) return
    app.openBrowser()
    const info = app.models.find((m) => m.id === model)
    if (info && !info.supportsTools) app.toast(`${info.name} can't use tools, so it can't drive the browser. Pick a model marked "tools".`)
  }

  const openPrompt = () => {
    promptDraft = view?.session.systemPrompt ?? app.settings?.settings.systemPrompt ?? ''
    promptOpen = true
  }

  const savePrompt = async (value: string | null) => {
    promptOpen = false
    await app.updateSession({ systemPrompt: value })
  }
</script>

<div class="relative flex h-full min-w-0 flex-1 flex-col">
  <header
    class="relative z-10 flex h-12 shrink-0 items-center gap-2 pr-3 transition-[box-shadow,padding] duration-200 {app.sidebarOpen
      ? 'pl-5'
      : 'pl-14'} {scrolled && !empty ? 'shadow-[0_1px_0_var(--line)]' : ''}"
  >
    {#if view && !empty}
      <h1 class="min-w-0 flex-1 truncate text-[13.5px] text-fg-2" in:fade>{view.session.title}</h1>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <button
      class="icon-btn relative {app.browserOpen ? '!text-fg' : ''}"
      use:tip={app.browserOpen ? 'Hide browser' : 'Open browser'}
      onclick={() => (app.browserOpen && app.activeTab === 'browser' ? app.closeBrowser() : app.openBrowser())}
    >
      <Icon name="globe" size={16} />
      {#if app.control.active}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-accent"></span>{/if}
    </button>
  </header>

  {#if empty}<div class="flex-1"></div>{/if}

  <div class="relative {empty ? 'shrink-0' : 'min-h-0 flex-1'}">
    <div bind:this={scroller} {onscroll} class="h-full overflow-y-auto {empty ? 'overflow-hidden' : ''}">
      {#if empty}
        <div class="mx-auto max-w-[720px] px-6 pb-6 text-center" in:fade={{ duration: 260 }}>
          <Logo size={64} class="mx-auto mb-5 text-fg" />
          <h2 class="font-serif text-[34px] leading-tight font-[420] tracking-[-0.015em]">{greeting}.</h2>
          {#if app.settings && !app.settings.hasOpenRouterKey}
            <button class="mt-3 text-[14px] text-fg-2 underline decoration-muted underline-offset-4 hover:decoration-fg" onclick={() => (app.settingsOpen = true)}>
              Add an OpenRouter key to begin
            </button>
          {/if}
        </div>
      {:else if view}
        <div class="mx-auto flex max-w-[720px] flex-col gap-7 px-6 pt-4 pb-10">
          {#each view.path as node, i (node.message.id)}
            <MessageItem {node} last={i === view.path.length - 1} />
          {/each}
        </div>
      {/if}
    </div>

    {#if !pinned && !empty}
      <button
        class="absolute bottom-3 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full bg-surface text-fg-2 shadow-float hover:text-fg"
        use:tip={'Jump to latest'}
        transition:fly={{ y: 6, duration: 160 }}
        onclick={() => toBottom('smooth')}
      >
        <Icon name="arrowDown" size={15} />
      </button>
    {/if}
  </div>

  <div bind:this={dock} class="mx-auto w-full max-w-[720px] shrink-0 px-6 {empty ? 'pb-2' : 'pb-5'}">
    <Composer
      bind:this={composer}
      placeholder={empty ? 'Ask anything, or drop a file' : 'Reply'}
      {model}
      onmodel={(id) => app.updateSession({ model: id })}
      customInstructions={hasOverride}
      oninstructions={openPrompt}
      browserEnabled={view?.session.browserEnabled ?? false}
      onbrowser={toggleBrowser}
    />
  </div>

  {#if empty}<div class="flex-[1.3]"></div>{/if}
</div>

{#if promptOpen}
  <div class="fixed inset-0 z-50 grid place-items-center p-6" role="dialog" aria-modal="true" aria-label="Chat instructions">
    <button class="absolute inset-0 bg-scrim" aria-label="Close" transition:fade={{ duration: 150 }} onclick={() => (promptOpen = false)}></button>
    <div class="relative w-full max-w-lg rounded-lg bg-surface p-5 shadow-float" transition:pop>
      <h2 class="font-serif text-[20px]">Instructions for this chat</h2>
      <p class="mt-1 text-[13px] text-muted">Replaces the global instructions for this chat only.</p>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        autofocus
        bind:value={promptDraft}
        rows="9"
        class="mt-4 w-full resize-y rounded-md bg-bg px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none focus:shadow-[0_0_0_1px_var(--muted)]"
        onkeydown={(e) => e.key === 'Escape' && (promptOpen = false)}
      ></textarea>
      <div class="mt-4 flex items-center gap-1 text-[13px]">
        {#if hasOverride}
          <button class="rounded-md px-2 py-1 text-fg-2 hover:bg-hover hover:text-fg" onclick={() => savePrompt(null)}>Use global</button>
        {/if}
        <button class="ml-auto rounded-md px-3 py-1.5 text-fg-2 hover:bg-hover hover:text-fg" onclick={() => (promptOpen = false)}>Cancel</button>
        <button class="rounded-md bg-fg px-3.5 py-1.5 font-medium text-bg" onclick={() => savePrompt(promptDraft)}>Save</button>
      </div>
    </div>
  </div>
{/if}
