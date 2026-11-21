<script lang="ts">
  import { APPROVE_ARM_MS, type ComputerWait } from '@shared/computer'
  import { modKey, shortcut } from '@/lib/keys'
  import { fly, slide } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'

  /** What computer use waits on in this reply: an approval, or a Show-me step for the user to do. */
  let { wait, held = false }: { wait: NonNullable<ComputerWait>; held?: boolean } = $props()

  // Approve arms after a short beat, so a key pressed for something else can't say yes (the notch's too).
  // Main sends the wait again on other changes (a new object each time): only a new id re-arms.
  const ARM_MS = APPROVE_ARM_MS
  const waitId = $derived(wait.id)
  let armed = $state(false)
  $effect(() => {
    void waitId
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
  class="rounded-[var(--r-card)] bg-card px-4 pt-3.5 pb-4 {wait.kind === 'approval'
    ? 'shadow-[0_0_0_1px_color-mix(in_srgb,var(--danger)_35%,transparent),var(--shadow-sm)]'
    : 'shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)]'}"
  role={wait.kind === 'approval' ? 'alertdialog' : 'status'}
  aria-labelledby="wait-title"
  data-computer-wait={wait.kind}
  tabindex="-1"
  onkeydown={oncardkey}
  inert={held}
  in:fly={{ y: 4, duration: 220 }}
  out:slide={{ duration: 200 }}
>
  <div class="mb-2.5 flex h-4 items-center gap-2">
    <span class="mono-label inline-flex items-center gap-1.5 {wait.kind === 'approval' ? '!text-danger' : ''}">
      <i class="size-1.5 rounded-full {wait.kind === 'approval' ? 'bg-danger' : 'bg-fg-3'}"></i>{wait.kind === 'approval' ? 'Needs your OK' : 'Showing you'}
    </span>
    {#if wait.kind === 'teach'}
      <span class="mono-label ml-auto tabular-nums">Step {wait.step} of {wait.total}</span>
    {/if}
  </div>
  <p id="wait-title" class="mb-1 font-display text-[18px] leading-[1.3] tracking-[-0.015em] text-pretty text-fg">{wait.kind === 'approval' ? wait.title : wait.instruction}</p>
  {#if wait.kind === 'approval' && wait.detail}
    <pre
      class="mt-2 max-h-24 overflow-auto rounded-[10px] bg-canvas px-3 py-2 font-mono text-[12px] leading-normal break-all whitespace-pre-wrap text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">{wait.detail}</pre>
  {:else if wait.kind === 'teach'}
    <p class="text-[13.5px] text-fg-3">Do it on screen, then press Done. Or type what happened, or “just do it”.</p>
    {#if wait.total <= MAX_DASHES}
      <div class="mt-3 flex gap-1" aria-hidden="true">{#each Array(wait.total) as _, i (i)}<i class="h-[3px] flex-1 rounded-full {i < wait.step ? 'bg-solid' : 'bg-line'}"></i>{/each}</div>
    {/if}
  {/if}
  <div class="mt-3.5 flex items-center gap-2">
    {#if wait.kind === 'approval'}
      {#key wait.id}
        <button class="cu-btn primary" class:arming={!armed} disabled={!armed} onclick={() => app.approve(wait.id, true)}>
          <!-- Arming: the pill fills from the left, then takes clicks. -->
          {#if !armed}<span class="cu-fill" style="--arm:{ARM_MS}ms" aria-hidden="true"></span>{/if}
          <span class="cu-label">Approve <span class="cu-keys" aria-label={shortcut('↵')}>{#each keys(shortcut('↵')) as k (k)}<kbd class="cu-kbd" aria-hidden="true"
              >{#if k === '↵'}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
                  ><path d="M13 3.5v4.5a2 2 0 0 1-2 2H3.5" /><path d="M6 7.5 3.5 10 6 12.5" /></svg
                >{:else}{k}{/if}</kbd
            >{/each}</span
          ></span>
        </button>
      {/key}
      <button class="cu-btn line" onclick={() => app.approve(wait.id, false)}>
        Deny <kbd class="cu-kbd">Esc</kbd>
      </button>
    {:else}
      <button class="cu-btn primary" onclick={() => app.teachDone(wait.id)}>Done</button>
      <span class="flex-1"></span>
      <button class="cu-btn" onclick={() => app.stop()}>Stop lesson</button>
    {/if}
  </div>
</div>
