import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Context, Effect, Layer } from 'effect'
import type { Settings, SettingsPatch, SettingsView } from '@shared/types'
import { ConfigError, MissingApiKey, errorMessage } from '../errors'
import { AppPaths } from './AppPaths'

export const DEFAULT_SETTINGS: Settings = {
  // OpenRouter's auto-router always exists; pick a specific model in Settings.
  defaultModel: 'openrouter/auto',
  systemPrompt: 'You are a helpful, concise assistant. Format answers with Markdown.',
  temperature: 0.7,
  sttModel: 'scribe_v2',
  sttLanguage: '',
  pdfEngine: 'cloudflare-ai',
  artifactsEnabled: true
}

const PDF_ENGINES: ReadonlyArray<Settings['pdfEngine']> = ['cloudflare-ai', 'mistral-ocr', 'native']

/** Merges whatever is in config.json over the defaults, ignoring values of the wrong type. */
export const normalizeSettings = (raw: unknown): Settings => {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: keyof Settings, fallback: string) => (typeof input[k] === 'string' ? (input[k] as string) : fallback)
  const temperature = typeof input.temperature === 'number' ? Math.min(2, Math.max(0, input.temperature)) : undefined
  const pdfEngine = PDF_ENGINES.find((e) => e === input.pdfEngine)
  return {
    defaultModel: str('defaultModel', DEFAULT_SETTINGS.defaultModel).trim() || DEFAULT_SETTINGS.defaultModel,
    systemPrompt: str('systemPrompt', DEFAULT_SETTINGS.systemPrompt),
    temperature: temperature ?? DEFAULT_SETTINGS.temperature,
    sttModel: str('sttModel', DEFAULT_SETTINGS.sttModel).trim() || DEFAULT_SETTINGS.sttModel,
    sttLanguage: str('sttLanguage', DEFAULT_SETTINGS.sttLanguage).trim(),
    pdfEngine: pdfEngine ?? DEFAULT_SETTINGS.pdfEngine,
    artifactsEnabled:
      typeof input.artifactsEnabled === 'boolean' ? input.artifactsEnabled : DEFAULT_SETTINGS.artifactsEnabled
  }
}

/** Encrypts secrets at rest (Electron `safeStorage` in the app, identity in tests). */
export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export type KeyName = 'openrouter' | 'elevenlabs'

const ENV_KEYS: Record<KeyName, string> = { openrouter: 'OPENROUTER_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' }
const LABELS: Record<KeyName, string> = { openrouter: 'OpenRouter', elevenlabs: 'ElevenLabs' }

const writeAtomic = (file: string, data: string) => {
  writeFileSync(`${file}.tmp`, data, 'utf8')
  renameSync(`${file}.tmp`, file)
}

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings, ConfigError>
    readonly view: Effect.Effect<SettingsView, ConfigError>
    readonly update: (patch: SettingsPatch) => Effect.Effect<SettingsView, ConfigError>
    readonly apiKey: (name: KeyName) => Effect.Effect<string, MissingApiKey | ConfigError>
  }
>()('chat-v2/SettingsStore') {
  static readonly layer = (cipher: SecretCipher) =>
    Layer.effect(
      SettingsStore,
      Effect.gen(function* () {
        const paths = yield* AppPaths

        const attempt = <A>(what: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) => new ConfigError({ message: `${what}: ${errorMessage(cause)}`, cause })
          })

        // config.json is meant to be hand-editable, so it is re-read on every access.
        const readConfig = attempt('Could not read config.json', () => {
          if (!existsSync(paths.configFile)) {
            writeAtomic(paths.configFile, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n')
            return DEFAULT_SETTINGS
          }
          return normalizeSettings(JSON.parse(readFileSync(paths.configFile, 'utf8')))
        })

        const readSecrets = attempt('Could not read secrets.json', (): Partial<Record<KeyName, string>> => {
          if (!existsSync(paths.secretsFile)) return {}
          const raw = JSON.parse(readFileSync(paths.secretsFile, 'utf8')) as Record<string, unknown>
          const out: Partial<Record<KeyName, string>> = {}
          for (const name of ['openrouter', 'elevenlabs'] as const) {
            const value = raw[name]
            if (typeof value === 'string' && value) out[name] = cipher.decrypt(value)
          }
          return out
        })

        const resolveKey = (secrets: Partial<Record<KeyName, string>>, name: KeyName) =>
          secrets[name] || process.env[ENV_KEYS[name]] || ''

        const view = Effect.gen(function* () {
          const settings = yield* readConfig
          const secrets = yield* readSecrets
          return {
            settings,
            hasOpenRouterKey: resolveKey(secrets, 'openrouter') !== '',
            hasElevenLabsKey: resolveKey(secrets, 'elevenlabs') !== '',
            configPath: paths.configFile
          } satisfies SettingsView
        })

        const update = Effect.fn('SettingsStore.update')(function* (patch: SettingsPatch) {
          if (patch.settings) {
            const current = yield* readConfig
            const next = normalizeSettings({ ...current, ...patch.settings })
            yield* attempt('Could not write config.json', () =>
              writeAtomic(paths.configFile, JSON.stringify(next, null, 2) + '\n')
            )
          }
          if (patch.openRouterKey !== undefined || patch.elevenLabsKey !== undefined) {
            const secrets = yield* readSecrets
            const next: Partial<Record<KeyName, string>> = { ...secrets }
            if (patch.openRouterKey !== undefined) next.openrouter = patch.openRouterKey.trim()
            if (patch.elevenLabsKey !== undefined) next.elevenlabs = patch.elevenLabsKey.trim()
            yield* attempt('Could not write secrets.json', () => {
              const encrypted: Record<string, string> = {}
              for (const [k, v] of Object.entries(next)) if (v) encrypted[k] = cipher.encrypt(v)
              writeAtomic(paths.secretsFile, JSON.stringify(encrypted, null, 2) + '\n')
            })
          }
          return yield* view
        })

        const apiKey = Effect.fn('SettingsStore.apiKey')(function* (name: KeyName) {
          const key = resolveKey(yield* readSecrets, name)
          if (!key) {
            return yield* new MissingApiKey({
              message: `Add your ${LABELS[name]} API key in Settings (or set ${ENV_KEYS[name]}).`
            })
          }
          return key
        })

        return SettingsStore.of({ get: readConfig, view, update, apiKey })
      })
    )
}
