<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { untrack } from 'svelte'
  import { type ComputerMode, stopShortcutLabel } from '@shared/computer'
  import type { Attachment } from '@shared/types'
  import { isMac, modKey, shortcut } from '@/lib/keys'
  import { fade, pop } from '@/lib/motion'
  import { startRecording, type Recording } from '@/lib/recorder'
  import { app } from '@/lib/store.svelte'
  import { applyEdit, listEditing } from '@/lib/textarea'
  import AttachmentChip from './AttachmentChip.svelte'
  import Icon from './Icon.svelte'
  import ModelPicker from './ModelPicker.svelte'

  let {
    placeholder = 'Message',
    model,
    onmodel,
    browserEnabled = false,
    onbrowser,
    computerEnabled = false,
    oncomputer,
    computerMode = 'do',
    onmode
  }: {
    placeholder?: string
    model: string
    onmodel: (id: string) => void
    browserEnabled?: boolean
    onbrowser: () => void
    computerEnabled?: boolean
    oncomputer: () => void
    computerMode?: ComputerMode
    onmode: (mode: ComputerMode) => void
  } = $props()

  let text = $state('')
  let uploading = $state(0)
  let dragging = $state(false)
  let focused = $state(false)
  let textarea: HTMLTextAreaElement | undefined = $state()
  let fileInput: HTMLInputElement | undefined = $state()

  // Push-to-talk: hold the mic to talk, or click once to start and again to stop.
  let recording = $state<Recording | null>(null)
  let held = $state(false)
  let elapsed = $state(0)
  let transcribing = $state(false)
  let pressedAt = 0
  let startedAt = 0
  // Set while the mic is opening, which includes any permission prompt.
  let starting = false
  let tick: ReturnType<typeof setInterval> | undefined

  const busy = $derived(app.streaming)
  const canSend = $derived((text.trim() !== '' || app.draftAttachments.length > 0) && uploading === 0 && app.analyzing.size === 0 && !busy)
  // While a Show-me step waits, a message answers it (the reply goes on); attachments stay in the draft.
  const answering = $derived(app.teaching && text.trim() !== '')
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

  const fit = () => {
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }

  const oninput = fit

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
      queueMicrotask(fit)
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
      if (!stored && loaded === key && text.trim() !== '') {
        text = ''
        queueMicrotask(fit)
      }
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
    app.draftAttachments = app.draftAttachments.filter((x) => x.id !== a.id)
    void window.api.attachments.discard(a.id)
  }

  const answer = async () => {
    const body = text
    text = ''
    queueMicrotask(fit)
    if (!(await app.send(body, []))) text = body
  }

  const submit = async () => {
    if (answering) return answer()
    if (!canSend) return
    const body = text
    const files = app.draftAttachments
    text = ''
    app.draftAttachments = []
    queueMicrotask(fit)
    const ok = await app.send(body, files)
    if (!ok) {
      // Put the draft back so nothing is lost.
      text = body
      app.draftAttachments = files
      queueMicrotask(fit)
    }
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void submit()
    }
    // Tab switches Do it and Show me, unless it just nested a list item.
    if (e.key === 'Tab' && computerOn && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented) {
      e.preventDefault()
      onmode(computerMode === 'do' ? 'teach' : 'do')
    }
  }

  const onpaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const beginRecording = async () => {
    if (recording || transcribing || starting) return
    if (!app.settings?.hasElevenLabsKey) {
      app.toast('Add an ElevenLabs key in Settings to use voice input.')
      app.settingsOpen = true
      return
    }
    starting = true
    try {
      if (!(await window.api.stt.microphone())) {
        app.toast('Microphone access is off for chat-v2. Turn it on in System Settings → Privacy & Security → Microphone.')
        return
      }
      recording = await startRecording()
      startedAt = Date.now()
      elapsed = 0
      tick = setInterval(() => (elapsed = Math.floor((Date.now() - startedAt) / 1000)), 250)
    } catch (e) {
      app.toast(`Microphone unavailable: ${e instanceof Error ? e.message : e}`)
    } finally {
      starting = false
    }
  }

  const finishRecording = async () => {
    const r = recording
    if (!r) return
    recording = null
    held = false
    clearInterval(tick)
    transcribing = true
    try {
      const audio = await r.stop()
      const transcript = await app.attempt(() => window.api.stt.transcribe(audio.data, audio.mime))
      if (transcript) {
        text = text.trim() ? `${text.trimEnd()} ${transcript}` : transcript
        queueMicrotask(() => {
          fit()
          textarea?.focus()
        })
      } else if (transcript === '') {
        app.toast('No speech detected.', 'info')
      }
    } finally {
      transcribing = false
    }
  }

  const cancelRecording = () => {
    recording?.cancel()
    recording = null
    held = false
    clearInterval(tick)
  }

  const micDown = async (e: PointerEvent) => {
    if (e.button !== 0) return
    if (recording) {
      void finishRecording()
      pressedAt = 0
      return
    }
    pressedAt = Date.now()
    await beginRecording()
    // Still pressed once the mic opened: this is push-to-talk.
    if (pressedAt && recording) held = true
  }

  const micUp = () => {
    if (pressedAt && recording && Date.now() - pressedAt > 400) void finishRecording()
    else held = false
    pressedAt = 0
  }

  const onWindowKey = (e: KeyboardEvent) => {
    // Cmd+M on a Mac, Ctrl+M elsewhere.
    if (modKey(e) && e.key.toLowerCase() === 'm') {
      e.preventDefault()
      // Holding the keys down must not flip the mic on and off.
      if (e.repeat) return
      if (recording) void finishRecording()
      else void beginRecording()
    }
    if (e.key === 'Escape' && recording) {
      e.preventDefault()
      cancelRecording()
    }
  }

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const clock = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`)
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

<div
  class="rounded-lg bg-surface shadow-float transition-shadow duration-150 {focused || recording
    ? 'shadow-[0_0_0_1px_var(--muted),var(--shadow)]'
    : 'shadow-[0_0_0_1px_var(--line),var(--shadow)]'}"
>
  {#if app.draftAttachments.length > 0 || uploading > 0}
    <div class="flex flex-wrap items-center gap-1.5 px-3 pt-3">
      {#each app.draftAttachments as a (a.id)}<AttachmentChip attachment={a} onremove={() => removeAttachment(a)} />{/each}
      {#if uploading > 0}<span class="px-1 text-[12px] text-muted" in:fade>Uploading…</span>{/if}
      {#if app.analyzing.size > 0}<span class="thinking px-1 text-[12px]" in:fade>Finding the beat…</span>{/if}
    </div>
  {/if}

  <div class="relative">
    <textarea
      bind:this={textarea}
      bind:value={text}
      use:listEditing
      {oninput}
      {onkeydown}
      {onpaste}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      rows="1"
      placeholder={app.teaching ? 'Tell it what happened, or press Done' : placeholder}
      class="block max-h-[240px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-[15px] leading-relaxed outline-none placeholder:text-muted {recording || transcribing
        ? 'opacity-0'
        : ''}"
    ></textarea>
    {#if recording || transcribing}
      <div class="absolute inset-0 flex items-center gap-2.5 px-4 pt-2 text-[14px]" in:fade={{ duration: 120 }}>
        {#if recording}
          <span class="size-2 rounded-full bg-accent [animation:rec-pulse_1.2s_ease-in-out_infinite]"></span>
          <span class="font-mono text-[13px] tabular-nums">{clock}</span>
          <span class="text-muted">{held ? 'Release to transcribe' : 'Listening. Click the mic to finish, Esc to cancel'}</span>
        {:else}
          <span class="thinking">Transcribing</span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- A container, so the row can drop labels when the composer itself is narrow. -->
  <div class="@container flex items-center gap-0.5 px-2 pb-2">
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
    <button class="icon-btn" use:tip={'Attach files'} onclick={() => fileInput?.click()}><Icon name="paperclip" size={17} /></button>
    <button
      class="icon-btn select-none {recording ? '!bg-accent !text-on-accent' : ''}"
      use:tip={{ text: 'Voice: hold to talk, or click to start and stop', kbd: shortcut('M') }}
      disabled={transcribing}
      onpointerdown={micDown}
      onpointerup={micUp}
      onpointerleave={micUp}
    >
      <Icon name="mic" size={17} />
    </button>

    <button
      class="flex h-7 items-center gap-1.5 rounded-full px-[7px] text-[12.5px] transition-colors {browserEnabled
        ? 'bg-fg text-bg'
        : 'text-fg-2 hover:bg-hover hover:text-fg'}"
      role="switch"
      aria-checked={browserEnabled}
      aria-label="Browser"
      use:tip={browserEnabled ? 'The assistant can use the browser in this chat' : 'Let the assistant use the browser in this chat'}
      onclick={onbrowser}
    >
      <Icon name="globe" size={14} /><span class="hidden @sm:inline">Browser</span>
    </button>
    {#if app.computerSupported}
      <button
        class="flex h-7 items-center gap-1.5 rounded-full px-[7px] text-[12.5px] transition-colors {computerEnabled
          ? 'bg-fg text-bg'
          : 'text-fg-2 hover:bg-hover hover:text-fg'}"
        role="switch"
        aria-checked={computerEnabled}
        aria-label="Computer"
        use:tip={computerEnabled ? 'The assistant can see your screen and use your apps in this chat' : 'Let the assistant see your screen and use your apps in this chat'}
        onclick={oncomputer}
      >
        <Icon name="monitor" size={14} /><span class="hidden @sm:inline">Computer</span>
      </button>
      {#if computerEnabled}
        <div
          class="ml-0.5 flex h-7 items-center rounded-full p-0.5 text-[12.5px] shadow-[inset_0_0_0_1px_var(--line)]"
          role="radiogroup"
          aria-label="Computer mode"
          use:tip={{ text: 'Do it: the assistant uses your computer. Show me: it shows you each step to do yourself.', kbd: 'Tab' }}
          in:fade={{ duration: 120 }}
        >
          {#each [['do', 'Do it'], ['teach', 'Show me']] as const as [mode, label] (mode)}
            <button
              class="h-6 rounded-full px-2 transition-colors {computerMode === mode ? 'bg-hover text-fg' : 'text-muted hover:text-fg'}"
              role="radio"
              aria-checked={computerMode === mode}
              onclick={() => onmode(mode)}>{label}</button
            >
          {/each}
        </div>
      {/if}
    {/if}
    <span class="ml-auto"></span>
    <ModelPicker placement="up" value={model} onchange={onmodel} />
    <button
      class="ml-1 grid size-8 place-items-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-95 {stopping
        ? 'bg-fg text-bg'
        : canSend || answering
          ? 'bg-accent text-on-accent'
          : 'bg-hover text-muted'}"
      use:tip={stopping
        ? computerOn
          ? { text: 'Stop. Works from any app too', kbd: stopShortcutLabel(isMac) }
          : 'Stop generating'
        : { text: answering ? 'Answer the step' : 'Send', kbd: 'Enter' }}
      disabled={!stopping && !canSend && !answering}
      onclick={() => (stopping ? app.stop() : submit())}
    >
      {#key stopping}
        <span in:pop={{ duration: 160 }}><Icon name={stopping ? 'stop' : 'arrowUp'} size={16} stroke={stopping ? 2.4 : 2} /></span>
      {/key}
      <span class="sr-only">{stopping ? 'Stop' : 'Send'}</span>
    </button>
  </div>
</div>
