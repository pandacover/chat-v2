<script lang="ts">
  // The right panel with nothing open in it: its tab strip (+ alone), and what it can open.
  import type { Snippet } from 'svelte'
  import PanelChoices from './PanelChoices.svelte'

  let { tabs }: { tabs: Snippet } = $props()
</script>

<section class="flex h-full min-w-0 flex-col" aria-label="Panel" data-panel-home>
  <header class="flex h-[52px] shrink-0 items-center gap-1 bg-canvas px-2.5">
    {@render tabs()}
  </header>
  <div class="grid min-h-0 flex-1 place-items-center overflow-y-auto bg-canvas p-6">
    <div class="w-full max-w-[320px]">
      <div class="mb-4 text-center">
        <div class="font-display text-[22px] font-light tracking-[-0.02em]">Nothing open</div>
        <p class="mt-1 text-[13px] text-fg-3">Open the browser, or an artifact from this chat.</p>
      </div>
      <div class="rounded-[14px] bg-card p-1 shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)]">
        <PanelChoices role={undefined} />
      </div>
    </div>
  </div>
</section>
