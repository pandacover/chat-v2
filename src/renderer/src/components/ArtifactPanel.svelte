<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import { escapeHtml, highlighter } from '@/lib/highlight.svelte'
  import { fade } from '@/lib/motion'
  import { app, type OpenArtifact } from '@/lib/store.svelte'
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  /**
   * One artifact tab of the panel: `open` is the artifact and the version it shows, `active` whether
   * its tab is the one on show. The panel's tabs (App.svelte) start the header.
   */
  let { tabs, open, active }: { tabs: Snippet; open: OpenArtifact; active: boolean } = $props()

  let tab = $state<'preview' | 'code'>('preview')
  let url = $state<string | null>(null)
  let reloadKey = $state(0)
  let loading = $state(true)
  let copied = $state(false)

  const versions = $derived(app.versionsOf(open.identifier))
  // Off-branch selection (e.g. after switching branches) falls back to the newest version.
  const found = $derived(versions.findIndex((v) => v.messageId === open.messageId))
  const index = $derived(found === -1 ? versions.length - 1 : found)
  const current = $derived(versions[index])

  // Plain strings, so a streamed line that leaves the artifact unchanged doesn't
  // re-publish it or re-highlight its code.
  const html = $derived(current?.block.content)
  const highlighted = $derived(highlighter.hljs?.highlight(html ?? '', { language: 'xml' }).value ?? escapeHtml(html ?? ''))

  $effect(() => {
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
    if (v) app.pickVersion(open.identifier, v.messageId)
  }

  const download = () => {
    if (!current) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([current.block.content], { type: 'text/html' }))
    a.download = `${current.block.identifier}.html`
    a.click()
    // The save dialog reads the blob after the user picks a folder, so it must outlive that.
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
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
    if (e.key !== 'Escape' || e.defaultPrevented || app.page !== 'chat' || !active || !app.panelOpen || document.querySelector('[aria-modal="true"]')) return
    e.preventDefault()
    app.closeTab(`artifact:${open.identifier}`)
  }}
/>

{#if current}
  <section class="flex h-full min-w-0 flex-col" aria-label="Artifact">
    <!-- Its tab's close button closes it (Esc does too); the app bar's panel toggle hides the panel. -->
    <header class="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-2.5">
      {@render tabs()}
      {#if versions.length > 1}
        <div class="flex shrink-0 items-center font-label text-[11.5px] text-fg-3 tabular-nums">
          <button class="icon-btn size-[26px] !rounded-lg" aria-label="Previous version" disabled={index === 0} onclick={() => select(index - 1)}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <span>v{index + 1}/{versions.length}</span>
          <button class="icon-btn size-[26px] !rounded-lg" aria-label="Next version" disabled={index === versions.length - 1} onclick={() => select(index + 1)}>
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
      {/if}
      <div class="seg mx-1 !p-0.5" role="tablist" aria-label="View">
        <button role="tab" class="!h-6 !px-2.5" aria-selected={tab === 'preview'} onclick={() => (tab = 'preview')}>Preview</button>
        <button role="tab" class="!h-6 !px-2.5" aria-selected={tab === 'code'} onclick={() => (tab = 'code')}>Code</button>
      </div>
      <button class="icon-btn size-[26px] shrink-0 !rounded-lg" use:tip={'Reload'} onclick={() => ((loading = true), reloadKey++)}><Icon name="refresh" size={14} /></button>
      <button class="icon-btn size-[26px] shrink-0 !rounded-lg" use:tip={copied ? 'Copied' : 'Copy HTML'} onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
      <button class="icon-btn size-[26px] shrink-0 !rounded-lg" use:tip={'Download .html'} onclick={download}><Icon name="download" size={14} /></button>
    </header>

    <div class="relative min-h-0 flex-1 bg-canvas">
      <div class="relative h-full overflow-hidden">
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
          <div class="h-full overflow-auto p-5" in:fade={{ duration: 140 }}>
            <pre class="text-[12.5px] leading-relaxed"><code class="hljs font-mono">{@html highlighted}</code></pre>
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
