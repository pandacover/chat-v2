<script lang="ts" module>
  import fox from '@/assets/logo.png'

  /** '' at rest, 'listening' while the mic is open, 'thinking' while a reply or a transcript is on its way. */
  export type MascotState = '' | 'listening' | 'thinking'
  /** The mascot's image (a transparent 512 px fox), for code that wants the picture alone, such as an avatar. */
  export const mascotUrl = fox
</script>

<script lang="ts">
  /*
   * Tomo's mascot, the fox. It carries the voice states the orb used to: still at rest; listening, it
   * swells and glows with the voice's `level` (or breathes while the mic opens); thinking, it sways
   * with a soft pulsing glow. All of it is CSS transforms and opacity on the image and a glow behind
   * it, so it costs nothing at rest, and it holds still under prefers-reduced-motion.
   */
  let {
    size = 32,
    state = '',
    level,
    alt = '',
    class: cls = ''
  }: {
    /** Pixels, or any CSS length ('100%' fills the parent). */
    size?: number | string
    state?: MascotState
    /** The voice's loudness, 0..1, while listening. Unset, a listening mascot breathes on its own. */
    level?: number
    /** Empty (the default) leaves it decorative; give a name where it stands for someone, as an avatar. */
    alt?: string
    class?: string
  } = $props()

  const px = $derived(typeof size === 'number' ? `${size}px` : size)
  const lvl = $derived(typeof level === 'number' && Number.isFinite(level) ? Math.min(1, Math.max(0, level)).toFixed(3) : '0')
</script>

<span
  class="mascot {cls}"
  class:listening={state === 'listening'}
  class:thinking={state === 'thinking'}
  class:breathe={state === 'listening' && typeof level !== 'number'}
  style="--s: {px}; --lvl: {lvl}"
  role={alt ? 'img' : undefined}
  aria-label={alt || undefined}
  aria-hidden={alt ? undefined : 'true'}
>
  <img src={fox} alt="" draggable="false" />
</span>

<style>
  .mascot {
    --lvl: 0;
    position: relative;
    display: block;
    flex: none;
    width: var(--s);
    height: var(--s);
    user-select: none;
  }
  /* A soft halo in the voice blue behind the fox, off at rest. */
  .mascot::before {
    content: '';
    position: absolute;
    inset: -14%;
    border-radius: 50%;
    background: radial-gradient(closest-side, var(--ripple), transparent);
    opacity: 0;
    transform: scale(0.9);
    transition:
      opacity 300ms var(--ease-studio),
      transform 300ms var(--ease-studio);
    pointer-events: none;
  }
  img {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    transform-origin: 50% 85%;
    transition: transform 160ms var(--ease-studio);
    pointer-events: none;
  }

  /* Listening: the fox swells a little, and the halo with it, as the voice gets louder. */
  .listening::before {
    opacity: calc(0.3 + var(--lvl) * 0.7);
    transform: scale(calc(0.92 + var(--lvl) * 0.22));
    transition-duration: 160ms;
  }
  .listening img {
    transform: translateY(calc(var(--lvl) * -3%)) scale(calc(1 + var(--lvl) * 0.12));
  }
  /* The mic is opening (no level yet): it breathes. */
  .breathe::before,
  .thinking::before {
    animation: mascot-glow 2.4s ease-in-out infinite;
  }
  .breathe img {
    animation: mascot-breathe 2.4s ease-in-out infinite;
  }
  /* Thinking: a slow sway from where it sits, and a pulsing halo. */
  .thinking::before {
    animation-duration: 1.8s;
  }
  .thinking img {
    animation: mascot-think 1.8s ease-in-out infinite;
  }

  @keyframes mascot-glow {
    0%,
    100% {
      opacity: 0.2;
      transform: scale(0.9);
    }
    50% {
      opacity: 0.6;
      transform: scale(1);
    }
  }
  @keyframes mascot-breathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.04);
    }
  }
  @keyframes mascot-think {
    0%,
    100% {
      transform: rotate(-4deg);
    }
    50% {
      transform: rotate(4deg) translateY(-3%);
    }
  }

  /* Reduced motion: no movement; the halo alone says it listens or thinks. */
  @media (prefers-reduced-motion: reduce) {
    .mascot::before,
    .mascot img {
      animation: none !important;
      transition: none !important;
    }
    .mascot img {
      transform: none !important;
    }
    .listening::before,
    .thinking::before {
      opacity: 0.45;
      transform: none;
    }
  }
</style>
