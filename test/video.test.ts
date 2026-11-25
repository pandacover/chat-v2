// Videos: attached and described to the model (services/Attachments.ts), seen through frames and
// heard through a transcript (agent/video.ts, services/Videos.ts), end to end against a fake Claude
// Code and a stand-in for ElevenLabs Scribe; plus the deputy's pure parts (agent/deputy.ts).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { AppPaths } from '../src/main/services/AppPaths'
import { Attachments, describeVideo } from '../src/main/services/Attachments'
import { Broadcaster, Chat } from '../src/main/services/Chat'
import { Db } from '../src/main/services/Db'
import { ElevenLabs } from '../src/main/services/ElevenLabs'
import { Jobs } from '../src/main/services/Jobs'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { videosLayer } from '../src/main/services/Videos'
import { Agent } from '../src/main/agent/driver'
import { DEFAULT_FRAMES, MAX_FRAMES, frameTimes, segmentWords, transcriptText } from '../src/main/agent/video'
import { deputyMayAnswer, deputyPrompt, parseDeputy, userSaid } from '../src/main/agent/deputy'
import { ComputerUse, noOverlay } from '../src/main/computer'
import { isVideoRun, stepLine, summarizeSteps } from '../src/shared/steps'
import { Browser } from '../src/main/services/Browser'
import { type Script, fakeQuery } from './fakeQuery'

setDefaultTimeout(30_000)

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tomo-video-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe('frame times', () => {
  test('spread evenly over the video, each in the middle of its share', () => {
    expect(frameTimes(80, {})).toEqual([5, 15, 25, 35, 45, 55, 65, 75])
    expect(frameTimes(80, {}).length).toBe(DEFAULT_FRAMES)
    expect(frameTimes(10, { count: 2 })).toEqual([2.5, 7.5])
    expect(frameTimes(100, { start: 20, end: 40, count: 4 })).toEqual([22.5, 27.5, 32.5, 37.5])
  })
  test('given times are kept inside the video, in order, once each, and no more than allowed', () => {
    expect(frameTimes(10, { times: [12, 3, 3, -1] })).toEqual([0, 3, 10])
    expect(frameTimes(1000, { times: Array.from({ length: 40 }, (_, i) => i) })).toHaveLength(MAX_FRAMES)
    expect(frameTimes(1000, { count: 99 })).toHaveLength(MAX_FRAMES)
  })
  test('a still or unknown length gives one frame', () => {
    expect(frameTimes(0, {})).toEqual([0])
    expect(frameTimes(10, { start: 4, end: 4 })).toEqual([4])
  })
})

const words = (list: Array<[string, number, number, string?, string?]>) =>
  list.flatMap(([text, start, end, speaker = 'speaker_0', type = 'word'], i) => [
    ...(i ? [{ text: ' ', start, end: start, type: 'spacing', speaker }] : []),
    { text, start, end, type, speaker }
  ])

test('a run of video steps is told apart from the browser', () => {
  const step = (tool: string) => ({ tool, label: tool, ok: true })
  expect(isVideoRun([step('video_frames'), step('video_transcript'), step('video')])).toBe(true)
  expect(isVideoRun([step('video_frames'), step('browser_read')])).toBe(false)
  expect(summarizeSteps(`${stepLine(step('video_frames'))}\nSaw it.`)).toBe('[Looked at a video: video_frames]\nSaw it.')
})

describe('transcripts', () => {
  test('stretches break at a new speaker and a long pause; sounds are in brackets', () => {
    const segs = segmentWords(
      words([
        ['Hello', 0, 0.4],
        ['there.', 0.5, 0.9],
        ['Hi!', 1.2, 1.5, 'speaker_1'],
        ['laughter', 1.6, 2, 'speaker_1', 'audio_event'],
        ['Later', 6, 6.5, 'speaker_1']
      ])
    )
    expect(segs).toEqual([
      { start: 0, end: 0.9, speaker: 'speaker_0', text: 'Hello there.' },
      { start: 1.2, end: 2, speaker: 'speaker_1', text: 'Hi! (laughter)' },
      { start: 6, end: 6.5, speaker: 'speaker_1', text: 'Later' }
    ])
    const text = transcriptText('talk.mp4', { segments: segs, language: 'eng' })
    expect(text).toBe(
      '<transcript video="talk.mp4" language="eng">\n[0:00–0:00] Speaker 1: Hello there.\n[0:01–0:02] Speaker 2: Hi! (laughter)\n[0:06–0:06] Speaker 2: Later\n</transcript>'
    )
    // A stretch of it; one voice needs no names.
    expect(transcriptText('talk.mp4', { segments: segs, language: null }, 5, 10)).toContain('[0:06–0:06] Speaker 2: Later')
    expect(transcriptText('solo.mp4', { segments: [segs[0]!], language: null })).toContain('] Hello there.')
    expect(transcriptText('quiet.mp4', { segments: [], language: null })).toContain('(No speech was heard in this video.)')
  })
  test('a very long transcript is cut, saying where to go on from', () => {
    const segments = Array.from({ length: 3000 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, speaker: null, text: 'word '.repeat(10).trim() }))
    const text = transcriptText('long.mp4', { segments, language: null })
    expect(text.length).toBeLessThan(62_000)
    expect(text).toMatch(/Cut off here: ask again with start \d+ for the rest\./)
  })
})

