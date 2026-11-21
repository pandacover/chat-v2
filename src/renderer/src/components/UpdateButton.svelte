<script lang="ts">
  // The update control: one row at the foot of the sidebar, shown only while there is something to
  // do (src/main/updateMachine.ts): a new version to download, its download, and once it's ready, a
  // restart into it. The row is the one control for it (no label plus a separate button). Hovering
  // shows a popover with what it would do and what changed. Checking now, and the last check's
  // result, live in Settings › About.
  // It's never `disabled` while busy, only aria-disabled: a disabled button gets no hover, and the
  // popover is where the download's percentage shows.
  import { onDestroy } from 'svelte'
  import { fade } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  const u = $derived(app.update)
  const status = $derived(u?.status ?? 'unsupported')

  const act = async () => {
    if (!u) return
    const api = window.api.updates
    const call =
      status === 'idle' ? api.check : status === 'available' ? api.download : status === 'downloaded' ? api.install : null
    if (!call) return
    const next = await app.attempt(() => call())
    if (next) app.update = next
  }

  const label = $derived(
    status === 'unsupported'
      ? 'Updates'
      : status === 'checking'
        ? 'Checking for updates'
        : status === 'available'
          ? `Download Tomo ${u?.next}`
          : status === 'downloading'
            ? `Downloading Tomo ${u?.next}: ${u?.percent ?? 0}%`
            : status === 'downloaded' || status === 'installing'
              ? `Restart to install Tomo ${u?.next}`
              : 'Check for updates'
  )

  // The progress ring: r 9 in a 24 box, as the Icon geometry.
  const RING = 2 * Math.PI * 9
  const dash = $derived(RING * (1 - Math.min(100, Math.max(0, u?.percent ?? 0)) / 100))

  /** "just now", "5 min ago", "3 h ago", or the date. */
  const ago = (at: number) => {
    const s = Math.round((Date.now() - at) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)} min ago`
    if (s < 86400) return `${Math.round(s / 3600)} h ago`
    return new Date(at).toLocaleDateString()
  }

  // The popover: fixed to the viewport so the sidebar's overflow can't clip it.
  let button: HTMLButtonElement | undefined = $state()
  let open = $state(false)
  let pos = $state({ left: 0, bottom: 0 })
  let timer: ReturnType<typeof setTimeout> | undefined
  // The relative time is re-read while the popover is open.
  let tick = $state(0)
  let ticker: ReturnType<typeof setInterval> | undefined
  const WIDTH = 248

  const show = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!button) return
      const r = button.getBoundingClientRect()
      pos = { left: Math.max(8, Math.min(innerWidth - WIDTH - 8, r.left)), bottom: innerHeight - r.top + 8 }
      tick++
      open = true
      clearInterval(ticker)
      ticker = setInterval(() => tick++, 30_000)
    }, 200)
  }
  const hide = () => {
    clearTimeout(timer)
    clearInterval(ticker)
    open = false
  }
  onDestroy(hide)
  // The row goes once the update is done with; its popover goes with it.
  $effect(() => {
    if (!button) hide()
  })
</script>

{#if status === 'available' || status === 'downloading' || status === 'downloaded' || status === 'installing'}
  <button
    bind:this={button}
    class="mb-1 flex h-[34px] w-full shrink-0 items-center gap-2 rounded-[10px] bg-blue-wash px-2.5 text-[13px] font-medium whitespace-nowrap text-blue-fg transition-colors hover:bg-[color-mix(in_srgb,var(--blue)_18%,transparent)] aria-disabled:cursor-default"
    aria-label={label}
    aria-busy={status === 'downloading' || status === 'installing'}
    aria-disabled={!['available', 'downloaded'].includes(status)}
    onclick={act}
    onpointerenter={show}
    onpointerleave={hide}
    onfocus={show}
    onblur={hide}
    transition:fade={{ duration: 160 }}
  >
    <i class="size-1.5 shrink-0 rounded-full bg-blue"></i>
    <span class="min-w-0 flex-1 truncate text-left">
      {status === 'available'
        ? `Tomo ${u?.next} is out`
        : status === 'downloading'
          ? `Downloading ${u?.percent ?? 0}%`
          : status === 'installing'
            ? 'Restarting…'
            : 'Update ready'}
    </span>
    {#if status === 'available'}
      <Icon name="download" size={15} />
    {:else if status === 'downloading'}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="color-mix(in srgb, currentColor 25%, transparent)" stroke-width="3" />
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray={RING}
          stroke-dashoffset={dash}
          transform="rotate(-90 12 12)"
          class="transition-[stroke-dashoffset] duration-300 ease-out"
        />
      </svg>
    {:else}
      <span class="grid place-items-center {status === 'installing' ? 'animate-spin' : ''}"><Icon name="refresh" size={15} /></span>
    {/if}
  </button>
{/if}

{#if open && u}
  <div
    role="tooltip"
    class="glass-float fixed z-[100] rounded-[14px] px-3.5 py-3 text-[12.5px] leading-snug text-fg-2"
    style="left: {pos.left}px; bottom: {pos.bottom}px; width: {WIDTH}px"
  >
    {#key tick}
      {#if status === 'unsupported'}
        <div class="font-medium text-fg">Tomo {u.current}</div>
        <div class="mt-0.5 text-muted">Development build. Updates apply to installed versions.</div>
      {:else if status === 'available' || status === 'downloading' || status === 'downloaded' || status === 'installing'}
        <div class="font-medium text-fg">
          {status === 'available'
            ? `Version ${u.next} is available`
            : status === 'downloading'
              ? `Downloading ${u.next}: ${u.percent ?? 0}%`
              : status === 'installing'
                ? `Restarting into ${u.next}…`
                : `Restart to install ${u.next}`}
        </div>
        {#if u.notes}
          <p class="mt-1.5 line-clamp-6 whitespace-pre-line text-fg-2">{u.notes}</p>
        {/if}
        <div class="mt-1.5 text-[11.5px] text-muted">
          {status === 'available'
            ? `You have ${u.current}. Click to download.`
            : status === 'downloaded'
              ? `You have ${u.current}. Click to restart now, or it installs when you quit.`
              : `You have ${u.current}.`}
        </div>
      {:else}
        <div class="font-medium text-fg">
          {status === 'checking'
            ? 'Checking for updates…'
            : u.error
              ? "Couldn't check for updates"
              : u.checkedAt
                ? `Tomo ${u.current} is up to date`
                : `Tomo ${u.current}`}
        </div>
        <div class="mt-0.5 text-[11.5px] text-muted">
          {u.error ? `You have ${u.current}. ` : ''}{u.checkedAt ? `Last ${u.error ? 'successful check' : 'checked'} ${ago(u.checkedAt)}.` : 'Not checked yet.'}
          {status === 'idle' ? ' Click to check now.' : ''}
        </div>
      {/if}
      {#if u.error}
        <div class="mt-1.5 flex items-start gap-1.5 text-danger"><span class="mt-px shrink-0"><Icon name="alert" size={12} /></span>{u.error}</div>
      {/if}
    {/key}
  </div>
{/if}
