import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { parseContent, replaceArtifacts } from '../src/shared/artifacts'
import { type NoteItem, type ShotItem, docToSpec, layoutBoard, parseBoardDoc, parseMoodboard, sketchPrompt } from '../src/shared/moodboard'
import { AppPaths } from '../src/main/services/AppPaths'
import { type ImageRequest, OpenRouter } from '../src/main/services/OpenRouter'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { Sketches } from '../src/main/services/Sketches'

const SPEC = {
  style: 'neon noir',
  shots: [
    { id: 'wide', title: 'Wide', sketch: 'rooftop at dusk', steps: ['Low tripod', 'Hold 8 bars'] },
    { id: 'close', title: 'Close', sketch: 'face lit by a phone', steps: ['85mm', 'Push in slowly', 'Cut on the snare'] }
  ],
  notes: ['Palette: teal and rust']
}

describe('mood board format', () => {
  test('artifacts carry their kind', () => {
    const [html, board] = parseContent('<artifact identifier="a" title="A"><p/></artifact><artifact type="moodboard" identifier="b" title="B">{}</artifact>')
    expect(html).toMatchObject({ kind: 'html' })
    expect(board).toMatchObject({ kind: 'moodboard', identifier: 'b' })
  })

  test('reads model JSON leniently', () => {
    expect(parseMoodboard('not json')).toBeNull()
    expect(parseMoodboard('{"shots": []}')).toBeNull()
    const spec = parseMoodboard(JSON.stringify([{ description: 'a street', steps: ['Go', 3, null] }, { title: 'Two' }, { id: 'x' }]))!
    expect(spec.shots).toEqual([
      { id: 'shot-1', title: 'Shot 1', sketch: 'a street', steps: ['Go', '3'] },
      { id: 'shot-2', title: 'Two', sketch: 'Two', steps: [] }
    ])
    expect(spec.style).toBe('')
  })

  test('layout gives every step an arrow target and round-trips to the same spec', () => {
    const doc = layoutBoard(SPEC)
    const shots = doc.items.filter((i): i is ShotItem => i.kind === 'shot')
    const notes = doc.items.filter((i): i is NoteItem => i.kind === 'note')
    expect(shots).toHaveLength(2)
    expect(notes.filter((n) => n.shotId === 'close').map((n) => n.text)).toEqual(['85mm', 'Push in slowly', 'Cut on the snare'])
    // Steps sit to the right of their shot; free notes sit above the shots.
    for (const n of notes.filter((n) => n.shotId)) expect(n.x).toBeGreaterThan(shots.find((s) => s.id === n.shotId)!.x + shots[0]!.w)
    expect(notes.find((n) => !n.shotId)!.y).toBeLessThan(shots[0]!.y - 44)
    // A tall panel stacks the shots; a wide one puts them side by side, clear of each other's steps.
    expect(shots[1]!.x).toBe(shots[0]!.x)
    const wide = layoutBoard(SPEC, null, 4).items.filter((i) => i.kind !== 'note' || i.shotId === 'wide')
    const wideStep = wide.find((i) => i.kind === 'note')!
    expect(wide.find((i) => i.id === 'close')!.x).toBeGreaterThan(wideStep.x + wideStep.w)
    expect(docToSpec(doc)).toEqual(SPEC)
    expect(parseBoardDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
  })

  test('a new version keeps the positions of shots the user moved', () => {
    const before = layoutBoard(SPEC)
    const wide = before.items.find((i) => i.id === 'wide') as ShotItem
    wide.x = 999
    wide.variant = 2
    const next = layoutBoard({ ...SPEC, shots: [...SPEC.shots, { id: 'new', title: 'New', sketch: 'car', steps: [] }] }, before)
    expect(next.items.find((i) => i.id === 'wide')).toMatchObject({ x: 999, variant: 2 })
    expect(next.items.filter((i) => i.kind === 'shot')).toHaveLength(3)
    // A changed sketch description is drawn fresh.
    const redrawn = layoutBoard({ ...SPEC, shots: [{ ...SPEC.shots[0]!, sketch: 'rooftop at dawn' }] }, before)
    expect(redrawn.items.find((i) => i.id === 'wide')).toMatchObject({ variant: 0 })
  })

  test('replaceArtifacts swaps only the bodies asked for', () => {
    const content = 'a\n<artifact type="moodboard" identifier="m" title="M">\nold\n</artifact>\n<artifact identifier="h">x</artifact>'
    const out = replaceArtifacts(content, ({ identifier, kind }) => (kind === 'moodboard' && identifier === 'm' ? 'new' : null))
    expect(out).toBe('a\n<artifact type="moodboard" identifier="m" title="M">\nnew\n</artifact>\n<artifact identifier="h">x</artifact>')
  })

  test('sketch prompts forbid text in the image', () => {
    expect(sketchPrompt('a car', 'rain')).toContain('no text')
    expect(sketchPrompt('a car', '')).not.toContain('Mood')
  })
})

describe('sketches', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-sketch-'))
    dirs.push(dir)
    const calls: ImageRequest[] = []
    const paths = AppPaths.layer(dir)
    const settings = SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths))
    const openRouter = Layer.succeed(
      OpenRouter,
      OpenRouter.of({
        streamChat: () => {
          throw new Error('unused')
        },
        listModels: Effect.succeed([]),
        listImageModels: Effect.succeed([]),
        generateImage: (req) =>
          Effect.sync(() => calls.push(req)).pipe(
            Effect.andThen(Effect.sleep('20 millis')),
            Effect.as({ data: new Uint8Array([1, 2, 3]), mime: 'image/png', cost: 0.008 })
          )
      })
    )
    const runtime = ManagedRuntime.make(Sketches.layer.pipe(Layer.provide(Layer.mergeAll(openRouter, settings, paths))))
    const get = (prompt: string, variant = 0) => runtime.runPromise(Sketches.use((s) => s.get(prompt, variant)))
    return { dir, calls, runtime, get }
  }

  test('each prompt is drawn once, even when asked for twice at the same time', async () => {
    const t = setup()
    const [a, b] = await Promise.all([t.get('a rooftop'), t.get('a rooftop')])
    expect(a).toBe('data:image/png;base64,AQID')
    expect(b).toBe(a)
    expect(await t.get('a rooftop')).toBe(a)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]).toMatchObject({ model: 'black-forest-labs/flux-3-image-klein', prompt: 'a rooftop', aspectRatio: '16:9' })
    expect(readdirSync(join(t.dir, 'sketches'))).toHaveLength(1)
    // Redraw asks again.
    await t.get('a rooftop', 1)
    expect(t.calls).toHaveLength(2)
    await t.runtime.dispose()
  })
})