describe('the deputy', () => {
  test('never answers what the user keeps for themselves', () => {
    expect(deputyMayAnswer('shell.run')).toBe(true)
    expect(deputyMayAnswer('files.write')).toBe(true)
    expect(deputyMayAnswer('team')).toBe(true)
    expect(deputyMayAnswer('shell.irreversible')).toBe(false)
    expect(deputyMayAnswer('computer.irreversible')).toBe(false)
  })
  test("takes only the user's own words, a few at least", () => {
    const said = ['Sort my downloads.  You can APPROVE things for me on that job, I’m busy']
    expect(userSaid("you can approve things for me on that job, i'm busy", said)).toBe(true)
    expect(userSaid('approve everything forever', said)).toBe(false)
    expect(userSaid('approve', said)).toBe(false)
  })
  test('reads a yes or no, and nothing else', () => {
    expect(parseDeputy('Sure.\n{"approve": true, "why": "They said so."}')).toEqual({ approve: true, why: 'They said so.' })
    expect(parseDeputy('{"approve": "yes"}')).toBeNull()
    expect(parseDeputy('no json')).toBeNull()
    const prompt = deputyPrompt(
      { name: 'Tomo', words: 'approve for me', job: { title: 'Tidy', summary: null }, bot: 'Scout', task: 'Tidy the folder' },
      { title: 'Run a command', detail: 'mv a b', kind: 'shell.run' }
    )
    expect(prompt).toContain('<user_words>\napprove for me\n</user_words>')
    expect(prompt).toContain('Kind: Other commands')
  })
})

describe('video attachments', () => {
  test('a video is saved with its length and size, and goes to the model as a description, never the file', async () => {
    const dir = tempDir()
    const probed: string[] = []
    const probe = async (path: string) => (probed.push(path), { duration: 83.5, width: 1920, height: 1080 })
    const paths = AppPaths.layer(dir)
    const runtime = ManagedRuntime.make(Attachments.layerWith(() => null, probe).pipe(Layer.provideMerge(Layer.mergeAll(Db.layer(join(dir, 'chat.db')), paths))))
    const run = <A, E>(effect: Effect.Effect<A, E, Attachments | Db>) => runtime.runPromise(effect)
    try {
      const added = await run(Attachments.use((a) => a.add({ name: 'clip.mp4', mime: 'video/mp4', data: new Uint8Array([0, 0, 0, 24]).buffer })))
      expect(added).toMatchObject({ kind: 'video', mime: 'video/mp4', video: { duration: 83.5, width: 1920, height: 1080 } })
      expect(probed).toHaveLength(1)
      // From disk: copied, not read through memory.
      const src = join(dir, 'From disk.MOV')
      writeFileSync(src, 'moov')
      const copied = await run(Attachments.use((a) => a.addVideoFile({ path: src, name: 'From disk.MOV', mime: '' })))
      expect(copied).toMatchObject({ kind: 'video', mime: 'video/quicktime', size: 4 })
      const stored = (await run(Db.use((db) => db.use((d) => d.getAttachment(copied.id)))))!
      expect(readFileSync(stored.path, 'utf8')).toBe('moov')
      expect(await run(Effect.flip(Attachments.use((a) => a.addVideoFile({ path: join(dir, 'notes.txt'), name: 'notes.txt', mime: 'text/plain' }))))).toMatchObject({
        _tag: 'InvalidInput'
      })
      const row = (await run(Db.use((db) => db.use((d) => d.getAttachment(added.id)))))!
      const blocks = await run(Attachments.use((a) => a.toBlocks([row])))
      expect(blocks).toEqual([{ type: 'text', text: describeVideo(added) }])
      expect(describeVideo(added)).toContain(`<video file="clip.mp4" id="${added.id}">\nLength 1:23 (83.5 s), 1920×1080`)
      expect(describeVideo({ ...added, video: null })).toContain("Its length couldn't be read")
    } finally {
      await runtime.dispose()
    }
  })
})

