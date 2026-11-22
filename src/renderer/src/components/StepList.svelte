<script lang="ts">
  import { untrack } from 'svelte'
  import type { ComputerDoing } from '@shared/computer'
  import { type Step, isDesktopRun, isMemoryRun, isTeamRun } from '@shared/steps'
  import { fly, slide } from '@/lib/motion'
  import Icon from './Icon.svelte'

  /**
   * `doing`: the computer tool running now in this reply, shown live until its step lands.
   * `browsing`: what the browser is doing for this reply, when it is the one driving it.
   */
  let {
    steps,
    live = false,
    running = false,
    done = false,
    doing = null,
    browsing = null
  }: { steps: Step[]; live?: boolean; running?: boolean; done?: boolean; doing?: ComputerDoing | null; browsing?: string | null } = $props()

  /** A line's roll in and out (the dwell below waits it out). */
  const ROLL = 200

  // Folded to one line by default; the header opens the full list.
  let toggled = $state<boolean | null>(null)
  const open = $derived(toggled ?? false)
  const failed = $derived(steps.filter((s) => !s.ok).length)
  const desktop = $derived(isDesktopRun(steps) || !!doing)
  const memory = $derived(!desktop && isMemoryRun(steps))
  const team = $derived(!desktop && !memory && isTeamRun(steps))

  /**
   * The live tool's step lands a moment before main says the tool is over. From then on the
   * finished step stands for it, so the same line never shows twice (live and done) for a frame.
   * `since` is how many steps there were when this tool started: its step lands at that index.
   */
  let since = $state<{ doing: ComputerDoing | null; count: number }>({ doing: null, count: 0 })
  $effect.pre(() => {
    const d = doing
    untrack(() => {
      if (d !== since.doing) since = { doing: d, count: steps.length }
    })
  })
  const landed = $derived(!!doing && since.doing === doing && !doing.quiet && steps.length > since.count)
  const liveDoing = $derived(landed ? null : doing)

  const now = $derived<{ label: string; detail?: string; quiet: boolean } | null>(
    !running ? null : liveDoing ? liveDoing : browsing ? { label: browsing, quiet: false } : null
  )

  type Line = { key: string; label: string; detail?: string; tone: 'live' | 'quiet' | 'done' | 'failed' | 'summary'; summary?: string }
  const IDLE: Line = { key: 'working', label: 'Working', tone: 'quiet' }
  // The folded line: the action under way, else the last one; once the reply is over, the count.
  const line = $derived.by<Line | null>(() => {
    if (done) return { key: 'summary', label: '', tone: 'summary' }
    if (now) return { key: `${now.label}\n${now.detail ?? ''}`, label: now.label, detail: now.detail, tone: now.quiet ? 'quiet' : 'live' }
    const last = steps.at(-1)
    // Between tools, before the first step is in: the last line stays (below), or if there was none
    // yet, the line says it is at work.
    if (!last) return running ? IDLE : null
    return { key: `${last.label}\n${last.detail ?? ''}`, label: last.label, detail: last.detail, tone: last.ok ? 'done' : 'failed' }
  })

  /**
   * Each new line rolls in, so a line that changes faster than DWELL ms (quick looks between
   * actions) would stack up half-rolled lines: changes that come sooner wait out the dwell, and
   * only the latest is shown. A change to the same line (live → done) applies at once. The dwell
   * is the roll and a few frames more, so a roll is always over before the next one starts: at
   * most two lines are ever in the slot.
   */
  const DWELL = ROLL + 40
  let shown = $state<Line | null>(untrack(() => line))
  let shownAt = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  $effect.pre(() => {
    const next = line
    untrack(() => {
      clearTimeout(pending)
      // A moment between tools keeps the line that is up rather than rolling to "Working" and on.
      if (next === IDLE && shown) return
      const wait = shownAt + DWELL - performance.now()
      if (!shown || !next || next.key === shown.key || wait <= 0) {
        if (next?.key !== shown?.key) shownAt = performance.now()
        shown = next
      } else
        pending = setTimeout(() => {
          if (line === IDLE && shown) return
          shown = line
          shownAt = performance.now()
        }, wait)
    })
  })
  $effect(() => () => clearTimeout(pending))

  // Long runs collapse to the latest few; the rest is one click away.
  const COLLAPSED = 4
  let expanded = $state(false)
  const hidden = $derived(expanded ? 0 : Math.max(0, steps.length - COLLAPSED))
  const shownSteps = $derived(steps.slice(hidden))
</script>

