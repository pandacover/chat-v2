<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { flip } from 'svelte/animate'
  import { SvelteSet } from 'svelte/reactivity'
  import type { Session } from '@shared/types'
  import { ease, fade } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import Icon, { type IconName } from './Icon.svelte'
  import Logo from './Logo.svelte'
  import UpdateButton from './UpdateButton.svelte'

  let query = $state('')
  let renaming = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  let draft = $state('')

  const DAY = 24 * 60 * 60 * 1000

  /** A sidebar row: a saved chat, or (session null) the new chat while it has a draft. */
  interface Entry {
    key: string
    title: string
    session: Session | null
    draft: boolean
  }

  /** The new chat has no title yet; its draft's first line stands in. */
  const draftTitle = (text: string) => {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New chat'
  }

  // Unsent drafts first, then pinned chats, then the rest by day.
  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const entries: Entry[] = app.sessions.map((s) => ({ key: s.id, title: s.title, session: s, draft: app.hasDraft(s.id) }))
    if (app.hasDraft('')) entries.push({ key: '', title: draftTitle(app.draftText('')), session: null, draft: true })
    const list = q ? entries.filter((e) => e.title.toLowerCase().includes(q)) : entries
    const draftAt = (e: Entry) => app.drafts.get(e.key)?.at ?? Number.MAX_SAFE_INTEGER
    const drafts = list.filter((e) => e.draft).sort((a, b) => draftAt(b) - draftAt(a))
    const pinned = list
      .filter((e) => !e.draft && e.session?.pinnedAt != null)
      .sort((a, b) => a.session!.pinnedAt! - b.session!.pinnedAt!)
    const today = new Date().setHours(0, 0, 0, 0)
    const buckets: Array<[string, Entry[]]> = [
      ['Drafts', drafts],
      ['Pinned', pinned],
      ['Today', []],
      ['Yesterday', []],
      ['This week', []],
      ['Earlier', []]
    ]
    for (const e of list) {
      if (e.draft || !e.session || e.session.pinnedAt != null) continue
      const at = e.session.updatedAt
      const i = at >= today ? 2 : at >= today - DAY ? 3 : at >= today - 7 * DAY ? 4 : 5
      buckets[i]![1].push(e)
    }
    return buckets.filter(([, items]) => items.length > 0)
  })

  // Collapsed groups, by label, kept across launches. A search shows every group open.
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
    const searching = query.trim() !== ''
    const out: Row[] = []
    for (const [label, items] of groups) {
      const open = searching || !collapsed.has(label)
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

  // Drag the right edge to resize; the width is kept across launches. Double-click resets it.
  const DEFAULT_WIDTH = 252
  const clampWidth = (px: number) => Math.round(Math.max(200, Math.min(480, window.innerWidth - 640, px)))
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
    const move = (ev: PointerEvent) => {
      app.sidebarWidth = clampWidth(ev.clientX)
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

<aside
  class="relative flex h-full shrink-0 flex-col overflow-hidden bg-side {resizing ? 'cursor-col-resize select-none' : 'transition-[width] duration-200 ease-out'}"
  style="width: {app.sidebarOpen ? app.sidebarWidth : 0}px"
  inert={!app.sidebarOpen}
>
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    class="group absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize"
    onpointerdown={startResize}
    ondblclick={() => setWidth(DEFAULT_WIDTH)}
  >
    <span class="absolute inset-y-0 right-0 w-px transition-colors group-hover:bg-muted {resizing ? '!bg-fg-2' : ''}"></span>
  </div>
  <div class="flex h-full flex-col" style="width: {app.sidebarWidth}px">
    <!-- The toggle sits exactly where the closed sidebar's "Show sidebar" button does, so it never moves under the pointer. -->
    <div class="relative flex h-12 items-start justify-between pt-3 pr-2 pl-3">
      <button class="icon-btn" use:tip={{ text: 'Hide sidebar', kbd: shortcut('B') }} onclick={() => (app.sidebarOpen = false)}>
        <Icon name="sidebar" size={17} />
      </button>
      <div class="pointer-events-none absolute inset-x-0 top-3 flex h-[27px] items-center justify-center gap-1">
        <Logo size={22} class="text-fg" />
        <span class="font-serif text-[17px] tracking-tight italic">chat</span>
      </div>
      <button class="icon-btn" use:tip={{ text: 'New chat', kbd: shortcut('N') }} onclick={() => app.newSession()}>
        <Icon name="compose" size={17} />
      </button>
    </div>

    <label class="mx-2 mb-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted transition-colors focus-within:bg-surface focus-within:text-fg">
      <Icon name="search" size={14} />
      <input bind:value={query} placeholder="Search" class="w-full bg-transparent text-[13px] outline-none placeholder:text-muted" />
      {#if query}
        <button class="text-muted hover:text-fg" use:tip={'Clear'} onclick={() => (query = '')}><Icon name="x" size={13} /></button>
      {/if}
    </label>

    <nav class="relative min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {#each rows as row (row.key)}
        <div class={row.entry ? 'mt-1' : 'pt-[18px]'} animate:flip={{ duration: 200, easing: ease }} transition:fade={{ duration: 120 }}>
          {#if !row.entry}
            <button
              class="group/label flex items-center gap-1 rounded-sm px-2.5 py-0.5 text-[11.5px] text-muted transition-colors enabled:hover:text-fg"
              aria-expanded={row.open}
              disabled={query.trim() !== ''}
              onclick={() => toggleGroup(row.label)}
            >
              {row.label}
              {#if !query.trim()}
                <Icon
                  name="chevronDown"
                  size={12}
                  class="transition-[transform,opacity] duration-150 {row.open
                    ? 'opacity-0 group-hover/label:opacity-100 group-focus-visible/label:opacity-100'
                    : '-rotate-90'}"
                />
              {/if}
            </button>
          {:else}
            {@const e = row.entry}
            {@const s = e.session}
            {@const active = (app.view?.session.id ?? '') === e.key}
            <div
              class="group relative flex h-9 items-center rounded-md text-[13px] transition-colors {active
                ? 'bg-surface text-fg'
                : 'text-fg-2 focus-within:bg-hover hover:bg-hover hover:text-fg'}"
            >
              {#if s && renaming === s.id}
                <input
                  use:focusSelect
                  bind:value={draft}
                  class="mx-1 h-6 min-w-0 flex-1 rounded-sm bg-bg px-1.5 text-fg outline-none"
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      renaming = null
                    }
                  }}
                  onblur={commitRename}
                />
              {:else if s && confirming === s.id}
                <div class="flex w-full items-center gap-1 pr-1 pl-2.5" in:fade={{ duration: 120 }}>
                  <span class="min-w-0 flex-1 truncate text-fg">Delete this chat?</span>
                  <button class="rounded-sm px-1.5 py-0.5 text-[12px] text-muted hover:text-fg" onclick={() => (confirming = null)}>Keep</button>
                  <button class="rounded-sm px-1.5 py-0.5 text-[12px] font-medium text-danger hover:bg-hover" onclick={() => app.remove(s.id)}>Delete</button>
                </div>
              {:else}
                <button
                  class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left"
                  onclick={() => (s ? app.open(s.id) : app.newSession())}
                  ondblclick={() => s && startRename(s)}
                >
                  {#if e.draft}<span class="shrink-0 text-accent" use:tip={'Unsent draft'}><Icon name="pen" size={12} /></span>{/if}
                  {#if s?.forkedFromSessionId}<span class="text-muted" use:tip={'Forked chat'}><Icon name="branch" size={12} /></span>{/if}
                  <span class="truncate {s ? '' : 'italic'}">{e.title}</span>
                </button>
                <!-- Over the title rather than beside it, so the title runs to the tile's edge; it fades out under the actions. -->
                <div class="absolute inset-y-0 right-0 flex opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                  <span class="pointer-events-none w-6 bg-linear-to-l to-transparent {active ? 'from-surface' : 'from-hover'}"></span>
                  <div class="flex items-center rounded-r-md pr-1 {active ? 'bg-surface' : 'bg-hover'}">
                    {#if s}
                      <button class="icon-btn !p-1" use:tip={s.pinnedAt != null ? 'Unpin chat' : 'Pin chat'} onclick={() => app.pin(s.id, s.pinnedAt == null)}>
                        <Icon name="pin" size={13} class={s.pinnedAt != null ? '' : 'rotate-45'} />
                      </button>
                      <button class="icon-btn !p-1" use:tip={'Rename'} onclick={() => startRename(s)}><Icon name="edit" size={13} /></button>
                      <button class="icon-btn !p-1" use:tip={'Delete'} onclick={() => (confirming = s.id)}><Icon name="trash" size={13} /></button>
                    {:else}
                      <button class="icon-btn !p-1" use:tip={'Discard draft'} onclick={() => app.discardDraft('')}><Icon name="trash" size={13} /></button>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <p class="px-3 pt-8 text-center text-[13px] text-muted" in:fade>{query ? 'Nothing matches.' : 'Your chats will show up here.'}</p>
      {/each}
    </nav>

    <div class="flex items-center gap-1 px-2 py-2">
      <button
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-2 transition-colors hover:bg-hover hover:text-fg"
        onclick={() => (app.settingsOpen = true)}
      >
        <Icon name="settings" size={13} /> Settings
      </button>
      <div class="ml-auto"><UpdateButton /></div>
      <div class="flex rounded-md bg-hover/60 p-0.5" role="radiogroup" aria-label="Theme">
        {#each themes as t (t.id)}
          <button
            role="radio"
            aria-checked={theme.pref === t.id}
            use:tip={t.label}
            class="grid size-6 place-items-center rounded-sm transition-colors {theme.pref === t.id ? 'bg-surface text-fg shadow-[0_1px_2px_#0000001a]' : 'text-muted hover:text-fg'}"
            onclick={() => theme.set(t.id)}
          >
            <Icon name={t.icon} size={13} />
          </button>
        {/each}
      </div>
    </div>
  </div>
</aside>

{#if !app.sidebarOpen}
  <!-- A notch curved out of the chat's top-left corner, mirroring the one on the right. -->
  <svg class="pointer-events-none fixed top-0 left-0 z-30" width="104" height="49" aria-hidden="true" in:fade={{ duration: 180 }}>
    <path d="M104 0V14.5C88 14.5 88 47.5 72 47.5H0V0Z" fill="var(--side)" />
    <path d="M104 14.5C88 14.5 88 47.5 72 47.5H0" fill="none" stroke="var(--line)" />
  </svg>
  <div class="fixed top-2 left-2 z-30 flex items-center gap-0.5 rounded-lg p-1" in:fade={{ duration: 180 }}>
    <button class="icon-btn" use:tip={{ text: 'Show sidebar', kbd: shortcut('B') }} onclick={() => (app.sidebarOpen = true)}>
      <Icon name="sidebar" size={17} />
    </button>
    <button class="icon-btn" use:tip={{ text: 'New chat', kbd: shortcut('N') }} onclick={() => app.newSession()}>
      <Icon name="compose" size={17} />
    </button>
  </div>
{/if}
