<script lang="ts">
  // The open job's title in the app bar, when a job's thread (or a bot's own thread on it) is open:
  // what the job has used on hover, and whether it is finished. Nothing in Tomo's own conversation.
  // Not part of the window's drag area, so its tooltip shows; the bar around it still drags.
  import { tip } from '@/lib/tooltip'
  import { app } from '@/lib/store.svelte'
  import { meter } from '@/lib/meter.svelte'
  import { jobUsageLine, sharesLine } from '@shared/usage'
  import { fade } from '@/lib/motion'
  import Icon from './Icon.svelte'

  /** After the bot's name (the sidebar shut): a chevron between them. */
  let { after = false }: { after?: boolean } = $props()

  const job = $derived(app.currentJob)
  $effect(() => {
    if (job) void meter.loadJob(job.id)
  })
  const jobTip = $derived.by(() => {
    if (!job) return null
    const parts = [job.usage && job.usage.replies > 0 ? jobUsageLine(job.usage) : '', sharesLine((meter.shares.get(job.id) ?? []).filter((s) => s.percent > 0))]
    const line = parts.filter(Boolean).join(', ')
    return [job.status === 'done' ? 'This job is finished; writing here opens it again' : '', line ? `Used ${line}${parts[1] ? ' (an estimate)' : ''}` : ''].filter(Boolean).join(' · ') || null
  })
</script>

{#if !app.isPrimary && app.view}
  <span class="flex h-8 min-w-0 items-center gap-1.5 select-none" in:fade={{ duration: 160 }}>
    {#if after}<Icon name="chevronRight" size={12} class="shrink-0 text-fg-4" />{/if}
    <span class="app-no-drag min-w-0 truncate text-[13.5px] font-medium" data-chat-title use:tip={jobTip ? { text: jobTip, placement: 'bottom' } : null}>{app.view.session.title}</span>
    <!-- With several bots the job bar says so. -->
    {#if job?.status === 'done' && !app.team}<span class="mono-label shrink-0 pl-0.5 !text-[10px] !text-fg-4" data-job-finished>Finished</span>{/if}
  </span>
{/if}
