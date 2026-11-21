<script lang="ts">
  // A bot's picture: Tomo's fox for the primary (avatar 'mascot'), else the name's first letter.
  import type { Bot } from '@shared/types'
  import logo from '@/assets/logo.png'

  let { bot, size = 20, class: klass = '' }: { bot: Pick<Bot, 'name' | 'avatar'> | null; size?: number; class?: string } = $props()

  const mascot = $derived(!bot || bot.avatar === 'mascot')
</script>

{#if mascot}
  <span class="bot-avatar grid shrink-0 place-items-center overflow-hidden rounded-full bg-bubble select-none {klass}" style="width: {size}px; height: {size}px" aria-hidden="true">
    <img src={logo} alt="" draggable="false" class="size-[84%] object-contain" />
  </span>
{:else}
  <span
    class="bot-avatar grid shrink-0 place-items-center rounded-full bg-wash font-medium text-fg-2 select-none {klass}"
    style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.5)}px"
    aria-hidden="true">{bot!.name.slice(0, 1).toUpperCase()}</span
  >
{/if}

<style>
  .bot-avatar {
    box-shadow: 0 0 0 1px var(--ring);
  }
</style>
