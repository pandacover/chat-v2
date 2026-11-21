<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { flip } from 'svelte/animate'
  import { SvelteSet } from 'svelte/reactivity'
  import type { Session } from '@shared/types'
  import { entries, grouped, openEntry, type Entry } from '@/lib/chats.svelte'
  import { ease, fade } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import Icon, { type IconName } from './Icon.svelte'
  import UpdateButton from './UpdateButton.svelte'

  let renaming = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  let draft = $state('')

  // Drafts first, then pinned chats, then the rest by day.
  const groups = $derived(grouped(entries()))

  // Collapsed groups, by label, kept across launches.
  const COLLAPSED_KEY = 'chat-v2:collapsed-groups'
  const collapsed = new SvelteSet<string>(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
  const toggleGroup = (label: string) => {
    if (collapsed.has(label)) collapsed.delete(label)
    else collapsed.add(label)
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  }

  // Headers and chats in one keyed list, so a header moves with the same flip as the chats around it.
  type Row = { key: string; label: string; open: boolean; entry?: undefined } | { key: string; entry: Entry }
  const rows = $derived.by(() => {
    const out: Row[] = []
    for (const [label, items] of groups) {
      const open = !collapsed.has(label)
      out.push({ key: `group:${label}`, label, open })
      if (open) for (const e of items) out.push({ key: `chat:${e.key}`, entry: e })
    }
    return out
  })

  const startRename = (s: Session) => {
    confirming = null
    renaming = s.id
    draft = s.title
  }

  const commitRename = async () => {
    const id = renaming
    renaming = null
    if (id && draft.trim()) await app.rename(id, draft.trim())
  }

  const focusSelect = (el: HTMLInputElement) => {
    el.focus()
    el.select()
  }

  const themes: Array<{ id: ThemePref; icon: IconName; label: string }> = [
    { id: 'light', icon: 'sun', label: 'Light' },
    { id: 'dark', icon: 'moon', label: 'Dark' },
    { id: 'system', icon: 'monitor', label: 'System' }
  ]

  const authLabel = $derived(app.settings?.settings.auth === 'apiKey' ? 'API key' : 'Claude sign-in')

  // Drag the right edge to resize; the width is kept across launches. Double-click resets it.
  const DEFAULT_WIDTH = 256
  const clampWidth = (px: number) => Math.round(Math.max(208, Math.min(420, window.innerWidth - 640, px)))
  app.sidebarWidth = clampWidth(app.sidebarWidth)
  let resizing = $state(false)
  const setWidth = (px: number) => {
    app.sidebarWidth = clampWidth(px)
    localStorage.setItem('chat-v2:sidebar-width', String(app.sidebarWidth))
  }

  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    resizing = true
    // Relative to where it was grabbed, so the edge doesn't jump to the pointer.
    const from = app.sidebarWidth - e.clientX
    const move = (ev: PointerEvent) => {
      app.sidebarWidth = clampWidth(from + ev.clientX)
    }
    const up = () => {
      resizing = false
      setWidth(app.sidebarWidth)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
</script>

<svelte:window onresize={() => (app.sidebarWidth = clampWidth(app.sidebarWidth))} />

<!-- One spot for the sidebar toggle, open or closed, so a second click lands on it. -->
<div class="fixed top-[18px] left-[14px] z-[45] flex gap-0.5">
  <button
    class="icon-btn size-8"
    data-sidebar-toggle
    use:tip={{ text: app.sidebarOpen ? 'Hide sidebar' : 'Show sidebar', kbd: shortcut('B') }}
    onclick={() => (app.sidebarOpen = !app.sidebarOpen)}
  >
    <Icon name="sidebar" size={16} />
  </button>
  {#if !app.sidebarOpen}
    <button class="icon-btn size-8" use:tip={{ text: 'Home', kbd: shortcut('N') }} onclick={() => app.newSession()} in:fade={{ duration: 160 }}>
      <Icon name="home" size={16} />
    </button>
  {/if}
</div>

<aside
  class="side relative flex h-full shrink-0 flex-col overflow-hidden bg-side {resizing ? 'cursor-col-resize select-none' : 'transition-[width,opacity] duration-[350ms] ease-out'}"
  style="width: {app.sidebarOpen ? app.sidebarWidth : 0}px; opacity: {app.sidebarOpen ? 1 : 0}"
  inert={!app.sidebarOpen}
>
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    class="group absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize"
    use:tip={'Drag to resize · double-click to reset'}
    onpointerdown={startResize}
    ondblclick={() => setWidth(DEFAULT_WIDTH)}
  >
    <span class="absolute inset-y-3 right-0 w-0.5 rounded-full transition-colors group-hover:bg-line-2 {resizing ? '!bg-line-2' : ''}"></span>
  </div>

  <div class="flex h-full flex-col gap-0.5 px-2.5 pt-4 pb-2.5" style="width: {app.sidebarWidth}px">
    <!-- The name, centred across the sidebar, level with the sidebar toggle beside it. The fox
         mascot is the app's icon (and in Settings › About). -->
    <div class="mb-2 flex h-9 shrink-0 items-center justify-center">
      <span class="font-display text-[17px] leading-none font-medium tracking-[-0.02em] select-none">tomo</span>
    </div>

    <button class="nav-item {app.view ? '' : 'on'}" onclick={() => app.newSession()}>
      <Icon name="home" size={16} />Home<kbd class="studio-kbd ml-auto">{shortcut('N')}</kbd>
    </button>
    <button class="nav-item" onclick={() => (app.findOpen = true)}>
      <Icon name="search" size={16} />Search<kbd class="studio-kbd ml-auto">{shortcut('K')}</kbd>
    </button>

    <nav class="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2 [scrollbar-width:none]">
      {#each rows as row (row.key)}
        <div class={row.entry ? 'mt-[3px]' : ''} animate:flip={{ duration: 200, easing: ease }} transition:fade={{ duration: 120 }}>
          {#if !row.entry}
            <button
              class="group/label mono-label mt-3.5 mb-0.5 flex items-center gap-1 rounded-lg px-2.5 py-1.5 whitespace-nowrap transition-colors hover:text-fg"
              aria-expanded={row.open}
              onclick={() => toggleGroup(row.label)}
            >
              {row.label}
              <Icon
                name="chevronDown"
                size={12}
                class="transition-[transform,opacity] duration-200 {row.open
                  ? 'opacity-0 group-hover/label:opacity-100 group-focus-visible/label:opacity-100'
                  : '-rotate-90'}"
              />
            </button>
          {:else}
            {@const e = row.entry}
            {@const s = e.session}
            {@const active = (app.view?.session.id ?? '') === e.key}
            <div class="chat-row group relative">
              {#if s && renaming === s.id}
                <div class="nav-item on">
                  <input
                    use:focusSelect
                    bind:value={draft}
                    aria-label="Chat title"
                    class="h-6 min-w-0 flex-1 bg-transparent text-fg outline-none"
                    onkeydown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        renaming = null
                      }
                    }}
                    onblur={commitRename}
                  />
                </div>
              {:else if s && confirming === s.id}
                <div class="nav-item on !pr-1" in:fade={{ duration: 120 }}>
                  <span class="min-w-0 flex-1 truncate text-fg">Delete this chat?</span>
                  <button class="btn quiet sm !h-6 !px-2" onclick={() => (confirming = null)}>Keep</button>
                  <button class="btn quiet sm !h-6 !px-2 !text-danger" onclick={() => app.remove(s.id)}>Delete</button>
                </div>
              {:else}
                <button class="nav-item !gap-2 {active ? 'on' : ''}" onclick={() => openEntry(e)} ondblclick={() => s && startRename(s)}>
                  {#if e.draft}<span class="grid shrink-0 place-items-center text-blue" use:tip={'Unsent draft'}><Icon name="pen" size={13} /></span>{/if}
                  {#if s?.forkedFromSessionId}
                    {@const parent = app.sessions.find((x) => x.id === s.forkedFromSessionId)}
                    <span class="grid shrink-0 place-items-center text-fg-3" use:tip={parent ? `Forked from “${parent.title}”` : 'Forked chat'}><Icon name="branch" size={13} /></span>
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-left {s ? '' : 'italic'}">{e.title}</span>
                </button>
                <!-- Over the title rather than beside it, so the title runs to the row's edge; it fades out under the actions. -->
                <div class="acts pointer-events-none absolute top-1 right-1 flex rounded-r-lg pl-4 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 {active ? 'on' : ''}">
                  {#if s}
                    <button class="icon-btn size-[26px] !rounded-lg" use:tip={s.pinnedAt != null ? 'Unpin chat' : 'Pin chat'} onclick={() => app.pin(s.id, s.pinnedAt == null)}>
                      <Icon name="pin" size={14} class={s.pinnedAt != null ? '' : 'rotate-45'} />
                    </button>
                    <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Rename'} onclick={() => startRename(s)}><Icon name="edit" size={14} /></button>
                    <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Delete'} onclick={() => (confirming = s.id)}><Icon name="trash" size={14} /></button>
                  {:else}
                    <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Discard draft'} onclick={() => app.discardDraft('')}><Icon name="trash" size={14} /></button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <p class="px-2.5 py-6 text-[13px] text-fg-3" in:fade>Your chats will show up here.</p>
      {/each}
    </nav>

    <UpdateButton />
    <div class="mb-1.5 flex shrink-0 rounded-[10px] bg-wash p-[3px]" role="radiogroup" aria-label="Theme">
      {#each themes as t (t.id)}
        <button
          role="radio"
          aria-checked={theme.pref === t.id}
          class="inline-flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[12.5px] font-medium whitespace-nowrap transition-colors {theme.pref === t.id
            ? 'glass text-fg'
            : 'text-fg-3 hover:text-fg'}"
          onclick={() => theme.set(t.id)}
        >
          <Icon name={t.icon} size={13} />{t.label}
        </button>
      {/each}
    </div>
    <button
      class="group flex h-12 w-full min-w-0 shrink-0 items-center gap-2.5 rounded-xl pr-1.5 pl-2 text-left whitespace-nowrap transition-colors hover:bg-wash"
      use:tip={{ text: 'Settings', kbd: shortcut(',') }}
      data-tip-no-label
      aria-label="Settings"
      onclick={() => (app.settingsOpen = true)}
    >
      <span class="avatar size-[30px] shrink-0 rounded-full"></span>
      <span class="min-w-0 flex-1 leading-[1.25]">
        <b class="block truncate font-medium">{authLabel}</b>
        <span class="block font-label text-[11.5px] text-fg-3">Settings</span>
      </span>
      <Icon name="settings" size={15} class="text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  </div>
</aside>

<style>
  .nav-item {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-inner);
    color: var(--fg-2);
    text-align: left;
    white-space: nowrap;
    transition: background-color 120ms;
  }
  .nav-item:hover {
    background: var(--side-hover);
  }
  /* The active row is glass (app.css .glass). */
  .nav-item.on {
    background: var(--glass-bg);
    -webkit-backdrop-filter: blur(16px) saturate(180%);
    backdrop-filter: blur(16px) saturate(180%);
    color: var(--fg);
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--glass-ring),
      var(--shadow-sm);
  }
  .nav-item > :global(svg) {
    color: var(--fg-3);
  }
  .nav-item.on > :global(svg) {
    color: var(--fg);
  }
  /* The actions fade the title out under them, in the row's own colour. */
  .acts {
    background: linear-gradient(90deg, transparent, var(--side-hover) 16px);
  }
  .acts.on {
    background: linear-gradient(90deg, transparent, var(--glass-on-side) 16px);
  }
  .avatar {
    background: conic-gradient(from 200deg, #ffd29a, #f7a8b8, #a8c5ff, #ffd29a);
    box-shadow: inset 0 0 0 1px var(--ring);
  }
</style>
