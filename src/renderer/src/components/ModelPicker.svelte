<script lang="ts">
  import { tick } from 'svelte'
  import { MODELS, modelName } from '@shared/models'
  import { pop } from '@/lib/motion'
  import Icon from './Icon.svelte'

  let {
    value,
    onchange,
    block = false,
    placement = 'down',
    noneLabel
  }: {
    value: string
    onchange: (id: string) => void
    block?: boolean
    placement?: 'up' | 'down'
    /** Offers an empty choice with this label (value ''). */
    noneLabel?: string
  } = $props()

  const choices = $derived([...(noneLabel ? [{ id: '', name: noneLabel, note: '' }] : []), ...MODELS])
  const label = $derived(value === '' && noneLabel ? noneLabel : modelName(value))

  let open = $state(false)
  let cursor = $state(0)
  let root: HTMLDivElement | undefined = $state()
  let list: HTMLUListElement | undefined = $state()

  const pick = (id: string) => {
    onchange(id)
    open = false
  }

  const toggle = async () => {
    open = !open
    cursor = Math.max(0, choices.findIndex((m) => m.id === value))
    await tick()
    list?.focus()
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      cursor = Math.min(choices.length - 1, Math.max(0, cursor + (e.key === 'ArrowDown' ? 1 : -1)))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const m = choices[cursor]
      if (m) pick(m.id)
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
    class="flex max-w-full items-center gap-1.5 text-[13px] font-medium transition-colors {block
      ? 'h-8 rounded-[10px] bg-card pr-2.5 pl-3 shadow-[inset_0_0_0_1px_var(--line)] hover:bg-wash'
      : 'h-[30px] rounded-full pr-2 pl-2.5 text-fg-2 hover:bg-wash'} {open ? 'bg-wash text-fg' : ''}"
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    <span class="truncate {block ? 'text-fg' : ''}">{label}</span>
    <Icon name="chevronDown" size={14} class="text-fg-4 transition-transform duration-200 {open ? 'rotate-180' : ''} {block ? 'ml-auto' : ''}" />
  </button>

  {#if open}
    <div
      class="absolute z-50 w-[300px] max-w-[80vw] overflow-hidden {placement === 'up' ? 'bottom-full mb-2 origin-bottom-right' : 'top-full mt-2 origin-top-right'} glass-float rounded-[14px] {block
        ? 'left-0'
        : 'right-0'}"
      transition:pop={{ duration: 150 }}
    >
      <ul bind:this={list} class="p-1 outline-none" role="listbox" tabindex="-1" {onkeydown}>
        {#each choices as m, i (m.id)}
          <li role="option" aria-selected={m.id === value}>
            <button
              type="button"
              tabindex="-1"
              class="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left {i === cursor ? 'bg-wash' : ''}"
              onmouseenter={() => (cursor = i)}
              onclick={() => pick(m.id)}
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13.5px] font-medium {m.id ? 'text-fg' : 'text-fg-2'}">{m.name}</span>
                {#if m.note}<span class="block truncate text-[12px] text-fg-3">{m.note}</span>{/if}
              </span>
              <Icon name="check" size={15} class={m.id === value ? 'text-fg' : 'opacity-0'} />
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
