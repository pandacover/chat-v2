<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { Bot, Session } from '@shared/types'
  import { openBotSettings } from '@/lib/settingsNav'
  import { draftTitle, entries, grouped, openEntry, type Entry } from '@/lib/chats.svelte'
  import { fade } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import BotAvatar, { PRESENCE_LABELS } from './BotAvatar.svelte'
  import Icon, { type IconName } from './Icon.svelte'
  import UpdateButton from './UpdateButton.svelte'
  import UsageMeter from './UsageMeter.svelte'

  let renaming = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  let draft = $state('')

  // Drafts first, then pinned jobs, then open ones (by owner, with several bots), then finished ones by day.
  const groups = $derived(grouped(entries()))

  /** The job an approval waits in (its shared thread or a bot's own thread on it): its row gets a badge. */
  const waitJob = $derived.by(() => {
    const w = app.computerWait
    return w ? (app.sessions.find((s) => s.id === w.sessionId)?.jobId ?? null) : null
  })

  /** A bot in the roster opens its latest thread of its own; the primary, its conversation. */
  const openBot = (b: Bot) => {
    if (b.isPrimary) return void app.openPrimary()
    const thread = app.latestThreadOf(b.id)
    if (thread) void app.open(thread.id)
    else openBotSettings(b.id)
  }

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
  /**
   * What a row shows. The new chat's title isn't here: its row reads it as you type, so typing
   * doesn't make a new list.
   */
  const sameRow = (a: Row, b: Row) =>
    a.entry && b.entry
      ? a.entry.draft === b.entry.draft &&
        (a.entry.session === null
          ? b.entry.session === null
          : b.entry.session !== null &&
            a.entry.title === b.entry.title &&
            a.entry.job.status === b.entry.job.status &&
            a.entry.job.summary === b.entry.job.summary &&
            a.entry.session.pinnedAt === b.entry.session.pinnedAt &&
            a.entry.session.forkedFromSessionId === b.entry.session.forkedFromSessionId)
      : !a.entry && !b.entry && a.open === b.open
  /**
   * The list is worked out again whenever anything it reads changes (a keystroke in a draft, the
   * open chat, a refreshed chat list), but each new array makes the keyed list below measure every
   * row for its flip, which with hundreds of chats forced a layout of the whole window on every
   * key and chat switch. Unchanged rows keep their objects, and an unchanged list its array.
   */
  let lastRows: Row[] = []
  const rows = $derived.by(() => {
    const before = new Map(lastRows.map((r) => [r.key, r]))
    const out: Row[] = []
    const add = (row: Row) => {
      const prev = before.get(row.key)
      out.push(prev && sameRow(prev, row) ? prev : row)
    }
    for (const [label, items] of groups) {
      const open = !collapsed.has(label)
      add({ key: `group:${label}`, label, open })
      if (open) for (const e of items) add({ key: `chat:${e.key}`, entry: e })
    }
    if (out.length === lastRows.length && out.every((r, i) => r === lastRows[i])) return lastRows
    return (lastRows = out)
  })

  /*
   * Rows glide to their new places when the list changes (FLIP), by hand: Svelte's animate:flip
   * measured every row on every pass over the list, and while a glide was still running each
   * measure forced a layout of the window, row by row. That restarted every row's glide, so
   * typing a new chat's first words took seconds a key. Here positions are read for all rows
   * first and written after, only when the rows really change, and only rows in view move.
   */
  let nav: HTMLElement | undefined = $state()
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let tops = new Map<string, number>()
  const rowTops = () => {
    const out = new Map<string, number>()
    for (const el of nav?.children ?? []) {
      const key = (el as HTMLElement).dataset.row
      if (key) out.set(key, (el as HTMLElement).offsetTop)
    }
    return out
  }
  $effect.pre(() => {
    void rows
    tops = untrack(rowTops)
  })
  $effect(() => {
    void rows
    const el = nav
    if (!el || reduceMotion.matches) return
    const before = tops
    const after = rowTops()
    const top = el.scrollTop - 40
    const bottom = el.scrollTop + el.clientHeight + 40
    for (const child of el.children) {
      const row = child as HTMLElement
      const key = row.dataset.row
      const from = key === undefined ? undefined : before.get(key)
      const to = key === undefined ? undefined : after.get(key)
      if (from === undefined || to === undefined || from === to) continue
      if (Math.max(from, to) < top || Math.min(from, to) > bottom) continue
      row.animate([{ transform: `translateY(${from - to}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
    }
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

<!-- One spot for the sidebar toggle, open or closed, so a second click lands on it: in the app bar,
     after a Mac's traffic lights. Nothing marked app-drag may come after it over the same spot, or
     the window takes the click for a drag. -->
<div class="app-no-drag fixed top-0.5 z-[45] flex gap-0.5" style="left: calc(var(--bar-left) + 10px)">
  <button
    class="icon-btn size-8"
    data-sidebar-toggle
    use:tip={{ text: app.sidebarOpen ? 'Hide sidebar' : 'Show sidebar', kbd: shortcut('B') }}
    onclick={() => (app.sidebarOpen = !app.sidebarOpen)}
  >
    <Icon name="sidebar" size={16} />
  </button>
  {#if !app.sidebarOpen}
    <button class="icon-btn size-8" use:tip={{ text: 'New topic', kbd: shortcut('N') }} onclick={() => app.newSession()} in:fade={{ duration: 160 }}>
      <Icon name="compose" size={16} />
    </button>
    <!-- Whose conversation is open, while the sidebar that shows it is shut. Part of the bar: it
         moves the window like the rest of it. -->
    {#if app.currentBot}
      {@const bot = app.currentBot}
      <span class="app-drag ml-1.5 flex h-8 min-w-0 items-center gap-2 pr-2 select-none" data-bar-bot in:fade={{ duration: 160 }}>
        <BotAvatar {bot} size={20} presence={app.presence[bot.id] ?? null} />
        <span class="truncate text-[13.5px] font-medium" data-bar-bot-name>{bot.name}</span>
      </span>
    {/if}
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
    class="absolute right-0 bottom-0 z-10 w-2 cursor-col-resize"
    style="top: var(--card-top)"
    use:tip={'Drag to resize · double-click to reset'}
    onpointerdown={startResize}
    ondblclick={() => setWidth(DEFAULT_WIDTH)}
  ></div>

  <!-- Below the app bar, level with the cards' tops. The app's name isn't repeated here: Tomo, the
       row below, is already its name. -->
  <div class="flex h-full flex-col gap-0.5 px-2.5 pb-2.5" style="width: {app.sidebarWidth}px; padding-top: var(--card-top)">

    <!-- The primary bot's conversation: everything said without picking a job goes here. -->
    <div class="chat-row group relative">
      <button class="nav-item !gap-2.5 {app.isPrimary ? 'on' : ''}" data-primary-entry onclick={() => app.openPrimary()}>
        <BotAvatar bot={app.primaryBot} size={20} />
        <span class="min-w-0 flex-1 truncate font-medium">{app.primaryBot?.name ?? 'Tomo'}</span>
        {#if app.isPrimary ? app.hasDraft(app.view?.session.id ?? '') : false}<span class="grid shrink-0 place-items-center text-blue" use:tip={'Unsent draft'}><Icon name="pen" size={13} /></span>{/if}
      </button>
      <div class="acts pointer-events-none absolute top-1 right-1 flex rounded-r-lg pl-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 {app.isPrimary ? 'on' : ''}">
        <button class="icon-btn size-[26px] !rounded-lg" use:tip={{ text: 'New topic', kbd: shortcut('N') }} onclick={() => app.newSession()}><Icon name="compose" size={14} /></button>
      </div>
    </div>
    <button class="nav-item" onclick={() => (app.findOpen = true)}>
      <Icon name="search" size={16} />Search<kbd class="studio-kbd ml-auto">{shortcut('K')}</kbd>
    </button>

    {#if app.team}
      <!-- The roster, once there are several bots: what each is doing. -->
      <div class="shrink-0" data-roster in:fade={{ duration: 160 }}>
        <div class="mono-label mt-3 mb-0.5 px-2.5 py-1.5">Bots</div>
        {#each app.bots as b (b.id)}
          {@const presence = app.presence[b.id] ?? 'idle'}
          {@const open = app.view?.session.kind === 'worker' && app.view.session.botId === b.id}
          <button
            class="nav-item !h-8 !gap-2.5 {open ? 'on' : ''}"
            data-roster-bot={b.name}
            use:tip={b.isPrimary ? `${b.name}'s conversation` : app.latestThreadOf(b.id) ? `${b.name}'s latest thread` : `${b.name} hasn't had a job yet`}
            onclick={() => openBot(b)}
          >
            <BotAvatar bot={b} size={20} {presence} />
            <span class="min-w-0 flex-1 truncate">{b.name}</span>
            {#if presence !== 'idle'}
              <span class="shrink-0 font-label text-[11.5px] {presence === 'waiting' || presence === 'stuck' ? 'text-danger' : 'text-fg-3'}" data-presence-label>{PRESENCE_LABELS[presence]}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <nav bind:this={nav} class="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2 [scrollbar-width:none]">
      {#each rows as row (row.key)}
        <!-- A row that goes leaves at once, so the rows after it glide up in its place. -->
        <div class="row {row.entry ? 'mt-[3px]' : 'head'}" data-row={row.key} in:fade={{ duration: 120 }}>
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
                  <span class="min-w-0 flex-1 truncate text-fg">Delete this job?</span>
                  <button class="btn quiet sm !h-6 !px-2" onclick={() => (confirming = null)}>Keep</button>
                  <button class="btn quiet sm !h-6 !px-2 !text-danger" onclick={() => app.removeJob(e.job.id)}>Delete</button>
                </div>
              {:else}
                <button class="nav-item !gap-2 {active ? 'on' : ''}" use:tip={e.job.summary ?? null} onclick={() => openEntry(e)} ondblclick={() => s && startRename(s)}>
                  {#if e.draft}<span class="grid shrink-0 place-items-center text-blue" use:tip={'Unsent draft'}><Icon name="pen" size={13} /></span>{/if}
                  {#if e.job.parentJobId || s?.forkedFromSessionId}
                    {@const parent = app.jobs.find((x) => x.id === e.job.parentJobId)}
                    <span class="grid shrink-0 place-items-center text-fg-3" use:tip={parent ? `Forked from “${parent.title}”` : 'Forked job'}><Icon name="branch" size={13} /></span>
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-left {s ? '' : 'italic'}">{s ? e.title : draftTitle(app.draftText(''))}</span>
                  {#if waitJob === e.job.id}<span class="size-2 shrink-0 rounded-full bg-danger" role="status" aria-label="Needs your OK" use:tip={'Needs your OK'} data-wait-badge></span>{/if}
                </button>
                <!-- Over the title rather than beside it, so the title runs to the row's edge; it fades out under the actions. -->
                <div class="acts pointer-events-none absolute top-1 right-1 flex rounded-r-lg pl-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 {active ? 'on' : ''}">
                  {#if s}
                    <button class="icon-btn size-[26px] !rounded-lg" use:tip={s.pinnedAt != null ? 'Unpin job' : 'Pin job'} onclick={() => app.pin(s.id, s.pinnedAt == null)}>
                      <Icon name="pin" size={14} class={s.pinnedAt != null ? '' : 'rotate-45'} />
                    </button>
                    <button
                      class="icon-btn size-[26px] !rounded-lg"
                      use:tip={e.job.status === 'open' ? 'Mark finished' : 'Reopen'}
                      onclick={() => app.setJobStatus(e.job.id, e.job.status === 'open' ? 'done' : 'open')}
                    >
                      <Icon name={e.job.status === 'open' ? 'check' : 'undo'} size={14} />
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
        <p class="px-2.5 py-6 text-[13px] text-fg-3" in:fade>Your jobs will show up here. Tell {app.primaryBot?.name ?? 'Tomo'} what you're working on.</p>
      {/each}
    </nav>

    <UsageMeter />
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
  /*
   * A row out of view skips style, layout and paint. With hundreds of chats, anything that touched
   * the whole list (the sidebar's inert switch as it opens and closes, a theme change) restyled
   * thousands of elements in one frame. Rows are a fixed height, so the list's length is right
   * before they are first shown; the margin leaves room for the open row's ring and shadow.
   */
  .row {
    content-visibility: auto;
    contain-intrinsic-block-size: auto 34px;
    overflow-clip-margin: 6px;
  }
  .row.head {
    contain-intrinsic-block-size: auto 40px;
  }
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
  /* Only the buttons take clicks: the fade before them is still the row, which opens the job. */
  .chat-row:hover .acts > button,
  .acts:focus-within > button {
    pointer-events: auto;
  }
  .avatar {
    background: conic-gradient(from 200deg, #ffd29a, #f7a8b8, #a8c5ff, #ffd29a);
    box-shadow: inset 0 0 0 1px var(--ring);
  }
</style>
