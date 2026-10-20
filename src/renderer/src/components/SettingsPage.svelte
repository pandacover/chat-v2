<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { onDestroy, onMount } from 'svelte'
  import type { AppTip, MemoryRevision, MemoryRun, Settings } from '@shared/types'
  import { CALL_TOKENS, callCost } from '@shared/estimates'
  import { money } from '@/lib/pricing'
  import { CODE_FONTS, READING_FONTS, READING_SIZES, UI_FONTS, appearance, type FontOption, type ReadingSize } from '@/lib/appearance.svelte'
  import { fade, fly } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import Icon from './Icon.svelte'
  import Logo from './Logo.svelte'
  import ModelPicker from './ModelPicker.svelte'

  let form = $state<Settings>({ ...app.settings!.settings })
  let keys = $state({ openRouterKey: '', elevenLabsKey: '' })
  let status = $state<'idle' | 'saving' | 'saved'>('idle')
  let scroller: HTMLDivElement | undefined = $state()
  let active = $state('keys')

  const sections = [
    { id: 'keys', label: 'API keys' },
    { id: 'model', label: 'Model' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'memory', label: 'Memory' },
    ...(window.api.computer.supported ? [{ id: 'computer', label: 'Computer use' }] : []),
    { id: 'voice', label: 'Voice & files' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'about', label: 'About' }
  ]

  // Plain settings save on their own, shortly after the last change.
  let timer: ReturnType<typeof setTimeout> | undefined
  let savedTimer: ReturnType<typeof setTimeout> | undefined
  let first = true
  $effect(() => {
    const snapshot = $state.snapshot(form)
    if (first) {
      first = false
      return
    }
    clearTimeout(timer)
    timer = setTimeout(() => void persist(snapshot), 450)
  })

  const persist = async (settings: Settings) => {
    status = 'saving'
    const view = await app.attempt(() => window.api.settings.update({ settings }))
    if (!view) return void (status = 'idle')
    app.settings = view
    status = 'saved'
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => (status = 'idle'), 1600)
  }

  onDestroy(() => {
    // Leaving mid-debounce still saves.
    if (timer) {
      clearTimeout(timer)
      void persist($state.snapshot(form))
    }
  })

  const keyRows = $derived([
    { id: 'openRouterKey' as const, label: 'OpenRouter', has: app.settings!.hasOpenRouterKey, link: 'https://openrouter.ai/keys', hint: 'sk-or-…', use: 'Chat replies and the model list.' },
    { id: 'elevenLabsKey' as const, label: 'ElevenLabs', has: app.settings!.hasElevenLabsKey, link: 'https://elevenlabs.io/app/settings/api-keys', hint: 'Paste your key', use: 'Voice input.' }
  ])

  const saveKey = async (id: 'openRouterKey' | 'elevenLabsKey') => {
    const value = keys[id].trim()
    if (!value) return
    const view = await app.attempt(() => window.api.settings.update({ [id]: value }))
    if (!view) return
    app.settings = view
    keys[id] = ''
    app.toast(`${id === 'openRouterKey' ? 'OpenRouter' : 'ElevenLabs'} key saved`, 'info')
    if (id === 'openRouterKey') void app.loadModels()
  }

  const clearKey = async (id: 'openRouterKey' | 'elevenLabsKey') => {
    const view = await app.attempt(() => window.api.settings.update({ [id]: '' }))
    if (view) app.settings = view
  }

  const close = () => (app.page = 'chat')

  // Computer use: what stays off limits, and what the assistant learned about apps.
  let builtIn = $state<string[]>([])
  let tips = $state<AppTip[] | null>(null)
  let newProtected = $state('')
  onMount(() => {
    if (!window.api.computer.supported) return
    void app.attempt(() => window.api.computer.protectedApps()).then((list) => list && (builtIn = list))
    void app.attempt(() => window.api.computer.tips()).then((list) => (tips = list ?? []))
  })
  const addProtected = () => {
    const word = newProtected.trim()
    if (!word) return
    if (!form.computerProtected.some((w) => w.toLowerCase() === word.toLowerCase())) form.computerProtected = [...form.computerProtected, word]
    newProtected = ''
  }
  const removeTip = async (id: string) => {
    const list = await app.attempt(() => window.api.computer.removeTip(id))
    if (list) tips = list
  }

  // Memory: what the app has learned, edited in place. Every change is a new version.
  onMount(() => void app.loadMemory())
  let newFact = $state('')
  let editing = $state<number | null>(null)
  let editDraft = $state('')
  let confirmForget = $state(false)
  let showHistory = $state(false)

  const addFact = async () => {
    const fact = newFact.trim()
    if (fact && (await app.editMemory(() => window.api.memory.add(fact)))) newFact = ''
  }

  const saveEdit = async () => {
    const id = editing
    editing = null
    if (id !== null && editDraft.trim()) await app.editMemory(() => window.api.memory.edit(id, editDraft.trim()))
  }

  const forget = async () => {
    confirmForget = false
    await app.editMemory(() => window.api.memory.clear())
  }

  const restore = async (rev: number) => {
    if (await app.editMemory(() => window.api.memory.restore(rev))) app.toast(`Restored memory to version ${rev}`, 'info')
  }

  const KINDS: Record<MemoryRevision['kind'], string> = {
    learned: 'Learned from a chat',
    edited: 'Edited by you',
    restored: 'Restored',
    cleared: 'Forgot everything'
  }

  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  // OpenRouter names start with the provider ("Google: Gemini 2.5 Flash"); the picker shows it apart.
  const shortName = (name: string) => name.replace(/^[^:]{1,40}:\s*/, '')
  const modelName = (id: string) => shortName(app.models.find((m) => m.id === id)?.name ?? id)

  /** What the picked model costs per call, from OpenRouter's current prices. */
  const costLine = (id: string, kind: keyof typeof CALL_TOKENS, per: string) => {
    const info = app.models.find((m) => m.id === id)
    if (!info) return app.models.length ? `OpenRouter doesn't list a price for ${id}.` : ''
    const cost = callCost(info.pricing, kind)
    const name = shortName(info.name)
    if (cost === null) return `${name}'s price depends on the model OpenRouter routes to.`
    if (cost === 0) return `${name} is free.`
    return `${name} costs about ${money(cost)} ${per} (${money(cost * 1000)} per thousand).`
  }

  const OUTCOMES: Record<MemoryRun['outcome'], (r: MemoryRun) => string> = {
    skipped: () => "Skipped before the model: it doesn't say anything about you.",
    nothing: (r) => `${modelName(r.model!)} found nothing to keep.`,
    saved: (r) => `${modelName(r.model!)} updated memory.`,
    unreadable: (r) => `${modelName(r.model!)} didn't reply with the JSON memory needs.`,
    error: (r) => `${modelName(r.model!)} failed.`
  }

  const focusSelect = (el: HTMLInputElement) => {
    el.focus()
    el.select()
  }

  const jump = (id: string) => {
    active = id
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Highlight the section nearest the top of the viewport.
  const onscroll = () => {
    if (!scroller) return
    const top = scroller.getBoundingClientRect().top + 80
    let current = sections[0]!.id
    for (const s of sections) {
      const el = document.getElementById(`settings-${s.id}`)
      if (el && el.getBoundingClientRect().top <= top) current = s.id
    }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = sections.at(-1)!.id
    active = current
  }

  const field =
    'h-9 w-full rounded-md bg-surface px-3 text-[13px] shadow-[0_0_0_1px_var(--line)] outline-none transition-shadow placeholder:text-muted focus:shadow-[0_0_0_1px_var(--muted)]'

  const pdfEngines = [
    { id: 'cloudflare-ai', label: 'Text', hint: 'Extracts the text layer. Free.' },
    { id: 'mistral-ocr', label: 'OCR', hint: 'Reads scanned pages. Billed per page by OpenRouter.' },
    { id: 'native', label: 'Native', hint: 'Sends the file to the model. Needs a model that reads PDFs.' }
  ]
  const efforts = [
    { id: 'minimal', label: 'Minimal', hint: 'Acts almost at once. Fine for clicking through menus it can see.' },
    { id: 'low', label: 'Low', hint: 'Thinks briefly before each step. The default: quick, and enough for most tasks.' },
    { id: 'medium', label: 'Medium', hint: 'Thinks longer before each step, for fiddly work in apps it finds hard.' },
    { id: 'high', label: 'High', hint: 'Thinks hardest. Each step takes noticeably longer.' }
  ]
  const themes = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' }
  ]
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      close()
    }
  }}
