import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { AppPaths } from '../src/main/services/AppPaths'
import { AUTO_ROUTER, CONFIG_VERSION, DEFAULT_MODEL, SettingsStore } from '../src/main/services/SettingsStore'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-v2-settings-'))
  dirs.push(dir)
  return dir
}

/** One app start: builds the store (which migrates config.json), then runs `f` against it. */
const start = <A>(dir: string, f: (s: typeof SettingsStore.Service) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* SettingsStore)
    }).pipe(Effect.provide(SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(AppPaths.layer(dir)))))
  )

const file = (dir: string) => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>

describe('config.json migrations', () => {
  test('an older file on the auto-router moves to the new default, once; choosing the router again later sticks', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultModel: AUTO_ROUTER, temperature: 0.3, somethingHandAdded: true }))

    expect((await start(dir, (s) => s.get)).defaultModel).toBe(DEFAULT_MODEL)
    // Only the model changed: the rest of the file stays as the user left it, now stamped current.
    expect(file(dir)).toEqual({ configVersion: CONFIG_VERSION, defaultModel: DEFAULT_MODEL, temperature: 0.3, somethingHandAdded: true })

    // The user picks the auto-router again, and the app restarts twice.
    await start(dir, (s) => s.update({ settings: { defaultModel: AUTO_ROUTER } }))
    expect(file(dir).configVersion).toBe(CONFIG_VERSION)
    expect((await start(dir, (s) => s.get)).defaultModel).toBe(AUTO_ROUTER)
    expect((await start(dir, (s) => s.get)).defaultModel).toBe(AUTO_ROUTER)
  })

  test('an older file with another model keeps it', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultModel: 'anthropic/claude-sonnet-5.5' }))
    expect((await start(dir, (s) => s.get)).defaultModel).toBe('anthropic/claude-sonnet-5.5')
    expect(file(dir).configVersion).toBe(CONFIG_VERSION)
  })

  test('a fresh install starts current, on the default model', async () => {
    const dir = tempDir()
    expect((await start(dir, (s) => s.get)).defaultModel).toBe(DEFAULT_MODEL)
    expect(file(dir).configVersion).toBe(CONFIG_VERSION)
  })

  test("a file that isn't valid JSON is left alone, and reading it says why", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), '{ "defaultModel": ')
    await expect(start(dir, (s) => s.get)).rejects.toThrow('Could not read config.json')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{ "defaultModel": ')
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false)
  })
})
