<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { tick } from 'svelte'
  import type { ModelInfo } from '@shared/types'
  import { pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'
  import { priceDetail, priceLine } from '@/lib/pricing'

  let {
    value,
    onchange,
    block = false,
    placement = 'down',
    filter,
    noneLabel
  }: {
    value: string
    onchange: (id: string) => void
    block?: boolean
    placement?: 'up' | 'down'
    /** Limits the list, e.g. to models that accept images. */
    filter?: (m: ModelInfo) => boolean
    /** Offers an empty choice with this label (value ''). */
    noneLabel?: string
  } = $props()

  let open = $state(false)
  let query = $state('')
  let cursor = $state(0)
  let root: HTMLDivElement | undefined = $state()
  let list: HTMLUListElement | undefined = $state()

  const split = (id: string, name: string) => {
    const provider = id.includes('/') ? id.split('/')[0]! : ''
    // OpenRouter names look like "Anthropic: Claude Sonnet"; drop the repeated vendor.
    const label = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : name
    return { provider, label }
  }

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const pool = filter ? app.models.filter(filter) : app.models
    const list = q ? pool.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : pool
    return list.slice(0, 100)
  })

  const current = $derived.by(() => {
    if (!value && noneLabel) return { provider: '', label: noneLabel }
    const m = app.models.find((m) => m.id === value)
    return split(value, m?.name ?? value.split('/').pop() ?? value)
  })

  const selectedPrice = $derived.by(() => {
    const m = app.models.find((m) => m.id === value)
    return m ? `${m.name}: ${priceDetail(m)}` : null
  })

  const pick = (id: string) => {
    onchange(id)
    open = false
    query = ''
  }

  const toggle = async () => {
    open = !open
    cursor = Math.max(0, results.findIndex((m) => m.id === value))
    if (open && app.models.length === 0) void app.loadModels()
    await tick()
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  const onkeydown = async (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      cursor = Math.min(results.length - 1, Math.max(0, cursor + (e.key === 'ArrowDown' ? 1 : -1)))
      await tick()
      list?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      const m = results[cursor]
      if (m) pick(m.id)
      else if (query.includes('/')) pick(query.trim())
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      open = false
    }
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) open = false
  }}
/>

<div class="relative {block ? 'w-full' : 'min-w-0'}" bind:this={root} data-model-picker>
  <button
    type="button"
    class="flex max-w-full items-center gap-1.5 rounded-md text-[13px] transition-colors {block
      ? 'h-9 w-full bg-bg px-3 hover:bg-hover'
      : 'h-8 px-2.5 text-fg-2 hover:bg-hover hover:text-fg'} {open ? 'bg-hover text-fg' : ''}"
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={open}
    use:tip={open ? null : selectedPrice}
  >
    <!-- Inline (in the composer) the provider gives way first when space runs short. -->
    {#if current.provider}
      {@const narrow = block ? '' : 'hidden @md:inline'}
      <span class="text-muted {narrow}">{current.provider}</span><span class="text-muted/60 {narrow}">/</span>
    {/if}
    <span class="truncate text-fg">{current.label}</span>
    <Icon name="chevronDown" size={13} class="text-muted transition-transform duration-150 {open ? 'rotate-180' : ''} {block ? 'ml-auto' : ''}" />
  </button>

  {#if open}
    <div
      class="absolute z-50 w-[420px] max-w-[80vw] overflow-hidden {placement === 'up' ? 'bottom-full mb-1.5 origin-bottom-right' : 'top-full mt-1.5 origin-top-right'} rounded-lg bg-surface shadow-[0_0_0_1px_var(--line),var(--shadow)] {block
        ? 'left-0'
        : 'right-0'}"
      transition:pop={{ duration: 150 }}
    >
      <div class="flex items-center gap-2 px-3 py-2.5 text-muted shadow-[0_1px_0_var(--line)]">
        <Icon name="search" size={14} />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={query}
          oninput={() => (cursor = 0)}
          {onkeydown}
          placeholder="Search models"
          class="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-muted"
        />
      </div>
      <ul bind:this={list} class="max-h-80 overflow-y-auto p-1" role="listbox">
        {#if noneLabel && !query.trim()}
          <li role="option" aria-selected={value === ''}>
            <button type="button" class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-fg-2 hover:bg-hover" onclick={() => pick('')}>
              <span class="flex-1">{noneLabel}</span>
              <Icon name="check" size={13} class={value === '' ? 'text-fg' : 'opacity-0'} />
            </button>
          </li>
        {/if}
        {#each results as m, i (m.id)}
          {@const s = split(m.id, m.name)}
          <li role="option" aria-selected={m.id === value} data-cursor={i === cursor}>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] {i === cursor ? 'bg-hover' : ''}"
              onmouseenter={() => (cursor = i)}
              onclick={() => pick(m.id)}
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate"><span class="text-fg">{s.label}</span><span class="ml-1 text-muted">{s.provider}</span></span>
                <span class="block truncate text-[11.5px] text-muted tabular-nums" use:tip={priceDetail(m)}>{priceLine(m)}</span>
              </span>
              {#if m.supportsTools}<span class="text-[11px] text-muted" use:tip={'Can use tools, including the browser'}>tools</span>{/if}
              {#if m.inputModalities.includes('image')}<span class="text-[11px] text-muted" use:tip={'Accepts images'}>img</span>{/if}
              {#if m.inputModalities.includes('file')}<span class="text-[11px] text-muted" use:tip={'Reads files natively'}>pdf</span>{/if}
              {#if m.contextLength}<span class="w-10 text-right text-[11px] text-muted tabular-nums">{m.contextLength >= 1e6 ? `${Math.round(m.contextLength / 1e6)}M` : `${Math.round(m.contextLength / 1000)}k`}</span>{/if}
              <Icon name="check" size={13} class={m.id === value ? 'text-fg' : 'opacity-0'} />
            </button>
          </li>
        {:else}
          <li class="px-3 py-3 text-[13px] text-muted">
            {#if app.modelsError}
              {app.modelsError}
            {:else if app.models.length === 0}
              <span class="thinking">Loading models</span>
            {:else if query.includes('/')}
              Press Enter to use <span class="text-fg">{query.trim()}</span>
            {:else}
              No models match.
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
