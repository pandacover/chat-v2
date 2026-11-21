<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { untrack } from 'svelte'
  import { stopShortcutLabel } from '@shared/computer'
  import type { Attachment } from '@shared/types'
  import { isMac, modKey, shortcut } from '@/lib/keys'
  import { fade, pop } from '@/lib/motion'
  import { orb } from '@/lib/orb'
  import { app } from '@/lib/store.svelte'
  import { clock, voice } from '@/lib/voice.svelte'
  import { applyEdit, listEditing } from '@/lib/textarea'
  import AttachmentChip from './AttachmentChip.svelte'
  import Icon from './Icon.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import PointButton from './PointButton.svelte'

  let {
    placeholder = 'Message',
    tall = false,
    inChat = true,
    model,
    onmodel,
    browserEnabled = false,
    onbrowser,
    computerEnabled = false,
    oncomputer
  }: {
    placeholder?: string
    /** Home: a taller box. */
    tall?: boolean
    /** In a chat the orb takes the mic's place while it listens; on Home the orb is in the middle. */
    inChat?: boolean
    model: string
    onmodel: (id: string) => void
    browserEnabled?: boolean
    onbrowser: () => void
    computerEnabled?: boolean
    oncomputer: () => void
  } = $props()

  let text = $state('')
  let uploading = $state(0)
  let dragging = $state(false)
  let focused = $state(false)
  let textarea: HTMLTextAreaElement | undefined = $state()
  let fileInput: HTMLInputElement | undefined = $state()

  // Push-to-talk (lib/voice.svelte.ts): hold the mic to talk, or click once to start and again to stop.
  let pressedAt = 0
  let micButton: HTMLButtonElement | undefined = $state()
  const listening = $derived(voice.phase === 'recording' || voice.phase === 'starting' || voice.phase === 'transcribing')
  /** The composer shows the listening line in place of the text (in a chat; Home has the stage). */
  const listenLine = $derived(inChat && listening)

  const busy = $derived(app.streaming)
  // A test, not text.trim(): that copied the whole draft on every key, and a paste can be megabytes.
  const hasText = $derived(/\S/.test(text))
  const canSend = $derived((hasText || app.draftAttachments.length > 0) && uploading === 0 && app.analyzing.size === 0 && !busy)
  // While a Show-me step waits, a message answers it (the reply goes on); attachments stay in the draft.
  const answering = $derived(app.teaching && hasText)
  const computerOn = $derived(computerEnabled && app.computerSupported)
  const stopping = $derived(busy && !answering)

  export const focus = () => textarea?.focus()

  /** Adds a block (such as a quoted reply) after the draft, as one undoable step. */
  export const append = (block: string) => {
    if (!textarea) return
    const head = text.trimEnd()
    const value = head ? `${head}\n\n${block}` : block
    applyEdit(textarea, { value, start: value.length, end: value.length })
    textarea.scrollTop = textarea.scrollHeight
  }

  // Each chat keeps its own unsent text and attachments ('' is the new chat).
  const key = $derived(app.view?.session.id ?? '')
  let loaded: string | null = null
  $effect.pre(() => {
    const next = key
    untrack(() => {
      if (next === loaded) return
      if (loaded !== null) app.parkAttachments(loaded)
      loaded = next
      text = app.draftText(next)
      app.unparkAttachments(next)
    })
  })
  $effect(() => {
    const value = text
    untrack(() => loaded !== null && app.setDraft(loaded, value))
  })
  // The draft was thrown away from the sidebar (or its chat deleted).
  $effect(() => {
    const stored = app.drafts.get(key)
    untrack(() => {
      if (!stored && loaded === key && hasText) text = ''
    })
  })

  const addFiles = async (files: Iterable<File>) => {
    for (const file of files) {
      uploading += 1
      try {
        const data = await file.arrayBuffer()
        const added = await app.attempt(() =>
          window.api.attachments.add({ name: file.name || 'pasted-image.png', mime: file.type, data })
        )
        if (added) {
          app.addDraftAttachment(added)
          if (added.kind === 'audio') void app.analyzeDraft(added, data)
        }
      } finally {
        uploading -= 1
      }
    }
    textarea?.focus()
  }

  const removeAttachment = (a: Attachment) => {
    // A Point's image and note go together.
    const gone = new Set([a.id, app.pointPartner(a.id)].filter((id): id is string => !!id && app.draftAttachments.some((x) => x.id === id)))
    app.draftAttachments = app.draftAttachments.filter((x) => !gone.has(x.id))
    for (const id of gone) void window.api.attachments.discard(id)
  }

  const answer = async () => {
    const body = text
    text = ''
    if (!(await app.send(body, []))) text = body
  }

  const submit = async () => {
    if (answering) return answer()
    if (!canSend) return
    const body = text
    const files = app.draftAttachments
    text = ''
    app.draftAttachments = []
    const ok = await app.send(body, files)
    if (!ok) {
      // Put the draft back so nothing is lost.
      text = body
      app.draftAttachments = files
    }
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const onpaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  // The transcript joins the draft; the voice stage can also clear it (Esc to start over).
  voice.onTranscript = (transcript) => {
    text = hasText ? `${text.trimEnd()} ${transcript}` : transcript
    queueMicrotask(() => textarea?.focus())
  }
  voice.onClear = () => {
    text = ''
  }
  voice.hasText = () => hasText

  const micDown = async (e: PointerEvent) => {
    if (e.button !== 0) return
    if (voice.recording) {
      void voice.finish()
      pressedAt = 0
      return
    }
    pressedAt = Date.now()
    await voice.start()
    // Still pressed once the mic opened: this is push-to-talk.
    if (pressedAt && voice.recording) voice.held = true
  }

  const micUp = () => {
    if (pressedAt && voice.recording && Date.now() - pressedAt > 400) void voice.finish()
    else voice.held = false
    pressedAt = 0
  }

  const onWindowKey = (e: KeyboardEvent) => {
    if (app.settingsOpen || app.findOpen) return
    // Cmd+M on a Mac, Ctrl+M elsewhere.
    if (modKey(e) && e.key.toLowerCase() === 'm') {
      e.preventDefault()
      // Holding the keys down must not flip the mic on and off.
      if (e.repeat) return
      voice.toggle()
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (voice.recording || voice.phase === 'starting') {
        e.preventDefault()
        voice.cancel()
      } else if (voice.home === 'ready' && voice.phase === 'idle') {
        e.preventDefault()
        voice.startOver()
      }
    }
  }

  // A ring leaves the mic's orb on each spike in the voice.
  $effect(() => {
    void voice.spikes
    const host = untrack(() => micButton)
    if (!host || !untrack(() => listenLine) || untrack(() => voice.spikes) === 0) return
    const ring = document.createElement('span')
    ring.className = 'ripple'
    ring.style.setProperty('--rs', '30px')
    ring.style.setProperty('--rg', '1.9')
    host.append(ring)
    ring.addEventListener('animationend', () => ring.remove())
  })

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
</script>

<svelte:window
  onkeydown={onWindowKey}
  ondragover={(e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragging = true
  }}
  ondragleave={(e) => {
    if (!e.relatedTarget) dragging = false
  }}
  ondrop={(e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragging = false
    void addFiles(e.dataTransfer?.files ?? [])
  }}
/>

{#if dragging}
  <div class="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-lg bg-bg/85 shadow-[inset_0_0_0_1.5px_var(--fg-2)]" transition:fade={{ duration: 120 }}>
    <div class="text-center">
      <div class="font-serif text-[22px]">Drop to attach</div>
      <div class="mt-1 text-[13px] text-muted">Images, PDFs, text and code</div>
    </div>
  </div>
{/if}

<div class="composer relative z-0 w-full rounded-[20px] text-left transition-shadow duration-200" class:focused>
  {#if app.draftAttachments.length > 0 || uploading > 0}
    <div class="flex flex-wrap items-center gap-1.5 px-3 pt-3">
      {#each app.draftAttachments as a (a.id)}<AttachmentChip attachment={a} onremove={() => removeAttachment(a)} />{/each}
      {#if uploading > 0}<span class="px-1 text-[12px] text-fg-3" in:fade>Uploading…</span>{/if}
      {#if app.analyzing.size > 0}<span class="thinking px-1 text-[12px]" in:fade>Finding the beat…</span>{/if}
    </div>
  {/if}

  <div class="relative">
    <textarea
      bind:this={textarea}
      bind:value={text}
      use:listEditing
      {onkeydown}
      {onpaste}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      rows="1"
      placeholder={app.teaching ? 'Tell it what happened, or press Done' : placeholder}
      class="fit block max-h-[220px] w-full resize-none bg-transparent px-[18px] pt-[15px] pb-1 text-[15px] leading-normal outline-none placeholder:text-fg-4 {tall ? 'min-h-[78px]' : 'min-h-[52px]'} {listenLine
        ? 'invisible'
        : ''}"
    ></textarea>
    {#if listenLine}
      <!-- Voice in a chat: the orb takes the mic's place, and this line the text's. -->
      <div class="absolute inset-0 flex items-start gap-2.5 px-[18px] pt-[15px] text-[15px]" in:fade={{ duration: 120 }}>
        <span class="thinking">{voice.phase === 'transcribing' ? 'Transcribing' : 'Listening'}</span>
        {#if voice.phase !== 'transcribing'}
          <span class="font-label text-[12.5px] leading-[22px] font-medium text-fg-3 tabular-nums">{clock(voice.elapsed)}</span>
          <kbd class="studio-kbd ml-auto leading-[22px]">{voice.held ? 'Release to transcribe' : 'Esc to cancel'}</kbd>
        {/if}
      </div>
    {/if}
  </div>

  <!-- A container, so the row can drop labels when the composer itself is narrow. -->
  <div class="@container flex items-center gap-1 pt-1.5 pr-2 pb-2 pl-2.5">
    <input
      bind:this={fileInput}
      type="file"
      multiple
      class="hidden"
      onchange={(e) => {
        const input = e.currentTarget
        void addFiles([...(input.files ?? [])]).then(() => (input.value = ''))
      }}
    />
    <button class="icon-btn size-8" use:tip={'Attach files'} onclick={() => fileInput?.click()}><Icon name="paperclip" size={16} /></button>

    <button
      class="toggle"
      role="switch"
      aria-checked={browserEnabled}
      aria-label="Browser"
      use:tip={browserEnabled ? 'The assistant can use the browser in this chat' : 'Let the assistant use the browser in this chat'}
      onclick={onbrowser}
    >
      <Icon name="globe" size={15} /><span class="hidden @sm:inline">Browser</span>
    </button>
    {#if app.computerSupported}
      <button
        class="toggle"
        role="switch"
        aria-checked={computerEnabled}
        aria-label="Computer"
        use:tip={computerEnabled ? 'The assistant can see your screen and use your apps in this chat' : 'Let the assistant see your screen and use your apps in this chat'}
        onclick={oncomputer}
      >
        <Icon name="monitor" size={15} /><span class="hidden @sm:inline">Computer</span>
      </button>
      {#if computerOn}<PointButton onadded={() => textarea?.focus()} />{/if}
    {/if}
    <span class="ml-auto"></span>
    <ModelPicker placement="up" value={model} onchange={onmodel} />
    <button
      bind:this={micButton}
      class="relative grid size-[34px] shrink-0 place-items-center rounded-full text-fg-2 transition-colors select-none hover:bg-wash {!inChat && listening
        ? '!bg-solid !text-on-solid'
        : ''}"
      aria-label={voice.recording ? 'Finish talking' : 'Talk'}
      data-tip-no-label
      use:tip={{ text: 'Voice: hold to talk, or click to start and stop', kbd: shortcut('M') }}
      disabled={voice.phase === 'transcribing'}
      onpointerdown={micDown}
      onpointerup={micUp}
      onpointerleave={micUp}
    >
      {#if listenLine}
        <span
          class="orb"
          style="--s: 32px; --pk: 0.22; --lvl: {voice.level.toFixed(3)}"
          use:orb={{ state: voice.phase === 'transcribing' ? 'thinking' : 'listening', level: voice.recording ? voice.level : undefined }}
        ></span>
      {:else}
        <Icon name="mic" size={18} />
      {/if}
    </button>
    <button
      class="ml-0.5 grid size-[34px] shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-[0.94] {stopping || canSend || answering
        ? 'bg-solid text-on-solid hover:bg-solid-hover'
        : 'bg-wash text-fg-4'}"
      use:tip={stopping
        ? computerOn
          ? { text: 'Stop. Works from any app too', kbd: stopShortcutLabel(isMac) }
          : 'Stop generating'
        : { text: answering ? 'Answer the step' : 'Send', kbd: 'Enter' }}
      disabled={!stopping && !canSend && !answering}
      onclick={() => (stopping ? app.stop() : submit())}
    >
      {#key stopping}
        <span in:pop={{ duration: 160 }}><Icon name={stopping ? 'stop' : 'arrowUp'} size={17} stroke={2} /></span>
      {/key}
      <span class="sr-only">{stopping ? 'Stop' : 'Send'}</span>
    </button>
  </div>
</div>

<style>
  /*
   * Glass, as app.css .glass-float, but the frosting is on a layer behind the content rather than on
   * the box itself: a box with a backdrop filter stops its children's own backdrop filters seeing
   * past it, and the model list (glass too) opens outside the composer.
   */
  .composer {
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--glass-ring),
      var(--shadow-float);
  }
  .composer::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--glass-bg);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
  }
  /* Focused, its ring firms up and a soft halo joins it. */
  .composer.focused {
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--ring-2),
      0 0 0 4px var(--wash),
      var(--shadow-float);
  }
  /*
   * The box grows with its text up to its max-height. Script measured it on every key (height
   * auto, then read scrollHeight), a forced layout of the window each time.
   */
  .fit {
    field-sizing: content;
  }
  .toggle {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: 30px;
    margin-left: 2px;
    padding: 0 11px 0 9px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-3);
    transition:
      background-color 150ms,
      color 150ms;
  }
  .toggle:hover {
    background: var(--wash);
    color: var(--fg);
  }
  .toggle[aria-checked='true'] {
    background: var(--solid);
    color: var(--on-solid);
  }
  @container (width < 24rem) {
    .toggle {
      padding: 0 8px;
    }
  }
</style>
