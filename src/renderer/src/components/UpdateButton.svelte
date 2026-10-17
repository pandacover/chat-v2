<script lang="ts">
  import { fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { tip } from '@/lib/tooltip'
  import Icon from './Icon.svelte'

  const u = $derived(app.update)
  const visible = $derived(!!u && !!u.next && ['available', 'downloading', 'ready', 'error'].includes(u.status))

  const install = async () => {
    const next = await app.attempt(() => window.api.updates.install())
    if (next) app.update = next
  }
</script>

{#if u && visible}
  <div class="px-2 pb-1" transition:fly={{ y: 6, duration: 200 }}>
    {#if u.status === 'available'}
      <button
        class="flex w-full items-center gap-2 rounded-md bg-surface px-2.5 py-2 text-left text-[13px] shadow-[0_0_0_1px_var(--line)] transition-shadow hover:shadow-[0_0_0_1px_var(--muted)]"
        use:tip={u.manual
          ? `${u.downloaded ? 'Opens' : 'Downloads'} the ${u.build ?? 'Mac'} build${u.downloaded ? ', already downloaded' : ' and opens it'}. Drag chat-v2 into Applications to replace this one.`
          : 'Downloads the update and restarts into it.'}
        onclick={install}
      >
        <span class="grid size-5 place-items-center rounded-full bg-accent text-on-accent"><Icon name="arrowDown" size={12} stroke={2.2} /></span>
        <span class="min-w-0 flex-1">
          <span class="block text-fg">Update to {u.next}</span>
          <span class="block text-[11.5px] text-muted">{u.downloaded ? 'Downloaded, ready to open' : `You have ${u.current}`}</span>
        </span>
      </button>
    {:else if u.status === 'downloading'}
      <div class="rounded-md bg-surface px-2.5 py-2 text-[13px] shadow-[0_0_0_1px_var(--line)]" aria-live="polite">
        <div class="flex items-center justify-between text-fg-2"><span>Downloading {u.next}</span><span class="tabular-nums">{u.percent ?? 0}%</span></div>
        <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-hover">
          <div class="h-full rounded-full bg-fg-2 transition-[width] duration-300 ease-out" style="width: {u.percent ?? 0}%"></div>
        </div>
      </div>
    {:else if u.status === 'ready'}
      <div class="rounded-md bg-surface px-2.5 py-2 text-[13px] text-fg-2 shadow-[0_0_0_1px_var(--line)]">
        {#if u.manual}
          Opened {u.next}. Drag chat-v2 into Applications, then reopen it.
        {:else}
          <span class="thinking">Restarting into {u.next}</span>
        {/if}
      </div>
    {:else if u.status === 'error'}
      <button
        class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-danger hover:bg-hover"
        use:tip={u.error ?? 'Update failed'}
        onclick={install}
      >
        <Icon name="alert" size={13} /> Update failed. Retry
      </button>
    {/if}
  </div>
{/if}
