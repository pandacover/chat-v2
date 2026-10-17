<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { tip } from '@/lib/tooltip'
  import { pop } from '@/lib/motion'
  import { citation } from '@/lib/quote'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  // Select text in a reply and a Reply button appears over it. The button opens a one-line
  // input; Enter adds the quote and what was typed to the composer.

  let { scroller, onreply }: { scroller: HTMLElement | undefined; onreply: (block: string) => void } = $props()

  /** The quoted text, kept because opening the input clears the window's selection. */
  let picked = $state<{ text: string; range: Range } | null>(null)
  let writing = $state(false)
  let reply = $state('')
  let pos = $state<{ left: number; top: number } | null>(null)
  let box: HTMLDivElement | undefined = $state()
  let input: HTMLInputElement | undefined = $state()

  const GAP = 8
  // Marks the quoted text while the input has focus (CSS custom highlight, styled in app.css).
  const MARK = 'reply-quote'

  const scopeOf = (node: Node | null) =>
    (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-reply-scope]') ?? null

  /** The window's selection when it is some text inside a single reply. */
  const read = () => {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const scope = scopeOf(sel.anchorNode)
    if (!scope || scope !== scopeOf(sel.focusNode)) return null
    const text = sel.toString().trim()
    return text ? { text, range: sel.getRangeAt(0).cloneRange() } : null
  }

  const close = () => {
    picked = null
    writing = false
    reply = ''
    pos = null
    CSS.highlights?.delete(MARK)
  }

  /**
   * Over the first line of the selection, or under its last line when there is no room above;
   * inside the chat column either way.
   */
  const place = () => {
    if (!picked || !box || !scroller) return
    if (!picked.range.startContainer.isConnected) return close()
    const all = picked.range.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (!writing && (all.bottom < view.top || all.top > view.bottom)) return void (pos = null)
    // A selection that starts at the end of a line has an empty box there; skip it.
    const lines = [...picked.range.getClientRects()].filter((r) => r.width > 1)
    const first = lines[0] ?? all
    const last = lines.at(-1) ?? all
    const { offsetWidth: w, offsetHeight: h } = box
    const above = first.top - GAP - h >= view.top
    const anchor = above ? first : last
    pos = {
      left: Math.min(Math.max(anchor.left + anchor.width / 2 - w / 2, view.left + GAP), view.right - w - GAP),
      top: Math.min(Math.max(above ? first.top - GAP - h : last.bottom + GAP, view.top + GAP), view.bottom - h - GAP)
    }
  }

  let frame = 0
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(place)
  }

  const open = async () => {
    if (!picked) return
    writing = true
    CSS.highlights?.set(MARK, new Highlight(picked.range))
    await tick()
    place()
    input?.focus()
  }

  const submit = () => {
    if (!picked) return
    // With nothing typed, leave the caret on a fresh line under the quote.
    onreply(reply.trim() ? citation(picked.text, reply) : `${citation(picked.text)}\n\n`)
    close()
  }

  $effect(() => {
    const el = scroller
    if (!el) return
    el.addEventListener('scroll', schedule, { passive: true })
    return () => el.removeEventListener('scroll', schedule)
  })

  // Re-measure once the button or the input is on screen.
  $effect(() => {
    void picked
    void writing
    if (box) untrack(place)
  })

  // Switching chats replaces the messages.
  $effect(() => {
    void app.view?.session.id
    untrack(close)
  })
</script>

<svelte:window
  onpointerup={(e) => {
    if (writing || box?.contains(e.target as Node)) return
    // After the browser has settled the selection (a double-click selects on mouseup).
    requestAnimationFrame(() => {
      if (writing) return
      const next = read()
      if (next) picked = next
      else close()
    })
  }}
  onpointerdown={(e) => {
    if (!picked || box?.contains(e.target as Node)) return
    // Dragging the chat's scrollbar to reread something doesn't abandon the reply.
    if (scroller && e.target === scroller && e.offsetX >= scroller.clientWidth) return
    close()
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape' && picked && !writing) close()
  }}
  onresize={schedule}
/>

<svelte:document
  onselectionchange={() => {
    // Typing in the input moves the selection there; only a cleared selection hides the button.
    if (picked && !writing && getSelection()?.isCollapsed) close()
  }}
/>

{#if picked}
  <div
    bind:this={box}
    class="fixed z-30 {pos ? '' : 'invisible'}"
    style="left: {pos?.left ?? 0}px; top: {pos?.top ?? 0}px"
    in:pop={{ duration: 140 }}
  >
    {#if writing}
      <div class="flex w-[360px] max-w-[calc(100vw-32px)] items-center gap-2 rounded-lg bg-surface py-1.5 pr-1.5 pl-3 shadow-[0_0_0_1px_var(--line),var(--shadow)]">
        <Icon name="reply" size={14} class="text-muted" />
        <input
          bind:this={input}
          bind:value={reply}
          placeholder="Reply to this"
          aria-label="Reply to the selected text"
          class="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <button
          class="grid size-7 shrink-0 place-items-center rounded-full bg-fg text-bg transition-transform duration-150 active:scale-95"
          use:tip={{ text: 'Add to your message', kbd: 'Enter' }}
          onclick={submit}
        >
          <Icon name="arrowUp" size={14} stroke={2} />
        </button>
      </div>
    {:else}
      <button
        class="flex h-7 items-center gap-1.5 rounded-full bg-fg pr-3 pl-2.5 text-[12.5px] font-medium text-bg shadow-float transition-transform duration-150 active:scale-95"
        onmousedown={(e) => e.preventDefault()}
        onclick={open}
      >
        <Icon name="reply" size={13} stroke={2} /> Reply
      </button>
    {/if}
  </div>
{/if}
