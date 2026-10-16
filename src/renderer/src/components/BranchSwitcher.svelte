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
  <div class="flex items-center text-[12px] text-muted tabular-nums" use:tip={'Branches'}>
    <button class="icon-btn !p-1" aria-label="Previous branch" disabled={disabled || node.siblingIndex === 0} onclick={() => go(-1)}>
      <Icon name="chevronLeft" size={13} />
    </button>
    <span class="min-w-7 text-center">{node.siblingIndex + 1} / {node.siblingIds.length}</span>
    <button
      class="icon-btn !p-1"
      aria-label="Next branch"
      disabled={disabled || node.siblingIndex === node.siblingIds.length - 1}
      onclick={() => go(1)}
    >
      <Icon name="chevronRight" size={13} />
    </button>
  </div>
{/if}
