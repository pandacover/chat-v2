<script lang="ts">
  import { flip } from 'svelte/animate'
  import type { Session } from '@shared/types'
  import { ease, fade, fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import Icon, { type IconName } from './Icon.svelte'

  let query = $state('')
  let renaming = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  let draft = $state('')

  const DAY = 24 * 60 * 60 * 1000

  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const list = q ? app.sessions.filter((s) => s.title.toLowerCase().includes(q)) : app.sessions
    const today = new Date().setHours(0, 0, 0, 0)
    const buckets: Array<[string, Session[]]> = [
      ['Today', []],
      ['Yesterday', []],
      ['This week', []],
      ['Earlier', []]
    ]
    for (const s of list) {
      const i = s.updatedAt >= today ? 0 : s.updatedAt >= today - DAY ? 1 : s.updatedAt >= today - 7 * DAY ? 2 : 3
      buckets[i]![1].push(s)
    }
    return buckets.filter(([, items]) => items.length > 0)
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
</script>

<aside
  class="flex h-full shrink-0 flex-col overflow-hidden bg-side transition-[width] duration-200 ease-out"
  style="width: {app.sidebarOpen ? 252 : 0}px"
  inert={!app.sidebarOpen}
>
  <div class="flex h-full w-[252px] flex-col">
    <div class="flex h-12 items-center gap-1 pr-2 pl-4">
      <span class="font-serif text-[17px] tracking-tight italic">chat</span>
      <span class="ml-auto"></span>
      <button class="icon-btn" title="Hide sidebar (Ctrl+B)" onclick={() => (app.sidebarOpen = false)}>
        <Icon name="sidebar" size={17} />
      </button>
      <button class="icon-btn" title="New chat (Ctrl+N)" onclick={() => app.newSession()}>
        <Icon name="compose" size={17} />
      </button>
    </div>

    <label class="mx-2 mb-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted transition-colors focus-within:bg-surface focus-within:text-fg">
      <Icon name="search" size={14} />
      <input bind:value={query} placeholder="Search" class="w-full bg-transparent text-[13px] outline-none placeholder:text-muted" />
      {#if query}
        <button class="text-muted hover:text-fg" title="Clear" onclick={() => (query = '')}><Icon name="x" size={13} /></button>
      {/if}
    </label>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {#each groups as [label, items] (label)}
        <div class="px-2.5 pt-5 pb-1.5 text-[11.5px] text-muted">{label}</div>
        <div class="flex flex-col gap-1">
        {#each items as s (s.id)}
          {@const active = app.view?.session.id === s.id}
          <div
            animate:flip={{ duration: 200, easing: ease }}
            class="group relative flex h-9 items-center rounded-md text-[13px] transition-colors {active
              ? 'bg-surface text-fg shadow-[0_1px_0_var(--line)]'
              : 'text-fg-2 hover:bg-hover hover:text-fg'}"
          >
            {#if renaming === s.id}
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
            {:else if confirming === s.id}
              <div class="flex w-full items-center gap-1 pr-1 pl-2.5" in:fade={{ duration: 120 }}>
                <span class="min-w-0 flex-1 truncate text-fg">Delete this chat?</span>
                <button class="rounded-sm px-1.5 py-0.5 text-[12px] text-muted hover:text-fg" onclick={() => (confirming = null)}>Keep</button>
                <button class="rounded-sm px-1.5 py-0.5 text-[12px] font-medium text-danger hover:bg-hover" onclick={() => app.remove(s.id)}>Delete</button>
              </div>
            {:else}
              <button
                class="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left"
                onclick={() => app.open(s.id)}
                ondblclick={() => startRename(s)}
              >
                {#if s.forkedFromSessionId}<span class="text-muted" title="Forked chat"><Icon name="branch" size={12} /></span>{/if}
                <span class="truncate">{s.title}</span>
              </button>
              <div class="flex shrink-0 items-center pr-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                <button class="icon-btn !p-1" title="Rename" onclick={() => startRename(s)}><Icon name="edit" size={13} /></button>
                <button class="icon-btn !p-1" title="Delete" onclick={() => (confirming = s.id)}><Icon name="trash" size={13} /></button>
              </div>
            {/if}
          </div>
        {/each}
        </div>
      {:else}
        <p class="px-3 pt-8 text-center text-[13px] text-muted" in:fade>{query ? 'Nothing matches.' : 'Your chats will show up here.'}</p>
      {/each}
    </nav>

    <div class="flex items-center gap-1 px-2 py-2">
      <button
        class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-fg-2 transition-colors hover:bg-hover hover:text-fg"
        onclick={() => (app.settingsOpen = true)}
      >
        <Icon name="settings" size={15} /> Settings
      </button>
      <div class="ml-auto flex rounded-md bg-hover/60 p-0.5" role="radiogroup" aria-label="Theme">
        {#each themes as t (t.id)}
          <button
            role="radio"
            aria-checked={theme.pref === t.id}
            title={t.label}
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
  <button
    class="icon-btn fixed top-2.5 left-2.5 z-30"
    title="Show sidebar (Ctrl+B)"
    in:fly={{ x: -6, duration: 180 }}
    onclick={() => (app.sidebarOpen = true)}
  >
    <Icon name="sidebar" size={17} />
  </button>
{/if}
