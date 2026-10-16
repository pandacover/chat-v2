<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { untrack } from 'svelte'
  import { parseContent, type ContentBlock } from '@shared/artifacts'
  import { splitSteps, type Step } from '@shared/steps'
  import StepList from './StepList.svelte'
  import type { PathNode } from '@shared/types'
  import { fade, fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import AttachmentChip from './AttachmentChip.svelte'
  import BranchSwitcher from './BranchSwitcher.svelte'
  import Icon from './Icon.svelte'
  import Markdown from './Markdown.svelte'
  import { usageDetail, usageLabel } from '@/lib/usage'

  let { node, last = false }: { node: PathNode; last?: boolean } = $props()

  const message = $derived(node.message)
  const streaming = $derived(message.status === 'streaming')
  // Lines animate only when they arrive while you watch, never on history or a backfill.
  const live = $derived(streaming && app.liveIds.has(message.id))
  // Browser steps are their own blocks; artifacts are parsed out of the prose between them.
  type Block = ContentBlock | { type: 'steps'; steps: Step[] }
  const blocks = $derived<Block[]>(
    message.role === 'assistant'
      ? splitSteps(message.content).flatMap((seg): Block[] => (seg.type === 'steps' ? [seg] : parseContent(seg.content)))
      : []
  )
  const busy = $derived(app.streaming)
  // The turn you just sent slides in; opening, switching or forking a chat renders still.
  const fresh = untrack(
    () => app.liveIds.has(node.message.id) || (!!node.message.activeChildId && app.liveIds.has(node.message.activeChildId))
  )

  let copied = $state(false)
  let editing = $state(false)
  let draft = $state('')
  let keptAttachments = $state<string[]>([])

  // Open an artifact automatically when it finishes streaming in this window.
  const announced = new Set<string>()
  $effect(() => {
    if (!app.liveIds.has(message.id)) return
    for (const b of blocks) {
      if (b.type === 'artifact' && b.complete && !announced.has(b.identifier)) {
        announced.add(b.identifier)
        // Don't pull focus away from the browser while the agent is using it.
        if (!app.control.active) app.showArtifact({ identifier: b.identifier, messageId: message.id })
      }
    }
  })

  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    copied = true
    setTimeout(() => (copied = false), 1400)
  }

  const startEdit = () => {
    draft = message.content
    keptAttachments = message.attachments.map((a) => a.id)
    editing = true
  }

  const unchanged = () =>
    draft === message.content &&
    keptAttachments.length === message.attachments.length

  const submitEdit = async () => {
    if (!draft.trim() && keptAttachments.length === 0) return
    editing = false
    // Nothing changed: no new branch.
    if (unchanged()) return
    // A state proxy can't cross IPC ("An object could not be cloned").
    await app.edit(message.id, draft, $state.snapshot(keptAttachments))
  }

  const autosize = (el: HTMLTextAreaElement) => {
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 360)}px`
    }
    fit()
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.addEventListener('input', fit)
    return { destroy: () => el.removeEventListener('input', fit) }
  }

  const notice: Record<string, string> = {
    interrupted: 'Interrupted when the app closed.',
    stopped: 'Stopped.',
    error: 'Something went wrong.'
  }

  const lines = (s: string) => {
    const n = s.split('\n').length
    return `${n} ${n === 1 ? 'line' : 'lines'}`
  }
</script>

{#if message.role === 'user'}
  <div class="group flex flex-col gap-1.5" in:fly={{ y: 8, duration: fresh ? 240 : 0 }}>
    {#if message.attachments.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each editing ? message.attachments.filter((a) => keptAttachments.includes(a.id)) : message.attachments as a (a.id)}
          <AttachmentChip
            attachment={a}
            onremove={editing ? () => (keptAttachments = keptAttachments.filter((id) => id !== a.id)) : undefined}
          />
        {/each}
      </div>
    {/if}

    {#if message.content || editing}
      <!-- The same box switches between text and textarea, so editing does not move anything. -->
      <div
        class="rounded-lg bg-hover transition-shadow duration-150 {editing
          ? 'shadow-[0_0_0_1px_var(--muted)]'
          : busy
            ? ''
            : 'cursor-text hover:shadow-[0_0_0_1px_var(--line)]'}"
      >
        {#if editing}
          <textarea
            use:autosize
            rows="1"
            bind:value={draft}
            aria-label="Edit message"
            class="block w-full resize-none bg-transparent px-3.5 py-2 text-[14.5px] leading-[1.6] text-fg outline-none"
            onkeydown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                submitEdit()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                editing = false
              }
            }}
            onblur={(e) => {
              // Leaving an untouched edit just closes it; a changed draft stays open.
              const next = e.relatedTarget as HTMLElement | null
              if (!unchanged() || next?.closest('[data-edit-actions]')) return
              editing = false
            }}
          ></textarea>
        {:else}
          <div
            role="button"
            tabindex={busy ? -1 : 0}
            aria-label="Edit message"
            class="px-3.5 py-2 text-[14.5px] leading-[1.6] whitespace-pre-wrap text-fg outline-none"
            onclick={() => {
              // Selecting text to copy should not flip the message into edit mode.
              if (!getSelection()?.isCollapsed) return
              if (!busy) startEdit()
            }}
            onkeydown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                e.preventDefault()
                startEdit()
              }
            }}
          >
            {message.content}
          </div>
        {/if}
      </div>
    {/if}

    {#if editing}
      <div class="flex h-7 items-center gap-1 text-[12.5px]" data-edit-actions in:fade={{ duration: 120 }}>
        <button class="rounded-md bg-fg px-2.5 py-1 font-medium text-bg disabled:opacity-40" disabled={busy} onclick={submitEdit}>Send</button>
        <button class="rounded-md px-2.5 py-1 text-fg-2 hover:bg-hover hover:text-fg" onclick={() => (editing = false)}>Cancel</button>
        <span class="ml-1.5 text-muted">Sends as a new branch</span>
      </div>
    {:else}
      <div class="-ml-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <button class="icon-btn !p-1" use:tip={copied ? 'Copied' : 'Copy'} onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
        <button class="icon-btn !p-1" use:tip={'Edit (creates a branch)'} disabled={busy} onclick={startEdit}><Icon name="edit" size={14} /></button>
        <BranchSwitcher {node} disabled={busy} />
      </div>
    {/if}
  </div>
{:else if message.role === 'assistant'}
  <div class="group flex flex-col gap-3" in:fade={{ duration: fresh ? 200 : 0 }}>
    {#each blocks as block, i (i)}
      {#if block.type === 'text'}
        <Markdown source={block.content} streaming={streaming && i === blocks.length - 1} live={live && i === blocks.length - 1} />
      {:else if block.type === 'steps'}
        <StepList steps={block.steps} {live} running={streaming && i === blocks.length - 1} done={!streaming} />
      {:else}
        {@const active = app.artifact?.identifier === block.identifier && app.artifact?.messageId === message.id}
        <button
          class="group/card relative flex w-full max-w-sm items-center gap-3 overflow-hidden rounded-lg py-2.5 pr-3 pl-2.5 text-left transition-[background-color,box-shadow] duration-150 {active
            ? 'bg-surface shadow-[0_0_0_1px_var(--muted)]'
            : 'bg-surface shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--muted)]'}"
          disabled={!block.complete}
          onclick={() => app.showArtifact({ identifier: block.identifier, messageId: message.id })}
        >
          <span class="grid size-9 place-items-center rounded-md bg-hover text-fg-2"><Icon name="window" size={17} /></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13.5px] font-medium text-fg">{block.title}</span>
            <span class="block text-[12px] text-muted">
              {#if block.complete}HTML · {lines(block.content)}{:else}Writing… {lines(block.content)}{/if}
            </span>
          </span>
          {#if block.complete}
            <span class="text-[12px] text-muted transition-colors group-hover/card:text-fg">{active ? 'Open' : 'View'}</span>
          {:else}
            <span class="absolute inset-x-0 bottom-0 h-px overflow-hidden"><span class="block h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] bg-fg-2"></span></span>
          {/if}
        </button>
      {/if}
    {/each}

    {#if streaming && app.control.active && blocks.at(-1)?.type !== 'steps'}
      <StepList steps={[]} live running />
    {:else if streaming && blocks.length === 0}
      <div class="thinking py-1 text-[13.5px]" aria-live="polite">Thinking</div>
    {/if}

    {#if message.status === 'interrupted' || message.status === 'stopped' || message.status === 'error'}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] {message.status === 'error' ? 'text-danger' : 'text-muted'}" in:fade>
        <span class="flex items-center gap-1.5">
          {#if message.status === 'error'}<Icon name="alert" size={14} />{/if}
          {notice[message.status]}
          {#if message.error}<span class="text-fg-2">{message.error}</span>{/if}
        </span>
        <span class="flex items-center gap-1">
          {#if message.status !== 'error' || message.content}
            <button class="rounded-md px-2 py-0.5 font-medium text-fg hover:bg-hover disabled:opacity-40" disabled={busy} onclick={() => app.continueReply(message.id)}>
              Continue
            </button>
          {/if}
          <button class="rounded-md px-2 py-0.5 text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-40" disabled={busy} onclick={() => app.regenerate(message.id)}>
            Retry
          </button>
        </span>
      </div>
    {/if}

    {#if !streaming}
      <div
        class="-ml-1 flex h-6 items-center gap-0.5 transition-opacity duration-150 {last
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}"
      >
        <button class="icon-btn !p-1" use:tip={copied ? 'Copied' : 'Copy'} onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
        <button class="icon-btn !p-1" use:tip={'Regenerate (creates a branch)'} disabled={busy} onclick={() => app.regenerate(message.id)}>
          <Icon name="refresh" size={14} />
        </button>
        <button class="icon-btn !p-1" use:tip={'Fork into a new chat from here'} onclick={() => app.fork(message.id)}>
          <Icon name="branch" size={14} />
        </button>
        <BranchSwitcher {node} disabled={busy} />
        {#if message.model}<span class="ml-2 truncate text-[11.5px] text-muted">{message.model}</span>{/if}
        {#if message.usage}
          <span class="px-0.5 text-[11.5px] text-muted/60" aria-hidden="true">·</span>
          <span class="shrink-0 text-[11.5px] text-muted tabular-nums" use:tip={usageDetail(message.usage)} in:fade={{ duration: 200 }}>{usageLabel(message.usage)}</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}
