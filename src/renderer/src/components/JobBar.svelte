<script lang="ts">
  // The job view's strip under the top bar, once there are several bots: the bots on the job (each
  // with its presence; a click opens its own thread, where you can talk to it), the job's status
  // and what it has used, and its notes. Shown on the job's shared thread and on its bots' threads.
  import { tip } from '@/lib/tooltip'
  import { pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { meter } from '@/lib/meter.svelte'
  import { jobUsageLine, sharesLine } from '@shared/usage'
  import BotAvatar, { PRESENCE_LABELS } from './BotAvatar.svelte'
  import Icon from './Icon.svelte'

  const detail = $derived(app.jobDetail)
  const job = $derived(detail ? (app.jobs.find((j) => j.id === detail.job.id) ?? detail.job) : null)
  const openId = $derived(app.view?.session.id ?? '')

  let notesOpen = $state(false)
  let root: HTMLDivElement | undefined = $state()

  $effect(() => {
    if (job) void meter.loadJob(job.id)
  })
  const used = $derived.by(() => {
    if (!job) return ''
    const parts = [job.usage && job.usage.replies > 0 ? jobUsageLine(job.usage) : '', sharesLine((meter.shares.get(job.id) ?? []).filter((s) => s.percent > 0))]
    return parts.filter(Boolean).join(' · ')
  })

  const KIND_LABELS: Record<string, string> = { state: 'Where things stand', left: "What's left", files: 'Files touched', decision: 'Decision', progress: 'Progress' }

  /** A bot's chip opens its own thread; the primary's (it has none) the job's shared thread. */
  const openBot = (threadId: string | null) => {
    if (threadId) void app.open(threadId)
    else if (job) void app.openJob(job)
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (notesOpen && root && !root.contains(e.target as Node)) notesOpen = false
  }}
/>

{#if detail && job}
  <div class="relative mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-2 px-8 pb-2" bind:this={root} data-job-bar>
    <div class="flex min-w-0 items-center gap-1" aria-label="Bots on this job">
      {#each detail.bots as b (b.botId)}
        {@const bot = app.bots.find((x) => x.id === b.botId)}
        {#if bot}
          {@const presence = app.presence[bot.id] ?? 'idle'}
          {@const on = b.threadId ? openId === b.threadId : openId === job.threadId}
          <button

            class="flex h-7 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-[12.5px] font-medium transition-colors {on ? 'glass text-fg' : 'text-fg-2 hover:bg-wash'}"
            use:tip={`${PRESENCE_LABELS[presence]} · ${b.threadId ? `Open ${bot.name}'s own thread on this job` : bot.isPrimary ? 'The job’s shared thread' : `${bot.name} has no thread of its own here yet`}`}
            data-job-bot={bot.name}
            onclick={() => openBot(b.threadId)}
          >
            <BotAvatar {bot} size={20} {presence} />{bot.name}
          </button>
        {/if}
      {/each}
    </div>
    <span class="flex-1"></span>
    <span class="mono-label shrink-0 !text-[10.5px]">{job.status === 'open' ? 'Open' : 'Finished'}</span>
    {#if used}<span class="mono-stat min-w-0 truncate" use:tip={'What this job has used (shares of your plan are estimates)'}>{used}</span>{/if}
    <button
      class="btn quiet sm shrink-0 !h-7 !gap-1.5 !px-2.5 {notesOpen ? '!text-fg' : ''}"
      aria-expanded={notesOpen}
      data-job-notes-toggle
      onclick={() => (notesOpen = !notesOpen)}
    >
      <Icon name="note" size={13} />Notes{#if detail.notes.length}<span class="text-fg-3 tabular-nums">{detail.notes.length}</span>{/if}
    </button>
    {#if notesOpen}
      <div class="glass-float absolute top-full right-8 z-40 mt-1 max-h-[min(420px,60vh)] w-[380px] max-w-[80vw] origin-top-right overflow-y-auto rounded-[14px] p-3" transition:pop={{ duration: 150 }} data-job-notes>
        {#if detail.notes.length === 0}
          <p class="px-1 py-2 text-[13px] text-fg-3">No notes yet. The bots on this job write down decisions, where things stand and what's left as they go.</p>
        {:else}
          {#each detail.notes as n (n.id)}
            <div class="px-2 py-2 [&+&]:border-t [&+&]:border-line" data-note={n.type}>
              <div class="mono-label mb-0.5 !text-[10.5px]">{KIND_LABELS[n.type] ?? n.type}{n.title ? ` · ${n.title}` : ''}</div>
              <p class="text-[13px] whitespace-pre-wrap text-fg-2">{n.body}</p>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}
