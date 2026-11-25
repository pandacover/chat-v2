// The video tools: how a bot sees and hears a video, which no Claude model takes whole. frames
// gives stills (evenly spread, over a stretch, or at given moments); transcript gives what is said,
// with times and speakers, from ElevenLabs Scribe, kept once made. A video is an attachment (by
// its id, or its name in this chat) or a file on the computer (by its path, under the bot's rule
// for reading files). services/Videos.ts does the work behind them.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Step } from '@shared/steps'
import type { VideoInfo } from '@shared/types'
import type { RunContext, ToolModuleFactory } from './module'

/** Frames one call may ask for, and how many it gets when it doesn't say. */
export const MAX_FRAMES = 16
export const DEFAULT_FRAMES = 8
/** Characters of transcript one call returns; a longer one is read a stretch at a time. */
export const TRANSCRIPT_CHARS = 60_000

/** A video a tool call names, found. */
export interface FoundVideo {
  path: string
  name: string
  mime: string
  /** Null when not known yet (a file on disk) or not readable. */
  info: VideoInfo | null
}

/** A stretch of speech: who said it (Scribe's speaker id, when it told speakers apart), and when. */
export interface Segment {
  start: number
  end: number
  speaker: string | null
  text: string
}

export interface VideoDeps {
  /** The video `ref` names, or what is wrong. May ask the user's OK to read a file. */
  readonly find: (ctx: RunContext, ref: string, signal: AbortSignal) => Promise<FoundVideo | { error: string }>
  readonly probe: (path: string) => Promise<VideoInfo | null>
  /** Stills near `times`; one within `snap` seconds of a keyframe is taken there (each says its real time). */
  readonly frames: (path: string, times: readonly number[], edge: number, snap: number) => Promise<{ frames: Array<{ time: number; data: string }>; partial: boolean }>
  /** The transcript, made once per file and kept. */
  readonly transcript: (video: FoundVideo) => Promise<{ segments: Segment[]; language: string | null }>
}

export const clock = (s: number, tenths = false) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const ss = tenths ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * The moments to take frames at: `times` as given, or `count` spread evenly over start..end (each
 * in the middle of its share, so neither the black first frame nor the last is taken). Within the
 * video, in order, without repeats.
 */
export const frameTimes = (duration: number, o: { times?: readonly number[] | undefined; start?: number | undefined; end?: number | undefined; count?: number | undefined }): number[] => {
  const last = Math.max(0, duration)
  const clampT = (t: number) => Math.min(Math.max(0, t), last)
  let times: number[]
  if (o.times?.length) times = o.times.slice(0, MAX_FRAMES).map(clampT)
  else {
    const from = clampT(o.start ?? 0)
    const to = Math.max(from, clampT(o.end ?? last))
    const n = Math.min(MAX_FRAMES, Math.max(1, Math.round(o.count ?? DEFAULT_FRAMES)))
    const span = to - from
    times = span <= 0 ? [from] : Array.from({ length: n }, (_, i) => from + ((i + 0.5) * span) / n)
  }
  const rounded = times.map((t) => Math.round(t * 100) / 100)
  return [...new Set(rounded)].sort((a, b) => a - b)
}

/**
 * How far a frame may move to a keyframe (which decodes alone, so it is fast): for frames spread
 * over a stretch, under half the gap between them, so no two land on one keyframe; none for moments
 * asked for exactly.
 */
export const snapFor = (times: readonly number[], o: { times?: readonly number[] | undefined }): number => {
  if (o.times?.length || times.length === 0) return 0
  if (times.length === 1) return 1
  return ((times.at(-1)! - times[0]!) / (times.length - 1)) * 0.45
}

