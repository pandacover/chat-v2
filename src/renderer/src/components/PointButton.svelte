<script lang="ts">
  // Point: the user marks a spot or a box on their screen, and it goes into the next message as a
  // marked image and a note with its coordinates (main's computer/point.ts). Shown while computer
  // use is on in the chat. Ctrl+P (Cmd+P on a Mac) starts it, or cancels the one under way.
  import { modKey, shortcut } from '@/lib/keys'
  import { pop } from '@/lib/motion'
  import { app } from '@/lib/store.svelte'
  import { tip } from '@/lib/tooltip'
  import Icon from './Icon.svelte'

  let { onadded }: { onadded?: () => void } = $props()

  const toggle = () => void app.attempt(() => window.api.computer.point())

  // Once a mark is in the draft, the composer takes focus for the message about it.
  let seen = app.pointAdded
  $effect(() => {
    if (app.pointAdded === seen) return
    seen = app.pointAdded
    onadded?.()
  })

  const onkeydown = (e: KeyboardEvent) => {
    if (!modKey(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p' || app.settingsOpen) return
    e.preventDefault()
    if (!e.repeat) toggle()
  }
</script>

<svelte:window {onkeydown} />

<!-- A round companion to the Computer switch beside it; solid while Point is on, like the switches. -->
<button
  class="icon-btn size-8 {app.pointing ? '!bg-solid !text-on-solid' : ''}"
  aria-label="Point"
  aria-pressed={app.pointing}
  data-tip-no-label
  use:tip={{ text: app.pointing ? 'Cancel pointing' : 'Point at something on your screen', kbd: shortcut('P') }}
  onclick={toggle}
  in:pop={{ duration: 160 }}
>
  <Icon name="crosshair" size={16} />
</button>
