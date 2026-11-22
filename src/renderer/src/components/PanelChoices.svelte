<script lang="ts">
  // What the right panel can open: the browser, and each artifact of the open chat (newest first).
  // Listed in the menu of the panel's + and in the empty panel. Something already open is gone to.
  import { app, tabKey } from '@/lib/store.svelte'
  import type { ChatArtifact } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  /** Called after a pick (the menu closes). */
  let { onpick, role = 'menuitem' }: { onpick?: () => void; role?: 'menuitem' | undefined } = $props()

  const artifacts = $derived([...app.chatArtifacts].reverse())
  const isOpen = (key: string) => app.panelTabs.some((t) => tabKey(t) === key)

  const browser = () => {
    if (isOpen('browser')) app.selectTab('browser')
    else app.openBrowser()
    onpick?.()
  }
  const artifact = (a: ChatArtifact) => {
    const key = `artifact:${a.identifier}`
    if (isOpen(key)) app.selectTab(key)
    else app.showArtifact({ identifier: a.identifier, messageId: a.versions.at(-1)!.messageId })
    onpick?.()
  }
</script>

<button type="button" {role} class="item" data-panel-choice="browser" onclick={browser}>
  <Icon name="globe" size={15} class="shrink-0 text-fg-3" />
  <span class="min-w-0 flex-1 truncate">Browser</span>
  {#if isOpen('browser')}<Icon name="check" size={15} class="shrink-0" />{/if}
</button>
<div class="mono-label px-2.5 pt-3 pb-1.5">Artifacts in this chat</div>
{#each artifacts as a (a.identifier)}
  <button type="button" {role} class="item" data-panel-choice="artifact:{a.identifier}" onclick={() => artifact(a)}>
    <Icon name="window" size={15} class="shrink-0 text-fg-3" />
    <span class="min-w-0 flex-1">
      <span class="block truncate">{a.title}</span>
      {#if a.versions.length > 1}<span class="block text-[12px] text-fg-3">{a.versions.length} versions</span>{/if}
    </span>
    {#if isOpen(`artifact:${a.identifier}`)}<Icon name="check" size={15} class="shrink-0" />{/if}
  </button>
{:else}
  <p class="px-2.5 pb-2 text-[12.5px] text-fg-3">None yet. What Tomo makes in this chat shows up here.</p>
{/each}

<style>
  .item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    border-radius: 10px;
    padding: 7px 10px;
    text-align: left;
    font-size: 13.5px;
    color: var(--fg);
    outline: none;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--wash);
  }
</style>