/** Scribe's words as stretches of speech: a new one at a change of speaker, a pause, or a sentence's end once it runs long. */
export const segmentWords = (words: ReadonlyArray<{ text: string; start: number; end: number; type: string; speaker: string | null }>): Segment[] => {
  const out: Segment[] = []
  let cur: Segment | null = null
  for (const w of words) {
    if (w.type === 'spacing') {
      if (cur) cur.text += ' '
      continue
    }
    const text = w.type === 'audio_event' ? w.text.replace(/^\(?/, '(').replace(/\)?$/, ')') : w.text
    const pause = cur ? w.start - cur.end : 0
    const long = cur ? cur.end - cur.start : 0
    const sentenceEnd = cur ? /[.!?…]["')\]]?\s*$/.test(cur.text) : false
    if (!cur || w.speaker !== cur.speaker || pause > 1.5 || (long > 20 && sentenceEnd) || long > 45) {
      if (cur) out.push(cur)
      cur = { start: w.start, end: w.end, speaker: w.speaker, text }
    } else {
      cur.text += cur.text.endsWith(' ') || !cur.text ? text : ` ${text}`
      cur.end = Math.max(cur.end, w.end)
    }
  }
  if (cur) out.push(cur)
  return out.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text)
}

/** The transcript as the model reads it: a line per stretch, with its times, and speakers when there are several. */
export const transcriptText = (name: string, t: { segments: readonly Segment[]; language: string | null }, from = 0, to = Infinity) => {
  const speakers = new Set(t.segments.map((s) => s.speaker).filter(Boolean))
  const label = (s: Segment) => (speakers.size > 1 && s.speaker ? `${s.speaker.replace(/^speaker_(\d+)$/, (_, n: string) => `Speaker ${Number(n) + 1}`)}: ` : '')
  const shown = t.segments.filter((s) => s.end >= from && s.start <= to)
  const lines: string[] = []
  let chars = 0
  let cut: Segment | null = null
  for (const s of shown) {
    const line = `[${clock(s.start)}–${clock(s.end)}] ${label(s)}${s.text}`
    if (chars + line.length > TRANSCRIPT_CHARS) {
      cut = s
      break
    }
    lines.push(line)
    chars += line.length + 1
  }
  const head = `<transcript video="${name.replace(/"/g, "'")}"${t.language ? ` language="${t.language}"` : ''}>`
  const body = lines.length ? lines.join('\n') : t.segments.length ? '(Nothing is said in this stretch.)' : '(No speech was heard in this video.)'
  const more = cut ? `\n(Cut off here: ask again with start ${Math.floor(cut.start)} for the rest.)` : ''
  return `${head}\n${body}${more}\n</transcript>`
}

const INSTRUCTIONS = `Videos the user attaches come to you as <video> tags with an id: you can't watch them, but the video tools let you see and hear them. Load them with ToolSearch "select:mcp__video__frames,mcp__video__transcript".
- frames(video, count | start, end | times): stills from the video, spread evenly or at the moments you name, each with its time. Start with an overview, then look closer where it matters.
- transcript(video, start, end): what is said, with times and speakers.
A video is its id, its file name in this chat, or the full path of a video file on the computer.`

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

const UNDECODABLE = /DEMUXER|DECODER|could not|can't be decoded|not supported|MEDIA_ERR|format error/i

