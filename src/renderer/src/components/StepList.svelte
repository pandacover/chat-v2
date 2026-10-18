<script lang="ts">
  import { type Step, isDesktopRun } from '@shared/steps'
  import { fly, slide } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let { steps, live = false, running = false, done = false }: { steps: Step[]; live?: boolean; running?: boolean; done?: boolean } = $props()

  // Folded to one line by default; the header opens the full list.
  let toggled = $state<boolean | null>(null)
  const open = $derived(toggled ?? false)
  const failed = $derived(steps.filter((s) => !s.ok).length)
  const desktop = $derived(isDesktopRun(steps))
  const working = $derived(running && app.control.active)
  // What the folded line shows while the reply is still going: the action under way, else the last one.
  const current = $derived<{ label: string; ok: boolean } | null>(
    working ? { label: app.control.label || 'Working', ok: true } : (steps.at(-1) ?? null)
  )

  // Long runs collapse to the latest few; the rest is one click away.
  const COLLAPSED = 4
  let expanded = $state(false)
  const hidden = $derived(expanded ? 0 : Math.max(0, steps.length - COLLAPSED))
  const shown = $derived(steps.slice(hidden))
</script>

<div class="flex flex-col gap-0.5 rounded-lg bg-surface px-3 py-2 shadow-[0_0_0_1px_var(--line)]">
  <div class="flex items-center gap-1.5 text-[12px] text-muted {open ? 'mb-0.5' : ''}">
    <button class="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left hover:text-fg" aria-expanded={open} onclick={() => (toggled = !open)}>
      <Icon name={desktop ? 'monitor' : 'globe'} size={12} />
      <span>{desktop ? 'Computer' : 'Browser'}</span>
      {#if done}
        <span>· {steps.length} {steps.length === 1 ? 'step' : 'steps'}{#if failed}, <span class="text-danger">{failed} failed</span>{/if}</span>
      {:else if !open && current}
        <!-- Slot: each new action rolls in from below as the previous one rolls out above. -->
        <span class="ml-1 grid h-[1lh] min-w-0 flex-1 overflow-hidden text-[13px] leading-snug" aria-live="polite">
          {#key current.label}
            <span
              class="flex min-w-0 items-center gap-2 [grid-area:1/1] {current.ok ? 'text-fg-2' : 'text-danger'}"
              in:fly={{ y: 14, duration: 260 }}
              out:fly={{ y: -14, duration: 260 }}
            >
              <span class="size-1.5 shrink-0 rounded-full {working ? 'bg-accent [animation:rec-pulse_1.2s_ease-in-out_infinite]' : current.ok ? 'bg-muted' : 'bg-danger'}"></span>
              <span class="truncate {working ? 'thinking' : ''}">{current.label}</span>
            </span>
          {/key}
        </span>
      {/if}
      {#if steps.length > 0 || done}
        <Icon name="chevronDown" size={12} class="shrink-0 transition-transform duration-150 {open ? 'rotate-180' : ''}" />
      {/if}
    </button>
    {#if open && hidden > 0}
      <button class="ml-auto shrink-0 rounded px-1 hover:text-fg" onclick={() => (expanded = true)}>Show {hidden} earlier</button>
    {:else if open && expanded && steps.length > COLLAPSED}
      <button class="ml-auto shrink-0 rounded px-1 hover:text-fg" onclick={() => (expanded = false)}>Show fewer</button>
    {/if}
  </div>
  {#if open}
    <div class="flex flex-col gap-0.5" transition:slide>
      {#each shown as step, i (hidden + i)}
        <div class="flex items-start gap-2 py-0.5 text-[13px] leading-snug" in:fly={{ y: 4, duration: live ? 200 : 0 }}>
          <span class="grid h-[1lh] w-3 shrink-0 place-items-center">
            <span class="size-1.5 rounded-full {step.ok ? 'bg-muted' : 'bg-danger'}"></span>
          </span>
          <span class="min-w-0 {step.ok ? 'text-fg-2' : 'text-danger'}">
            {step.label}
            {#if step.detail}<span class="block text-[12px] text-muted">{step.detail}</span>{/if}
          </span>
        </div>
      {/each}
      {#if working}
        <div class="flex items-start gap-2 py-0.5 text-[13px] leading-snug" in:fly={{ y: 4, duration: 200 }}>
          <span class="grid h-[1lh] w-3 shrink-0 place-items-center"><span class="size-1.5 rounded-full bg-accent [animation:rec-pulse_1.2s_ease-in-out_infinite]"></span></span>
          <span class="thinking">{app.control.label || 'Working'}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
