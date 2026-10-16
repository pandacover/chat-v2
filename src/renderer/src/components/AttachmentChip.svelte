<script lang="ts">
  import { tip } from '@/lib/tooltip'
  import type { Attachment } from '@shared/types'
  import { pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let { attachment, onremove }: { attachment: Attachment; onremove?: () => void } = $props()

  const size = $derived(
    attachment.size > 1024 * 1024
      ? `${(attachment.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(attachment.size / 1024))} KB`
  )
  const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
  const audio = $derived(attachment.kind === 'audio' ? attachment.analysis : null)
  const analyzing = $derived(attachment.kind === 'audio' && app.analyzing.has(attachment.id))
  const meta = $derived.by(() => {
    if (attachment.kind !== 'audio') return size
    if (analyzing) return 'Finding the beat…'
    if (!audio) return size
    return `${audio.bpm !== null ? `${Math.round(audio.bpm)} BPM` : 'No steady beat'} · ${clock(audio.duration)}`
  })
  const audioTip = $derived.by(() => {
    if (!audio) return attachment.name
    const second = audio.library ? `; second opinion ${audio.library.bpm} BPM (${audio.agreement === 'agree' ? 'agrees' : audio.agreement === 'octave' ? 'half/double' : 'differs'})` : ''
    return `${audio.bpm !== null ? `${audio.bpm.toFixed(1)} BPM, ${audio.beats.length} beats, confidence ${audio.confidence.toFixed(2)}` : 'No steady beat found'}${second}`
  })
  // A tiny waveform from the analysis peaks.
  const bars = $derived(audio ? Array.from({ length: 12 }, (_, i) => audio.peaks[Math.floor((i / 12) * audio.peaks.length)] ?? 0) : [])
  const ext = $derived(attachment.kind === 'pdf' ? 'PDF' : (attachment.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'TXT'))
</script>

<div class="group relative flex h-11 items-center gap-2.5 rounded-md bg-hover/70 pr-3 pl-1.5" in:pop>
  {#if attachment.kind === 'image'}
    <img src={window.api.attachments.url(attachment.id)} alt="" class="size-8 rounded-sm object-cover" />
  {:else if attachment.kind === 'audio'}
    <div class="flex size-8 items-center justify-center gap-[1.5px] rounded-sm bg-surface px-1" aria-hidden="true">
      {#if bars.length}
        {#each bars as b, i (i)}<span class="w-[1.5px] rounded-full bg-fg-2" style="height: {Math.max(2, (b / 99) * 22)}px"></span>{/each}
      {:else}
        <Icon name="mic" size={14} class="text-muted {analyzing ? 'animate-pulse' : ''}" />
      {/if}
    </div>
  {:else}
    <div class="grid size-8 place-items-center rounded-sm bg-surface font-mono text-[9.5px] font-medium tracking-wide text-muted">{ext}</div>
  {/if}
  <div class="min-w-0 leading-tight">
    <div class="max-w-36 truncate text-[12.5px] text-fg" use:tip={attachment.name}>{attachment.name}</div>
    <div class="text-[11px] text-muted tabular-nums {analyzing ? 'thinking' : ''}" use:tip={attachment.kind === 'audio' ? audioTip : null}>{meta}</div>
  </div>
  {#if onremove}
    <button
      class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      use:tip={`Remove ${attachment.name}`}
      onclick={onremove}><Icon name="x" size={11} stroke={2.2} /></button
    >
  {/if}
</div>