/** The tool set, for any bot's reply. */
export const videoModule =
  (deps: VideoDeps): ToolModuleFactory =>
  (ctx) => {
    const say = async (text: string, step: Step | null, isError = false) => {
      if (step) await ctx.step(step)
      return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
    }
    const failed = (what: string, e: unknown, name: string) => {
      const msg = e instanceof Error ? e.message : String(e)
      const text = UNDECODABLE.test(msg)
        ? `${name} can't be decoded here: its format or codec isn't one the app plays (it plays MP4, MOV and WebM with H.264, HEVC, VP8, VP9 or AV1; not most AVI or WMV). Tell the user, and ask for an MP4 if they can make one.`
        : `${what} failed: ${msg}`
      return say(text, { tool: 'video', label: `${what} failed`, ok: false, detail: name }, true)
    }

    const frames = tool(
      'frames',
      `Stills from a video, each with its real time. Without times or count you get ${DEFAULT_FRAMES} spread over the whole video (or over start..end), each moved to a nearby keyframe so they come quickly; count sets how many (up to ${MAX_FRAMES}); times takes them at exactly the moments you name.`,
      {
        video: z.string().describe("The video's id (from its <video> tag), its file name in this chat, or the full path of a video file"),
        count: z.number().int().min(1).max(MAX_FRAMES).optional().describe(`How many frames, spread evenly (default ${DEFAULT_FRAMES})`),
        start: z.number().min(0).optional().describe('Seconds: where the stretch to spread them over begins'),
        end: z.number().min(0).optional().describe('Seconds: where it ends'),
        times: z.array(z.number().min(0)).max(MAX_FRAMES).optional().describe('Exact moments in seconds, instead of spreading them')
      },
      async (a) => {
        const found = await deps.find(ctx, a.video, ctx.signal)
        if ('error' in found) return say(found.error, null, true)
        try {
          const info = found.info ?? (await deps.probe(found.path))
          if (!info) throw new Error("The video can't be decoded")
          const times = frameTimes(info.duration, a)
          const edge = times.length <= 4 ? 1024 : 768
          const got = await deps.frames(found.path, times, edge, snapFor(times, a))
          if (got.frames.length === 0) throw new Error('No frames could be decoded')
          const content: Content = [
            { type: 'text', text: `${found.name}: ${clock(info.duration)} long, ${info.width}×${info.height}. ${got.frames.length} frame${got.frames.length === 1 ? '' : 's'}:` }
          ]
          for (const f of got.frames) content.push({ type: 'text', text: `At ${clock(f.time, true)}` }, { type: 'image', data: f.data, mimeType: 'image/jpeg' })
          if (got.partial)
            content.push({ type: 'text', text: `Stopped after ${got.frames.length} of ${times.length}: this video is slow to decode. Ask for fewer frames, or a shorter stretch, for the rest.` })
          const span = got.frames.length > 1 ? `${clock(got.frames[0]!.time)}–${clock(got.frames.at(-1)!.time)}` : clock(got.frames[0]?.time ?? 0)
          await ctx.step({ tool: 'video_frames', label: `Looked at ${got.frames.length} frame${got.frames.length === 1 ? '' : 's'} of ${found.name}`, ok: true, detail: span })
          return { content }
        } catch (e) {
          return failed('Taking frames', e, found.name)
        }
      },
      { searchHint: 'frames: see, watch or look at a video, screenshots or stills from a video clip or recording', annotations: { readOnlyHint: true } }
    )

    const transcript = tool(
      'transcript',
      'What is said in a video (or an audio file on the computer), with the time of each stretch and who speaks when there are several voices. Made once, then kept. start and end (seconds) give just that stretch.',
      {
        video: z.string().describe("The video's id (from its <video> tag), its file name in this chat, or the full path of a video or audio file"),
        start: z.number().min(0).optional().describe('Seconds: only what is said from here'),
        end: z.number().min(0).optional().describe('Seconds: only what is said until here')
      },
      async (a) => {
        const found = await deps.find(ctx, a.video, ctx.signal)
        if ('error' in found) return say(found.error, null, true)
        try {
          const t = await deps.transcript(found)
          const text = transcriptText(found.name, t, a.start ?? 0, a.end ?? Infinity)
          return say(text, { tool: 'video_transcript', label: `Read the transcript of ${found.name}`, ok: true, detail: `${t.segments.length} stretches of speech` })
        } catch (e) {
          return failed('Transcribing', e, found.name)
        }
      },
      { searchHint: 'transcript: transcribe a video, what is said or spoken in a video, speech to text, subtitles, captions', annotations: { readOnlyHint: true } }
    )

    return {
      name: 'video',
      instructions: INSTRUCTIONS,
      server: createSdkMcpServer({ name: 'video', version: '1.0.0', tools: [frames, transcript] })
    }
  }