{#snippet dot(tone: Line['tone'] | 'denied')}
  {#if tone === 'live'}
    <span class="cu-dot small"></span>
  {:else}
    <span
      class="size-1.5 shrink-0 rounded-full {tone === 'failed' ? 'bg-danger' : tone === 'denied' ? 'shadow-[inset_0_0_0_1.25px_var(--fg-3)]' : 'bg-fg-4'}"
    ></span>
  {/if}
{/snippet}

<div class="flex flex-col overflow-hidden rounded-[14px] bg-card shadow-[0_0_0_1px_var(--ring)]">
  <div class="flex h-10 items-center gap-2 px-3.5 text-[13px] text-fg-2">
    <button class="flex h-10 min-w-0 flex-1 items-center gap-2.5 text-left transition-colors hover:text-fg" aria-expanded={open} onclick={() => (toggled = !open)}>
      <Icon name={desktop ? 'monitor' : memory ? 'brain' : team ? 'chat' : 'globe'} size={16} class="shrink-0 text-fg-3" />
      <span class="shrink-0">{desktop ? 'Computer' : memory ? 'Memory' : team ? 'Bots' : 'Browser'}</span>
      <!-- Slot: each new line rolls in from below as the previous one rolls out above. The summary
           (once the reply is over) rolls in the same way. -->
      <span class="ml-1.5 grid h-[1lh] min-w-0 flex-1 overflow-hidden text-[13px] leading-snug" aria-live="polite" data-step-line={shown?.tone === 'live' || shown?.tone === 'quiet' ? 'now' : shown?.tone === 'summary' ? 'summary' : 'last'}>
        {#if shown && (!open || shown.tone === 'summary')}
          {#key shown.key}
            <span class="flex min-w-0 items-center gap-2 [grid-area:1/1]" in:fly={{ y: 14, duration: ROLL }} out:fly={{ y: -14, duration: ROLL }}>
              {#if shown.tone === 'summary'}
                <span class="font-label text-[11.5px] text-fg-4 tabular-nums"
                  >{steps.length} {steps.length === 1 ? 'step' : 'steps'}{#if failed}<span class="text-danger">, {failed} failed</span>{/if}</span
                >
              {:else}
                {@render dot(shown.tone)}
                <!-- What it did and to what; the target is cut first when the line is short of room. -->
                <span class="truncate transition-colors duration-200 {shown.tone === 'failed' ? 'text-danger' : shown.tone === 'quiet' ? 'text-fg-3' : shown.tone === 'live' ? 'text-fg' : 'text-fg-2'}"
                  >{shown.label}{#if shown.detail}<span class="text-fg-3"><span class="px-1.5" aria-hidden="true">·</span>{shown.detail}</span>{/if}</span
                >
              {/if}
            </span>
          {/key}
        {/if}
      </span>
      <!-- Always there (hidden until there is a list), so the line never narrows when the first step lands. -->
      <Icon name="chevronDown" size={16} class="shrink-0 text-fg-4 transition-[transform,opacity] duration-200 {open ? 'rotate-180' : ''} {steps.length > 0 || done ? '' : 'opacity-0'}" />
    </button>
    {#if open && hidden > 0}
      <button class="btn quiet sm ml-auto !h-6 !px-2" onclick={() => (expanded = true)}>Show {hidden} earlier</button>
    {:else if open && expanded && steps.length > COLLAPSED}
      <button class="btn quiet sm ml-auto !h-6 !px-2" onclick={() => (expanded = false)}>Show fewer</button>
    {/if}
  </div>
  {#if open}
    <div class="flex flex-col border-t border-line px-3.5 pt-1 pb-3" transition:slide>
      {#each shownSteps as step, i (hidden + i)}
        <!-- A step that just stood live in the row below takes its place without moving. -->
        <div class="flex items-start gap-2.5 py-[5px] text-[13px] leading-snug" in:fly={{ y: 4, duration: live && hidden + i !== since.count ? 200 : 0 }}>
          <span class="grid h-[1lh] w-4 shrink-0 place-items-center">{@render dot(step.denied ? 'denied' : step.ok ? 'done' : 'failed')}</span>
          <span class="min-w-0 {step.ok ? (step.denied ? 'text-fg-3' : 'text-fg-2') : 'text-danger'}">
            {step.label}
            {#if step.detail}<span class="block text-[12px] break-words text-fg-3">{step.detail}</span>{/if}
          </span>
        </div>
      {/each}
      {#if now}
        <div class="flex items-start gap-2.5 py-[5px] text-[13px] leading-snug" in:fly={{ y: 4, duration: 200 }} data-step-now>
          <span class="grid h-[1lh] w-4 shrink-0 place-items-center">{@render dot(now.quiet ? 'quiet' : 'live')}</span>
          <span class="min-w-0 {now.quiet ? 'text-fg-3' : 'text-fg'}">
            {now.label}
            {#if now.detail}<span class="block text-[12px] break-words text-fg-3">{now.detail}</span>{/if}
          </span>
        </div>
      {/if}
    </div>
  {/if}
</div>
