<script lang="ts">
  // Under a reply paused at a usage limit: when it goes on by itself, and Continue now / Cancel.
  // Cancelled, the reply stays stopped with the usual Continue and Retry.
  import { onDestroy } from 'svelte'
  import type { UsagePause } from '@shared/usage'
  import { limitName, whenPhrase } from '@shared/usage'
  import { fade } from '@/lib/motion'
  import { meter } from '@/lib/meter.svelte'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let { pause }: { pause: UsagePause } = $props()
  let now = $state(Date.now())
  const ticker = setInterval(() => (now = Date.now()), 15_000)
  onDestroy(() => clearInterval(ticker))
</script>

<div class="pause flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] px-3.5 py-2.5 text-[13px]" data-limit-pause role="status" in:fade>
  <span class="grid shrink-0 place-items-center text-danger"><Icon name="gauge" size={15} /></span>
  <span class="min-w-0 flex-1 leading-snug">
    <b class="font-medium text-fg">Paused at your {limitName(pause.window)}</b>
    <span class="block text-fg-3">
      Your work so far is saved. Tomo continues {whenPhrase(pause.resumeAt, now)}{pause.resetsAt ? ', once the limit resets' : ''}.
    </span>
  </span>
  <span class="flex shrink-0 items-center gap-1">
    <button class="btn solid sm" disabled={app.streaming} onclick={() => meter.continueNow(pause)}>Continue now</button>
    <button class="btn sm" onclick={() => meter.cancel(pause.messageId)}>Cancel</button>
  </span>
</div>

<style>
  .pause {
    background: var(--glass-bg);
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--glass-ring),
      var(--shadow-sm);
  }
</style>
