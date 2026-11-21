<script lang="ts">
  // Search: a modal over everything, opened from the sidebar or Ctrl K (Cmd K). Empty, it lists the
  // latest jobs; typed, the jobs whose title matches, best first, with the match in bold.
  import { entries, groupOf, openEntry, type Entry } from '@/lib/chats.svelte'
  import { fade, pop } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let query = $state('')
  let sel = $state(0)
  let list: HTMLDivElement | undefined = $state()

  const q = $derived(query.trim().toLowerCase())
  const hits = $derived.by(() => {
    const all = entries()
    if (!q) return all.slice(0, 6)
    return all
      .filter((e) => e.title.toLowerCase().includes(q))
      .sort((a, b) => a.title.toLowerCase().indexOf(q) - b.title.toLowerCase().indexOf(q))
  })
  $effect(() => {
    void q
    sel = 0
  })

  const close = () => (app.findOpen = false)
  const pick = (e: Entry | undefined) => {
    if (!e) return
    close()
    void openEntry(e)
  }

  const parts = (title: string) => {
    const i = q ? title.toLowerCase().indexOf(q) : -1
    return i < 0 ? [title, '', ''] : [title.slice(0, i), title.slice(i, i + q.length), title.slice(i + q.length)]
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      sel = Math.max(0, Math.min(hits.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))
      queueMicrotask(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(hits[sel])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  // Hover moves the selection only when the pointer itself moves: a re-render under a still
  // pointer must not take the selection from the arrow keys.
  let lastPt = [-1, -1]
  const hover = (e: PointerEvent, i: number) => {
    if (e.clientX === lastPt[0] && e.clientY === lastPt[1]) return
    lastPt = [e.clientX, e.clientY]
    sel = i
  }

  const focus = (el: HTMLInputElement) => el.focus()
</script>

<div class="fixed inset-0 z-[55] flex items-start justify-center pt-[14vh]" role="dialog" aria-modal="true" aria-label="Search jobs">
  <button class="absolute inset-0 bg-scrim backdrop-blur-[4px]" aria-label="Close search" tabindex="-1" transition:fade={{ duration: 200 }} onclick={close}></button>
  <div class="glass-strong relative w-[min(620px,90vw)] overflow-hidden rounded-[20px]" transition:pop={{ duration: 220 }}>
    <div class="flex h-14 items-center gap-3 border-b border-line pr-4 pl-[18px] text-fg-3">
      <Icon name="search" size={18} />
      <input
        use:focus
        bind:value={query}
        {onkeydown}
        placeholder="Search jobs"
        autocomplete="off"
        aria-label="Search jobs"
        class="min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-4"
      />
      <kbd class="studio-kbd inline-flex h-[22px] items-center rounded-md px-[7px] shadow-[inset_0_0_0_1px_var(--line)]">Esc</kbd>
    </div>
    <div bind:this={list} class="max-h-[min(400px,56vh)] overflow-y-auto p-1.5" role="listbox" aria-label="Jobs">
      {#if hits.length > 0}
        <span class="mono-label block px-2.5 pt-3 pb-1.5">{q ? 'Jobs' : 'Recent'}</span>
      {:else}
        <div class="px-4 py-7 text-center text-[13.5px] text-fg-3">{q ? 'No job matches.' : 'Your jobs will show up here.'}</div>
      {/if}
      {#each hits as e, i (e.key)}
        {@const [a, m, b] = parts(e.title)}
        <button
          role="option"
          aria-selected={i === sel}
          class="flex h-[42px] w-full items-center gap-3 rounded-[10px] px-2.5 text-left {i > 0 ? 'mt-0.5' : ''} {i === sel ? 'bg-wash text-fg' : 'text-fg-2'}"
          onpointermove={(ev) => hover(ev, i)}
          onclick={() => pick(e)}
        >
          <Icon name={e.draft ? 'pen' : e.session?.forkedFromSessionId ? 'branch' : 'chat'} size={16} class="text-fg-4" />
          <span class="min-w-0 flex-1 truncate {e.session ? '' : 'italic'}">{a}{#if m}<mark class="bg-transparent font-semibold text-fg">{m}</mark>{/if}{b}</span>
          <span class="mono-label shrink-0 !text-fg-4">{groupOf(e) === 'Drafts' ? 'Draft' : groupOf(e)}</span>
        </button>
      {/each}
    </div>
    <div class="flex gap-4 border-t border-line px-[18px] py-2.5 text-[12px] text-fg-4">
      <span><kbd class="studio-kbd mr-1">↑↓</kbd>Move</span>
      <span><kbd class="studio-kbd mr-1">↵</kbd>Open</span>
      <span class="ml-auto"><kbd class="studio-kbd mr-1">{shortcut('K')}</kbd>Search</span>
    </div>
  </div>
</div>
