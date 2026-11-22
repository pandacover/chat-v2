<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import ArtifactPanel from './components/ArtifactPanel.svelte'
  import BarActions from './components/BarActions.svelte'
  import BrowserPanel from './components/BrowserPanel.svelte'
  import ChatView from './components/ChatView.svelte'
  import FindModal from './components/FindModal.svelte'
  import Icon from './components/Icon.svelte'
  import PanelHome from './components/PanelHome.svelte'
  import PanelTabs from './components/PanelTabs.svelte'
  import SettingsPage from './components/SettingsPage.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import { modKey } from './lib/keys'
  import { ease, fade, fly } from './lib/motion'
  import { app, tabKey } from './lib/store.svelte'

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
   * The panel slides in from the right edge. The chat column takes its new width at once, and the
   * panel glides into the room it left. Growing the panel's width instead narrowed the chat a
   * little every frame, re-laying out and repainting the whole conversation each time (about 30 ms
   * a frame on a long chat), so the panel stuttered in and out.
   */
  const slideFrames = (width: number, opening: boolean): Keyframe[] =>
    Array.from({ length: 25 }, (_, i) => {
      const t = ease(opening ? i / 24 : 1 - i / 24)
      return { transform: `translateX(${(1 - t) * width}px)`, opacity: Math.min(1, t * 1.5) }
    })
  /**
   * Closing, the panel leaves the layout at once, staying where it sat (main's padding is 8px), so
   * the chat widens as it slides away rather than all at once after. Position can't be animated,
   * so it is set as the slide starts.
   */
  const OUT_OF_LAYOUT = { position: 'absolute', top: 'var(--card-top)', bottom: '8px', right: '8px' }
  const IN_LAYOUT = { position: '', top: '', bottom: '', right: '' }

  /**
   * The panel's element is always there. Closed, it is parked: out of the layout, transparent and
   * click-through, holding the browser while a chat that isn't open has it (a job's thread drives
   * it while you talk to Tomo), so its page keeps running and can be read and captured. (A hidden
   * or off-screen webview stops painting, and its screenshots never come back.)
   */
  let panelEl: HTMLDivElement | undefined = $state()
  let parked = $state(untrack(() => !app.panelOpen))
  /** Sliding out: what it shows stays until it is gone. */
  let leaving = $state(false)
  let slide: Animation | null = null
  let wasOpen = untrack(() => app.panelOpen)
  // Before the DOM updates, so what it shows is still there when the slide out starts.
  $effect.pre(() => {
    const open = app.panelOpen
    untrack(() => {
      if (open === wasOpen) return
      wasOpen = open
      slide?.cancel()
      slide = null
      const el = panelEl
      const width = panelWidth + 8
      if (open) {
        parked = false
        leaving = false
        if (!el) return
        Object.assign(el.style, IN_LAYOUT)
        if (!reduce.matches) slide = el.animate(slideFrames(width, true), { duration: 450 })
        return
      }
      if (!el || reduce.matches) {
        parked = true
        leaving = false
        return
      }
      leaving = true
      Object.assign(el.style, OUT_OF_LAYOUT)
      const s = (slide = el.animate(slideFrames(width, false), { duration: 450, fill: 'forwards' }))
      s.onfinish = () => {
        if (slide !== s) return
        slide = null
        parked = true
        leaving = false
        Object.assign(el.style, IN_LAYOUT)
        s.cancel()
      }
    })
  })

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

</script>

<svelte:window {onkeydown} onresize={() => (panelWidth = clampPanel(panelWidth))} />

<!-- The panel's tabs, at the start of whichever header shows. -->
{#snippet panelTabs()}
  <PanelTabs />
{/snippet}

<!-- The app bar: the strip above the cards moves the window where nothing clickable sits (app.css). -->
<div class="app-drag fixed inset-x-0 top-0 h-[var(--card-top)]" aria-hidden="true"></div>

{#if ready}
  <!-- Behind a modal nothing takes focus or clicks. -->
  <div class="flex h-full {resizing ? 'cursor-col-resize select-none' : ''}" inert={app.settingsOpen || app.findOpen} in:fade={{ duration: 200 }}>
    <Sidebar />
    <main class="relative flex min-w-0 flex-1 pt-[var(--card-top)] pr-2 pb-2 transition-[padding] duration-[350ms] ease-out {app.sidebarOpen ? 'pl-0' : 'pl-2'}">
      <div class="flex min-w-0 flex-1" inert={app.page !== 'chat'}>
        <ChatView />
        <div
          bind:this={panelEl}
          class="flex shrink-0 justify-end overflow-hidden {parked ? 'pointer-events-none absolute top-[var(--card-top)] right-2 bottom-2 opacity-0' : 'relative'}"
          style="width: {panelWidth + 8}px"
          inert={!app.panelOpen}
          aria-hidden={!app.panelOpen || undefined}
          data-panel={parked ? 'parked' : 'open'}
        >
          {#if app.panelOpen || leaving || app.browserAlive}
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
                <!-- Every tab stays mounted, so switching tabs never reloads the page or an artifact. The
                     browser is outside the list: a list moves its items, and a moved webview reloads. -->
                {#each app.shownTabs as t (tabKey(t))}
                  {#if t.kind === 'artifact'}
                    {@const on = app.activeTab !== null && tabKey(app.activeTab) === tabKey(t)}
                    <div class="absolute inset-0 {on ? '' : 'invisible'}" inert={!on}><ArtifactPanel tabs={panelTabs} open={t} active={on} /></div>
                  {/if}
                {/each}
                <!-- Mounted wherever the browser is open, in this chat's panel or another's, so its page
                     keeps running. Off show it is transparent and click-through rather than hidden: a
                     hidden webview stops painting, and the agent's screenshots of it never come back. -->
                {#if app.browserAlive}
                  {@const on = app.browserOpen && app.activeTab?.kind === 'browser'}
                  <div class="absolute inset-0 {on ? '' : 'pointer-events-none opacity-0'}" inert={!on} data-browser={on ? 'shown' : 'away'}>
                    <BrowserPanel tabs={panelTabs} />
                  </div>
                {/if}
                {#if app.shownTabs.length === 0}<PanelHome tabs={panelTabs} />{/if}
              </section>
            </div>
          {/if}
        </div>
      </div>
    </main>
  </div>

  <!-- The app bar's right end: the conversation's and the window's actions, and the panel toggle.
       After the bar's drag strip in the page, so its buttons take clicks (app.css). -->
  <BarActions />

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
