<script lang="ts">
  import { onMount } from 'svelte'
  import ArtifactPanel from './components/ArtifactPanel.svelte'
  import BrowserPanel from './components/BrowserPanel.svelte'
  import ChatView from './components/ChatView.svelte'
  import Icon from './components/Icon.svelte'
  import SettingsPage from './components/SettingsPage.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import { ease, fade, fly } from './lib/motion'
  import { app } from './lib/store.svelte'

  let ready = $state(false)
  let resizing = $state(false)
  // Pixel width so the panel can animate open without its contents reflowing.
  let panelWidth = $state(Math.round(window.innerWidth * 0.44))
  const clampPanel = (px: number) => Math.round(Math.min(window.innerWidth - 640, Math.max(360, px)))

  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  /**
   * Opens the panel by growing its width, so the chat column narrows in step
   * instead of jumping. The contents keep their final width throughout.
   */
  const reveal = (_node: Element, { width }: { width: number }) => ({
    duration: reduce.matches ? 0 : 300,
    easing: ease,
    css: (t: number) => `width: ${t * width}px`
  })

  onMount(async () => {
    await app.init()
    ready = true
  })

  const onkeydown = (e: KeyboardEvent) => {
    if (!e.ctrlKey) return
    const key = e.key.toLowerCase()
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

  // Drag the divider to resize the artifact panel.
  const startResize = (e: PointerEvent) => {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    resizing = true
    const move = (ev: PointerEvent) => {
      panelWidth = clampPanel(window.innerWidth - ev.clientX)
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

{#if ready}
  <div class="flex h-full {resizing ? 'cursor-col-resize select-none' : ''}" in:fade={{ duration: 200 }}>
    <Sidebar />
    <main class="relative flex min-w-0 flex-1 bg-bg {app.sidebarOpen ? 'shadow-[-1px_0_0_var(--line)]' : ''}">
      <div class="flex min-w-0 flex-1" inert={app.page !== 'chat'}>
        <ChatView />
        {#if app.panelOpen}
          <div class="relative flex shrink-0 justify-end overflow-hidden" style="width: {panelWidth}px" transition:reveal={{ width: panelWidth }}>
            <div class="relative flex h-full shrink-0" style="width: {panelWidth}px">
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel"
                class="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize"
                onpointerdown={startResize}
              >
                <span class="absolute inset-y-0 left-0 w-px bg-line transition-colors group-hover:bg-muted {resizing ? '!bg-fg-2' : ''}"></span>
              </div>
              <div class="flex min-w-0 flex-1 flex-col bg-side {resizing ? 'pointer-events-none' : ''}">
                {#if app.browserOpen && app.hasArtifact}
                  <div class="flex shrink-0 gap-1 px-2 pt-2" role="tablist" aria-label="Panel">
                    {#each [{ id: 'artifact', label: app.artifactVersions[0]?.block.title ?? 'Artifact', icon: app.artifactVersions[0]?.block.kind === 'moodboard' ? 'board' : 'window' }, { id: 'browser', label: app.browser.title || 'Browser', icon: 'globe' }] as t (t.id)}
                      <button
                        role="tab"
                        aria-selected={app.activeTab === t.id}
                        class="flex min-w-0 max-w-[50%] items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition-colors {app.activeTab === t.id
                          ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--line)]'
                          : 'text-fg-2 hover:bg-hover hover:text-fg'}"
                        onclick={() => (app.panelTab = t.id as 'artifact' | 'browser')}
                      >
                        <Icon name={t.icon as 'window' | 'globe' | 'board'} size={13} />
                        <span class="truncate">{t.label}</span>
                        {#if t.id === 'browser' && app.control.active}<span class="size-1.5 shrink-0 rounded-full bg-accent"></span>{/if}
                      </button>
                    {/each}
                  </div>
                {/if}
                <!-- Both stay mounted so switching tabs never reloads the page or the artifact. -->
                <div class="relative min-h-0 flex-1">
                  {#if app.hasArtifact}
                    <div class="absolute inset-0 {app.activeTab === 'artifact' ? '' : 'invisible'}" inert={app.activeTab !== 'artifact'}><ArtifactPanel /></div>
                  {/if}
                  {#if app.browserOpen}
                    <div class="absolute inset-0 {app.activeTab === 'browser' ? '' : 'invisible'}" inert={app.activeTab !== 'browser'}><BrowserPanel /></div>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>
      {#if app.page === 'settings' && app.settings}
        <SettingsPage />
      {/if}
    </main>
  </div>
{/if}


<div class="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex flex-col items-center gap-2 px-4">
  {#each app.toasts as t (t.id)}
    <div
      class="pointer-events-auto flex max-w-[560px] items-center gap-2.5 rounded-full py-2 pr-2 pl-4 text-[13px] shadow-float {t.kind === 'error'
        ? 'bg-fg text-bg'
        : 'bg-surface text-fg shadow-[0_0_0_1px_var(--line),var(--shadow)]'}"
      in:fly={{ y: 10, duration: 220 }}
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
