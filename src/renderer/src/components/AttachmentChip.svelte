<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import type { Attachment } from '@shared/types'
  import { pop } from '@/lib/motion'
  import Icon from './Icon.svelte'

  let { attachment, onremove }: { attachment: Attachment; onremove?: () => void } = $props()

  const size = $derived(
    attachment.size > 1024 * 1024
      ? `${(attachment.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(attachment.size / 1024))} KB`
  )
  const ext = $derived(attachment.kind === 'pdf' ? 'PDF' : (attachment.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'TXT'))
</script>

<div class="group relative flex h-11 items-center gap-2.5 rounded-md bg-hover/70 pr-3 pl-1.5" in:pop>
  {#if attachment.kind === 'image'}
    <img src={window.api.attachments.url(attachment.id)} alt="" class="size-8 rounded-sm object-cover" />
  {:else}
    <div class="grid size-8 place-items-center rounded-sm bg-surface font-mono text-[9.5px] font-medium tracking-wide text-muted">{ext}</div>
  {/if}
  <div class="min-w-0 leading-tight">
    <div class="max-w-36 truncate text-[12.5px] text-fg" use:tip={attachment.name}>{attachment.name}</div>
    <div class="text-[11px] text-muted">{size}</div>
  </div>
  {#if onremove}
    <button
      class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      use:tip={`Remove ${attachment.name}`}
      onclick={onremove}><Icon name="x" size={11} stroke={2.2} /></button
    >
  {/if}
</div>
