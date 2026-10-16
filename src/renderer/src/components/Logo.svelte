<script lang="ts">
  import { logoSvg } from '@shared/logo'

  let { size = 24, class: klass = '' }: { size?: number; class?: string } = $props()

  // Dots take the surrounding text colour, so the mark follows the theme.
  const svg = $derived(logoSvg({ size, fill: 'currentColor' }))
</script>

<span class="inline-block shrink-0 leading-none {klass}" style="width: {size}px; height: {size}px" aria-hidden="true">{@html svg}</span>
