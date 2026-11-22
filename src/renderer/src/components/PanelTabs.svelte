<script lang="ts">
  // The right panel's tab strip, at the start of whichever header shows: a tab for each thing open
  // (the browser, an artifact of the open chat), each with its close button, then + to open
  // another, from a menu of what there is.
  import { tick } from 'svelte'
  import { tip } from '@/lib/tooltip'
  import { pop } from '@/lib/motion'
  import { app, tabKey, type PanelTab } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'
  import PanelChoices from './PanelChoices.svelte'

  let open = $state(false)
  let root: HTMLDivElement | undefined = $state()
  let menu: HTMLDivElement | undefined = $state()

  const activeKey = $derived(app.activeTab ? tabKey(app.activeTab) : null)
  const label = (t: PanelTab) =>
    t.kind === 'browser' ? app.browser.title || 'Browser' : (app.chatArtifacts.find((a) => a.identifier === t.identifier)?.title ?? 'Artifact')

  const toggle = async () => {
    open = !open
    await tick()
    menu?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      open = false
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) open = false
  }}
/>

<div class="relative mr-auto flex min-w-0 items-center gap-1" bind:this={root}>
  {#if app.shownTabs.length > 0}
    <div class="tabs flex min-w-0 gap-0.5 overflow-x-auto rounded-full bg-wash p-[3px]" role="tablist" aria-label="Panel">
      {#each app.shownTabs as t (tabKey(t))}
        {@const key = tabKey(t)}
        {@const on = key === activeKey}
        <div
          class="group/tab flex h-7 max-w-[180px] min-w-[72px] shrink items-center rounded-full transition-colors {on ? 'glass text-fg' : 'text-fg-3 hover:text-fg'}"
          data-panel-tab={key}
        >
          <button role="tab" aria-selected={on} class="inline-flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 text-[13px] font-medium" onclick={() => app.selectTab(key)}>
            <Icon name={t.kind === 'browser' ? 'globe' : 'window'} size={14} class="shrink-0" />
            <span class="truncate">{label(t)}</span>
            {#if t.kind === 'browser' && app.control.active}<span class="size-1.5 shrink-0 rounded-full bg-blue"></span>{/if}
          </button>
          <!-- Always there, shown on the open tab and on hover, so a tab never changes width. -->
          <button
            class="mr-1 ml-0.5 grid size-5 shrink-0 place-items-center rounded-full text-fg-4 transition-opacity hover:bg-wash hover:text-fg focus-visible:opacity-100 {on ? '' : 'opacity-0 group-hover/tab:opacity-100'}"
            use:tip={'Close tab'}
            data-panel-close={key}
            onclick={() => app.closeTab(key)}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      {/each}
    </div>
  {/if}
  <button
    class="icon-btn size-7 shrink-0 {open ? '!text-fg' : ''}"
    aria-haspopup="menu"
    aria-expanded={open}
    use:tip={open ? null : 'Open the browser or an artifact'}
    data-panel-add
    onclick={toggle}
  >
    <Icon name="plus" size={15} />
  </button>

  {#if open}
    <!-- Opaque: it always sits over a page or an artifact, which would show through the glass. -->
    <div
      bind:this={menu}
      role="menu"
      tabindex="-1"
      class="glass-float !bg-card absolute top-full left-0 z-50 mt-2 max-h-[min(380px,60vh)] w-[300px] max-w-[80vw] origin-top-left overflow-y-auto rounded-[14px] p-1"
      transition:pop={{ duration: 150 }}
      data-panel-menu
      {onkeydown}
    >
      <div class="mono-label px-2.5 pt-2.5 pb-1.5">Open in the panel</div>
      <PanelChoices onpick={() => (open = false)} />
    </div>
  {/if}
</div>

<style>
  .tabs {
    scrollbar-width: none;
  }
</style>
