<script lang="ts">
  import type { Step } from '@shared/steps'
  import { fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let { steps, live = false, running = false }: { steps: Step[]; live?: boolean; running?: boolean } = $props()

  // Long runs collapse to the latest few; the rest is one click away.
  const COLLAPSED = 4
  let expanded = $state(false)
  const hidden = $derived(expanded ? 0 : Math.max(0, steps.length - COLLAPSED))
  const shown = $derived(steps.slice(hidden))
</script>

<div class="flex flex-col gap-0.5 rounded-lg bg-surface px-3 py-2 shadow-[0_0_0_1px_var(--line)]">
  <div class="mb-0.5 flex items-center gap-1.5 text-[12px] text-muted">
    <Icon name="globe" size={12} />
    <span>Browser</span>
    {#if hidden > 0}
      <button class="ml-auto rounded px-1 hover:text-fg" onclick={() => (expanded = true)}>Show {hidden} earlier</button>
    {:else if expanded && steps.length > COLLAPSED}
      <button class="ml-auto rounded px-1 hover:text-fg" onclick={() => (expanded = false)}>Show fewer</button>
    {/if}
  </div>
  {#each shown as step, i (hidden + i)}
    <div class="flex items-start gap-2 py-0.5 text-[13px] leading-snug" in:fly={{ y: 4, duration: live ? 200 : 0 }}>
      <span class="mt-[5px] grid size-3 shrink-0 place-items-center">
        {#if !step.ok}
          <span class="size-1.5 rounded-full bg-danger"></span>
        {:else}
          <span class="size-1.5 rounded-full bg-muted"></span>
        {/if}
      </span>
      <span class="min-w-0 {step.ok ? 'text-fg-2' : 'text-danger'}">
        {step.label}
        {#if step.detail}<span class="block text-[12px] text-muted">{step.detail}</span>{/if}
      </span>
    </div>
  {/each}
  {#if running && app.control.active}
    <div class="flex items-center gap-2 py-0.5 text-[13px]" in:fly={{ y: 4, duration: 200 }}>
      <span class="mt-px grid size-3 shrink-0 place-items-center"><span class="size-1.5 rounded-full bg-accent [animation:rec-pulse_1.2s_ease-in-out_infinite]"></span></span>
      <span class="thinking">{app.control.label || 'Working'}</span>
    </div>
  {/if}
</div>
