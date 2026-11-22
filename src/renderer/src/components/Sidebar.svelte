<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { untrack } from 'svelte'
  import type { Bot, Session } from '@shared/types'
  import { openBotSettings } from '@/lib/settingsNav'
  import { entries, NEED_LABELS, openEntry, sections, type Entry, type Need } from '@/lib/chats.svelte'
  import type { Section } from '@/lib/sections'
  import { fade } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import BarTitle from './BarTitle.svelte'
  import BotAvatar, { PRESENCE_LABELS } from './BotAvatar.svelte'
  import Icon, { type IconName } from './Icon.svelte'
  import UpdateButton from './UpdateButton.svelte'
  import UsageMeter from './UsageMeter.svelte'

  /** What the bar keeps free at its right end for its actions (BarActions: up to four buttons). */
  const BAR_ACTIONS_ROOM = 160

  let renaming = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  let draft = $state('')

  /** Pinned jobs; the jobs that need you (no label); then, at the foot, Working and Settled. */
  const all = $derived(entries())
  const parts = $derived(sections(all))

  /** A bot in the roster opens its latest thread of its own; the primary, its conversation. */
  const openBot = (b: Bot) => {
    if (b.isPrimary) return void app.openPrimary()
    const thread = app.latestThreadOf(b.id)
    if (thread) void app.open(thread.id)
    else openBotSettings(b.id)
  }

  // Which sections are open, kept across launches. All but the main one start shut.
  type Folding = Exclude<Section, 'main'>
  const OPEN_KEY = 'tomo:sidebar-sections'
  localStorage.removeItem('chat-v2:collapsed-groups')
  const readOpen = (): Record<Folding, boolean> => {
    try {
      const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Partial<Record<Folding, unknown>>
      return { pinned: raw.pinned === true, working: raw.working === true, settled: raw.settled === true }
    } catch {
      return { pinned: false, working: false, settled: false }
    }
  }
  const unfolded = $state(readOpen())
  const toggle = (id: Folding) => {
    unfolded[id] = !unfolded[id]
    localStorage.setItem(OPEN_KEY, JSON.stringify(unfolded))
  }

  type Row = { key: string; entry: Entry; need: Need | null }
  /** What a row shows: a row that shows the same keeps its object, so the list below doesn't redraw it. */
  const sameRow = (a: Row, b: Row) =>
    a.need === b.need &&
    a.entry.draft === b.entry.draft &&
    a.entry.title === b.entry.title &&
    a.entry.job.status === b.entry.job.status &&
    a.entry.job.summary === b.entry.job.summary &&
    a.entry.job.ownerBotId === b.entry.job.ownerBotId &&
    a.entry.job.parentJobId === b.entry.job.parentJobId &&
    a.entry.session.pinnedAt === b.entry.session.pinnedAt &&
    a.entry.session.forkedFromSessionId === b.entry.session.forkedFromSessionId
  /**
   * The lists are worked out again whenever anything they read changes (a keystroke in a draft,
   * the open chat, a refreshed chat list), but each new array makes the keyed lists below measure
   * every row for its glide, which with hundreds of chats forced a layout of the whole window on
   * every key and chat switch. Unchanged rows keep their objects, and an unchanged list its array.
   */
  let last: Record<Section, Row[]> = { pinned: [], main: [], working: [], settled: [] }
  const keep = (id: Section, list: Entry[]): Row[] => {
    const before = new Map(last[id].map((r) => [r.key, r]))
    const out = list.map((entry): Row => {
      const row = { key: `chat:${entry.key}`, entry, need: parts.needs.get(entry.key) ?? null }
      const prev = before.get(row.key)
      return prev && sameRow(prev, row) ? prev : row
    })
    const prev = last[id]
    return (last[id] = out.length === prev.length && out.every((r, i) => r === prev[i]) ? prev : out)
  }
  const pinnedRows = $derived(keep('pinned', parts.pinned))
  const mainRows = $derived(keep('main', parts.main))
  const workingRows = $derived(keep('working', parts.working))
  const settledRows = $derived(keep('settled', parts.settled))
  const allRows = () => [pinnedRows, mainRows, workingRows, settledRows]

  /*
   * Rows glide to their new places when a list changes (FLIP), by hand: Svelte's animate:flip
   * measured every row on every pass over the list, and while a glide was still running each
   * measure forced a layout of the window, row by row. That restarted every row's glide, so
   * typing a new chat's first words took seconds a key. Here positions are read for all rows
   * first and written after, only when the rows really change, and only rows in view move.
   */
  let side: HTMLElement | undefined = $state()
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let tops = new Map<string, number>()
  const lists = () => [...(side?.querySelectorAll<HTMLElement>('[data-list]') ?? [])]
  const rowTops = () => {
    const out = new Map<string, number>()
    for (const list of lists())
      for (const el of list.children) {
        const key = (el as HTMLElement).dataset.row
        if (key) out.set(`${list.dataset.list}/${key}`, (el as HTMLElement).offsetTop)
      }
    return out
  }
  $effect.pre(() => {
    void allRows()
    tops = untrack(rowTops)
  })
  $effect(() => {
    void allRows()
    void [unfolded.pinned, unfolded.working, unfolded.settled]
    if (reduceMotion.matches) return
    const before = tops
    const after = rowTops()
    for (const list of lists()) {
      const top = list.scrollTop - 40
      const bottom = list.scrollTop + list.clientHeight + 40
      for (const child of list.children) {
        const row = child as HTMLElement
        const key = row.dataset.row === undefined ? undefined : `${list.dataset.list}/${row.dataset.row}`
        const from = key === undefined ? undefined : before.get(key)
        const to = key === undefined ? undefined : after.get(key)
        if (from === undefined || to === undefined || from === to) continue
        if (Math.max(from, to) < top || Math.min(from, to) > bottom) continue
        row.animate([{ transform: `translateY(${from - to}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      }
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

<!-- A section's label, as the old group labels were, with its count and a chevron that turns as it folds. -->
{#snippet head(id: Folding, label: string, count: number)}
  <button
    class="group/label mono-label flex shrink-0 items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 whitespace-nowrap transition-colors hover:text-fg"
    aria-expanded={unfolded[id]}
    data-row="section:{id}"
    onclick={() => toggle(id)}
  >
    {label}<span class="text-fg-4 tabular-nums" data-count>{count}</span>
    <Icon
      name="chevronDown"
      size={12}
      class="-ml-0.5 transition-[transform,opacity] duration-200 {unfolded[id] ? 'opacity-0 group-hover/label:opacity-100 group-focus-visible/label:opacity-100' : '-rotate-90'}"
    />
  </button>
{/snippet}

{#snippet list(id: Section, items: Row[])}
  <div class="relative -mx-1 min-h-0 overflow-y-auto px-1 pb-1 [scrollbar-width:none]" data-list={id}>
    {#each items as row (row.key)}
      <!-- A row that goes leaves at once, so the rows after it glide up in its place. -->
      <div class="row mt-[3px]" data-row={row.key} data-need={row.need ?? undefined} in:fade={{ duration: 120 }}>
        {@render item(row)}
      </div>
    {/each}
  </div>
{/snippet}

{#snippet item({ entry: e, need }: Row)}
  {@const s = e.session}
  {@const active = (app.view?.session.id ?? '') === e.key || (!!app.view && app.view.session.id === app.ownThreadOf(e.job)?.id)}
  {@const owner = app.team ? (app.bots.find((b) => b.id === e.job.ownerBotId) ?? app.primaryBot) : null}
  <div class="chat-row group relative">
    {#if renaming === s.id}
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
    {:else if confirming === s.id}
      <div class="nav-item on !pr-1" in:fade={{ duration: 120 }}>
        <span class="min-w-0 flex-1 truncate text-fg">Delete this job?</span>
        <button class="btn quiet sm !h-6 !px-2" onclick={() => (confirming = null)}>Keep</button>
        <button class="btn quiet sm !h-6 !px-2 !text-danger" onclick={() => app.removeJob(e.job.id)}>Delete</button>
      </div>
    {:else}
      <button class="nav-item !gap-2 {active ? 'on' : ''}" use:tip={e.job.summary ?? null} onclick={() => openEntry(e)} ondblclick={() => startRename(s)}>
        {#if owner}<span class="grid shrink-0 place-items-center" use:tip={owner.name} data-row-owner={owner.name}><BotAvatar bot={owner} size={16} /></span>{/if}
        {#if e.draft}<span class="grid shrink-0 place-items-center text-blue" use:tip={'Unsent draft'}><Icon name="pen" size={13} /></span>{/if}
        {#if e.job.parentJobId || s.forkedFromSessionId}
          {@const parent = app.jobs.find((x) => x.id === e.job.parentJobId)}
          <span class="grid shrink-0 place-items-center text-fg-3" use:tip={parent ? `Forked from “${parent.title}”` : 'Forked job'}><Icon name="branch" size={13} /></span>
        {/if}
        <span class="min-w-0 flex-1 truncate text-left">{e.title}</span>
        {#if need === 'waiting'}
          {@const label = app.computerWait?.kind === 'teach' ? 'A step waits for you' : NEED_LABELS.waiting}
          <span class="size-2 shrink-0 rounded-full bg-danger" role="status" aria-label={label} use:tip={label} data-wait-badge></span>
        {:else if need === 'paused' || need === 'failed'}
          <span class="grid shrink-0 place-items-center {need === 'failed' ? 'text-danger' : 'text-fg-3'}" role="status" aria-label={NEED_LABELS[need]} use:tip={need === 'failed' ? 'The last reply failed' : 'Paused: waiting for you to continue'}>
            <Icon name="alert" size={13} />
          </span>
        {:else if need === 'unread'}
          <span class="size-2 shrink-0 rounded-full bg-blue" role="status" aria-label={NEED_LABELS.unread} use:tip={'New since you last looked'} data-unread-badge></span>
        {/if}
      </button>
      <!-- Over the title rather than beside it, so the title runs to the row's edge; it fades out under the actions. -->
      <div class="acts pointer-events-none absolute top-1 right-1 flex rounded-r-lg pl-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 {active ? 'on' : ''}">
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
      </div>
    {/if}
  </div>
{/snippet}

<!-- One spot for the sidebar toggle, open or closed, so a second click lands on it: in the app bar,
     after a Mac's traffic lights. Nothing marked app-drag may come after it over the same spot, or
     the window takes the click for a drag. -->
<div
  class="app-no-drag bar-controls fixed top-0.5 z-[45] flex min-w-0 gap-0.5"
  style="left: calc(var(--bar-left) + 10px); max-width: calc(100vw - var(--bar-left) - var(--bar-right) - {BAR_ACTIONS_ROOM}px)"
>
  <button
    class="icon-btn size-8"
    data-sidebar-toggle
    use:tip={{ text: app.sidebarOpen ? 'Hide sidebar' : 'Show sidebar', kbd: shortcut('B') }}
    onclick={() => (app.sidebarOpen = !app.sidebarOpen)}
  >
    <Icon name="sidebar" size={16} />
  </button>
  {#if !app.sidebarOpen}
    <button class="icon-btn size-8" data-new-topic use:tip={{ text: 'New topic', kbd: shortcut('N') }} onclick={() => app.newSession()} in:fade={{ duration: 160 }}>
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
    <!-- And the job, in a job's thread: Tomo › Cat page. -->
    <BarTitle after={!!app.currentBot} />
  {/if}
</div>
{#if app.sidebarOpen}
  <!-- The job's title over the left edge of the chat, where its header was. -->
  <div class="fixed top-0.5 z-[45] flex min-w-0" style="left: {app.sidebarWidth + 20}px; right: calc(var(--bar-right) + {BAR_ACTIONS_ROOM}px)">
    <BarTitle />
  </div>
{/if}

<aside
  bind:this={side}
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
        <button class="icon-btn size-[26px] !rounded-lg" data-new-topic use:tip={{ text: 'New topic', kbd: shortcut('N') }} onclick={() => app.newSession()}><Icon name="compose" size={14} /></button>
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

    {#if pinnedRows.length}
      <div class="section mt-3 max-h-[40%]" data-section="pinned">
        {@render head('pinned', 'Pinned', pinnedRows.length)}
        {#if unfolded.pinned}{@render list('pinned', pinnedRows)}{/if}
      </div>
    {/if}

    <!-- The jobs that need you: no label, and all the room the others leave. -->
    <div class="relative -mx-1 mt-2 flex min-h-0 flex-1 flex-col px-1" data-section="main">
      {#if all.length === 0}
        <p class="px-2.5 py-6 text-[13px] text-fg-3" in:fade>Your jobs will show up here. Tell {app.primaryBot?.name ?? 'Tomo'} what you're working on.</p>
      {:else if mainRows.length === 0}
        <p class="px-2.5 py-2 text-[13px] text-fg-4" data-nothing-needs-you in:fade={{ duration: 120 }}>Nothing needs you</p>
      {:else}
        {@render list('main', mainRows)}
      {/if}
    </div>

    <!-- At the foot, above the limit card; open, each grows upward and scrolls in itself. -->
    {#if workingRows.length}
      <div class="section mt-1 {unfolded.working ? 'max-h-[45%]' : ''}" data-section="working" in:fade={{ duration: 120 }}>
        {@render head('working', 'Working', workingRows.length)}
        {#if unfolded.working}{@render list('working', workingRows)}{/if}
      </div>
    {/if}
    {#if settledRows.length}
      <div class="section mt-1 mb-2 {unfolded.settled ? 'max-h-[45%]' : ''}" data-section="settled">
        {@render head('settled', 'Settled', settledRows.length)}
        {#if unfolded.settled}{@render list('settled', settledRows)}{/if}
      </div>
    {/if}

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
  /* A section folds to its label; open, it takes what its max-height allows and its list scrolls. */
  .section {
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: 0;
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
