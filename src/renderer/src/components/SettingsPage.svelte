<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { onDestroy } from 'svelte'
  import type { Settings } from '@shared/types'
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

  let checking = $state(false)
  const checkUpdates = async () => {
    checking = true
    const s = await app.attempt(() => window.api.updates.check())
    checking = false
    if (!s) return
    app.update = s
    if (s.status === 'idle') app.toast(`You're on the latest version (${s.current}).`, 'info')
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

<section class="absolute inset-0 z-20 flex flex-col bg-bg" aria-label="Settings" in:fly={{ y: 8, duration: 220 }} out:fade={{ duration: 120 }}>
  <header class="flex h-12 shrink-0 items-center gap-2 pr-4 {app.sidebarOpen ? 'pl-3' : 'pl-12'}">
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
                  Updates are checked every 30 minutes.
                {/if}
              </div>
            </div>
            <button
              class="rounded-md bg-surface px-3 py-1.5 text-fg-2 shadow-[0_0_0_1px_var(--line)] hover:text-fg disabled:opacity-50"
              disabled={checking || !app.update || app.update.status === 'unsupported'}
              onclick={checkUpdates}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</section>
