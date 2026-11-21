<script lang="ts">
  // The usage meter at the foot of the sidebar: one quiet row with the fullest window of a Claude
  // plan (or an API key's dollars this month), a paused reply or a warning when there is one.
  // Hovering shows every window; a click opens Settings › Usage. Hidden until there is something
  // to show. Nothing here asks for a budget: Anthropic's limits already ration usage.
  import { onDestroy, onMount } from 'svelte'
  import { extraLine, formatMoney, formatPercent, fullest, noticeText, resetPhrase, tone, whenPhrase } from '@shared/usage'
  import { fade } from '@/lib/motion'
  import { meter } from '@/lib/meter.svelte'
  import Icon from './Icon.svelte'
  import UsageBar from './UsageBar.svelte'

  onMount(() => meter.start())

  const v = $derived(meter.view)
  const top = $derived(v ? fullest(v.windows) : null)
  const pause = $derived(v?.pauses[0] ?? null)
  const shown = $derived(!!v && (v.auth === 'apiKey' ? true : v.windows.length > 0 || v.pauses.length > 0))

  // Times are re-read while the row is up.
  let now = $state(Date.now())
  const ticker = setInterval(() => (now = Date.now()), 30_000)

  let button: HTMLButtonElement | undefined = $state()
  let open = $state(false)
  let pos = $state({ left: 0, bottom: 0 })
  let timer: ReturnType<typeof setTimeout> | undefined
  const WIDTH = 264
  const show = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!button) return
      const r = button.getBoundingClientRect()
      pos = { left: Math.max(8, Math.min(innerWidth - WIDTH - 8, r.left)), bottom: innerHeight - r.top + 8 }
      now = Date.now()
      open = true
    }, 200)
  }
  const hide = () => {
    clearTimeout(timer)
    open = false
  }
  onDestroy(() => {
    hide()
    clearInterval(ticker)
  })
  $effect(() => {
    if (!button) hide()
  })

  const label = $derived(
    !v
      ? 'Usage'
      : pause
        ? `Paused at a usage limit, continues ${whenPhrase(pause.resumeAt, now)}`
        : v.auth === 'apiKey'
          ? `${formatMoney(v.cost.month)} this month`
          : top
            ? `${formatPercent(top.percent)} of the ${top.label} limit used`
            : 'Usage'
  )
</script>

{#if shown && v}
  <button
    bind:this={button}
    class="meter mb-1 flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-[12.5px] whitespace-nowrap text-fg-2 transition-colors hover:bg-[var(--side-hover)]"
    data-usage-meter
    aria-label="{label}. Open usage in Settings"
    onclick={() => meter.openSettings()}
    onpointerenter={show}
    onpointerleave={hide}
    onfocus={show}
    onblur={hide}
    transition:fade={{ duration: 160 }}
  >
    <span class="grid shrink-0 place-items-center {pause || v.warning ? 'text-danger' : 'text-fg-3'}"><Icon name="gauge" size={15} /></span>
    {#if pause}
      <span class="min-w-0 flex-1 truncate text-left text-danger">Paused, continues {whenPhrase(pause.resumeAt, now)}</span>
    {:else if v.auth === 'apiKey'}
      <span class="min-w-0 flex-1 truncate text-left">This month</span>
      <span class="mono-stat !text-fg-3">{formatMoney(v.cost.month)}</span>
    {:else if top}
      <span class="shrink-0">{top.label}</span>
      <UsageBar percent={top.percent} class="min-w-6 flex-1" />
      <span class="mono-stat w-8 text-right {tone(top.percent) === 'ok' ? '!text-fg-3' : '!text-danger'}">{formatPercent(top.percent)}</span>
    {/if}
    {#if v.warning && !pause}<i class="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true"></i>{/if}
  </button>
{/if}

{#if open && v}
  <div role="tooltip" class="glass-float fixed z-[100] rounded-[14px] px-3.5 py-3 text-[12.5px] leading-snug text-fg-2" style="left: {pos.left}px; bottom: {pos.bottom}px; width: {WIDTH}px">
    {#if v.auth === 'apiKey'}
      <div class="font-medium text-fg">API key spend</div>
      <div class="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <span>Today</span><span class="mono-stat !text-fg-2">{formatMoney(v.cost.today)}</span>
        <span>Last 7 days</span><span class="mono-stat !text-fg-2">{formatMoney(v.cost.week)}</span>
        <span>This month</span><span class="mono-stat !text-fg-2">{formatMoney(v.cost.month)}</span>
      </div>
      <div class="mt-2 text-[11.5px] text-muted">As Claude Code estimates it at API prices. Set spend limits in the Anthropic Console.</div>
    {:else}
      <div class="font-medium text-fg">Plan usage{v.plan ? ` · ${v.plan[0]!.toUpperCase()}${v.plan.slice(1)}` : ''}</div>
      <div class="mt-2 flex flex-col gap-2">
        {#each v.windows as w (w.id)}
          <div>
            <div class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate">{w.label}</span>
              <span class="mono-stat {tone(w.percent) === 'ok' ? '!text-fg-2' : '!text-danger'}">{formatPercent(w.percent)}</span>
            </div>
            <UsageBar percent={w.percent} class="mt-1" />
            {#if w.resetsAt}<div class="mt-0.5 text-[11.5px] text-muted">{resetPhrase(w.resetsAt, now)}</div>{/if}
          </div>
        {/each}
      </div>
      {#if v.extra?.enabled}
        <div class="mt-2 text-[11.5px] text-fg-3">Extra usage: {extraLine(v.extra)}</div>
      {/if}
    {/if}
    {#if pause}
      <div class="mt-2 flex items-start gap-1.5 text-danger">
        <span class="mt-px shrink-0"><Icon name="alert" size={12} /></span>
        {v.pauses.length === 1 ? 'A reply is' : `${v.pauses.length} replies are`} paused at a limit, and continue{v.pauses.length === 1 ? 's' : ''} {whenPhrase(pause.resumeAt, now)}.
      </div>
    {:else if v.warning}
      <div class="mt-2 flex items-start gap-1.5 text-danger">
        <span class="mt-px shrink-0"><Icon name="alert" size={12} /></span>{noticeText({ kind: 'overage', ...v.warning }, now)}
      </div>
    {/if}
    <div class="mt-2 text-[11.5px] text-muted">Click for details in Settings.</div>
  </div>
{/if}
