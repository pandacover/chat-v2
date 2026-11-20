<script lang="ts">
  import { APPROVE_ARM_MS, type ComputerWait } from '@shared/computer'
  import { modKey, shortcut } from '@/lib/keys'
  import { fly, slide } from '@/lib/motion'
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

  /** Keys pressed with focus in the card: Enter approves, Escape denies. */
  const oncardkey = (e: KeyboardEvent) => {
    if (wait.kind !== 'approval') return
    if (e.key === 'Enter' && modKey(e)) {
      e.preventDefault()
      e.stopPropagation()
      if (armed) void app.approve(wait.id, true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      void app.approve(wait.id, false)
    }
  }

  /**
   * Keys pressed elsewhere. Escape denies only if nothing else used it (cancelling a recording,
   * closing a dialog, a panel or an edit), so it waits until every handler has seen the key.
   */
  const onwindowkey = (e: KeyboardEvent) => {
    if (wait.kind !== 'approval') return
    if (e.key === 'Enter' && modKey(e)) {
      e.preventDefault()
      if (armed) void app.approve(wait.id, true)
    } else if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) {
      const id = wait.id
      setTimeout(() => {
        if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
        if (wait.kind === 'approval' && wait.id === id) void app.approve(id, false)
      })
    }
  }
  /** A shortcut as key chips: "Ctrl ↵" → Ctrl, ↵. */
  const keys = (s: string) => s.split(' ').filter(Boolean)
  /** Past this many steps the dashes would crowd the line; the count alone says it (as on the overlay's callout). */
  const MAX_DASHES = 8
</script>

<svelte:window onkeydown={onwindowkey} />

<!-- It folds away when the wait is over (an outro; Svelte makes it inert meanwhile). -->
<div
  class="rounded-lg bg-surface px-4 pt-3 pb-3 shadow-[0_0_0_1px_var(--line),var(--shadow)]"
  role={wait.kind === 'approval' ? 'alertdialog' : 'status'}
  aria-labelledby="wait-title"
  data-computer-wait={wait.kind}
  tabindex="-1"
  onkeydown={oncardkey}
  in:fly={{ y: 4, duration: 220 }}
  out:slide={{ duration: 180 }}
>
  <div class="flex h-5 items-center gap-2 text-[12px] text-muted">
    <span class="cu-dot small waiting text-fg-2"></span>
    {#if wait.kind === 'approval'}
      <span>Needs your OK</span>
    {:else}
      <span class="tabular-nums">Step <span class="text-fg-2">{wait.step}</span> of {wait.total}</span>
      {#if wait.total <= MAX_DASHES}
        <span class="cu-dashes ml-auto" aria-hidden="true">{#each Array(wait.total) as _, i (i)}<i class:on={i < wait.step}></i>{/each}</span>
      {/if}
    {/if}
  </div>
  <p id="wait-title" class="mt-1.5 text-[16px] leading-snug font-[450] tracking-[-0.01em] text-pretty text-fg">{wait.kind === 'approval' ? wait.title : wait.instruction}</p>
  {#if wait.kind === 'approval' && wait.detail}
    <pre
      class="mt-2.5 max-h-24 overflow-auto rounded-[10px] bg-bg px-3 py-2 font-mono text-[11.5px] leading-normal break-all whitespace-pre-wrap text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">{wait.detail}</pre>
  {:else if wait.kind === 'teach'}
    <p class="mt-1 text-[12.5px] text-muted">Do it on screen, then press Done. Or type what happened, or “just do it”.</p>
  {/if}
  <div class="mt-3 flex items-center justify-end gap-1.5">
    {#if wait.kind === 'approval'}
      <button class="cu-btn line" onclick={() => app.approve(wait.id, false)}>
        Deny <kbd class="cu-kbd text-muted">Esc</kbd>
      </button>
      {#key wait.id}
        <button class="cu-btn primary" class:arming={!armed} disabled={!armed} onclick={() => app.approve(wait.id, true)}>
          <!-- Arming: the pill fills from the left, then takes clicks. -->
          {#if !armed}<span class="cu-fill" style="--arm:{ARM_MS}ms" aria-hidden="true"></span>{/if}
          <span class="cu-label">Approve <span class="cu-keys">{#each keys(shortcut('↵')) as k (k)}<kbd class="cu-kbd">{k}</kbd>{/each}</span></span>
        </button>
      {/key}
    {:else}
      <button class="cu-btn" onclick={() => app.stop()}>Stop lesson</button>
      <button class="cu-btn primary" onclick={() => app.teachDone(wait.id)}>Done</button>
    {/if}
  </div>
</div>
