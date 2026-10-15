<script lang="ts">
  import { renderMarkdown } from '@/lib/markdown'

  let { source, streaming = false, live = false }: { source: string; streaming?: boolean; live?: boolean } = $props()

  const html = $derived(renderMarkdown(source, streaming))
  let el: HTMLDivElement | undefined = $state()
  let seen = 0
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')

  // {@html} rebuilds the whole block on every line, so CSS animations would replay on
  // everything. Instead, ease in only the blocks that did not exist before this line.
  $effect(() => {
    void html
    const node = el
    if (!node) return
    const count = node.children.length
    if (live && !reduce.matches) {
      for (let i = seen; i < count; i++) {
        node.children[i]?.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], {
          duration: 240,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
        })
      }
    }
    seen = count
  })

  const onclick = async (e: MouseEvent) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]')
    if (!button) return
    const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? ''
    await navigator.clipboard.writeText(code)
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = 'Copy'), 1400)
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="prose-chat" bind:this={el} {onclick}>{@html html}</div>
