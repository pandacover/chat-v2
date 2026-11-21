<script lang="ts">
  // A thin bar for how full a usage window is: quiet while there's room, the danger colour near
  // the limit and at it.
  import { tone } from '@shared/usage'

  let { percent, class: klass = '' }: { percent: number | null; class?: string } = $props()
  const t = $derived(tone(percent))
  const width = $derived(Math.max(0, Math.min(100, percent ?? 0)))
</script>

<span class="bar {klass}" data-tone={t} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
  <i style="width: {width}%"></i>
</span>

<style>
  .bar {
    position: relative;
    display: block;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--wash);
    box-shadow: inset 0 0 0 1px var(--ring);
  }
  i {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--fg-3);
    transition: width 300ms var(--ease-studio);
  }
  [data-tone='near'] i {
    background: color-mix(in srgb, var(--danger) 75%, var(--fg-3));
  }
  [data-tone='full'] i {
    background: var(--danger);
  }
</style>
