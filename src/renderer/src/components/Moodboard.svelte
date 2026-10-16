<script lang="ts">
  import '@fontsource/caveat/400.css'
  import '@fontsource/caveat/700.css'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { tip } from '@/lib/tooltip'
  import {
    type BoardDoc,
    type BoardItem,
    type NoteItem,
    type ShotItem,
    NOTE_W,
    TITLE_SPACE,
    estimateNoteHeight,
    layoutBoard,
    newId,
    parseBoardDoc,
    parseMoodboard,
    sketchPrompt
  } from '@shared/moodboard'
  import {
    HANDLE,
    LINE_H,
    NOTE_FONT,
    PRINT_PALETTE,
    STEP_INDENT,
    type Palette,
    type SketchState,
    TITLE_FONT,
    boardBounds,
    drawPaper,
    drawScene,
    itemRect,
    noteRect,
    shotRect,
    themePalette
  } from '@/lib/sketchy'
  import { app } from '@/lib/store.svelte'
  import Icon from './Icon.svelte'

  let {
    messageId,
    identifier,
    content,
    title,
    earlier = []
  }: {
    messageId: string
    identifier: string
    content: string
    title: string
    /** Older versions of this board, oldest first; edits to them carry positions forward. */
    earlier?: string[]
  } = $props()

  let host: HTMLDivElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let editor: HTMLTextAreaElement | undefined = $state()

  let doc = $state.raw<BoardDoc | null>(null)
  let failed = $state(false)
  let selected = $state<string | null>(null)
  let view = $state({ x: 0, y: 0, scale: 1 })
  let size = { w: 0, h: 0 }
  /** The field open in the text overlay. */
  /** `fresh` marks an item created for this edit; it is dropped if left empty. */
  let editing = $state<{ id: string; field: 'text' | 'title' | 'sketch'; value: string; before: string; fresh?: boolean } | null>(null)
  let undoStack: string[] = []
  let redoStack: string[] = []
  let canUndo = $state(false)
  let canRedo = $state(false)

  const sketches = new Map<string, SketchState>()
  // Measuring needs a context even before the canvas is on screen.
  const measure = document.createElement('canvas').getContext('2d')!

  const selectedItem = $derived(doc?.items.find((i) => i.id === selected) ?? null)
  const selectedShotId = $derived(selectedItem ? (selectedItem.kind === 'shot' ? selectedItem.id : selectedItem.shotId) : null)

  // --- drawing ---------------------------------------------------------------

  let frame = 0
  const redraw = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      paint()
    })
  }

  const sketchKey = (shot: ShotItem) => `${shot.variant}|${sketchPrompt(shot.sketch, doc?.style ?? '')}`

  const scene = (palette: Palette, scale: number) => ({
    doc: doc!,
    palette,
    sketch: (shot: ShotItem) => sketches.get(sketchKey(shot)),
    selected,
    hidden: editing ? (editing.field === 'title' ? `${editing.id}:title` : editing.field === 'text' ? editing.id : null) : null,
    scale
  })

  const paint = () => {
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')!
    const dpr = devicePixelRatio || 1
    const palette = themePalette(host)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawPaper(ctx, size.w, size.h, view, palette)
    if (!doc) return
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y)
    drawScene(ctx, scene(palette, 1 / view.scale))
  }

  // Theme switches change the palette.
  $effect(() => {
    void app.settings
    const observer = new MutationObserver(redraw)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    return () => observer.disconnect()
  })

  $effect(() => {
    void selected
    void editing
    void view.x
    void view.y
    void view.scale
    redraw()
  })

  // --- sketches --------------------------------------------------------------

  const requestSketches = () => {
    if (!doc) return
    for (const item of doc.items) {
      if (item.kind !== 'shot' || !item.sketch.trim()) continue
      const key = sketchKey(item)
      if (sketches.has(key)) continue
      sketches.set(key, { status: 'loading' })
      const [variant, ...rest] = key.split('|')
      void window.api.boards
        .sketch(rest.join('|'), Number(variant))
        .then(async (url) => {
          const image = new Image()
          image.src = url
          await image.decode()
          sketches.set(key, { status: 'ready', image })
        })
        .catch((e: unknown) => {
          const message = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          sketches.set(key, { status: 'error', message })
        })
        .finally(redraw)
    }
  }

  // --- loading and saving ----------------------------------------------------

  let loadedFor = ''
  const load = async () => {
    const key = `${messageId}:${identifier}`
    const spec = parseMoodboard(content)
    const saved = parseBoardDoc(await window.api.boards.get(messageId, identifier).catch(() => null))
    let next = saved
    if (!next && spec) {
      // Start from the most recent earlier version the user edited, so moved shots stay put.
      let previous: BoardDoc | null = null
      for (const id of [...earlier].reverse()) {
        previous = parseBoardDoc(await window.api.boards.get(id, identifier).catch(() => null))
        if (previous) break
      }
      next = layoutBoard(spec, previous, aspect())
    }
    if (loadedFor !== key) return
    doc = next
    failed = !next
    undoStack = []
    redoStack = []
    syncHistory()
    selected = null
    editing = null
    requestSketches()
    fitView()
  }

  $effect(() => {
    const key = `${messageId}:${identifier}`
    untrack(() => {
      if (loadedFor === key) return
      void flushSave()
      loadedFor = key
      doc = null
      void load()
    })
  })

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  const flushSave = async () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (!dirty || !doc) return
    dirty = false
    const [m, id] = loadedFor.split(':') as [string, string]
    await app.attempt(() => window.api.boards.save(m, id, doc))
  }

  const syncHistory = () => {
    canUndo = undoStack.length > 0
    canRedo = redoStack.length > 0
  }

  /** Records `before` for undo and saves the board shortly after. */
  const commit = (before: string) => {
    if (!doc || JSON.stringify(doc) === before) return
    undoStack.push(before)
    if (undoStack.length > 100) undoStack.shift()
    redoStack = []
    syncHistory()
    dirty = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void flushSave(), 400)
    requestSketches()
    redraw()
  }

  const snapshot = () => JSON.stringify(doc)

  /** Applies a change to a copy of the board, as one undo step. */
  const change = (mutate: (items: BoardItem[]) => BoardItem[] | void, style?: string) => {
    if (!doc) return
    const before = snapshot()
    const items = structuredClone(doc.items)
    doc = { ...doc, style: style ?? doc.style, items: mutate(items) ?? items }
    commit(before)
  }

  const restore = (from: string[], to: string[]) => {
    const state = from.pop()
    if (!state || !doc) return
    to.push(snapshot())
    doc = JSON.parse(state) as BoardDoc
    syncHistory()
    dirty = true
    void flushSave()
    if (selected && !doc.items.some((i) => i.id === selected)) selected = null
    requestSketches()
    redraw()
  }
  const undo = () => restore(undoStack, redoStack)
  const redo = () => restore(redoStack, undoStack)

  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (!host || !canvas) return
      const dpr = devicePixelRatio || 1
      size = { w: host.clientWidth, h: host.clientHeight }
      canvas.width = Math.round(size.w * dpr)
      canvas.height = Math.round(size.h * dpr)
      redraw()
    })
    if (host) ro.observe(host)
    // The handwriting face loads lazily; redraw once it is in.
    void Promise.all([document.fonts.load(NOTE_FONT), document.fonts.load(TITLE_FONT)]).then(() => redraw())
    return () => ro.disconnect()
  })

  onDestroy(() => {
    cancelAnimationFrame(frame)
    void flushSave()
  })

  // --- view ------------------------------------------------------------------

  const aspect = () => (host && host.clientHeight > 0 ? host.clientWidth / host.clientHeight : 1.6)

  const toWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale })

  const fitView = () => {
    if (!doc || !host) return
    const b = boardBounds(measure, doc)
    const w = host.clientWidth || 800
    const h = host.clientHeight || 600
    if (!b) return void (view = { x: w / 2, y: h / 2, scale: 1 })
    const scale = Math.min(1.2, Math.max(0.1, Math.min((w - 80) / b.w, (h - 120) / b.h)))
    view = { scale, x: (w - b.w * scale) / 2 - b.x * scale, y: (h - 40 - b.h * scale) / 2 - b.y * scale }
  }

  const zoomAt = (factor: number, sx = size.w / 2, sy = size.h / 2) => {
    const scale = Math.min(3, Math.max(0.1, view.scale * factor))
    const k = scale / view.scale
    view = { scale, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k }
  }

  const onwheel = (e: WheelEvent) => {
    e.preventDefault()
    if (editing) commitEdit()
    if (e.ctrlKey || e.metaKey) {
      const rect = canvas!.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015 * (e.deltaMode === 1 ? 30 : 1)), e.clientX - rect.left, e.clientY - rect.top)
    } else {
      view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY }
    }
  }

  // --- hit testing -----------------------------------------------------------

  const hit = (p: { x: number; y: number }): BoardItem | null => {
    if (!doc) return null
    for (let i = doc.items.length - 1; i >= 0; i--) {
      const item = doc.items[i]!
      const r = itemRect(measure, item)
      const pad = 6
      if (p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad) return item
    }
    return null
  }

  const onHandle = (p: { x: number; y: number }) => {
    const item = selectedItem
    if (!item || item.kind !== 'shot') return false
    const r = shotRect(item)
    // Matches drawSelection: padding and handle keep their screen size when zoomed out.
    const pad = 8 * Math.max(1, 1 / view.scale)
    const s = (HANDLE + 6) / view.scale
    return Math.abs(p.x - (r.x + r.w + pad)) <= s && Math.abs(p.y - (r.y + r.h + pad)) <= s
  }

  // --- pointer ---------------------------------------------------------------

  type Drag =
    | { mode: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | { mode: 'move'; sx: number; sy: number; start: Map<string, { x: number; y: number }>; before: string; moved: boolean }
    | { mode: 'resize'; id: string; before: string; ratio: number }
  let drag: Drag | null = null
  let cursor = $state('default')

  const onpointerdown = (e: PointerEvent) => {
    if (!doc || !canvas) return
    if (editing) commitEdit()
    host?.focus({ preventScroll: true })
    canvas.setPointerCapture(e.pointerId)
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const p = toWorld(sx, sy)
    if (e.button === 1 || e.button === 2 || spaceDown) {
      drag = { mode: 'pan', sx, sy, vx: view.x, vy: view.y }
      return
    }
    if (onHandle(p)) {
      const shot = selectedItem as ShotItem
      drag = { mode: 'resize', id: shot.id, before: snapshot(), ratio: shot.h / shot.w }
      return
    }
    const target = hit(p)
    selected = target?.id ?? null
    if (!target) {
      drag = { mode: 'pan', sx, sy, vx: view.x, vy: view.y }
      cursor = 'grabbing'
      return
    }
    // A shot carries its steps along unless Alt is held.
    const moving = doc.items.filter((i) => i.id === target.id || (target.kind === 'shot' && !e.altKey && i.kind === 'note' && i.shotId === target.id))
    drag = { mode: 'move', sx, sy, start: new Map(moving.map((i) => [i.id, { x: i.x, y: i.y }])), before: snapshot(), moved: false }
  }

  const onpointermove = (e: PointerEvent) => {
    if (!canvas || !doc) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    if (!drag) {
      const p = toWorld(sx, sy)
      cursor = spaceDown ? 'grab' : onHandle(p) ? 'nwse-resize' : hit(p) ? 'move' : 'default'
      return
    }
    if (drag.mode === 'pan') {
      view = { ...view, x: drag.vx + sx - drag.sx, y: drag.vy + sy - drag.sy }
      return
    }
    if (drag.mode === 'move') {
      const d = drag
      const dx = (sx - d.sx) / view.scale
      const dy = (sy - d.sy) / view.scale
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return
      d.moved = true
      // Items are mutated in place while dragging; the drop is recorded as one undo step.
      for (const item of doc.items) {
        const s = d.start.get(item.id)
        if (s) {
          item.x = s.x + dx
          item.y = s.y + dy
        }
      }
      redraw()
      return
    }
    const shot = doc.items.find((i) => i.id === (drag as { id: string }).id) as ShotItem | undefined
    if (!shot) return
    const p = toWorld(sx, sy)
    shot.w = Math.max(160, p.x - shot.x - 8)
    shot.h = Math.round(shot.w * drag.ratio)
    redraw()
  }

  const onpointerup = (e: PointerEvent) => {
    canvas?.releasePointerCapture(e.pointerId)
    const d = drag
    drag = null
    cursor = spaceDown ? 'grab' : 'default'
    if (!d || !doc || d.mode === 'pan') return
    if (d.mode === 'move' && !d.moved) return
    // In-place edits must become a new object for derived state to notice.
    doc = { ...doc, items: [...doc.items] }
    commit(d.before)
  }

  const ondblclick = (e: MouseEvent) => {
    if (!doc || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const p = toWorld(e.clientX - rect.left, e.clientY - rect.top)
    const target = hit(p)
    if (!target) return addNote(null, p)
    selected = target.id
    if (target.kind === 'note') return startEdit(target.id, 'text')
    startEdit(target.id, p.y < target.y ? 'title' : 'sketch')
  }

  // --- editing ---------------------------------------------------------------

  const startEdit = (id: string, field: 'text' | 'title' | 'sketch') => {
    const item = doc?.items.find((i) => i.id === id)
    if (!item) return
    const value = item.kind === 'note' ? item.text : field === 'title' ? item.title : item.sketch
    editing = { id, field, value, before: snapshot() }
    requestAnimationFrame(() => {
      editor?.focus()
      editor?.select()
    })
  }

  const commitEdit = () => {
    const e = editing
    if (!e || !doc) return
    editing = null
    const value = e.field === 'title' ? e.value.replace(/\s+/g, ' ').trim() : e.value.trim()
    const item = doc.items.find((i) => i.id === e.id)
    if (!item) return
    // An emptied step or note is removed, as is a new shot left undescribed; shots otherwise keep their old text.
    if (!value) {
      if (item.kind === 'note' || e.fresh) {
        doc = { ...doc, items: doc.items.filter((i) => i.id !== e.id && !(i.kind === 'note' && i.shotId === e.id)) }
        selected = null
        commit(e.before)
      }
      redraw()
      return
    }
    doc = {
      ...doc,
      items: doc.items.map((i) =>
        i.id !== e.id ? i : i.kind === 'note' ? { ...i, text: value } : e.field === 'title' ? { ...i, title: value } : { ...i, sketch: value }
      )
    }
    commit(e.before)
  }

  const cancelEdit = () => {
    const e = editing
    editing = null
    // An item created for this edit is dropped again.
    if (e?.fresh && doc) {
      doc = { ...doc, items: doc.items.filter((i) => i.id !== e.id) }
      selected = null
    }
    redraw()
  }

  /** Screen box and font of the open editor, over the text it replaces. */
  const editorBox = $derived.by(() => {
    if (!editing || !doc) return null
    const item = doc.items.find((i) => i.id === editing!.id)
    if (!item) return null
    const s = view.scale
    if (item.kind === 'note') {
      const r = noteRect(measure, item)
      const inset = item.shotId ? STEP_INDENT : 12
      const top = item.shotId ? 4 : 16
      return {
        left: view.x + (r.x + inset) * s,
        top: view.y + (r.y + top) * s,
        width: (r.w - inset - (item.shotId ? 0 : 12)) * s,
        height: Math.max(r.h - top, LINE_H * 2) * s,
        font: `${22 * s}px Caveat, cursive`,
        line: `${LINE_H * s}px`,
        sketch: false
      }
    }
    if (editing.field === 'title') {
      return {
        left: view.x + (item.x + 36) * s,
        top: view.y + (item.y - TITLE_SPACE + 4) * s,
        width: (item.w - 36) * s,
        height: (TITLE_SPACE - 8) * s,
        font: `700 ${27 * s}px Caveat, cursive`,
        line: `${(TITLE_SPACE - 8) * s}px`,
        sketch: false
      }
    }
    return { left: view.x + item.x * s, top: view.y + item.y * s, width: item.w * s, height: item.h * s, font: '', line: '', sketch: true }
  })

  // --- toolbar actions -------------------------------------------------------

  const addNote = (shotId: string | null, at?: { x: number; y: number }) => {
    if (!doc) return
    const id = newId(shotId ? 'step' : 'note')
    let x = at?.x ?? 0
    let y = at?.y ?? 0
    if (shotId) {
      const shot = doc.items.find((i) => i.id === shotId) as ShotItem | undefined
      const steps = doc.items.filter((i): i is NoteItem => i.kind === 'note' && i.shotId === shotId)
      const last = steps.at(-1)
      if (last) {
        const r = noteRect(measure, last)
        x = last.x
        y = r.y + r.h + 22
      } else if (shot) {
        x = shot.x + shot.w + 120
        y = shot.y + shot.h / 2 - 20
      }
    } else if (!at) {
      const c = toWorld(size.w / 2, size.h / 2)
      x = c.x - (NOTE_W - 40) / 2
      y = c.y - estimateNoteHeight('') / 2
    }
    const note: NoteItem = { kind: 'note', id, x, y, w: shotId ? NOTE_W : NOTE_W - 40, text: '', shotId }
    // The empty note is added without an undo step; writing in it records one.
    const before = snapshot()
    doc = { ...doc, items: [...doc.items, note] }
    selected = id
    editing = { id, field: 'text', value: '', before, fresh: true }
    requestAnimationFrame(() => editor?.focus())
  }

  const removeSelected = () => {
    const id = selected
    if (!id) return
    change((items) => items.filter((i) => i.id !== id && !(i.kind === 'note' && i.shotId === id)))
    selected = null
  }

  const redrawSketch = () => {
    const id = selectedShotId
    if (!id) return
    change((items) => items.map((i) => (i.id === id && i.kind === 'shot' ? { ...i, variant: i.variant + 1 } : i)))
  }

  const addShot = () => {
    if (!doc) return
    const b = boardBounds(measure, doc)
    const id = newId('shot')
    const shot: ShotItem = { kind: 'shot', id, x: b ? b.x : 0, y: b ? b.y + b.h + 130 + TITLE_SPACE : TITLE_SPACE, w: 480, h: 270, title: 'New shot', sketch: '', variant: 0 }
    const before = snapshot()
    doc = { ...doc, items: [...doc.items, shot] }
    selected = id
    // A shot needs a description before anything is drawn.
    editing = { id, field: 'sketch', value: '', before, fresh: true }
    requestAnimationFrame(() => editor?.focus())
  }

  /** Puts the board back to what the model wrote, dropping hand edits (undoable). */
  export const reset = () => {
    const spec = parseMoodboard(content)
    if (!spec || !doc) return
    const before = snapshot()
    doc = layoutBoard(spec, null, aspect())
    selected = null
    commit(before)
    fitView()
  }

  /** Renders the whole board to a PNG on light paper and downloads it. */
  export const exportPng = async () => {
    if (!doc) return
    await Promise.all([document.fonts.load(NOTE_FONT), document.fonts.load(TITLE_FONT)])
    const b = boardBounds(measure, doc)
    if (!b) return
    const margin = 60
    const scale = Math.min(2, 8000 / (b.w + margin * 2), 8000 / (b.h + margin * 2))
    const out = document.createElement('canvas')
    out.width = Math.round((b.w + margin * 2) * scale)
    out.height = Math.round((b.h + margin * 2) * scale)
    const ctx = out.getContext('2d')!
    drawPaper(ctx, out.width, out.height, { x: 0, y: 0, scale: scale }, PRINT_PALETTE)
    ctx.setTransform(scale, 0, 0, scale, (margin - b.x) * scale, (margin - b.y) * scale)
    drawScene(ctx, { ...scene(PRINT_PALETTE, 1), selected: null, hidden: null })
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'))
    if (!blob) return app.toast('The board is too large to export')
    const path = await app.attempt(async () => window.api.boards.savePng(identifier, await blob.arrayBuffer()))
    if (path) app.toast(`Saved ${path}`, 'info')
  }

  // --- keyboard --------------------------------------------------------------

  let spaceDown = false
  const onkeydown = (e: KeyboardEvent) => {
    if (editing) {
      // The editor may not have focus yet; Escape still belongs to it, not to the panel.
      if (e.key === 'Escape' && e.target !== editor) {
        e.preventDefault()
        e.stopPropagation()
        cancelEdit()
      }
      return
    }
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      removeSelected()
    } else if (e.key === 'Enter' && selectedItem) {
      e.preventDefault()
      startEdit(selectedItem.id, selectedItem.kind === 'note' ? 'text' : 'title')
    } else if (e.key === 'Escape' && selected) {
      // Deselect first; the panel's own Escape closes it next time.
      e.preventDefault()
      e.stopPropagation()
      selected = null
    } else if (e.key === ' ' && !spaceDown) {
      e.preventDefault()
      spaceDown = true
      cursor = 'grab'
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      zoomAt(1.2)
    } else if (mod && e.key === '-') {
      e.preventDefault()
      zoomAt(1 / 1.2)
    } else if (mod && e.key === '0') {
      e.preventDefault()
      fitView()
    }
  }
  const onkeyup = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      spaceDown = false
      cursor = 'default'
    }
  }
