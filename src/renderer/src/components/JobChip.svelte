<script lang="ts">
  // The job chip above the composer: which job the conversation is on, and the one click that
  // changes it. Talking to Tomo, it shows the job the last message went to (Tomo picks each time);
  // picking another job either moves that last message there (a wrong guess put right, while the
  // composer is empty) or sends the next message there. In a job's thread it switches jobs.
  import { tick } from 'svelte'
  import type { Job } from '@shared/types'
  import { tip } from '@/lib/tooltip'
  import { pop } from '@/lib/motion'
  import { shortcut } from '@/lib/keys'
  import { app } from '@/lib/store.svelte'
  import { meter } from '@/lib/meter.svelte'
  import { jobUsageLine, sharesLine } from '@shared/usage'
  import Icon from './Icon.svelte'

  let open = $state(false)
  let root: HTMLDivElement | undefined = $state()
  let menu: HTMLDivElement | undefined = $state()

  const primary = $derived(app.isPrimary)
  const job = $derived(app.currentJob)
  const target = $derived(app.target)
  const lastTurn = $derived(primary ? app.view?.path.findLast((n) => n.message.role === 'user')?.message : undefined)
  /** Picking moves the last message: talking to Tomo, nothing typed yet, and nothing picked for the next one. */
  const moving = $derived(primary && target === 'auto' && !!lastTurn && !app.hasDraft(app.view?.session.id ?? ''))
  const show = $derived(!primary || app.jobs.length > 0 || target !== 'auto')

  const label = $derived(target === 'new' && primary ? 'New topic' : (job?.title ?? (primary ? 'Tomo picks the job' : '')))
  const hint = $derived(
    !primary
      ? job?.status === 'done'
        ? 'This job is finished; writing here opens it again'
        : 'The job this thread belongs to'
      : target === 'auto'
        ? job
          ? 'Tomo picked this job for your last message, and picks one for each message'
          : 'Tomo picks a job for each message'
        : 'Your next message goes here'
  )

  // What the job has used, after the hint: its tokens and API-equivalent cost, and on a Claude plan
  // its estimated share of the windows (lib/meter.svelte.ts reads it again as usage moves).
  $effect(() => {
    if (job) void meter.loadJob(job.id)
  })
  const used = $derived.by(() => {
    if (!job || (target === 'new' && primary)) return ''
    const parts = [job.usage && job.usage.replies > 0 ? jobUsageLine(job.usage) : '', sharesLine((meter.shares.get(job.id) ?? []).filter((s) => s.percent > 0))]
    const line = parts.filter(Boolean).join(', ')
    return line ? ` · Used ${line}${parts[1] ? ' (an estimate)' : ''}` : ''
  })

  const RECENT_OPEN = 8
  const RECENT_DONE = 5
  const choices = $derived.by(() => {
    const byTime = [...app.jobs].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      open: byTime.filter((j) => j.status === 'open').slice(0, RECENT_OPEN),
      done: byTime.filter((j) => j.status === 'done').slice(0, RECENT_DONE)
    }
  })

  const sections = $derived<Array<[string, Job[]]>>([
    ['Open', choices.open],
    ['Finished', choices.done]
  ])

  const toggle = async () => {
    open = !open
    await tick()
    menu?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  const pick = async (choice: Job | 'new' | 'auto') => {
    open = false
    if (!primary) {
      if (choice === 'new' || choice === 'auto') await app.openPrimary('new')
      else await app.openJob(choice)
      return
    }
    if (choice === 'auto') return void (app.target = 'auto')
    const to = choice === 'new' ? ('new' as const) : { jobId: choice.id }
    if (moving) {
      // Already there: nothing to move.
      if (choice !== 'new' && choice.id === job?.id) return
      await app.moveLast(to)
    } else app.target = to
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      open = false
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  const isOn = (j: Job) => (target === 'new' && primary ? false : j.id === job?.id)
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) open = false
  }}
/>

{#if show}
  <div class="relative flex min-w-0 items-center gap-1" bind:this={root} data-job-chip>
    <button
      type="button"
      class="glass inline-flex h-7 max-w-[340px] min-w-0 items-center gap-1.5 rounded-full pr-2 pl-2.5 text-[12.5px] font-medium transition-colors {open ? 'text-fg' : 'text-fg-2 hover:text-fg'}"
      aria-haspopup="menu"
      aria-expanded={open}
      use:tip={open ? null : hint + used}
      onclick={toggle}
    >
      <Icon name={target === 'new' && primary ? 'compose' : primary && target === 'auto' ? 'sparkle' : 'chat'} size={13} class="shrink-0 text-fg-3" />
      <span class="truncate">{label}</span>
      {#if job?.status === 'done' && !(target === 'new' && primary)}<span class="mono-label shrink-0 !text-[10px] !text-fg-4">Finished</span>{/if}
      <Icon name="chevronDown" size={13} class="shrink-0 text-fg-4 transition-transform duration-200 {open ? 'rotate-180' : ''}" />
    </button>
    {#if primary && target !== 'auto'}
      <button type="button" class="icon-btn size-6 !rounded-full" use:tip={'Let Tomo pick'} aria-label="Let Tomo pick" onclick={() => (app.target = 'auto')}>
        <Icon name="x" size={12} />
      </button>
    {/if}

    {#if open}
      <div
        bind:this={menu}
        role="menu"
        tabindex="-1"
        class="glass-float absolute bottom-full left-0 z-50 mb-2 max-h-[min(380px,60vh)] w-[320px] max-w-[80vw] origin-bottom-left overflow-y-auto rounded-[14px] p-1"
        transition:pop={{ duration: 150 }}
        {onkeydown}
      >
        <div class="mono-label px-2.5 pt-2.5 pb-1.5">{!primary ? 'Switch to' : moving ? 'Move your last message to' : 'Send your next message to'}</div>
        {#if primary && target !== 'auto'}
          <button type="button" role="menuitem" class="item" onclick={() => pick('auto')}>
            <Icon name="sparkle" size={15} class="text-fg-3" /><span class="min-w-0 flex-1 truncate">Let Tomo pick</span>
          </button>
        {/if}
        <button type="button" role="menuitem" class="item" onclick={() => pick('new')}>
          <Icon name="compose" size={15} class="text-fg-3" /><span class="min-w-0 flex-1 truncate">New topic</span>
          {#if !primary}<kbd class="studio-kbd">{shortcut('N')}</kbd>{:else if target === 'new'}<Icon name="check" size={15} />{/if}
        </button>
        {#each sections as [heading, list] (heading)}
          {#if list.length > 0}
            <div class="mono-label px-2.5 pt-3 pb-1.5">{heading}</div>
            {#each list as j (j.id)}
              <button type="button" role="menuitem" class="item" onclick={() => pick(j)}>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13.5px] font-medium text-fg">{j.title}</span>
                  {#if j.summary}<span class="block truncate text-[12px] text-fg-3">{j.summary}</span>{/if}
                </span>
                <Icon name="check" size={15} class={isOn(j) ? 'text-fg' : 'opacity-0'} />
              </button>
            {/each}
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    border-radius: 10px;
    padding: 7px 10px;
    text-align: left;
    font-size: 13.5px;
    color: var(--fg);
    outline: none;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--wash);
  }
</style>
