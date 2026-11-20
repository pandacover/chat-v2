<script lang="ts">
  import { APPROVE_ARM_MS, type ComputerWait } from '@shared/computer'
  import { modKey, shortcut } from '@/lib/keys'
  import { fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'

  /** What computer use waits on in this reply: an approval, or a Show-me step for the user to do. */
  let { wait }: { wait: NonNullable<ComputerWait> } = $props()

  // Approve arms after a short beat, so a key pressed for something else can't say yes (the notch's too).
  const ARM_MS = APPROVE_ARM_MS
  let armed = $state(false)
  $effect(() => {
    void wait.id
    armed = false
    const t = setTimeout(() => (armed = true), ARM_MS)
    return () => clearTimeout(t)
  })

  const onkeydown = (e: KeyboardEvent) => {
    if (wait.kind !== 'approval') return
    if (e.key === 'Enter' && modKey(e)) {
      e.preventDefault()
      if (armed) void app.approve(wait.id, true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      void app.approve(wait.id, false)
    }
  }
</script>

<svelte:window {onkeydown} />

<div
  class="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--muted)]"
  role={wait.kind === 'approval' ? 'alertdialog' : 'status'}
  aria-labelledby="wait-title"
  data-computer-wait={wait.kind}
  in:fly={{ y: 4, duration: 220 }}
>
  <div class="min-w-0 flex-1 basis-60">
    <span class="text-[12px] text-muted">{wait.kind === 'approval' ? 'Needs your OK' : `Step ${wait.step} of ${wait.total}`}</span>
    <p id="wait-title" class="mt-0.5 text-[15px] leading-snug font-medium text-fg">{wait.kind === 'approval' ? wait.title : wait.instruction}</p>
    {#if wait.kind === 'approval' && wait.detail}
      <pre class="mt-2 max-h-24 overflow-auto rounded-md bg-bg px-2.5 py-2 font-mono text-[11.5px] leading-normal break-all whitespace-pre-wrap text-fg-2">{wait.detail}</pre>
    {:else if wait.kind === 'teach'}
      <p class="mt-0.5 text-[12px] text-muted">Do it on screen, then press Done. Or type what happened, or “just do it”.</p>
    {/if}
  </div>
  <div class="flex shrink-0 items-center gap-1 text-[13px]">
    {#if wait.kind === 'approval'}
      <button class="rounded-md px-3 py-1.5 text-fg-2 hover:bg-hover hover:text-fg" onclick={() => app.approve(wait.id, false)}>
        Deny <kbd class="ml-1 text-[11px] opacity-60">Esc</kbd>
      </button>
      <button
        class="relative overflow-hidden rounded-md px-3.5 py-1.5 font-medium text-bg transition-colors {armed ? 'bg-fg' : 'bg-fg/55'}"
        disabled={!armed}
        onclick={() => app.approve(wait.id, true)}
      >
        <!-- Arming: the button fills from the left, then takes clicks. -->
        {#if !armed}<span class="absolute inset-0 origin-left bg-fg [animation:arm_var(--arm)_linear_both]" style="--arm:{ARM_MS}ms" aria-hidden="true"></span>{/if}
        <span class="relative">Approve <kbd class="ml-1 text-[11px] opacity-70">{shortcut('↵')}</kbd></span>
      </button>
    {:else}
      <button class="rounded-md px-3 py-1.5 text-fg-2 hover:bg-hover hover:text-fg" onclick={() => app.stop()}>Stop lesson</button>
      <button class="rounded-md bg-fg px-3.5 py-1.5 font-medium text-bg" onclick={() => app.teachDone(wait.id)}>Done</button>
    {/if}
  </div>
</div>

<style>
  @keyframes -global-arm {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
</style>
