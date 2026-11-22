<script lang="ts" module>
  import type { Presence } from '@shared/types'

  /** What each presence reads as, for labels and tooltips. */
  export const PRESENCE_LABELS: Record<Presence, string> = {
    idle: 'Idle',
    thinking: 'Thinking',
    working: 'Working',
    waiting: 'Waiting for you',
    stuck: 'Stuck',
    done: 'Done'
  }
</script>

<script lang="ts">
  // A bot's picture: Tomo's fox (the Mascot, avatar 'mascot'), a picture, or the name's first letter
  // on one of a few tints of the theme's own colours (@shared/bots). With `presence`, a dot at its
  // foot says what the bot is doing: thinking, working, waiting for you, stuck or done (idle: none).
  import { avatarOf } from '@shared/bots'
  import type { Bot } from '@shared/types'
  import Mascot, { type MascotState } from './Mascot.svelte'

  let {
    bot,
    size = 20,
    state = '',
    presence = null,
    class: klass = ''
  }: { bot: Pick<Bot, 'name' | 'avatar'> | null; size?: number; state?: MascotState; presence?: Presence | null; class?: string } = $props()

  const avatar = $derived(bot ? avatarOf(bot.avatar) : ({ kind: 'mascot' } as const))
  // The fox thinks along while its bot does.
  const mascotState = $derived<MascotState>(state || (presence === 'thinking' || presence === 'working' ? 'thinking' : ''))
  const dot = $derived(Math.max(6, Math.round(size * 0.32)))
</script>

<span class="relative inline-grid shrink-0 {klass}" style="width: {size}px; height: {size}px" data-presence={presence ?? undefined}>
  {#if avatar.kind === 'mascot'}
    <span class="bot-avatar grid size-full place-items-center rounded-full bg-bubble select-none">
      <Mascot size="84%" state={mascotState} alt={bot?.name ?? 'Tomo'} />
    </span>
  {:else if avatar.kind === 'image'}
    <img class="bot-avatar size-full rounded-full object-cover select-none" src={avatar.url} alt={bot!.name} draggable="false" />
  {:else}
    <span
      class="bot-avatar tint-{avatar.tint} grid size-full place-items-center rounded-full font-medium select-none"
      style="font-size: {Math.round(size * 0.5)}px"
      role="img"
      aria-label={bot!.name}>{bot!.name.slice(0, 1).toUpperCase()}</span
    >
  {/if}
  {#if presence && presence !== 'idle'}
    <i class="presence {presence}" style="width: {dot}px; height: {dot}px" aria-label={PRESENCE_LABELS[presence]}></i>
  {/if}
</span>

<style>
  .bot-avatar {
    box-shadow: 0 0 0 1px var(--ring);
  }
  .tint-plain {
    background: var(--wash);
    color: var(--fg-2);
  }
  .tint-blue {
    background: color-mix(in srgb, var(--blue) 16%, var(--card));
    color: var(--blue-fg);
  }
  .tint-green {
    background: color-mix(in srgb, var(--ok) 15%, var(--card));
    color: var(--ok);
  }
  .tint-red {
    background: color-mix(in srgb, var(--danger) 13%, var(--card));
    color: var(--danger);
  }
  .tint-warm {
    background: var(--thumb);
    color: var(--fg-2);
  }
  /* The presence dot sits on the avatar's foot, cut out of it by a ring in the page's colour. */
  .presence {
    position: absolute;
    right: -1px;
    bottom: -1px;
    border-radius: 9999px;
    box-shadow: 0 0 0 1.5px var(--canvas);
  }
  .presence.thinking {
    background: var(--blue);
    animation: breathe 1.6s ease-in-out infinite;
  }
  .presence.working {
    background: var(--blue);
  }
  .presence.waiting {
    background: var(--danger);
  }
  .presence.stuck {
    background: var(--canvas);
    box-shadow:
      inset 0 0 0 1.5px var(--danger),
      0 0 0 1.5px var(--canvas);
  }
  .presence.done {
    background: var(--ok);
  }
  @keyframes breathe {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .presence.thinking {
      animation: none;
    }
  }
</style>
