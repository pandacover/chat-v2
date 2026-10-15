<script lang="ts">
  import hljs from 'highlight.js/lib/common'
  import { fade } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let tab = $state<'preview' | 'code'>('preview')
  let url = $state<string | null>(null)
  let reloadKey = $state(0)
  let loading = $state(true)
  let copied = $state(false)

  const versions = $derived(app.artifactVersions)
  // Off-branch selection (e.g. after switching branches) falls back to the newest version.
  const found = $derived(versions.findIndex((v) => v.messageId === app.artifact?.messageId))
  const index = $derived(found === -1 ? versions.length - 1 : found)
  const current = $derived(versions[index])

  $effect(() => {
    const html = current?.block.content
    if (html === undefined) return
    let cancelled = false
    void window.api.artifacts.publish(html).then((u) => {
      if (cancelled) return
      if (u !== url) loading = true
      url = u
    })
    return () => {
      cancelled = true
    }
  })

  const select = (i: number) => {
    const v = versions[i]
    if (v && app.artifact) app.artifact = { identifier: app.artifact.identifier, messageId: v.messageId }
  }

  const download = () => {
    if (!current) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([current.block.content], { type: 'text/html' }))
    a.download = `${current.block.identifier}.html`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const copy = async () => {
    if (!current) return
    await navigator.clipboard.writeText(current.block.content)
    copied = true
    setTimeout(() => (copied = false), 1400)
  }
</script>

<svelte:window
  onkeydown={(e) => {
    // Yield to dialogs and to any handler that already used the key.
    if (e.key !== 'Escape' || e.defaultPrevented || app.page !== 'chat' || document.querySelector('[aria-modal="true"]')) return
    app.artifact = null
  }}
/>

{#if current}
  <section class="flex h-full min-w-0 flex-col bg-side">
    <header class="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
      <h2 class="min-w-0 truncate font-serif text-[16px]" title={current.block.title}>{current.block.title}</h2>
      {#if versions.length > 1}
        <div class="ml-1 flex items-center text-[12px] text-muted tabular-nums">
          <button class="icon-btn !p-1" aria-label="Previous version" disabled={index === 0} onclick={() => select(index - 1)}>
            <Icon name="chevronLeft" size={13} />
          </button>
          <span>v{index + 1}</span>
          <button class="icon-btn !p-1" aria-label="Next version" disabled={index === versions.length - 1} onclick={() => select(index + 1)}>
            <Icon name="chevronRight" size={13} />
          </button>
        </div>
      {/if}

      <div class="relative ml-auto grid grid-cols-2 rounded-md bg-hover/70 p-0.5 text-[12.5px]" role="tablist">
        <span
          class="absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-sm bg-surface shadow-[0_1px_2px_#0000001f] transition-transform duration-200 ease-out"
          style="transform: translateX({tab === 'code' ? '100%' : '0'})"
        ></span>
        <button role="tab" aria-selected={tab === 'preview'} class="relative px-3 py-1 {tab === 'preview' ? 'text-fg' : 'text-muted'}" onclick={() => (tab = 'preview')}>
          Preview
        </button>
        <button role="tab" aria-selected={tab === 'code'} class="relative px-3 py-1 {tab === 'code' ? 'text-fg' : 'text-muted'}" onclick={() => (tab = 'code')}>
          Code
        </button>
      </div>

      <span class="mx-1 h-4 w-px bg-line"></span>
      <button class="icon-btn" title="Reload" onclick={() => ((loading = true), reloadKey++)}><Icon name="refresh" size={15} /></button>
      <button class="icon-btn" title={copied ? 'Copied' : 'Copy HTML'} onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={15} /></button>
      <button class="icon-btn" title="Download .html" onclick={download}><Icon name="download" size={15} /></button>
      <button class="icon-btn" title="Close (Esc)" onclick={() => (app.artifact = null)}><Icon name="x" size={15} /></button>
    </header>

    <div class="relative min-h-0 flex-1 px-2 pb-2">
      <div class="relative h-full overflow-hidden rounded-md bg-surface shadow-[0_0_0_1px_var(--line)]">
        {#if tab === 'preview'}
          {#if url}
            {#key `${url}:${reloadKey}`}
              <!-- Opaque-origin sandbox: scripts run, but cannot reach the app, its storage, or the parent window. -->
              <iframe
                title={current.block.title}
                src={url}
                sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"
                allow="fullscreen; clipboard-write"
                class="size-full bg-white transition-opacity duration-200 {loading ? 'opacity-0' : 'opacity-100'}"
                onload={() => (loading = false)}
              ></iframe>
            {/key}
          {/if}
          {#if loading}
            <div class="absolute inset-0 grid place-items-center" out:fade={{ duration: 150 }}><span class="thinking text-[13px]">Loading</span></div>
          {/if}
        {:else}
          <div class="h-full overflow-auto px-4 py-3" in:fade={{ duration: 140 }}>
            <pre class="text-[12.5px] leading-relaxed"><code class="hljs font-mono">{@html hljs.highlight(current.block.content, { language: 'xml' }).value}</code></pre>
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
