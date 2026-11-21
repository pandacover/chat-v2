<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import type { PathNode } from '@shared/types'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let { node, disabled = false }: { node: PathNode; disabled?: boolean } = $props()

  const go = (delta: number) => {
    const id = node.siblingIds[node.siblingIndex + delta]
    if (id) void app.switchBranch(id)
  }
</script>

{#if node.siblingIds.length > 1}
  <div class="mr-1 flex items-center font-label text-[11.5px] text-fg-3 tabular-nums" use:tip={'Branches'}>
    <button class="icon-btn size-[26px] !rounded-lg" aria-label="Previous branch" disabled={disabled || node.siblingIndex === 0} onclick={() => go(-1)}>
      <Icon name="chevronLeft" size={13} />
    </button>
    <span class="min-w-6 text-center">{node.siblingIndex + 1}/{node.siblingIds.length}</span>
    <button
      class="icon-btn size-[26px] !rounded-lg"
      aria-label="Next branch"
      disabled={disabled || node.siblingIndex === node.siblingIds.length - 1}
      onclick={() => go(1)}
    >
      <Icon name="chevronRight" size={13} />
    </button>
  </div>
{/if}