describe('the video tools', () => {
  // ElevenLabs Scribe, stood in for: the words of a short talk, and what each call sent.
  const scribe: Array<{ fields: Record<string, string>; file: { name: string; size: number } | null }> = []
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData()
        const fields: Record<string, string> = {}
        let file: { name: string; size: number } | null = null
        for (const [k, v] of form.entries()) {
          if (typeof v === 'string') fields[k] = v
          else file = { name: (v as File).name, size: (v as File).size }
        }
        scribe.push({ fields, file })
        return Response.json({
          text: 'Welcome to the demo. Thanks!',
          language_code: 'eng',
          words: words([
            ['Welcome', 0.2, 0.6],
            ['to', 0.6, 0.7],
            ['the', 0.7, 0.8],
            ['demo.', 0.8, 1.2],
            ['Thanks!', 4, 4.5, 'speaker_1']
          ]).map(({ speaker, ...w }) => ({ ...w, speaker_id: speaker }))
        })
      }
    })
    process.env.ELEVENLABS_BASE_URL = `http://localhost:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    delete process.env.ELEVENLABS_BASE_URL
  })

  // Each line of the user's message is a tool call: "frames {json}" or "transcript {json}"; the
  // reply says what came back (texts, and how many images).
  const script: Script = async function* (t) {
    if (t.call.options.persistSession === false) {
      yield* t.text('Named')
      yield t.result()
      return
    }
    const said = t.call.prompt.find((b) => b.type === 'text' && /^(frames|transcript) /m.test(b.text ?? ''))?.text ?? ''
    const out: string[] = []
    for (const line of said.split('\n')) {
      const m = /^(frames|transcript) (\{.*\})$/.exec(line.trim())
      if (!m) continue
      const r = yield* t.tool(`mcp__video__${m[1]}`, JSON.parse(m[2]!))
      const content = r.result?.content ?? []
      out.push(`${content.filter((c) => c.type === 'image').length} images | ${content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' | ')}`)
    }
    yield* t.text(out.join('\n') || 'nothing asked')
    yield t.result()
  }

  const setup = () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))
    const fake = fakeQuery(script)
    const grabbed: Array<{ path: string; times: readonly number[]; edge: number; snap: number }> = []
    const paths = AppPaths.layer(dir)
    const settings = SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths))
    const base = Layer.mergeAll(Db.layer(join(dir, 'chat.db')), settings, paths)
    const agent = Agent.layer({ query: fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
    const computer = ComputerUse.layer({ platform: null, overlay: noOverlay, remember: async () => {} })
    const probe = async () => ({ duration: 60, width: 1280, height: 720 })
    const providers = Layer.mergeAll(agent, Attachments.layerWith(() => null, probe), computer, ElevenLabs.layer).pipe(Layer.provideMerge(base))
    const broadcaster = Layer.succeed(Broadcaster, Broadcaster.of({ send: () => {} }))
    const chat = Chat.layer.pipe(Layer.provide(providers), Layer.provide(broadcaster), Layer.provide(Layer.succeed(Browser, {} as never)))
    const jobs = Jobs.layer.pipe(Layer.provideMerge(chat), Layer.provide(providers), Layer.provide(broadcaster))
    const videos = videosLayer({
      probe,
      // A slow video (its name says so) runs out of time after two frames.
      frames: async (path, times, edge, snap) => {
        grabbed.push({ path, times, edge, snap })
        const slow = grabbed.length === 4
        return { frames: (slow ? times.slice(0, 2) : times).map((time) => ({ time, data: 'AAAA' })), partial: slow }
      }
    }).pipe(Layer.provide(Layer.mergeAll(chat, providers)))
    const runtime = ManagedRuntime.make(Layer.mergeAll(jobs, videos, providers))
    const run = <A, E>(eff: Effect.Effect<A, E, Jobs | Chat | Db | Attachments | SettingsStore>) => runtime.runPromise(eff)
    const reply = async (text: string, attachmentIds: string[] = []) => {
      await run(Jobs.use((j) => j.send({ text, attachmentIds })))
      const t0 = Date.now()
      for (;;) {
        const last = (await run(Jobs.use((j) => j.primary))).path.at(-1)!.message
        if (last.role === 'assistant' && last.status !== 'streaming') return last.content
        if (Date.now() - t0 > 5000) throw new Error('timed out waiting for the reply')
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    return { dir, fake, grabbed, run, reply, runtime }
  }

  test('frames: an overview, a stretch, or given moments; by id or name, never a video that isn’t there', async () => {
    const t = setup()
    try {
      const video = await t.run(Attachments.use((a) => a.add({ name: 'Demo.mp4', mime: 'video/mp4', data: new Uint8Array(8).buffer })))
      const said = await t.reply(
        [
          `frames {"video":"${video.id}"}`,
          'frames {"video":"demo.MP4","start":10,"end":20,"count":2}',
          `frames {"video":"${video.id}","times":[1.5,90]}`,
          'frames {"video":"nope.mp4"}',
          `frames {"video":"${video.id}","count":4}`
        ].join('\n'),
        [video.id]
      )
      const lines = said.split('\n').filter((l) => !l.startsWith('::step'))
      expect(lines[0]).toBe(`8 images | Demo.mp4: 1:00 long, 1280×720. 8 frames: | ${[3.75, 11.25, 18.75, 26.25, 33.75, 41.25, 48.75, 56.25].map((s) => `At 0:${s.toFixed(1).padStart(4, '0')}`).join(' | ')}`)
      expect(lines[1]).toBe('2 images | Demo.mp4: 1:00 long, 1280×720. 2 frames: | At 0:12.5 | At 0:17.5')
      expect(lines[2]).toBe('2 images | Demo.mp4: 1:00 long, 1280×720. 2 frames: | At 0:01.5 | At 1:00.0')
      expect(lines[3]).toContain('0 images | There is no video “nope.mp4” here.')
      expect(lines[4]).toContain('2 images | Demo.mp4: 1:00 long, 1280×720. 2 frames: | At 0:07.5 | At 0:22.5 | Stopped after 2 of 4: this video is slow to decode.')
      expect(t.grabbed.map((g) => g.edge)).toEqual([768, 1024, 1024, 1024])
      // Spread frames may move to a keyframe, under half the gap between them; exact moments don't move.
      expect(t.grabbed.map((g) => Math.round(g.snap * 100) / 100)).toEqual([3.38, 2.25, 0, 6.75])
      // The model was told about the video, not sent it, and the reply's steps say what it looked at.
      const prompt = t.fake.calls.find((c) => c.options.persistSession !== false)!
      expect(prompt.prompt.map((b) => b.text ?? '').join('\n')).toContain(`<video file="Demo.mp4" id="${video.id}">`)
      expect(said).toContain('Looked at 8 frames of Demo.mp4')
      expect(Object.keys(prompt.options.mcpServers ?? {})).toContain('video')
    } finally {
      await t.runtime.dispose()
    }
  })

  test('transcript: made by Scribe once, with times and speakers, then kept; without a key it says where to add one', async () => {
    const t = setup()
    try {
      const video = await t.run(Attachments.use((a) => a.add({ name: 'talk.mov', mime: 'video/quicktime', data: new Uint8Array(16).buffer })))
      const noKey = await t.reply(`transcript {"video":"${video.id}"}`, [video.id])
      expect(noKey).toContain('no ElevenLabs API key is set')
      expect(scribe).toHaveLength(0)

      await t.run(SettingsStore.use((s) => s.update({ elevenLabsKey: 'xi-test' })))
      const said = await t.reply(`transcript {"video":"${video.id}"}\ntranscript {"video":"talk.mov","start":3}`)
      expect(said).toContain('[0:00–0:01] Speaker 1: Welcome to the demo.\n[0:04–0:04] Speaker 2: Thanks!')
      expect(said).toContain('Read the transcript of talk.mov')
      // The stretch from 3 s on has only the thanks.
      const second = said.split('\n').filter((l) => l.startsWith('0 images')).at(-1)!
      expect(second).toContain('<transcript video="talk.mov" language="eng">')
      // One call to Scribe, the file itself, word timings and speakers asked for.
      expect(scribe).toHaveLength(1)
      expect(scribe[0]!.file).toEqual({ name: expect.stringMatching(/\.mov$/), size: 16 })
      expect(scribe[0]!.fields).toMatchObject({ timestamps_granularity: 'word', diarize: 'true', model_id: 'scribe_v2' })
      const kept = await t.run(Db.use((db) => db.use((d) => d.transcriptOf(d.getAttachment(video.id)!.path))))
      expect(JSON.parse(kept!).segments).toHaveLength(2)
    } finally {
      await t.runtime.dispose()
    }
  })
})