/>

{#snippet segmented(options: Array<{ id: string; label: string }>, value: string, set: (v: string) => void)}
  <div
    class="relative grid rounded-md bg-hover/70 p-0.5 text-[12.5px]"
    style="grid-template-columns: repeat({options.length}, minmax(0, 1fr))"
    role="radiogroup"
  >
    <span
      class="absolute inset-y-0.5 left-0.5 rounded-sm bg-surface shadow-[0_1px_2px_#0000001f] transition-transform duration-200 ease-out"
      style="width: calc((100% - 4px) / {options.length}); transform: translateX({Math.max(0, options.findIndex((o) => o.id === value)) * 100}%)"
    ></span>
    {#each options as o (o.id)}
      <button role="radio" aria-checked={value === o.id} class="relative py-1.5 {value === o.id ? 'text-fg' : 'text-muted hover:text-fg-2'}" onclick={() => set(o.id)}>
        {o.label}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet fontPicker(options: FontOption[], value: string, set: (id: string) => void, sample: string)}
  <div class="grid grid-cols-3 gap-2" role="radiogroup">
    {#each options as f (f.id)}
      <button
        role="radio"
        aria-checked={value === f.id}
        class="flex flex-col items-start gap-1 rounded-md bg-surface px-3 py-2.5 text-left transition-shadow duration-150 {value === f.id
          ? 'shadow-[0_0_0_1.5px_var(--fg-2)]'
          : 'shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--muted)]'}"
        onclick={() => set(f.id)}
      >
        <span class="text-[20px] leading-none text-fg" style="font-family: {f.stack}">{sample}</span>
        <span class="text-[12px] text-muted">{f.label}</span>
      </button>
    {/each}
  </div>
{/snippet}

<section class="absolute inset-0 z-20 flex flex-col bg-side" aria-label="Settings" in:fly={{ y: 8, duration: 220 }} out:fade={{ duration: 120 }}>
  <div
    class="flex min-h-0 flex-1 flex-col bg-bg transition-[margin] duration-200 {app.sidebarOpen
      ? 'mt-3.5 rounded-tl-xl border-t border-l border-line'
      : ''}"
  >
    <header class="flex h-12 shrink-0 items-center gap-2 pr-4 {app.sidebarOpen ? 'pl-3' : 'pl-20'}">
      <button class="flex items-center gap-1 rounded-md py-1 pr-2.5 pl-1.5 text-[13px] text-fg-2 hover:bg-hover hover:text-fg" onclick={close}>
        <Icon name="chevronLeft" size={15} /> Back to chat
      </button>
      <span class="ml-auto text-[12px] text-muted" aria-live="polite">
        {#if status === 'saving'}<span in:fade>Saving…</span>{:else if status === 'saved'}<span class="flex items-center gap-1" in:fade><Icon name="check" size={12} /> Saved</span>{/if}
      </span>
    </header>

    <div bind:this={scroller} {onscroll} class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[860px] gap-12 px-8 pt-6 pb-24">
        <nav class="sticky top-6 hidden h-fit w-40 shrink-0 flex-col gap-0.5 md:flex" aria-label="Settings sections">
          <h1 class="mb-4 px-2.5 font-serif text-[28px] leading-none">Settings</h1>
          {#each sections as s (s.id)}
            <button
              class="rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors {active === s.id ? 'bg-hover text-fg' : 'text-fg-2 hover:text-fg'}"
              onclick={() => jump(s.id)}
            >
              {s.label}
            </button>
          {/each}
        </nav>

        <div class="min-w-0 flex-1 text-[13px]">
          <section id="settings-keys" class="scroll-mt-6 pb-10">
            <h2 class="font-serif text-[20px]">API keys</h2>
            <p class="mt-1 text-muted">Encrypted with your operating system's keychain and stored on this device only.</p>
            <div class="mt-5 space-y-5">
              {#each keyRows as k (k.id)}
                <div>
                  <div class="mb-1.5 flex items-baseline gap-2">
                    <span class="font-medium text-fg">{k.label}</span>
                    <span class="text-muted">{k.use}</span>
                    <a href={k.link} target="_blank" rel="noreferrer" class="ml-auto inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg">
                      Get a key <Icon name="external" size={11} />
                    </a>
                  </div>
                  <div class="flex gap-2">
                    <input
                      type="password"
                      bind:value={keys[k.id]}
                      placeholder={k.has ? 'Saved. Paste a new key to replace it' : k.hint}
                      class={field}
                      onkeydown={(e) => e.key === 'Enter' && saveKey(k.id)}
                    />
                    {#if keys[k.id].trim()}
                      <button class="shrink-0 rounded-md bg-fg px-3.5 font-medium text-bg" in:fade={{ duration: 120 }} onclick={() => saveKey(k.id)}>Save</button>
                    {/if}
                  </div>
                  {#if k.has}
                    <div class="mt-1.5 flex items-center gap-3 text-[12px]">
                      <span class="flex items-center gap-1 text-fg-2"><Icon name="check" size={12} /> Key saved</span>
                      <button class="text-muted hover:text-danger" onclick={() => clearKey(k.id)}>Remove</button>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </section>

          <section id="settings-model" class="scroll-mt-6 pb-10 shadow-[0_-1px_0_var(--line)] pt-8">
            <h2 class="font-serif text-[20px]">Model</h2>
            <p class="mt-1 text-muted">New chats start with this model. Each chat can switch from the composer.</p>
            <div class="mt-5 max-w-md">
              <ModelPicker block value={form.defaultModel} onchange={(id) => (form.defaultModel = id)} />
            </div>
            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">Vision model</span>
              <ModelPicker
                block
                value={form.visionModel}
                onchange={(id) => (form.visionModel = id)}
                filter={(m) => m.inputModalities.includes('image')}
                noneLabel="None: keep the chat's model"
              />
              <p class="mt-1.5 text-muted">Answers messages that include images, such as uploads or browser screenshots, when the chat's model can't see images.</p>
            </div>
            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">Title model</span>
              <ModelPicker block value={form.titleModel} onchange={(id) => (form.titleModel = id)} noneLabel="None: use the first message" />
              <p class="mt-1.5 text-muted">
                Names each new chat from its first message. A small model is enough.
                {form.titleModel ? costLine(form.titleModel, 'title', 'a title') : ''}
              </p>
            </div>
            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">Sketch model</span>
              <ModelPicker block source="image" value={form.sketchModel} onchange={(id) => (form.sketchModel = id)} />
              <p class="mt-1.5 text-muted">Draws the pencil sketches on mood boards, one image per shot. Each sketch is drawn once and kept, so reopening a board costs nothing.</p>
            </div>
            <label class="mt-5 block max-w-md">
              <span class="mb-1.5 flex justify-between"><span class="font-medium text-fg">Temperature</span><span class="text-fg-2 tabular-nums">{form.temperature.toFixed(1)}</span></span>
              <input type="range" min="0" max="2" step="0.1" bind:value={form.temperature} class="w-full accent-[var(--fg-2)]" />
              <span class="mt-0.5 flex justify-between text-[11.5px] text-muted"><span>Focused</span><span>Varied</span></span>
            </label>
          </section>

          <section id="settings-instructions" class="scroll-mt-6 pb-10 shadow-[0_-1px_0_var(--line)] pt-8">
            <div class="flex items-baseline">
              <h2 class="font-serif text-[20px]">System instructions</h2>
              <button class="ml-auto inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg" use:tip={app.settings!.configPath} onclick={() => window.api.settings.openConfigFile()}>
                Open config.json <Icon name="external" size={11} />
              </button>
            </div>
            <p class="mt-1 text-muted">Sent with every chat. A chat can replace them with its own from the composer.</p>
            <textarea
              bind:value={form.systemPrompt}
              rows="7"
              class="mt-4 w-full resize-y rounded-md bg-surface px-3.5 py-3 font-mono text-[12.5px] leading-relaxed shadow-[0_0_0_1px_var(--line)] outline-none focus:shadow-[0_0_0_1px_var(--muted)]"
            ></textarea>
            <label class="mt-5 flex cursor-pointer items-start gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={form.artifactsEnabled}
                aria-label="Interactive artifacts"
                class="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 {form.artifactsEnabled ? 'bg-fg' : 'bg-line'}"
                onclick={() => (form.artifactsEnabled = !form.artifactsEnabled)}
              >
                <span class="absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow transition-transform duration-200 ease-out {form.artifactsEnabled ? 'translate-x-4' : ''}"></span>
              </button>
              <span>
                <span class="block font-medium text-fg">Interactive artifacts</span>
                <span class="block text-muted">The model can build small HTML apps that run in the side panel.</span>
              </span>
            </label>
          </section>

          <section id="settings-memory" class="scroll-mt-6 pb-10 shadow-[0_-1px_0_var(--line)] pt-8">
            <h2 class="font-serif text-[20px]">Memory</h2>
            <p class="mt-1 max-w-[60ch] text-muted">
              A model reads each message you send for lasting facts about you, like your name, work or how you like answers, and keeps them on this device. Each new chat starts with them. Passwords, keys and account numbers are never kept.
            </p>
            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">Memory model</span>
              <ModelPicker block value={form.memoryModel} onchange={(id) => (form.memoryModel = id)} noneLabel="None: memory off" />
              <p class="mt-1.5 text-muted">
                {#if form.memoryModel}
                  {costLine(form.memoryModel, 'memory', 'for each message it reads')} Messages that don't talk about you are skipped first, for free.
                {:else}
                  Nothing is learned, and chats start without the facts below.
                {/if}
              </p>
            </div>

            {#if app.memory?.lastRun}
              {@const r = app.memory.lastRun}
              <div class="mt-5 max-w-[60ch] rounded-md bg-surface px-3 py-2.5 text-[12.5px] shadow-[0_0_0_1px_var(--line)]" aria-live="polite">
                <div class="flex items-baseline gap-2">
                  <span class="font-medium text-fg">Last message</span>
                  <span class="min-w-0 flex-1 truncate text-muted">“{r.message}”</span>
                  <span class="shrink-0 text-[11.5px] text-muted">{when(r.at)}</span>
                </div>
                <div class="mt-1 {r.outcome === 'error' || r.outcome === 'unreadable' ? 'text-danger' : 'text-fg-2'}">{OUTCOMES[r.outcome](r)}</div>
                {#if r.detail}<div class="mt-0.5 font-mono text-[11.5px] break-words text-muted">{r.detail}</div>{/if}
                {#each r.added as fact, j (j)}<div class="text-fg-2"><span class="text-muted">+</span> {fact}</div>{/each}
                {#each r.removed as fact, j (j)}<div class="text-muted line-through decoration-muted/60">{fact}</div>{/each}
                {#if r.dropped.length > 0}
                  <div class="mt-1 text-muted">Not kept, because they name things your message didn't mention: {r.dropped.join(' ')}</div>
                {/if}
              </div>
            {/if}

            <div class="mt-6">
              <div class="mb-1.5 flex items-baseline gap-2">
                <span class="font-medium text-fg">What chat-v2 knows about you</span>
                {#if app.memory && app.memory.facts.length > 0}
                  <span class="text-muted tabular-nums">{app.memory.facts.length}</span>
                  <span class="ml-auto"></span>
                  {#if confirmForget}
                    <span class="text-fg-2" in:fade={{ duration: 120 }}>Forget all of it?</span>
                    <button class="text-[12px] text-muted hover:text-fg" onclick={() => (confirmForget = false)}>Keep</button>
                    <button class="text-[12px] font-medium text-danger" onclick={forget}>Forget</button>
                  {:else}
                    <button class="text-[12px] text-muted hover:text-danger" onclick={() => (confirmForget = true)}>Forget everything</button>
                  {/if}
                {/if}
              </div>
              <ul class="divide-y divide-line overflow-hidden rounded-md bg-surface shadow-[0_0_0_1px_var(--line)]">
                {#each app.memory?.facts ?? [] as f (f.id)}
                  <li class="group flex min-h-9 items-center gap-2 px-3 py-1.5">
                    {#if editing === f.id}
                      <input
                        use:focusSelect
                        bind:value={editDraft}
                        class="h-7 min-w-0 flex-1 rounded-sm bg-bg px-2 outline-none"
                        onkeydown={(e) => {
                          if (e.key === 'Enter') void saveEdit()
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            editing = null
                          }
                        }}
                        onblur={saveEdit}
                      />
                    {:else}
                      <span class="min-w-0 flex-1 text-fg">{f.fact}</span>
                      <span class="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <button class="icon-btn !p-1" use:tip={'Edit'} onclick={() => ((editing = f.id), (editDraft = f.fact))}><Icon name="edit" size={13} /></button>
                        <button class="icon-btn !p-1" use:tip={'Forget this'} onclick={() => app.editMemory(() => window.api.memory.remove(f.id))}><Icon name="trash" size={13} /></button>
                      </span>
                    {/if}
                  </li>
                {:else}
                  <li class="px-3 py-2.5 text-muted">{app.memory ? 'Nothing yet. Tell it about yourself in any chat, or add a fact below.' : 'Loading…'}</li>
                {/each}
                <li class="flex items-center gap-2 px-3 py-1.5">
                  <Icon name="plus" size={13} class="shrink-0 text-muted" />
                  <input
                    bind:value={newFact}
                    placeholder="Add a fact, e.g. Prefers metric units."
                    class="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
                    onkeydown={(e) => e.key === 'Enter' && addFact()}
                  />
                  {#if newFact.trim()}<button class="shrink-0 rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg" in:fade={{ duration: 120 }} onclick={addFact}>Add</button>{/if}
                </li>
              </ul>
            </div>

            {#if app.memory && app.memory.revisions.length > 0}
              <button class="mt-4 flex items-center gap-1 text-[12.5px] text-fg-2 hover:text-fg" aria-expanded={showHistory} onclick={() => (showHistory = !showHistory)}>
                <Icon name="chevronDown" size={13} class="transition-transform duration-150 {showHistory ? '' : '-rotate-90'}" />
                Version history <span class="text-muted tabular-nums">({app.memory.revisions.length})</span>
              </button>
              {#if showHistory}
                <ol class="mt-2 space-y-3 border-l border-line pl-4" transition:fade={{ duration: 120 }}>
                  {#each app.memory.revisions as r, i (r.rev)}
                    <li>
                      <div class="flex items-baseline gap-2">
                        <span class="font-medium text-fg tabular-nums">v{r.rev}</span>
                        <span class="text-fg-2">{r.note ?? KINDS[r.kind]}</span>
                        <span class="text-[12px] text-muted">{when(r.createdAt)}</span>
                        {#if i > 0}
                          <button class="ml-auto text-[12px] text-muted hover:text-fg" use:tip={'Bring back the facts as they were after this change'} onclick={() => restore(r.rev)}>Restore</button>
                        {:else}
                          <span class="ml-auto text-[12px] text-muted">Current</span>
                        {/if}
                      </div>
                      {#each r.added as fact, j (j)}<div class="text-[12.5px] text-fg-2"><span class="text-muted">+</span> {fact}</div>{/each}
                      {#each r.removed as fact, j (j)}<div class="text-[12.5px] text-muted line-through decoration-muted/60">{fact}</div>{/each}
                    </li>
                  {/each}
                </ol>
              {/if}
            {/if}
          </section>

          {#if window.api.computer.supported}
            <section id="settings-computer" class="scroll-mt-6 pb-10 shadow-[0_-1px_0_var(--line)] pt-8">
              <h2 class="font-serif text-[20px]">Computer use</h2>
              <p class="mt-1 max-w-prose text-muted">
                Turn on <span class="text-fg-2">Computer</span> in a chat's composer and the assistant can see your main screen and work in your apps with its own sketched cursor, while
                your mouse stays yours. Press <span class="text-fg-2">Stop</span> on the bar at the top of the screen to take over.
              </p>

              <label class="mt-5 flex cursor-pointer items-start gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.computerBorrowPointer}
                  aria-label="Borrow the pointer when needed"
                  class="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 {form.computerBorrowPointer ? 'bg-fg' : 'bg-line'}"
                  onclick={() => (form.computerBorrowPointer = !form.computerBorrowPointer)}
                >
                  <span class="absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow transition-transform duration-200 ease-out {form.computerBorrowPointer ? 'translate-x-4' : ''}"></span>
                </button>
                <span>
                  <span class="block font-medium text-fg">Borrow the pointer when needed</span>
                  <span class="block max-w-prose text-muted">
                    Apps only follow a drag from the real mouse, so drags take your pointer for under a second and put it back. On a Mac, so do clicks in areas an app
                    draws itself, like a video timeline. Off, your pointer is never touched, and those drags and clicks mostly won't work.
                  </span>
                </span>
              </label>

              <div class="mt-6 max-w-md">
                <span class="mb-1.5 block font-medium text-fg">Computer use model</span>
                <ModelPicker
                  block
                  value={form.computerModel}
                  onchange={(id) => (form.computerModel = id)}
                  filter={(m) => m.inputModalities.includes('image')}
                  noneLabel="None: use the chat's model"
                />
                <p class="mt-1.5 text-muted">
                  Works the computer in replies that use it, so a chat can talk with one model and act with a faster one. It needs to see images: if it can't, the vision
                  model takes over, then the chat's model. A chat on OpenRouter's Auto Router acts with DeepSeek V4.1 Flash, as the router could switch models between steps.
                </p>
              </div>

              <div class="mt-6 max-w-md">
                <span class="mb-1.5 block font-medium text-fg">Thinking between steps</span>
                {@render segmented(efforts, form.computerReasoningEffort, (v) => (form.computerReasoningEffort = v as Settings['computerReasoningEffort']))}
                <p class="mt-1.5 text-muted">
                  {efforts.find((e) => e.id === form.computerReasoningEffort)?.hint} Models that don't think ignore this.
                </p>
              </div>

              <h3 class="mt-6 font-medium text-fg">Always off limits</h3>
              <p class="mt-0.5 max-w-prose text-muted">
                These are painted grey in what the assistant sees, and it can't click or type into them or open them, whatever it's asked.
              </p>
              <div class="mt-2.5 flex max-w-xl flex-wrap gap-1.5">
                {#each builtIn as label (label)}
                  <span class="rounded-full bg-hover px-2.5 py-0.5 text-[12.5px] text-fg-2">{label}</span>
                {/each}
                <span class="rounded-full bg-hover px-2.5 py-0.5 text-[12.5px] text-fg-2">chat-v2 itself</span>
              </div>

              <h3 class="mt-6 font-medium text-fg">Also protect</h3>
              <p class="mt-0.5 max-w-prose text-muted">An app (its name or .exe) or a word in window titles, such as <span class="text-fg-2">Steam</span> or <span class="text-fg-2">bank</span>.</p>
              <ul class="mt-2.5 max-w-md divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-[0_0_0_1px_var(--line)]">
                {#each form.computerProtected as word (word)}
                  <li class="group flex min-h-9 items-center gap-2 px-3 py-1.5">
                    <span class="min-w-0 flex-1 text-fg">{word}</span>
                    <button
                      class="icon-btn !p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      use:tip={'Stop protecting this'}
                      onclick={() => (form.computerProtected = form.computerProtected.filter((w) => w !== word))}><Icon name="trash" size={13} /></button
                    >
                  </li>
                {/each}
                <li class="flex items-center gap-2 px-3 py-1.5">
                  <Icon name="plus" size={13} class="shrink-0 text-muted" />
                  <input
                    bind:value={newProtected}
                    placeholder="Add an app or title word"
                    class="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
                    onkeydown={(e) => e.key === 'Enter' && addProtected()}
                  />
                  {#if newProtected.trim()}<button class="shrink-0 rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg" in:fade={{ duration: 120 }} onclick={addProtected}>Add</button>{/if}
                </li>
              </ul>

              <h3 class="mt-6 font-medium text-fg">What it learned about apps</h3>
              <p class="mt-0.5 max-w-prose text-muted">Tips the assistant saved while using an app, often after looking it up. They come back when that app is in front.</p>
              <ul class="mt-2.5 max-w-xl divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-[0_0_0_1px_var(--line)]">
                {#each tips ?? [] as t (t.id)}
                  <li class="group flex items-start gap-2 px-3 py-2">
                    <span class="mt-px shrink-0 rounded bg-hover px-1.5 text-[12px] text-fg-2">{t.app}</span>
                    <span class="min-w-0 flex-1 text-fg">{t.tip}</span>
                    <button class="icon-btn !p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" use:tip={'Forget this'} onclick={() => removeTip(t.id)}><Icon name="trash" size={13} /></button>
                  </li>
                {:else}
                  <li class="px-3 py-2.5 text-muted">{tips ? 'Nothing yet.' : 'Loading…'}</li>
                {/each}
              </ul>
            </section>
          {/if}

          <section id="settings-voice" class="scroll-mt-6 pb-10 shadow-[0_-1px_0_var(--line)] pt-8">
            <h2 class="font-serif text-[20px]">Voice & files</h2>
            <div class="mt-5 grid max-w-md grid-cols-2 gap-3">
              <label class="block">
                <span class="mb-1.5 block font-medium text-fg">Speech model</span>
                <input bind:value={form.sttModel} class={field} />
              </label>
              <label class="block">
                <span class="mb-1.5 block font-medium text-fg">Language</span>
                <input bind:value={form.sttLanguage} placeholder="Detect automatically" class={field} />
              </label>
            </div>
            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">PDF reading</span>
              {@render segmented(pdfEngines, form.pdfEngine, (v) => (form.pdfEngine = v as Settings['pdfEngine']))}
              <p class="mt-1.5 text-muted">{pdfEngines.find((e) => e.id === form.pdfEngine)?.hint}</p>
            </div>
          </section>

          <section id="settings-appearance" class="scroll-mt-6 shadow-[0_-1px_0_var(--line)] pt-8">
            <div class="flex items-baseline">
              <h2 class="font-serif text-[20px]">Appearance</h2>
              <button class="ml-auto text-[12px] text-muted hover:text-fg" onclick={() => appearance.reset()}>Reset fonts</button>
            </div>
            <p class="mt-1 text-muted">Stored on this device.</p>

            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">Theme</span>
              {@render segmented(themes, theme.pref, (v) => theme.set(v as ThemePref))}
            </div>

            <label class="mt-5 flex cursor-pointer items-start gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={form.alwaysOnTop}
                aria-label="Keep on top"
                class="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 {form.alwaysOnTop ? 'bg-fg' : 'bg-line'}"
                onclick={() => (form.alwaysOnTop = !form.alwaysOnTop)}
              >
                <span class="absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow transition-transform duration-200 ease-out {form.alwaysOnTop ? 'translate-x-4' : ''}"></span>
              </button>
              <span>
                <span class="block font-medium text-fg">Keep on top</span>
                <span class="block text-muted">The window stays above other apps on this desktop. The pin in the chat header does the same.</span>
              </span>
            </label>

            <div class="mt-6">
              <span class="mb-1.5 block font-medium text-fg">Reading font <span class="font-normal text-muted">for replies</span></span>
              {@render fontPicker(READING_FONTS, appearance.prefs.reading, (id) => appearance.set('reading', id), 'Ag')}
            </div>
            <div class="mt-5 max-w-md">
              <span class="mb-1.5 block font-medium text-fg">Reading size</span>
              {@render segmented([...READING_SIZES], appearance.prefs.size, (v) => appearance.set('size', v as ReadingSize))}
            </div>
            <p class="prose-chat mt-4 max-w-[60ch] rounded-md bg-surface px-4 py-3 shadow-[0_0_0_1px_var(--line)]">
              Replies are set like this. A sentence with <em>emphasis</em>, some <strong>weight</strong>, and <code>inline code</code>.
            </p>

            <div class="mt-6">
              <span class="mb-1.5 block font-medium text-fg">Interface font</span>
              {@render fontPicker(UI_FONTS, appearance.prefs.ui, (id) => appearance.set('ui', id), 'Ag')}
            </div>
            <div class="mt-6">
              <span class="mb-1.5 block font-medium text-fg">Code font</span>
              {@render fontPicker(CODE_FONTS, appearance.prefs.code, (id) => appearance.set('code', id), '{ }')}
            </div>
          </section>

          <section id="settings-about" class="scroll-mt-6 pt-8 pb-10 shadow-[0_-1px_0_var(--line)] mt-10">
            <h2 class="font-serif text-[20px]">About</h2>
            <div class="mt-4 flex items-center gap-4">
              <span class="grid size-14 place-items-center rounded-xl bg-[#0b0b0c] text-white"><Logo size={44} /></span>
              <div class="min-w-0 flex-1">
                <div class="font-medium text-fg">chat-v2 {app.update?.current ?? ''}</div>
                <div class="text-muted">
                  {#if !app.update || app.update.status === 'unsupported'}
                    Development build. Updates apply to installed versions.
                  {:else if app.update.next}
                    Version {app.update.next} is available.
                  {:else}
                    Updates are checked every 30 minutes, and shown by the button at the bottom of the sidebar.
                  {/if}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</section>