</script>

<!-- The board takes keyboard focus for its shortcuts (Delete, Ctrl+Z, Space to pan). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={host}
  class="relative size-full overflow-hidden outline-none"
  role="application"
  aria-label="Mood board: {title}"
  tabindex="0"
  {onkeydown}
  {onkeyup}
>
  <canvas
    bind:this={canvas}
    class="absolute inset-0 size-full touch-none"
    style="cursor: {cursor}"
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointercancel={onpointerup}
    {ondblclick}
    oncontextmenu={(e) => e.preventDefault()}
    {onwheel}
  ></canvas>

  {#if editing && editorBox}
    {#if editorBox.sketch}
      <div
        class="absolute flex flex-col gap-2 rounded-md bg-surface/95 p-3 shadow-[0_0_0_1px_var(--muted),var(--shadow)]"
        style="left: {editorBox.left}px; top: {editorBox.top}px; width: {Math.max(260, editorBox.width)}px; min-height: {Math.max(150, editorBox.height)}px"
      >
        <span class="text-[12px] font-medium text-fg-2">What the sketch shows</span>
        <textarea
          bind:this={editor}
          bind:value={editing.value}
          class="min-h-0 flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-fg outline-none"
          placeholder="Framing, angle, subject, setting, light"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              cancelEdit()
            }
          }}
          onblur={commitEdit}
        ></textarea>
        <span class="text-[11.5px] text-muted">Enter redraws the sketch with the image model.</span>
      </div>
    {:else}
      <textarea
        bind:this={editor}
        bind:value={editing.value}
        class="absolute resize-none overflow-hidden bg-transparent p-0 text-fg outline-none"
        style="left: {editorBox.left}px; top: {editorBox.top}px; width: {editorBox.width}px; height: {editorBox.height}px; font: {editorBox.font}; line-height: {editorBox.line}"
        placeholder={editing.field === 'title' ? 'Shot title' : 'Write a step'}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commitEdit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelEdit()
          }
        }}
        oninput={redraw}
        onblur={commitEdit}
      ></textarea>
    {/if}
  {/if}

  {#if failed}
    <div class="absolute inset-0 grid place-items-center p-8 text-center text-[13px] text-muted">
      The model's board couldn't be read. The Code tab shows what it wrote; ask it to try again.
    </div>
  {/if}

  {#if doc}
    <div class="absolute inset-x-0 bottom-3 flex justify-center px-3">
      <div class="flex items-center gap-0.5 rounded-lg bg-surface p-1 text-[12.5px] shadow-[0_0_0_1px_var(--line),var(--shadow)]">
        <button class="icon-btn" use:tip={'Add a shot'} onclick={addShot}><Icon name="camera" size={15} /></button>
        <button class="icon-btn" use:tip={selectedShotId ? 'Add a step to this shot' : 'Select a shot to add a step'} disabled={!selectedShotId} onclick={() => addNote(selectedShotId)}>
          <Icon name="plus" size={15} />
        </button>
        <button class="icon-btn" use:tip={'Add a note (or double-click the board)'} onclick={() => addNote(null)}><Icon name="note" size={15} /></button>
        <button class="icon-btn" use:tip={selectedShotId ? 'Draw this sketch again' : 'Select a shot to redraw its sketch'} disabled={!selectedShotId} onclick={redrawSketch}>
          <Icon name="pen" size={15} />
        </button>
        <button class="icon-btn" use:tip={{ text: 'Delete', kbd: 'Del' }} disabled={!selected} onclick={removeSelected}><Icon name="trash" size={15} /></button>
        <span class="mx-1 h-4 w-px bg-line"></span>
        <button class="icon-btn" use:tip={{ text: 'Undo', kbd: 'Ctrl Z' }} disabled={!canUndo} onclick={undo}><Icon name="undo" size={15} /></button>
        <button class="icon-btn" use:tip={{ text: 'Redo', kbd: 'Ctrl Y' }} disabled={!canRedo} onclick={redo}><Icon name="redo" size={15} /></button>
        <span class="mx-1 h-4 w-px bg-line"></span>
        <button class="icon-btn" use:tip={'Zoom out'} onclick={() => zoomAt(1 / 1.2)}><Icon name="minus" size={15} /></button>
        <button class="w-11 rounded-md py-1 text-center text-fg-2 tabular-nums hover:bg-hover hover:text-fg" use:tip={{ text: 'Fit the board', kbd: 'Ctrl 0' }} onclick={fitView}>
          {Math.round(view.scale * 100)}%
        </button>
        <button class="icon-btn" use:tip={'Zoom in'} onclick={() => zoomAt(1.2)}><Icon name="plus" size={15} /></button>
      </div>
    </div>
    <p class="pointer-events-none absolute top-2 left-3 text-[11.5px] text-muted">Double-click to edit · drag to move · Ctrl+scroll to zoom</p>
  {/if}
</div>
