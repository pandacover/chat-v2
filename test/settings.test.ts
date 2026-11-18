import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { DEFAULT_MODEL } from '../src/shared/models'
import { AppPaths } from '../src/main/services/AppPaths'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/main/services/SettingsStore'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-settings-'))
  dirs.push(dir)
  return dir
}

/** One app start: builds the store, then runs `f` against it. */
const start = <A>(dir: string, f: (s: typeof SettingsStore.Service) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* SettingsStore)
    }).pipe(Effect.provide(SettingsStore.layer({ encrypt: (s) => `x${s}`, decrypt: (s) => s.slice(1) }).pipe(Layer.provide(AppPaths.layer(dir)))))
  )

const file = (dir: string, name = 'config.json') => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>

describe('config.json', () => {
  test('a file from the OpenRouter days loads on Claude, and its old keys go at the next save', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ configVersion: 2, defaultModel: 'openrouter/auto', temperature: 0.3, pdfEngine: 'native', systemPrompt: 'Be brief.', alwaysOnTop: true }))
    expect(await start(dir, (s) => s.get)).toEqual({ ...DEFAULT_SETTINGS, systemPrompt: 'Be brief.', alwaysOnTop: true })
    // Reading leaves the file as it was; the next save writes only what the app knows.
    expect(file(dir).temperature).toBe(0.3)
    await start(dir, (s) => s.update({ settings: { effort: 'high' } }))
    expect(file(dir)).toEqual({ ...DEFAULT_SETTINGS, systemPrompt: 'Be brief.', alwaysOnTop: true, effort: 'high' })
  })

  test('a fresh install starts on the default model, signed in through Claude Code', async () => {
    const dir = tempDir()
    expect(await start(dir, (s) => s.get)).toMatchObject({ defaultModel: DEFAULT_MODEL, auth: 'login', titleModel: 'claude-haiku-5-5', memoryModel: 'claude-haiku-5-5' })
    expect(file(dir).defaultModel).toBe(DEFAULT_MODEL)
  })

  test("a file that isn't valid JSON is left alone, and reading it says why", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), '{ "defaultModel": ')
    await expect(start(dir, (s) => s.get)).rejects.toThrow('Could not read config.json')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{ "defaultModel": ')
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false)
  })
})

describe('API keys', () => {
  test('the Anthropic key is stored encrypted; an OpenRouter key from before is dropped at the next save', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ openrouter: 'xsk-or-old', elevenlabs: 'xel-1' }))
    const saved = await start(dir, (s) => s.update({ anthropicKey: ' sk-ant-1 ' }))
    expect(saved).toMatchObject({ hasAnthropicKey: true, hasElevenLabsKey: true })
    expect(file(dir, 'secrets.json')).toEqual({ anthropic: 'xsk-ant-1', elevenlabs: 'xel-1' })
    expect(await start(dir, (s) => s.apiKey('anthropic'))).toBe('sk-ant-1')
  })

  test('ANTHROPIC_API_KEY works in place of a saved key, and without either the error says where to add one', async () => {
    const dir = tempDir()
    const before = process.env.ANTHROPIC_API_KEY
    try {
      delete process.env.ANTHROPIC_API_KEY
      await expect(start(dir, (s) => s.apiKey('anthropic'))).rejects.toThrow('Add your Anthropic API key in Settings (or set ANTHROPIC_API_KEY).')
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env'
      expect(await start(dir, (s) => s.apiKey('anthropic'))).toBe('sk-ant-env')
      expect((await start(dir, (s) => s.view)).hasAnthropicKey).toBe(true)
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
    }
  })
})
