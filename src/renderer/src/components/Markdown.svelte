<script module lang="ts">
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
</script>

<script lang="ts">
  import { blockRenderer } from '@/lib/markdown'
  import { highlighter } from '@/lib/highlight.svelte'

  let { source, streaming = false, live = false }: { source: string; streaming?: boolean; live?: boolean } = $props()

  const render = blockRenderer()
  const blocks = $derived(render(source, streaming, highlighter.hljs !== null))
  let el: HTMLDivElement | undefined = $state()
  let seen = 0

  // The block being written is rebuilt on every line, so CSS animations would replay on
  // it. Instead, ease in only the blocks that did not exist before this line.
  $effect(() => {
    void blocks
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

<!-- A code block being written comes in pieces, so the finished ones keep their DOM (lib/markdown.ts WritingCode).
     Each is a block of its own, so a new line lays out only the last piece, not the whole block. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="prose-chat" bind:this={el} {onclick}>{#each blocks as block}{#if typeof block === 'string'}{@html block}{:else}<div class="code-block"><div class="code-head"><span>{block.lang}</span><button type="button" class="copy-code" data-copy>Copy</button></div><pre><code class="hljs">{#each block.chunks as chunk}<span class="piece">{@html chunk}</span>{/each}</code></pre></div>{/if}{/each}</div>

<style>
  .piece {
    display: block;
  }
</style>
