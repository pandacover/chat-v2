<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { onDestroy, onMount } from 'svelte'
  import type { MemoryRevision, MemoryRun, MemoryVersion, MemoryWriter, Settings, UpdateState } from '@shared/types'
  import { shortcut } from '@/lib/keys'
  import { modelName } from '@shared/models'
  import { CODE_FONTS, READING_FONTS, READING_SIZES, UI_FONTS, appearance, type FontOption, type ReadingSize } from '@/lib/appearance.svelte'
  import { fade, pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { theme, type ThemePref } from '@/lib/theme.svelte'
  import Icon, { type IconName } from './Icon.svelte'
  import logo from '@/assets/logo.png'
  import ModelPicker from './ModelPicker.svelte'
  import UsageSettings from './UsageSettings.svelte'
  import { meter } from '@/lib/meter.svelte'

  let form = $state<Settings>({ ...app.settings!.settings })
  let keys = $state({ anthropicKey: '', elevenLabsKey: '' })
  let status = $state<'idle' | 'saving' | 'saved'>('idle')
  let scroller: HTMLDivElement | undefined = $state()

  // One tab at a time, picked from the list on the left. Missing the API key it needs, the account comes first.
  type Tab = 'model' | 'memory' | 'voice' | 'account' | 'usage' | 'appearance' | 'about'
  const tabs: Array<{ id: Tab; label: string; icon: IconName }> = [
    { id: 'account', label: 'Account', icon: 'key' },
    { id: 'usage', label: 'Usage', icon: 'gauge' },
    { id: 'model', label: 'Model', icon: 'sparkle' },
    { id: 'memory', label: 'Memory', icon: 'brain' },
    { id: 'voice', label: 'Voice', icon: 'mic' },
    { id: 'appearance', label: 'Appearance', icon: 'type' },
    { id: 'about', label: 'About', icon: 'info' }
  ]
  let tab = $state<Tab>(meter.takeTab() ? 'usage' : app.settings!.settings.auth === 'apiKey' && !app.settings!.hasAnthropicKey ? 'account' : 'model')
  const show = (id: Tab) => {
    tab = id
    scroller?.scrollTo({ top: 0 })
  }

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

  type KeyId = 'anthropicKey' | 'elevenLabsKey'
  const keyRows = $derived([
    ...(form.auth === 'apiKey'
      ? [{ id: 'anthropicKey' as const, label: 'Anthropic', has: app.settings!.hasAnthropicKey, link: 'https://console.anthropic.com/settings/keys', hint: 'sk-ant-…', use: 'Chat replies, titles and memory.' }]
      : []),
    { id: 'elevenLabsKey' as const, label: 'ElevenLabs', has: app.settings!.hasElevenLabsKey, link: 'https://elevenlabs.io/app/settings/api-keys', hint: 'Paste your key', use: 'Voice input.' }
  ])

  const saveKey = async (id: KeyId) => {
    const value = keys[id].trim()
    if (!value) return
    const view = await app.attempt(() => window.api.settings.update({ [id]: value }))
    if (!view) return
    app.settings = view
    keys[id] = ''
    app.toast(`${id === 'anthropicKey' ? 'Anthropic' : 'ElevenLabs'} key saved`, 'info')
  }

  const clearKey = async (id: KeyId) => {
    const view = await app.attempt(() => window.api.settings.update({ [id]: '' }))
    if (view) app.settings = view
  }

  const close = () => (app.page = 'chat')

  // Memory: what the app has learned, as records edited in place. Every change is a new version.
  onMount(() => void app.loadMemory())
  let newFact = $state('')
  let editing = $state<number | null>(null)
  let editDraft = $state('')
  let confirmForget = $state(false)
  let showHistory = $state(false)
  // "Why does Tomo think this?": one record's versions, each with where it came from.
  let why = $state<number | null>(null)
  let versions = $state<MemoryVersion[] | null>(null)
  let confirmPurge = $state<number | null>(null)

  const loadVersions = async (id: number) => {
    const list = await app.attempt(() => window.api.memory.versions(id))
    if (why === id && list) versions = list
  }

  const toggleWhy = (id: number) => {
    if (why === id) return void (why = null)
    why = id
    versions = null
    void loadVersions(id)
  }

  const purge = async (id: number) => {
    confirmPurge = null
    if (why === id) why = null
    if (await app.editMemory(() => window.api.memory.purge(id))) app.toast('Deleted it and its history', 'info')
  }

  /** Opens the chat a version came from, over Settings. */
  const openSource = (sessionId: string) => {
    close()
    void app.open(sessionId)
  }

  // [[Links]] read as the names they are.
  const plain = (text: string) => text.replace(/\[\[([^[\]\n]{1,80})\]\]/g, '$1')

  const WRITERS: Record<MemoryWriter, string> = {
    extractor: 'Learned',
    reconciler: 'Tidied up in the daily review',
    user: 'Written by you',
    bot: 'Saved by Tomo when asked',
    archiver: 'Summed up when a job ended'
  }

  const addFact = async () => {
    const fact = newFact.trim()
    if (fact && (await app.editMemory(() => window.api.memory.add(fact)))) newFact = ''
  }

  const saveEdit = async () => {
    const id = editing
    editing = null
    if (id !== null && editDraft.trim() && (await app.editMemory(() => window.api.memory.edit(id, editDraft.trim()))) && why === id) void loadVersions(id)
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
    cleared: 'Forgot everything',
    purged: 'Deleted a record and its history',
    noted: 'Job note',
    archived: 'Archived a job'
  }

  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  const OUTCOMES: Record<MemoryRun['outcome'], (r: MemoryRun) => string> = {
    skipped: () => "Skipped before the model: it doesn't say anything about you.",
    nothing: (r) => `${modelName(r.model!)} found nothing to keep.`,
    saved: (r) => `${modelName(r.model!)} updated memory.`,
    unreadable: (r) => `${modelName(r.model!)} didn't reply with the JSON memory needs.`,
    error: (r) => `${modelName(r.model!)} failed.`
  }

  // Focus moves into the dialog on open, so Tab starts inside it.
  const focusSelf = (el: HTMLElement) => el.focus()

  const focusSelect = (el: HTMLInputElement) => {
    el.focus()
    el.select()
  }

  const field =
    'h-8 w-[200px] shrink-0 rounded-[10px] bg-card px-3 text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-shadow placeholder:text-fg-4 placeholder:font-normal focus:shadow-[inset_0_0_0_1px_var(--line-2)]'

  const auths = [
    { id: 'login', label: 'Claude sign-in', hint: '' },
    { id: 'apiKey', label: 'API key', hint: '' }
  ]
  const efforts = [
    { id: 'low', label: 'Low', hint: 'Answers quickly and thinks little. Cheapest.' },
    { id: 'medium', label: 'Medium', hint: 'Thinks where it helps. The default.' },
    { id: 'high', label: 'High', hint: 'Thinks longer before it answers, for harder questions.' },
    { id: 'xhigh', label: 'Higher', hint: 'Thinks much longer. Slower and costs more.' },
    { id: 'max', label: 'Max', hint: 'Thinks as long as it needs. The slowest and most expensive.' }
  ]
  const themes = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' }
  ]

  // Settings › About: check, download or restart into an update (the sidebar's row does the same).
  const updateAction = async (call: () => Promise<UpdateState>) => {
    const next = await app.attempt(call)
    if (next) app.update = next
  }
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
  <div class="seg" role="radiogroup">
    {#each options as o (o.id)}
      <button role="radio" aria-checked={value === o.id} onclick={() => set(o.id)}>{o.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet toggle(on: boolean, label: string, set: () => void)}
  <button type="button" role="switch" aria-checked={on} aria-label={label} class="switch" onclick={set}></button>
{/snippet}

{#snippet fontPicker(options: FontOption[], value: string, set: (id: string) => void, sample: string)}
  <div class="mt-2.5 grid grid-cols-3 gap-2" role="radiogroup">
    {#each options as f (f.id)}
      <button
        role="radio"
        aria-checked={value === f.id}
        class="flex flex-col items-start gap-1 rounded-[10px] bg-card px-3 py-2.5 text-left transition-shadow duration-150 {value === f.id
          ? 'shadow-[inset_0_0_0_1.5px_var(--solid)]'
          : 'shadow-[inset_0_0_0_1px_var(--line)] hover:shadow-[inset_0_0_0_1px_var(--line-2)]'}"
        onclick={() => set(f.id)}
      >
        <span class="text-[20px] leading-none text-fg" style="font-family: {f.stack}">{sample}</span>
        <span class="text-[12px] text-fg-3">{f.label}</span>
      </button>
    {/each}
  </div>
{/snippet}

<div class="fixed inset-0 z-50 grid place-items-center p-6" role="dialog" aria-modal="true" aria-label="Settings">
  <button class="absolute inset-0 bg-scrim backdrop-blur-[4px]" aria-label="Close settings" transition:fade={{ duration: 250 }} onclick={close}></button>
  <section
    use:focusSelf
    tabindex="-1"
    class="glass-strong relative flex h-[min(600px,86vh)] w-[min(880px,92vw)] overflow-hidden rounded-[20px] outline-none"
    transition:pop={{ duration: 300 }}
  >
    <nav class="flex w-[210px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-[var(--glass-side)] px-2.5 py-[18px]" aria-label="Settings sections">
      <h2 class="mx-2.5 mt-1.5 mb-[18px] font-display text-[26px] leading-none font-light tracking-[-0.03em]">Settings</h2>
      {#each tabs as t (t.id)}
        <button
          aria-current={tab === t.id ? 'page' : undefined}
          class="flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-left whitespace-nowrap transition-colors {tab === t.id
            ? 'glass text-fg'
            : 'text-fg-2 hover:bg-wash'}"
          onclick={() => show(t.id)}
        >
          <Icon name={t.icon} size={16} class={tab === t.id ? 'text-fg' : 'text-fg-3'} />
          {t.label}
        </button>
      {/each}
    </nav>

    <div bind:this={scroller} class="relative min-w-0 flex-1 overflow-y-auto px-7 pt-[22px] pb-7 text-[14px]">
      <div class="absolute top-3.5 right-3.5 flex items-center gap-2">
        <span class="text-[12px] text-fg-3" aria-live="polite">
          {#if status === 'saving'}<span in:fade>Saving…</span>{:else if status === 'saved'}<span class="flex items-center gap-1" in:fade><Icon name="check" size={12} /> Saved</span>{/if}
        </span>
        <button class="icon-btn size-8" use:tip={{ text: 'Close', kbd: 'Esc' }} aria-label="Close settings" onclick={close}>
          <Icon name="x" size={16} />
        </button>
      </div>

      {#if tab === 'account'}
        <section id="settings-account">
          <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Account</h3>
          <p class="mb-5 max-w-[60ch] text-fg-3">Replies run on Claude Code, which comes with the app. It needs your Claude sign-in or an Anthropic API key.</p>
          <div class="group-card">
            <div class="srow">
              <div class="l">
                <b>Sign in with</b>
                <span>
                  {#if form.auth === 'login'}
                    The account you signed in to Claude Code with, and its plan's usage. To sign in, run <code class="font-mono text-fg-2">claude</code> in a terminal and type
                    <code class="font-mono text-fg-2">/login</code>.
                  {:else}
                    Billed to your Anthropic Console account. The ANTHROPIC_API_KEY environment variable also works.
                  {/if}
                </span>
              </div>
              {@render segmented(auths, form.auth, (v) => (form.auth = v as Settings['auth']))}
            </div>
          </div>

          <div class="mono-label mx-0.5 mt-[22px] mb-1">API keys</div>
          <p class="mx-0.5 mb-2.5 text-[12.5px] text-fg-3">Encrypted with your operating system's keychain and stored on this device only.</p>
          <div class="group-card">
            {#each keyRows as k (k.id)}
              <div class="srow">
                <div class="l">
                  <b>{k.label} key</b>
                  <span>
                    For {k.use.replace(/\.$/, '').toLowerCase()}.
                    <a href={k.link} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-fg-2 hover:text-fg">Get a key <Icon name="external" size={11} /></a>
                  </span>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <label class="flex h-8 w-[240px] items-center gap-2 rounded-[10px] px-3 shadow-[inset_0_0_0_1px_var(--line)] focus-within:shadow-[inset_0_0_0_1px_var(--line-2)]">
                    <input
                      type="password"
                      bind:value={keys[k.id]}
                      aria-label="{k.label} key"
                      placeholder={k.has ? 'Paste to replace' : k.hint}
                      class="min-w-0 flex-1 bg-transparent font-label text-[12.5px] text-fg-2 outline-none placeholder:text-fg-4"
                      onkeydown={(e) => e.key === 'Enter' && saveKey(k.id)}
                    />
                    {#if k.has && !keys[k.id].trim()}<span class="shrink-0 text-[12px] font-medium text-ok">Saved</span>{/if}
                  </label>
                  {#if keys[k.id].trim()}
                    <button class="btn solid" in:fade={{ duration: 120 }} onclick={() => saveKey(k.id)}>Save</button>
                  {:else if k.has}
                    <button class="btn quiet hover:!text-danger" onclick={() => clearKey(k.id)}>Remove</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if tab === 'usage'}
        <UsageSettings />
      {/if}

      {#if tab === 'model'}
        <section id="settings-model">
          <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Model</h3>
          <p class="mb-5 text-fg-3">The default for new chats. Each chat can pick its own in the composer.</p>
          <div class="group-card">
            <div class="srow">
              <div class="l"><b>Default model</b><span>New chats start with this model</span></div>
              <div class="w-[200px] shrink-0"><ModelPicker block value={form.defaultModel} onchange={(id) => (form.defaultModel = id)} /></div>
            </div>
            <div class="srow !flex-col !items-stretch !gap-2.5">
              <div class="l"><b>Thinking</b><span>{efforts.find((e) => e.id === form.effort)?.hint} Models that don't think ignore this.</span></div>
              <div>{@render segmented(efforts, form.effort, (v) => (form.effort = v as Settings['effort']))}</div>
            </div>
            <div class="srow">
              <div class="l"><b>Title model</b><span>Names each new chat from its first message. Haiku is enough, and a title costs a fraction of a cent.</span></div>
              <div class="w-[200px] shrink-0"><ModelPicker block value={form.titleModel} onchange={(id) => (form.titleModel = id)} noneLabel="None: use the first message" /></div>
            </div>
            <div class="srow">
              <div class="l"><b>Interactive artifacts</b><span>The model can build small HTML apps that run in the side panel</span></div>
              {@render toggle(form.artifactsEnabled, 'Interactive artifacts', () => (form.artifactsEnabled = !form.artifactsEnabled))}
            </div>
          </div>
          <div class="group-card" id="settings-instructions">
            <div class="srow">
              <div class="l">
                <div class="flex items-baseline gap-2">
                  <b>System instructions</b>
                  <button class="ml-auto inline-flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg" use:tip={app.settings!.configPath} onclick={() => window.api.settings.openConfigFile()}>
                    Open config.json <Icon name="external" size={11} />
                  </button>
                </div>
                <span>Sent with every chat. A chat can replace them with its own from the button at its top right.</span>
                <textarea
                  bind:value={form.systemPrompt}
                  rows="5"
                  aria-label="System instructions"
                  class="mt-2.5 block min-h-[84px] w-full resize-y rounded-[10px] bg-transparent px-3 py-2.5 text-[13.5px] shadow-[inset_0_0_0_1px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--line-2)]"
                ></textarea>
              </div>
            </div>
          </div>
        </section>
      {/if}

      {#if tab === 'memory'}
        <section id="settings-memory">
          <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Memory</h3>
          <p class="mb-5 max-w-[60ch] text-fg-3">
            A model reads each message you send for lasting facts about you, like your name, work or how you like answers, and keeps them on this device. Each new chat starts with them.
            Passwords, keys and account numbers are never kept. Every change is versioned, and forgetting a fact deletes it and its history for good.
          </p>
          <div class="group-card">
            <div class="srow">
              <div class="l">
                <b>Memory model</b>
                <span>{form.memoryModel ? "Messages that don't talk about you are skipped first, for free." : 'Nothing is learned, and chats start without the facts below.'}</span>
              </div>
              <div class="w-[200px] shrink-0"><ModelPicker block value={form.memoryModel} onchange={(id) => (form.memoryModel = id)} noneLabel="None: memory off" /></div>
            </div>
            {#if app.memory?.lastRun}
              {@const r = app.memory.lastRun}
              <div class="srow !block text-[12.5px]" aria-live="polite">
                <div class="flex items-baseline gap-2">
                  <span class="font-medium text-fg">Last message</span>
                  <span class="min-w-0 flex-1 truncate text-fg-3">“{r.message}”</span>
                  <span class="shrink-0 font-label text-[11px] text-fg-4">{when(r.at)}</span>
                </div>
                <div class="mt-1 {r.outcome === 'error' || r.outcome === 'unreadable' ? 'text-danger' : 'text-fg-2'}">{OUTCOMES[r.outcome](r)}</div>
                {#if r.detail}<div class="mt-0.5 font-mono text-[11.5px] break-words text-fg-3">{r.detail}</div>{/if}
                {#each r.added as fact, j (j)}<div class="text-fg-2"><span class="text-fg-3">+</span> {fact}</div>{/each}
                {#each r.removed as fact, j (j)}<div class="text-fg-3 line-through decoration-fg-4">{fact}</div>{/each}
                {#if r.dropped.length > 0}
                  <div class="mt-1 text-fg-3">Not kept, because they name things your message didn't mention: {r.dropped.join(' ')}</div>
                {/if}
              </div>
            {/if}
          </div>

          <div class="mx-0.5 mt-[22px] mb-2.5 flex items-baseline gap-2">
            <span class="mono-label">What Tomo knows about you</span>
            {#if app.memory && app.memory.records.length > 0}
              <span class="mono-label !text-fg-4 tabular-nums">{app.memory.records.length}</span>
              <span class="ml-auto"></span>
              {#if confirmForget}
                <span class="text-[12.5px] text-fg-2" in:fade={{ duration: 120 }}>Forget all of it?</span>
                <button class="text-[12px] text-fg-3 hover:text-fg" onclick={() => (confirmForget = false)}>Keep</button>
                <button class="text-[12px] font-medium text-danger" onclick={forget}>Forget</button>
              {:else}
                <button class="text-[12px] text-fg-3 hover:text-danger" onclick={() => (confirmForget = true)}>Forget everything</button>
              {/if}
            {/if}
          </div>
          <ul class="group-card">
            {#each app.memory?.records ?? [] as r (r.id)}
              <li class="fact group !block">
                <div class="flex min-h-7 items-center gap-2">
                  {#if editing === r.id}
                    <input
                      use:focusSelect
                      bind:value={editDraft}
                      aria-label="Edit fact"
                      class="h-7 min-w-0 flex-1 rounded-md bg-canvas px-2 outline-none"
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
                    <span class="min-w-0 flex-1">
                      <span class="text-fg">{plain(r.body)}</span>
                      {#if r.title || r.aliases.length > 0 || r.links.length > 0}
                        <span class="mt-0.5 block truncate text-[12px] text-fg-3">
                          {[r.title, ...r.aliases].filter(Boolean).join(' · ')}{#if r.links.length > 0}{r.title || r.aliases.length > 0 ? ' · ' : ''}Links to {r.links.map((l) => l.title).join(', ')}{/if}
                        </span>
                      {/if}
                    </span>
                    {#if confirmPurge === r.id}
                      <span class="flex shrink-0 items-center gap-2" in:fade={{ duration: 120 }}>
                        <span class="text-[12.5px] text-fg-2">Delete it and its history for good?</span>
                        <button class="text-[12px] text-fg-3 hover:text-fg" onclick={() => (confirmPurge = null)}>Keep</button>
                        <button class="text-[12px] font-medium text-danger" onclick={() => purge(r.id)}>Delete</button>
                      </span>
                    {:else}
                      <span class="mono-label shrink-0 !text-fg-4">{r.type}</span>
                      <span class="flex shrink-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 {why === r.id ? '' : 'opacity-0'}">
                        <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Edit'} onclick={() => ((editing = r.id), (editDraft = r.body))}><Icon name="edit" size={14} /></button>
                        <button class="icon-btn size-[26px] !rounded-lg" use:tip={'Why does Tomo think this?'} aria-expanded={why === r.id} onclick={() => toggleWhy(r.id)}><Icon name="info" size={14} /></button>
                        <button class="icon-btn size-[26px] !rounded-lg hover:!text-danger" use:tip={'Forget this for good'} onclick={() => (confirmPurge = r.id)}><Icon name="trash" size={14} /></button>
                      </span>
                    {/if}
                  {/if}
                </div>
                {#if why === r.id}
                  <div class="mt-2 mb-1 rounded-[10px] bg-canvas px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)]" transition:fade={{ duration: 120 }}>
                    <div class="mono-label mb-2">Why Tomo thinks this</div>
                    {#if !versions}
                      <div class="text-[12.5px] text-fg-3">Loading…</div>
                    {:else}
                      <ol class="flex flex-col gap-2">
                        {#each versions as v (v.id)}
                          <li class="text-[12.5px]">
                            <div class="flex flex-wrap items-baseline gap-x-2 text-fg-3">
                              <span class="font-label text-[11px] text-fg-4">{when(v.createdAt)}</span>
                              <span>
                                {WRITERS[v.writer]}{#if v.sourceSessionId}{' '}{v.writer === 'user' ? 'from' : 'in'}
                                  {#if v.sourceTitle}<button class="text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg" use:tip={'Open this chat'} onclick={() => openSource(v.sourceSessionId!)}>{v.sourceTitle}</button>{:else}a chat that has since been deleted{/if}{/if}{#if v.sourceJobId}{' '}on a job{/if}
                              </span>
                              {#if v.removedRev === null}<span class="mono-label ml-auto">Current</span>{/if}
                            </div>
                            <div class={v.removedRev === null ? 'text-fg-2' : 'text-fg-3 line-through decoration-fg-4'}>{plain(v.body)}</div>
                          </li>
                        {/each}
                      </ol>
                    {/if}
                  </div>
                {/if}
              </li>
            {:else}
              <li class="fact text-fg-3">{app.memory ? 'Nothing yet. Tell it about yourself in any chat, or add a fact below.' : 'Loading…'}</li>
            {/each}
            <li class="fact">
              <Icon name="plus" size={14} class="shrink-0 text-fg-3" />
              <input
                bind:value={newFact}
                aria-label="Add a fact"
                placeholder="Add a fact, e.g. Prefers metric units."
                class="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-4"
                onkeydown={(e) => e.key === 'Enter' && addFact()}
              />
              {#if newFact.trim()}<button class="btn solid sm" in:fade={{ duration: 120 }} onclick={addFact}>Add</button>{/if}
            </li>
          </ul>

          {#if app.memory && app.memory.revisions.length > 0}
            <button class="mono-label mx-0.5 mt-[22px] mb-2.5 flex items-center gap-1 hover:text-fg" aria-expanded={showHistory} onclick={() => (showHistory = !showHistory)}>
              History <span class="!text-fg-4 tabular-nums">({app.memory.revisions.length})</span>
              <Icon name="chevronDown" size={12} class="transition-transform duration-200 {showHistory ? '' : '-rotate-90'}" />
            </button>
            {#if showHistory}
              <ol class="group-card" transition:fade={{ duration: 120 }}>
                {#each app.memory.revisions as r, i (r.rev)}
                  <li class="fact !block">
                    <div class="flex items-center gap-2">
                      <span class="mono-label w-[54px] shrink-0 tabular-nums">Rev {r.rev}</span>
                      <span class="min-w-0 flex-1 text-fg-2">{r.note ?? KINDS[r.kind]}</span>
                      <span class="shrink-0 font-label text-[11px] text-fg-4">{when(r.createdAt)}</span>
                      {#if i > 0}
                        <button class="btn sm" use:tip={'Bring back the facts as they were after this change'} onclick={() => restore(r.rev)}>Restore</button>
                      {:else}
                        <span class="mono-label shrink-0 pr-1.5">Current</span>
                      {/if}
                    </div>
                    {#each r.added as fact, j (j)}<div class="pl-[62px] text-[12.5px] text-fg-2"><span class="text-fg-3">+</span> {fact}</div>{/each}
                    {#each r.removed as fact, j (j)}<div class="pl-[62px] text-[12.5px] text-fg-3 line-through decoration-fg-4">{fact}</div>{/each}
                  </li>
                {/each}
              </ol>
            {/if}
          {/if}
        </section>
      {/if}

      {#if tab === 'voice'}
        <section id="settings-voice">
          <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Voice</h3>
          <p class="mb-5 text-fg-3">Click the mic or press {shortcut('M')} to talk. ElevenLabs Scribe transcribes it.</p>
          <div class="group-card">
            <label class="srow">
              <span class="l"><b>Speech model</b><span>The ElevenLabs model that transcribes your voice</span></span>
              <input bind:value={form.sttModel} class={field} />
            </label>
            <label class="srow">
              <span class="l"><b>Language</b><span>Detect it, or set one for better accuracy</span></span>
              <input bind:value={form.sttLanguage} placeholder="Detect automatically" class={field} />
            </label>
          </div>
        </section>
      {/if}

      {#if tab === 'appearance'}
        <section id="settings-appearance">
          <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">Appearance</h3>
          <p class="mb-5 text-fg-3">How Tomo looks. Stored on this device.</p>
          <div class="group-card">
            <div class="srow">
              <div class="l"><b>Theme</b><span>Dark uses the near-black Agents palette</span></div>
              {@render segmented(themes, theme.pref, (v) => theme.set(v as ThemePref))}
            </div>
            <div class="srow">
              <div class="l"><b>Keep on top</b><span>The window stays above other apps on this desktop. The pin in the chat's top bar does the same.</span></div>
              {@render toggle(form.alwaysOnTop, 'Keep on top', () => (form.alwaysOnTop = !form.alwaysOnTop))}
            </div>
            <div class="srow">
              <div class="l"><b>Reading size</b><span>For replies, in pixels</span></div>
              {@render segmented([...READING_SIZES], appearance.prefs.size, (v) => appearance.set('size', v as ReadingSize))}
            </div>
          </div>

          <div class="mx-0.5 mt-[22px] mb-2.5 flex items-baseline">
            <span class="mono-label">Fonts</span>
            <button class="ml-auto text-[12px] text-fg-3 hover:text-fg" onclick={() => appearance.reset()}>Reset fonts</button>
          </div>
          <div class="group-card">
            <div class="srow !block">
              <div class="l"><b>Reading font</b><span>For replies</span></div>
              {@render fontPicker(READING_FONTS, appearance.prefs.reading, (id) => appearance.set('reading', id), 'Ag')}
              <p class="prose-chat mt-3 rounded-[10px] bg-canvas px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
                Replies are set like this. A sentence with <em>emphasis</em>, some <strong>weight</strong>, and <code>inline code</code>.
              </p>
            </div>
            <div class="srow !block">
              <div class="l"><b>Interface font</b></div>
              {@render fontPicker(UI_FONTS, appearance.prefs.ui, (id) => appearance.set('ui', id), 'Ag')}
            </div>
            <div class="srow !block">
              <div class="l"><b>Code font</b></div>
              {@render fontPicker(CODE_FONTS, appearance.prefs.code, (id) => appearance.set('code', id), '{ }')}
            </div>
          </div>
        </section>
      {/if}

      {#if tab === 'about'}
        {@const u = app.update}
        <section id="settings-about">
          <h3 class="mt-1.5 mb-1 font-display text-[22px] leading-[1.2] font-normal tracking-[-0.02em]">About</h3>
          <div class="mt-4 mb-5 flex items-center gap-4">
            <img src={logo} alt="" width="56" height="56" class="size-14 shrink-0 select-none" draggable="false" />
            <p class="text-fg-3">Tomo {u?.current ?? ''}</p>
          </div>
          <div class="group-card">
            <div class="srow">
              <div class="l">
                {#if !u || u.status === 'unsupported'}
                  <b>Development build</b><span>Updates apply to installed versions.</span>
                {:else if u.status === 'available'}
                  <b>{u.next} is available</b><span>You have {u.current}.</span>
                {:else if u.status === 'downloading'}
                  <b>Downloading {u.next}: {u.percent ?? 0}%</b><span>In the background.</span>
                {:else if u.status === 'downloaded' || u.status === 'installing'}
                  <b>{u.next} is ready</b><span>Downloaded in the background. Restart now, or it installs when you quit.</span>
                {:else}
                  <b>{u.status === 'checking' ? 'Checking for updates…' : u.error ? "Couldn't check for updates" : u.checkedAt ? `Tomo ${u.current} is up to date` : `Tomo ${u.current}`}</b>
                  <span>{u.checkedAt ? `Last ${u.error ? 'successful check' : 'checked'} ${when(u.checkedAt)}.` : 'Not checked yet.'} Updates are checked every 30 minutes.</span>
                {/if}
                {#if u?.error}<span class="!mt-1 flex items-start gap-1.5 !text-danger"><span class="mt-0.5 shrink-0"><Icon name="alert" size={12} /></span>{u.error}</span>{/if}
              </div>
              {#if u?.status === 'idle' || u?.status === 'checking'}
                <button class="btn" disabled={u.status === 'checking'} onclick={() => updateAction(window.api.updates.check)}>Check for updates</button>
              {:else if u?.status === 'available'}
                <button class="btn solid" onclick={() => updateAction(window.api.updates.download)}>Download</button>
              {:else if u?.status === 'downloaded' || u?.status === 'installing'}
                <button class="btn solid" disabled={u.status === 'installing'} onclick={() => updateAction(window.api.updates.install)}>Restart to update</button>
              {/if}
            </div>
            {#if u?.notes && (u.status === 'available' || u.status === 'downloading' || u.status === 'downloaded')}
              <div class="srow !block">
                <div class="l"><b>What's new</b></div>
                <p class="mt-1 line-clamp-6 text-[13px] whitespace-pre-line text-fg-2">{u.notes}</p>
              </div>
            {/if}
          </div>
        </section>
      {/if}
    </div>
  </section>
</div>

<style>
  /* Frosted panes on the frosted modal: a lighter glass with the same edge. */
  .group-card {
    margin-bottom: 16px;
    border-radius: var(--r-card);
    background: var(--glass-bg);
    box-shadow:
      inset 0 1px 0 var(--glass-edge),
      0 0 0 1px var(--glass-ring),
      var(--shadow-sm);
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 13px 16px;
    border-top: 1px solid var(--line);
  }
  .srow:first-child {
    border-top: 0;
  }
  .l {
    display: block;
    flex: 1;
    min-width: 0;
  }
  .l :global(b) {
    display: block;
    font-weight: 500;
  }
  .l > span {
    display: block;
    margin-top: 1px;
    font-size: 12.5px;
    color: var(--fg-3);
  }
  .fact {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px 10px 8px 16px;
    border-top: 1px solid var(--line);
    font-size: 13.5px;
  }
  .fact:first-child {
    border-top: 0;
  }
</style>
