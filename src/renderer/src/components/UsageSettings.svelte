<script lang="ts">
  // Settings › Usage: what Anthropic reports for the account (a Claude plan's windows and extra
  // usage, or an API key's dollars), replies paused at a limit, and the current job's use and estimated share.
  // Opening it reads the meter again; nothing is polled.
  import { onDestroy, onMount } from 'svelte'
  import { extraLine, formatMoney, formatPercent, jobUsageLine, limitName, noticeText, resetPhrase, shareLabel, tone, whenPhrase } from '@shared/usage'
  import { fade } from '@/lib/motion'
  import { meter } from '@/lib/meter.svelte'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'
  import UsageBar from './UsageBar.svelte'

  const v = $derived(meter.view)
  let now = $state(Date.now())
  const ticker = setInterval(() => (now = Date.now()), 30_000)
  onDestroy(() => clearInterval(ticker))

  /** The job the open conversation is on: a job's thread, or in Tomo's conversation the current one (or none). */
  const job = $derived(app.currentJob)
  const shares = $derived(job ? (meter.shares.get(job.id) ?? []) : [])
  const loadShare = () => (job ? meter.loadJob(job.id) : Promise.resolve())
  onMount(() => {
    meter.start()
    void meter.refresh().then(loadShare)
  })

  /** A paused reply's job, by its thread. */
  const titleOf = (sessionId: string) => app.jobByThread.get(sessionId)?.title ?? app.sessions.find((s) => s.id === sessionId)?.title ?? 'A job'
  const ago = (at: number) => {
    const s = Math.round((now - at) / 1000)
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  const planName = (p: string) => `${p[0]!.toUpperCase()}${p.slice(1)}`
</script>

<section id="settings-usage">
  <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Usage</h3>
  {#if !v}
    <p class="mb-5 text-fg-3">Loading…</p>
  {:else if v.auth === 'apiKey'}
    <p class="mb-5 max-w-[60ch] text-fg-3">
      Replies run on your API key and are billed by the token. These are Claude Code's estimates at API prices; the Anthropic Console has the bill, and its spend limits are the
      way to cap it.
    </p>
    <div class="group-card">
      <div class="srow"><div class="l"><b>Today</b></div><span class="font-label text-[13px] tabular-nums">{formatMoney(v.cost.today)}</span></div>
      <div class="srow"><div class="l"><b>Last 7 days</b></div><span class="font-label text-[13px] tabular-nums">{formatMoney(v.cost.week)}</span></div>
      <div class="srow"><div class="l"><b>This month</b></div><span class="font-label text-[13px] tabular-nums">{formatMoney(v.cost.month)}</span></div>
    </div>
    <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer" class="mx-0.5 inline-flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-fg"
      >Spend limits in the Console <Icon name="external" size={11} /></a
    >
  {:else}
    <p class="mb-5 max-w-[60ch] text-fg-3">
      Your plan's limits, as Anthropic reports them. Tomo sets no budget of its own: when a limit is reached, a reply pauses with its work saved and goes on by itself once the
      limit resets.
    </p>

    {#if v.warning}
      <div class="warn mb-4 flex items-start gap-2 rounded-[12px] px-3.5 py-3 text-[13px] text-danger" in:fade>
        <span class="mt-0.5 shrink-0"><Icon name="alert" size={14} /></span>
        <span>{noticeText({ kind: 'overage', ...v.warning }, now)}</span>
      </div>
    {/if}

    <div class="mx-0.5 mb-2.5 flex items-baseline gap-2">
      <span class="mono-label">Limits{v.plan ? ` · ${planName(v.plan)} plan` : ''}</span>
      <span class="ml-auto text-[12px] text-fg-4" aria-live="polite">
        {#if v.refreshing}Checking…{:else if v.checkedAt}Checked {ago(v.checkedAt)}{/if}
      </span>
      <button class="text-[12px] text-fg-3 hover:text-fg disabled:opacity-50" disabled={v.refreshing} onclick={() => meter.refresh().then(loadShare)}>Refresh</button>
    </div>
    <div class="group-card">
      {#each v.windows as w (w.id)}
        <div class="srow" data-usage-window={w.id}>
          <div class="l">
            <b>{w.label}</b>
            <span>{w.resetsAt ? resetPhrase(w.resetsAt, now) : 'No reset time reported'}</span>
          </div>
          <div class="flex w-[220px] shrink-0 items-center gap-3">
            <UsageBar percent={w.percent} class="flex-1" />
            <span class="w-10 text-right font-label text-[13px] tabular-nums {tone(w.percent) === 'ok' ? 'text-fg-2' : 'text-danger'}">{formatPercent(w.percent)}</span>
          </div>
        </div>
      {:else}
        <div class="srow text-[13px] text-fg-3">
          {v.limits === false ? "Anthropic doesn't report plan limits for this sign-in." : v.error ? `Couldn't read usage: ${v.error}` : 'Nothing reported yet.'}
        </div>
      {/each}
      {#if v.error && v.windows.length > 0}
        <div class="srow !block text-[12.5px] text-fg-3">Couldn't read usage just now ({v.error}). Showing the last reading.</div>
      {/if}
    </div>

    {#if v.extra}
      <div class="mono-label mx-0.5 mt-[22px] mb-2.5">Extra usage</div>
      <div class="group-card">
        <div class="srow">
          <div class="l">
            <b>{v.extra.enabled ? extraLine(v.extra) : 'Off'}</b>
            <span>{v.extra.enabled ? 'Past a limit, work goes on at API prices up to your monthly limit. Tomo warns first.' : "Past a limit, replies pause until it resets."}</span>
          </div>
          {#if v.extra.enabled && v.extra.percent !== null}
            <div class="flex w-[220px] shrink-0 items-center gap-3">
              <UsageBar percent={v.extra.percent} class="flex-1" />
              <span class="w-10 text-right font-label text-[13px] text-fg-2 tabular-nums">{formatPercent(v.extra.percent)}</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}

  {/if}

  {#if v && job}
    <div class="mono-label mx-0.5 mt-[22px] mb-2.5">This job</div>
    <div class="group-card">
      <div class="srow" data-usage-job={job.id}>
        <div class="l">
          <b class="truncate">{job.title}</b>
          <span>
            {job.usage && job.usage.replies > 0 ? `${jobUsageLine(job.usage)} over ${job.usage.replies} ${job.usage.replies === 1 ? 'reply' : 'replies'}, at API prices.` : 'Nothing used yet.'}
            {#if shares.length > 0}Its share is an estimate: Anthropic reports usage per account, so each rise is split across the replies that ran then, by what they'd cost.{/if}
          </span>
        </div>
        {#if shares.length > 0}
          <span class="flex shrink-0 flex-col items-end text-[13px] text-fg-2">
            {#each shares as s (s.window)}<span data-usage-share={s.window}>{shareLabel(s)}</span>{/each}
          </span>
        {/if}
      </div>
    </div>
  {/if}

  {#if v && v.pauses.length > 0}
    <div class="mono-label mx-0.5 mt-[22px] mb-2.5">Paused replies</div>
    <ul class="group-card">
      {#each v.pauses as p (p.messageId)}
        <li class="srow">
          <div class="l">
            <b class="truncate">{titleOf(p.sessionId)}</b>
            <span>Paused at your {limitName(p.window)}. Continues {whenPhrase(p.resumeAt, now)}.</span>
          </div>
          <div class="flex shrink-0 gap-1">
            <button class="btn solid sm" onclick={() => meter.continueNow(p)}>Continue now</button>
            <button class="btn sm" onclick={() => meter.cancel(p.messageId)}>Cancel</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .group-card {
    margin-bottom: 16px;
    border-radius: var(--r-card);
    background: var(--glass-bg);
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--glass-ring),
      var(--shadow-sm);
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 13px 16px;
    border-top: 1px solid var(--line);
  }
  .srow:first-child {
    border-top: 0;
  }
  .l {
    display: block;
    flex: 1;
    min-width: 0;
  }
  .l :global(b) {
    display: block;
    font-weight: 500;
  }
  .l > span {
    display: block;
    margin-top: 1px;
    font-size: 12.5px;
    color: var(--fg-3);
  }
  .warn {
    background: var(--danger-wash);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 22%, transparent);
  }
</style>
