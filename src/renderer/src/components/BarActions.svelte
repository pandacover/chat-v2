<script lang="ts">
  // The app bar's right end: what acts on the open conversation and the window, in the same row as
  // the sidebar toggle at the left. The job's own instructions (in a job's thread), keeping the
  // window on top, and the right panel's toggle, always last, mirroring the sidebar's. The row is
  // anchored at its right end, so the one button that comes and goes (the instructions) is first:
  // it moves nothing to its right. On Windows the row stops short of the window's buttons
  // (--bar-right); a Mac has its traffic lights at the left, so it runs to the edge.
  import { tip } from '@/lib/tooltip'
  import { dimsBar } from '@/lib/theme.svelte'
  import { fade, pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { voice } from '@/lib/voice.svelte'
  import Icon from './Icon.svelte'

  /** Voice on a new chat clears the stage: the bar's actions step back, as the chat's header did. */
  const stage = $derived((!app.view || app.view.path.length === 0) && !app.pending && voice.home !== 'off')
  const hasOverride = $derived(app.chat.systemPrompt != null)

  let promptOpen = $state(false)
  let promptDraft = $state('')
  const openPrompt = () => {
    promptDraft = app.chat.systemPrompt ?? app.primaryBot?.instructions ?? app.settings?.settings.systemPrompt ?? ''
    promptOpen = true
  }
  const savePrompt = async (value: string | null) => {
    promptOpen = false
    await app.updateSession({ systemPrompt: value })
  }
</script>

<div
  class="app-no-drag bar-controls fixed top-0.5 z-[45] flex gap-0.5 transition-opacity duration-300 ease-out {stage ? 'pointer-events-none opacity-0' : ''}"
  style="right: calc(var(--bar-right) + 10px)"
  data-bar-actions
>
  <!-- The primary's instructions are its bot's, in Settings; a job's thread can have its own. -->
  {#if app.view && !app.isPrimary}
    <button class="icon-btn relative size-8 {hasOverride ? '!text-fg' : ''}" use:tip={'Instructions for this job'} onclick={openPrompt} in:fade={{ duration: 160 }}>
      <Icon name="settings" size={16} />
      {#if hasOverride}<span class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-fg"></span>{/if}
    </button>
  {/if}
  {#if app.settings}
    {@const onTop = app.settings.settings.alwaysOnTop}
    <button
      class="icon-btn size-8 {onTop ? '!text-fg' : ''}"
      aria-pressed={onTop}
      use:tip={onTop ? 'Unpin window' : 'Keep on top of other apps'}
      onclick={() => app.setPinned(!onTop)}
    >
      <Icon name="pin" size={16} class="transition-transform duration-200 {onTop ? '' : 'rotate-45'}" />
    </button>
  {/if}
  <!-- The right panel's one toggle, mirroring the sidebar's: it shows or hides the panel, its tabs
       kept. The browser and the chat's artifacts open from the + in the panel's tab strip. -->
  <button
    class="icon-btn relative size-8 {app.panelOpen ? '!text-fg' : ''}"
    aria-pressed={app.panelOpen}
    data-panel-toggle
    use:tip={app.panelOpen ? 'Hide panel' : 'Show panel'}
    onclick={() => app.togglePanel()}
  >
    <Icon name="sidebar" size={16} class="-scale-x-100" />
    <!-- The assistant is using the browser while the panel is hidden. -->
    {#if app.control.active && !app.panelOpen}<span class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-blue"></span>{/if}
  </button>
</div>

{#if promptOpen}
  <div class="fixed inset-0 z-50 grid place-items-center p-6" role="dialog" aria-modal="true" aria-label="Chat instructions">
    <button use:dimsBar class="absolute inset-0 bg-scrim backdrop-blur-[4px]" aria-label="Close" transition:fade={{ duration: 150 }} onclick={() => (promptOpen = false)}></button>
    <div class="glass-strong relative w-full max-w-lg rounded-[20px] p-6" transition:pop>
      <h2 class="font-display text-[22px] leading-tight font-normal tracking-[-0.02em]">Instructions for this job</h2>
      <p class="mt-1 text-[13.5px] text-fg-3">Replace {app.primaryBot?.name ?? 'Tomo'}'s instructions in this job only.</p>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        autofocus
        bind:value={promptDraft}
        rows="9"
        class="mt-4 w-full resize-y rounded-[10px] bg-[var(--glass-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed shadow-[inset_0_0_0_1px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--line-2)]"
        onkeydown={(e) => e.key === 'Escape' && (promptOpen = false)}
      ></textarea>
      <div class="mt-4 flex items-center gap-2">
        {#if hasOverride}
          <button class="btn quiet" onclick={() => savePrompt(null)}>Use {app.primaryBot?.name ?? 'Tomo'}'s</button>
        {/if}
        <button class="btn ml-auto" onclick={() => (promptOpen = false)}>Cancel</button>
        <button class="btn solid" onclick={() => savePrompt(promptDraft)}>Save</button>
      </div>
    </div>
  </div>
{/if}
