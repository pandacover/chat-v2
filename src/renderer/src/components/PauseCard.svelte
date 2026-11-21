<script lang="ts">
  import { fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  /**
   * A reply paused because it seemed stuck (main's agent/watch.ts): what was noticed, in plain
   * words, and Continue, which picks the reply up where it stopped with all its work kept.
   */
  let { messageId, reason, busy = false }: { messageId: string; reason: string | null; busy?: boolean } = $props()
</script>

<div
  class="rounded-[var(--r-card)] bg-card px-4 pt-3.5 pb-4 shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)]"
  role="status"
  aria-labelledby="pause-title-{messageId}"
  data-paused
  in:fly={{ y: 4, duration: 220 }}
>
  <div class="mb-2.5 flex h-4 items-center gap-2">
    <span class="mono-label inline-flex items-center gap-1.5"><i class="size-1.5 rounded-full bg-fg-3"></i>Paused</span>
  </div>
  <p id="pause-title-{messageId}" class="mb-1 font-display text-[18px] leading-[1.3] tracking-[-0.015em] text-pretty text-fg">This looked stuck, so I stopped.</p>
  {#if reason}<p class="text-[13.5px] text-fg-2" data-pause-reason>{reason}</p>{/if}
  <p class="mt-1 text-[13.5px] text-fg-3">Everything so far is kept. Continue picks up where it stopped, or tell me what to try instead.</p>
  <div class="mt-3.5 flex items-center gap-2">
    <button class="btn solid sm" disabled={busy} onclick={() => app.continueReply(messageId)}>Continue</button>
    <button class="btn sm" disabled={busy} onclick={() => app.regenerate(messageId)}><Icon name="refresh" size={13} />Retry</button>
  </div>
</div>
