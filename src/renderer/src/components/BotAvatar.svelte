<script lang="ts">
  // A bot's picture: Tomo's fox (the Mascot) for the primary (avatar 'mascot'), else the name's first letter.
  import type { Bot } from '@shared/types'
  import Mascot, { type MascotState } from './Mascot.svelte'

  let {
    bot,
    size = 20,
    state = '',
    class: klass = ''
  }: { bot: Pick<Bot, 'name' | 'avatar'> | null; size?: number; state?: MascotState; class?: string } = $props()

  const mascot = $derived(!bot || bot.avatar === 'mascot')
</script>

{#if mascot}
  <span class="bot-avatar grid shrink-0 place-items-center rounded-full bg-bubble select-none {klass}" style="width: {size}px; height: {size}px">
    <Mascot size="84%" {state} alt={bot?.name ?? 'Tomo'} />
  </span>
{:else}
  <span
    class="bot-avatar grid shrink-0 place-items-center rounded-full bg-wash font-medium text-fg-2 select-none {klass}"
    style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.5)}px"
    role="img"
    aria-label={bot!.name}>{bot!.name.slice(0, 1).toUpperCase()}</span
  >
{/if}

<style>
  .bot-avatar {
    box-shadow: 0 0 0 1px var(--ring);
  }
</style>
