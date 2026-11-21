<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { untrack } from 'svelte'
  import { parseContentCached, type ContentBlock } from '@shared/artifacts'
  import { modelName } from '@shared/models'
  import { splitSteps, type Step } from '@shared/steps'
  import { stopShortcutLabel } from '@shared/computer'
  import { isMac } from '@/lib/keys'
  import ComputerWaitCard from './ComputerWaitCard.svelte'
  import LimitPause from './LimitPause.svelte'
  import { meter } from '@/lib/meter.svelte'
  import PauseCard from './PauseCard.svelte'
  import StepList from './StepList.svelte'
  import type { Attachment, PathNode } from '@shared/types'
  import { collapse, fade, fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import AttachmentChip from './AttachmentChip.svelte'
  import BranchSwitcher from './BranchSwitcher.svelte'
  import Icon from './Icon.svelte'
  import Markdown from './Markdown.svelte'
  import Mascot from './Mascot.svelte'
  import { usageDetail, usageShort } from '@/lib/usage'
  import { listEditing } from '@/lib/textarea'

  let {
    node,
    last = false,
    far = false
  }: {
    node: PathNode
    last?: boolean
    /** Well before the end of the chat: skips layout and paint while off-screen (app.css .far). */
    far?: boolean
  } = $props()

  const message = $derived(node.message)
  const streaming = $derived(message.status === 'streaming')
  /** Paused at a usage limit: stopped, and goes on by itself once it resets (lib/meter.svelte.ts). A stuck pause is status 'paused'. */
  const limitPause = $derived(message.status === 'stopped' ? meter.pauseFor(message.id) : null)
  // Lines animate only when they arrive while you watch, never on history or a backfill.
  const live = $derived(streaming && app.liveIds.has(message.id))
  // Browser steps are their own blocks; artifacts are parsed out of the prose between them.
  type Block = ContentBlock | { type: 'steps'; steps: Step[] }
  const blocks = $derived<Block[]>(
    message.role === 'assistant'
      ? splitSteps(message.content).flatMap((seg, i): readonly Block[] =>
          // Keyed by where the text is, so the reply being written replaces its cached parse.
          seg.type === 'steps' ? [seg] : parseContentCached(seg.content, seg.content === message.content ? message.id : `${message.id}:${i}`)
        )
      : []
  )
  const busy = $derived(app.streaming)
  /** What computer use waits on in this reply. */
  const wait = $derived(app.computerWait?.messageId === message.id ? app.computerWait : null)
  // The Stop shortcut works while another app covers the chat; say so while a computer reply runs.
  const computerRun = $derived(streaming && app.chat.computerEnabled && app.computerSupported)
  /** The computer tool this reply runs now; while a card asks something, the card says it. */
  const doing = $derived(streaming && !wait ? (app.computerDoing.get(message.id) ?? null) : null)
  /**
   * The wait the card shows. A Show-me step that ends is held WAIT_HOLD ms (inert), so a next step
   * that follows at once updates the same card instead of folding it away and back in.
   */
  const WAIT_HOLD = 200
  let shownWait = $state(untrack(() => wait))
  let waitHeld = $state(false)
  let waitRelease: ReturnType<typeof setTimeout> | undefined
  $effect.pre(() => {
    const w = wait
    untrack(() => {
      clearTimeout(waitRelease)
      if (w || shownWait?.kind !== 'teach' || !streaming) {
        shownWait = w
        waitHeld = false
        return
      }
      waitHeld = true
      waitRelease = setTimeout(() => {
        shownWait = null
        waitHeld = false
      }, WAIT_HOLD)
    })
  })
  $effect(() => () => clearTimeout(waitRelease))
  /**
   * The Computer line before the reply's first step lands. Once up it stays (as "Working") until
   * that step is in, so a moment between tools, with nothing running, doesn't swap it for
   * "Thinking" and back.
   */
  const hasSteps = $derived(blocks.some((b) => b.type === 'steps'))
  let computerLatched = $state(false)
  $effect.pre(() => {
    const on = streaming && (app.control.active || !!doing) && !hasSteps
    const still = streaming
    untrack(() => {
      if (!still) computerLatched = false
      else if (on) computerLatched = true
    })
  })
  const placeholder = $derived(streaming && blocks.at(-1)?.type !== 'steps' && (app.control.active || !!doing || (computerLatched && !hasSteps)))
  /** Doing it, or showing how: read from the message, and switchable while the reply runs. */
  const mode = $derived(computerRun ? (app.computerModes.get(message.id) ?? null) : null)
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

  const saveImage = async (a: Attachment) => {
    const path = await app.attempt(() => window.api.attachments.saveAs(a.id, a.name))
    if (path) app.toast(`Saved to ${path}`, 'info')
  }

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

  // Counted, not split: an artifact being written is counted again on every line.
  const lines = (s: string) => {
    let n = 1
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
    return `${n} ${n === 1 ? 'line' : 'lines'}`
  }
</script>

{#if message.role === 'user'}
  <div class="msg user group flex flex-col items-end gap-1.5 {far ? 'far' : ''}" in:fly={{ y: 8, duration: fresh ? 240 : 0 }}>
    {#if message.attachments.length > 0}
      <div class="flex flex-wrap justify-end gap-1.5">
        {#each editing ? message.attachments.filter((a) => keptAttachments.includes(a.id)) : message.attachments as a (a.id)}
          <AttachmentChip
            attachment={a}
            onremove={editing ? () => (keptAttachments = keptAttachments.filter((id) => id !== a.id)) : undefined}
          />
        {/each}
      </div>
    {/if}

    <div class="flex w-full flex-row-reverse items-end gap-1">
    {#if message.content || editing}
      <!-- The same box switches between text and textarea, so editing does not move anything. -->
      <div
        class="min-w-0 rounded-[18px_18px_6px_18px] bg-bubble transition-shadow duration-150 {editing
          ? 'w-full shadow-[0_0_0_1px_var(--ring-2)]'
          : busy
            ? 'max-w-[80%]'
            : 'max-w-[80%] cursor-text hover:shadow-[0_0_0_1px_var(--ring)]'}"
      >
        {#if editing}
          <textarea
            use:autosize
            use:listEditing
            rows="1"
            bind:value={draft}
            aria-label="Edit message"
            class="block w-full resize-none bg-transparent px-4 py-2.5 text-[15px] leading-normal text-fg outline-none"
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
            class="px-4 py-2.5 text-[15px] leading-normal break-words whitespace-pre-wrap text-fg outline-none"
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

    {#if !editing}
      <div class="flex h-[26px] shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <BranchSwitcher {node} disabled={busy} />
        <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Edit · makes a branch'} disabled={busy} onclick={startEdit}><Icon name="edit" size={14} /></button>
        <button class="icon-btn size-[26px] !rounded-lg" use:tip={copied ? 'Copied' : 'Copy'} onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
      </div>
    {/if}
    </div>

    {#if editing}
      <div class="flex items-center gap-1.5" data-edit-actions in:fade={{ duration: 120 }}>
        <span class="mr-1.5 text-[12.5px] text-fg-3">Sends as a new branch</span>
        <button class="btn sm" onclick={() => (editing = false)}>Cancel</button>
        <button class="btn solid sm" disabled={busy} onclick={submitEdit}>Send</button>
      </div>
    {/if}
  </div>
{:else if message.role === 'assistant'}
  <!-- data-reply-scope: text selected in here can be quoted in a reply (SelectionReply). -->
  <div class="msg group flex flex-col gap-3 {far ? 'far' : ''}" data-reply-scope in:fade={{ duration: fresh ? 200 : 0 }}>
    {#each blocks as block, i (i)}
      {#if block.type === 'text'}
        <Markdown source={block.content} streaming={streaming && i === blocks.length - 1} live={live && i === blocks.length - 1} />
      {:else if block.type === 'steps'}
        <StepList steps={block.steps} {live} running={streaming && i === blocks.length - 1} done={!streaming} doing={i === blocks.length - 1 ? doing : null} />
      {:else}
        {@const active = app.artifact?.identifier === block.identifier && app.artifact?.messageId === message.id}
        <button
          class="group/card relative flex w-full max-w-[400px] items-center gap-3 overflow-hidden rounded-[14px] bg-card py-[7px] pr-3 pl-[7px] text-left transition-shadow duration-150 {active
            ? 'shadow-[0_0_0_1px_var(--ring-2),var(--shadow-sm)]'
            : 'shadow-[0_0_0_1px_var(--ring),var(--shadow-sm)] hover:shadow-[0_0_0_1px_var(--ring-2),0_6px_18px_-8px_rgb(0_0_0/0.2)]'}"
          disabled={!block.complete}
          aria-current={active || undefined}
          onclick={() => app.showArtifact({ identifier: block.identifier, messageId: message.id })}
        >
          <span class="grid size-10 shrink-0 place-items-center rounded-[10px] text-fg-2" style="background: var(--thumb)"><Icon name="window" size={17} /></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[14px] font-medium text-fg">{block.title}</span>
            <span class="block text-[12px] text-fg-3">
              {#if block.complete}Artifact · HTML · {lines(block.content)}{:else}Writing… {lines(block.content)}{/if}
            </span>
          </span>
          {#if block.complete}
            <Icon name="chevronRight" size={16} class="text-fg-4 transition-colors group-hover/card:text-fg" />
          {:else}
            <span class="absolute inset-x-0 bottom-0 h-px overflow-hidden"><span class="block h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] bg-fg-2"></span></span>
          {/if}
        </button>
      {/if}
    {/each}

    {#if message.attachments.length > 0}
      <!-- Files the assistant made for the user, like a screenshot of the browser. -->
      <div class="flex flex-wrap gap-2">
        {#each message.attachments as a (a.id)}
          {#if a.kind === 'image'}
            <div class="group/shot relative max-w-md overflow-hidden rounded-[14px] shadow-[0_0_0_1px_var(--ring)]" in:fade={{ duration: live ? 200 : 0 }}>
              <img src={window.api.attachments.url(a.id)} alt={a.name} class="block max-h-80 w-auto" />
              <button
                class="btn solid sm absolute top-2 right-2 opacity-0 transition-opacity group-hover/shot:opacity-100 focus-visible:opacity-100"
                use:tip={`Save ${a.name}`}
                onclick={() => saveImage(a)}>Save</button
              >
            </div>
          {:else}
            <AttachmentChip attachment={a} />
          {/if}
        {/each}
      </div>
    {/if}

    {#if shownWait}
      <ComputerWaitCard wait={shownWait} held={waitHeld} />
    {:else if placeholder}
      <StepList steps={[]} live running {doing} />
    {:else if streaming && blocks.length === 0}
      <div class="flex h-[26px] items-center gap-2.5 text-[14px]" aria-live="polite">
        <Mascot size={20} state="thinking" /><span class="thinking">Thinking</span>
      </div>
    {/if}
    {#if computerRun}
      <!-- While a computer reply runs: the Stop shortcut (it works from any app), and the mode this
           reply works in, which a click switches for the rest of the reply. The chip sits at the far
           end, so it can arrive a moment later without moving the line. It folds away with its gap
           when the reply ends, so the reply's text glides up rather than jumping. -->
      <div class="-mt-1 flex h-6 items-center gap-2 text-[12px] text-fg-3" in:fade={{ duration: 200 }} out:collapse>
        <span class="cu-keys text-fg-2" aria-label={stopShortcutLabel(isMac)}>{#each stopShortcutLabel(isMac).split(' ') as k (k)}<kbd class="cu-kbd">{k}</kbd>{/each}</span>
        <span>stops it from any app</span>
        {#if mode}
          <button
            class="cu-btn small line ml-auto"
            data-computer-mode={mode}
            use:tip={mode === 'do' ? 'Show me how instead' : 'Do it for me instead'}
            in:fade={{ duration: 160 }}
            onclick={() => app.setComputerMode(message.id, mode === 'do' ? 'teach' : 'do')}>{mode === 'do' ? 'Doing it' : 'Showing you'}</button
          >
        {/if}
      </div>
    {/if}

    <!-- A reply is paused one way or the other: stuck (status 'paused', PauseCard) or at a usage
         limit (stopped, with a pause that continues by itself at the reset, LimitPause). -->
    {#if limitPause}
      <LimitPause pause={limitPause} />
    {:else if message.status === 'paused'}
      <PauseCard messageId={message.id} reason={message.error} {busy} />
    {:else if message.status === 'interrupted' || message.status === 'stopped' || message.status === 'error'}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] {message.status === 'error' ? 'text-danger' : 'text-fg-3'}" in:fade>
        <span class="flex items-center gap-1.5">
          {#if message.status === 'error'}<Icon name="alert" size={14} />{/if}
          {notice[message.status]}
          {#if message.error}<span class="text-fg-2">{message.error}</span>{/if}
        </span>
        <span class="flex items-center gap-1">
          {#if message.status !== 'error' || message.content}
            <button class="btn solid sm" disabled={busy} onclick={() => app.continueReply(message.id)}>Continue</button>
          {/if}
          <button class="btn sm" disabled={busy} onclick={() => app.regenerate(message.id)}>Retry</button>
        </span>
      </div>
    {/if}

    {#if !streaming}
      <div
        class="-ml-1.5 flex h-[26px] min-w-0 items-center transition-opacity duration-150 select-none {last
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}"
      >
        <BranchSwitcher {node} disabled={busy} />
        <button class="icon-btn size-[26px] !rounded-lg" use:tip={copied ? 'Copied' : 'Copy'} onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
        <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Regenerate · makes a branch'} disabled={busy} onclick={() => app.regenerate(message.id)}>
          <Icon name="refresh" size={14} />
        </button>
        <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Fork into a new chat from here'} onclick={() => app.fork(message.id)}>
          <Icon name="fork" size={14} />
        </button>
        {#if message.model || message.usage}
          <span class="mono-stat ml-2 min-w-0 truncate" use:tip={message.usage ? usageDetail(message.usage) : null} in:fade={{ duration: 200 }}
            >{[message.model ? modelName(message.model) : '', message.usage ? usageShort(message.usage) : ''].filter(Boolean).join(' · ')}</span
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}
