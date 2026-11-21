<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import ArtifactPanel from './components/ArtifactPanel.svelte'
  import BrowserPanel from './components/BrowserPanel.svelte'
  import ChatView from './components/ChatView.svelte'
  import FindModal from './components/FindModal.svelte'
  import Icon from './components/Icon.svelte'
  import SettingsPage from './components/SettingsPage.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import { modKey } from './lib/keys'
  import { ease, fade, fly } from './lib/motion'
  import { app } from './lib/store.svelte'
  import { tip } from './lib/tooltip'

  let ready = $state(false)
  let resizing = $state(false)
  // Pixel width, kept by the panel's contents while it slides in and out.
  let panelWidth = $state(Math.round(window.innerWidth * 0.44))
  // The chat keeps at least 388px beside the sidebar, whatever width the sidebar was dragged to.
  const clampPanel = (px: number) =>
    Math.round(Math.min(window.innerWidth - 388 - (app.sidebarOpen ? app.sidebarWidth : 0), Math.max(360, px)))
  $effect(() => {
    void app.sidebarOpen
    void app.sidebarWidth
    panelWidth = clampPanel(untrack(() => panelWidth))
  })

  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  /**
   * Opens the panel by sliding it in from the right edge. The chat column takes its new width at
   * once, and the panel glides into the room it left. Growing the panel's width instead narrowed
   * the chat a little every frame, re-laying out and repainting the whole conversation each time
   * (about 30 ms a frame on a long chat), so the panel stuttered in and out.
   */
  const reveal = (_node: Element, { width }: { width: number }) => ({
    duration: reduce.matches ? 0 : 450,
    easing: ease,
    css: (t: number) => `transform: translateX(${(1 - t) * width}px); opacity: ${Math.min(1, t * 1.5)}`
  })
  /**
   * Closing, the panel leaves the layout at once, staying where it sat (main's padding is 8px), so
   * the chat widens as it slides away rather than all at once after. Position can't be animated,
   * so it is set as the slide starts.
   */
  const leaveLayout = (e: Event) => {
    const el = e.currentTarget as HTMLElement
    Object.assign(el.style, { position: 'absolute', top: '8px', bottom: '8px', right: '8px' })
  }

  onMount(async () => {
    await app.init()
    ready = true
  })

  // Cmd on a Mac, Ctrl elsewhere.
  const onkeydown = (e: KeyboardEvent) => {
    if (!modKey(e)) return
    const key = e.key.toLowerCase()
    // Settings and search sit over the chat as modals; shortcuts would act unseen behind them.
    if (key === 'k' && !app.settingsOpen) {
      e.preventDefault()
      app.findOpen = !app.findOpen
      return
    }
    if ((app.settingsOpen && key !== ',') || app.findOpen) return
    if (key === 'n') {
      e.preventDefault()
      void app.newSession()
    } else if (key === ',') {
      e.preventDefault()
      app.settingsOpen = true
    } else if (key === 'b') {
      e.preventDefault()
      app.sidebarOpen = !app.sidebarOpen
    }
  }

  // Drag the gap left of the panel to resize it.
  const startResize = (e: PointerEvent) => {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    resizing = true
    const move = (ev: PointerEvent) => {
      panelWidth = clampPanel(window.innerWidth - 8 - ev.clientX)
    }
    const up = () => {
      resizing = false
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const tabs = $derived([
    ...(app.hasArtifact ? [{ id: 'artifact' as const, label: app.artifactVersions[0]?.block.title ?? 'Artifact', icon: 'window' as const }] : []),
    ...(app.browserOpen ? [{ id: 'browser' as const, label: app.browser.title || 'Browser', icon: 'globe' as const }] : [])
  ])
</script>

<svelte:window {onkeydown} onresize={() => (panelWidth = clampPanel(panelWidth))} />

<!-- The panel's tabs, at the start of whichever panel's header shows. -->
{#snippet panelTabs()}
  <div class="mr-auto inline-flex min-w-0 rounded-full bg-wash p-[3px]" role="tablist" aria-label="Panel">
    {#each tabs as t (t.id)}
      <button
        role="tab"
        aria-selected={app.activeTab === t.id}
        class="inline-flex h-7 min-w-0 max-w-[180px] items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors {app.activeTab === t.id
          ? 'glass text-fg'
          : 'text-fg-3 hover:text-fg'}"
        onclick={() => (app.panelTab = t.id)}
      >
        <Icon name={t.icon} size={14} />
        <span class="truncate">{t.label}</span>
        {#if t.id === 'browser' && app.control.active}<span class="size-1.5 shrink-0 rounded-full bg-blue"></span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#if ready}
  <!-- Behind a modal nothing takes focus or clicks. -->
  <div class="flex h-full {resizing ? 'cursor-col-resize select-none' : ''}" inert={app.settingsOpen || app.findOpen} in:fade={{ duration: 200 }}>
    <Sidebar />
    <main class="relative flex min-w-0 flex-1 py-2 pr-2 transition-[padding] duration-[350ms] ease-out {app.sidebarOpen ? 'pl-0' : 'pl-2'}">
      <div class="flex min-w-0 flex-1" inert={app.page !== 'chat'}>
        <ChatView />
        {#if app.panelOpen}
          <div
            class="relative flex shrink-0 justify-end overflow-hidden"
            style="width: {panelWidth + 8}px"
            transition:reveal={{ width: panelWidth + 8 }}
            onoutrostart={leaveLayout}
          >
            <div class="relative flex h-full shrink-0 pl-2" style="width: {panelWidth + 8}px">
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel"
                class="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize"
                onpointerdown={startResize}
              >
                <span class="absolute inset-y-3 left-[3px] w-0.5 rounded-full transition-colors group-hover:bg-line-2 {resizing ? '!bg-line-2' : ''}"></span>
              </div>
              <section
                class="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--r-card)] bg-card shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)] {resizing ? 'pointer-events-none' : ''}"
              >
                <!-- Both stay mounted so switching tabs never reloads the page or the artifact. -->
                {#if app.hasArtifact}
                  <div class="absolute inset-0 {app.activeTab === 'artifact' ? '' : 'invisible'}" inert={app.activeTab !== 'artifact'}><ArtifactPanel tabs={panelTabs} /></div>
                {/if}
                {#if app.browserOpen}
                  <div class="absolute inset-0 {app.activeTab === 'browser' ? '' : 'invisible'}" inert={app.activeTab !== 'browser'}><BrowserPanel tabs={panelTabs} /></div>
                {/if}
              </section>
            </div>
          </div>
        {/if}
      </div>
    </main>
  </div>

  {#if app.panelToggle && app.page === 'chat'}
    <!-- The sidebar toggle mirrored: one spot whether the panel is open or shut, and it is the
         panel's close control too. The chat's top bar and the panel's header keep room for it. -->
    <button
      class="icon-btn fixed top-[18px] right-5 z-[45] size-8"
      aria-pressed={app.panelOpen}
      data-panel-toggle
      use:tip={app.panelOpen ? 'Hide panel' : app.latestArtifact ? 'Show artifact' : 'Show panel'}
      onclick={() => app.togglePanel()}
      transition:fade={{ duration: 160 }}
    >
      <Icon name="sidebar" size={16} class="-scale-x-100" />
    </button>
  {/if}

  {#if app.page === 'settings' && app.settings}
    <SettingsPage />
  {/if}
  {#if app.findOpen}
    <FindModal />
  {/if}
{/if}

<div class="pointer-events-none fixed inset-x-0 bottom-6 z-[70] flex flex-col items-center gap-2 px-4">
  {#each app.toasts as t (t.id)}
    <div
      class="pointer-events-auto flex max-w-[560px] items-center gap-2.5 rounded-full bg-solid py-[7px] pr-2 pl-4 text-[13px] font-medium text-on-solid shadow-float"
      role={t.kind === 'error' ? 'alert' : 'status'}
      in:fly={{ y: 16, duration: 300 }}
      out:fade={{ duration: 140 }}
    >
      {#if t.kind === 'error'}<Icon name="alert" size={14} />{/if}
      <span class="min-w-0 break-words">{t.text}</span>
      <button class="grid size-6 place-items-center rounded-full opacity-60 hover:opacity-100" aria-label="Dismiss" onclick={() => app.dismiss(t.id)}>
        <Icon name="x" size={13} />
      </button>
    </div>
  {/each}
</div>
