<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { tick } from 'svelte'
  import { fade, fly, pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Composer from './Composer.svelte'
  import Icon from './Icon.svelte'
  import Logo from './Logo.svelte'
  import MessageItem from './MessageItem.svelte'
  import SelectionReply from './SelectionReply.svelte'

  let scroller: HTMLDivElement | undefined = $state()
  let dock: HTMLDivElement | undefined = $state()
  let composer: ReturnType<typeof Composer> | undefined = $state()
  let pinned = $state(true)
  let promptOpen = $state(false)
  let promptDraft = $state('')

  const view = $derived(app.view)
  const empty = $derived(!view || view.path.length === 0)
  const model = $derived(app.chat.model ?? app.settings?.settings.defaultModel ?? '')
  const hasOverride = $derived(app.chat.systemPrompt != null)

  const greeting = (() => {
    const h = new Date().getHours()
    return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  })()

  // Keep the newest line in view unless the user scrolled up to read.
  const onscroll = () => {
    if (!scroller) return
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
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
    const next = !app.chat.browserEnabled
    await app.updateSession({ browserEnabled: next })
    if (!next) return
    app.openBrowser()
    const info = app.models.find((m) => m.id === model)
    if (info && !info.supportsTools) app.toast(`${info.name} can't use tools, so it can't drive the browser. Pick a model marked "tools".`)
  }

  const toggleComputer = async () => {
    const next = !app.chat.computerEnabled
    await app.updateSession({ computerEnabled: next })
    if (!next) return
    const info = app.models.find((m) => m.id === model)
    if (info && !info.supportsTools) app.toast(`${info.name} can't use tools, so it can't use the computer. Pick a model marked "tools".`)
    else if (info && !info.inputModalities.includes('image')) app.toast(`${info.name} can't see images, so it can't see your screen. Pick a model that takes images.`)
    else app.toast('The assistant can now see your screen and work in your apps in this chat, with its own cursor: your mouse stays yours. Settings, passwords and terminals stay off limits. Press Stop to take over.', 'info')
  }

  const openPrompt = () => {
    promptDraft = app.chat.systemPrompt ?? app.settings?.settings.systemPrompt ?? ''
    promptOpen = true
  }

  const savePrompt = async (value: string | null) => {
    promptOpen = false
    await app.updateSession({ systemPrompt: value })
  }
</script>

<div class="relative flex h-full min-w-0 flex-1 flex-col">
  <!--
    With the sidebar open the chat is inset below a thin sidebar-coloured strip, its edge carrying on from the sidebar's,
    and these controls sit in a notch curved out of its top-right corner. With the sidebar closed they float over the chat.
  -->
  <header class="absolute top-0 right-0 z-10">
    {#if app.sidebarOpen}
      <svg class="pointer-events-none absolute top-0 right-0" width="104" height="49" aria-hidden="true">
        <path d="M0 0V14.5C16 14.5 16 47.5 32 47.5H104V0Z" fill="var(--side)" />
        <path d="M0 14.5C16 14.5 16 47.5 32 47.5H104" fill="none" stroke="var(--line)" />
      </svg>
    {/if}
    <div class="relative mt-2 mr-2 flex items-center gap-0.5 rounded-lg p-1 {app.sidebarOpen ? '' : 'bg-side'}">
      {#if app.settings}
        {@const onTop = app.settings.settings.alwaysOnTop}
        <button
          class="icon-btn {onTop ? '!text-fg' : ''}"
          aria-pressed={onTop}
          use:tip={onTop ? 'Unpin window' : 'Keep on top of other apps'}
          onclick={() => app.setPinned(!onTop)}
        >
          <Icon name="pin" size={16} class="transition-transform duration-200 {onTop ? '' : 'rotate-45'}" />
        </button>
      {/if}
      <button
        class="icon-btn relative {app.browserOpen ? '!text-fg' : ''}"
        use:tip={app.browserOpen ? 'Hide browser' : 'Open browser'}
        onclick={() => (app.browserOpen && app.activeTab === 'browser' ? app.closeBrowser() : app.openBrowser())}
      >
        <Icon name="globe" size={16} />
        {#if app.control.active}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-accent"></span>{/if}
      </button>
    </div>
  </header>

  <div
    class="flex min-h-0 flex-1 flex-col bg-bg transition-[margin] duration-200 {app.sidebarOpen
      ? 'mt-3.5 rounded-tl-xl border-t border-l border-line'
      : ''}"
  >
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
          <div class="mx-auto flex max-w-[720px] flex-col gap-7 px-6 pt-10 pb-10">
            {#each view.path as node, i (node.message.id)}
              <MessageItem {node} last={i === view.path.length - 1} />
            {/each}
          </div>
        {/if}
      </div>

      {#if !pinned && !empty}
        <!-- Centred by a wrapper so the fly transition's transform doesn't fight the centring. -->
        <div class="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center" transition:fly={{ y: 6, duration: 160 }}>
          <button
            class="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full bg-surface pr-3.5 pl-3 text-[12.5px] text-fg-2 shadow-[0_0_0_1px_var(--line),var(--shadow)] transition-colors hover:text-fg"
            onclick={() => toBottom('smooth')}
          >
            <Icon name="arrowDown" size={14} /> Scroll to end
          </button>
        </div>
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
        browserEnabled={app.chat.browserEnabled}
        onbrowser={toggleBrowser}
        computerEnabled={app.chat.computerEnabled}
        oncomputer={toggleComputer}
      />
    </div>

    {#if empty}<div class="flex-[1.3]"></div>{/if}
  </div>
</div>

<SelectionReply {scroller} onreply={(block) => composer?.append(block)} />

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
