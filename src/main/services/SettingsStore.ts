import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Context, Effect, Layer } from 'effect'
import { DEFAULT_MODEL, SMALL_MODEL, isClaudeModel } from '@shared/models'
import type { Effort, Settings, SettingsPatch, SettingsView } from '@shared/types'
import { ConfigError, MissingApiKey, errorMessage } from '../errors'
import { AppPaths } from './AppPaths'

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: DEFAULT_MODEL,
  systemPrompt: 'You are a helpful, concise assistant. Format answers with Markdown.',
  effort: 'medium',
  auth: 'login',
  sttModel: 'scribe_v2',
  sttLanguage: '',
  artifactsEnabled: true,
  titleModel: SMALL_MODEL,
  memoryModel: SMALL_MODEL,
  alwaysOnTop: false
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Merges whatever is in config.json over the defaults. Values of the wrong type fall back to the
 * default, and keys the app doesn't know (OpenRouter's, from before) are dropped.
 */
export const normalizeSettings = (raw: unknown): Settings => {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: keyof Settings, fallback: string) => (typeof input[k] === 'string' ? (input[k] as string) : fallback)
  const bool = (k: keyof Settings, fallback: boolean) => (typeof input[k] === 'boolean' ? (input[k] as boolean) : fallback)
  // '' turns titles or memory off; a model that isn't Claude's (OpenRouter's) is replaced.
  const optionalModel = (k: 'titleModel' | 'memoryModel') => {
    const v = str(k, DEFAULT_SETTINGS[k]).trim()
    return v === '' || isClaudeModel(v) ? v : DEFAULT_SETTINGS[k]
  }
  const model = str('defaultModel', '').trim()
  return {
    defaultModel: isClaudeModel(model) ? model : DEFAULT_SETTINGS.defaultModel,
    systemPrompt: str('systemPrompt', DEFAULT_SETTINGS.systemPrompt),
    effort: EFFORTS.find((e) => e === input.effort) ?? DEFAULT_SETTINGS.effort,
    auth: input.auth === 'apiKey' ? 'apiKey' : 'login',
    sttModel: str('sttModel', DEFAULT_SETTINGS.sttModel).trim() || DEFAULT_SETTINGS.sttModel,
    sttLanguage: str('sttLanguage', DEFAULT_SETTINGS.sttLanguage).trim(),
    artifactsEnabled: bool('artifactsEnabled', DEFAULT_SETTINGS.artifactsEnabled),
    titleModel: optionalModel('titleModel'),
    memoryModel: optionalModel('memoryModel'),
    alwaysOnTop: bool('alwaysOnTop', DEFAULT_SETTINGS.alwaysOnTop)
  }
}

/** Encrypts secrets at rest (Electron `safeStorage` in the app, identity in tests). */
export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export type KeyName = 'anthropic' | 'elevenlabs'

const KEY_NAMES: readonly KeyName[] = ['anthropic', 'elevenlabs']
const ENV_KEYS: Record<KeyName, string> = { anthropic: 'ANTHROPIC_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' }
const LABELS: Record<KeyName, string> = { anthropic: 'Anthropic', elevenlabs: 'ElevenLabs' }

const writeAtomic = (file: string, data: string) => {
  writeFileSync(`${file}.tmp`, data, 'utf8')
  renameSync(`${file}.tmp`, file)
}

const configText = (settings: Settings) => JSON.stringify(settings, null, 2) + '\n'

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
            writeAtomic(paths.configFile, configText(DEFAULT_SETTINGS))
            return DEFAULT_SETTINGS
          }
          return normalizeSettings(JSON.parse(readFileSync(paths.configFile, 'utf8')))
        })

        const readSecrets = attempt('Could not read secrets.json', (): Partial<Record<KeyName, string>> => {
          if (!existsSync(paths.secretsFile)) return {}
          const raw = JSON.parse(readFileSync(paths.secretsFile, 'utf8')) as Record<string, unknown>
          const out: Partial<Record<KeyName, string>> = {}
          for (const name of KEY_NAMES) {
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
            hasAnthropicKey: resolveKey(secrets, 'anthropic') !== '',
            hasElevenLabsKey: resolveKey(secrets, 'elevenlabs') !== '',
            configPath: paths.configFile
          } satisfies SettingsView
        })

        const update = Effect.fn('SettingsStore.update')(function* (patch: SettingsPatch) {
          if (patch.settings) {
            const current = yield* readConfig
            const next = normalizeSettings({ ...current, ...patch.settings })
            yield* attempt('Could not write config.json', () => writeAtomic(paths.configFile, configText(next)))
          }
          if (patch.anthropicKey !== undefined || patch.elevenLabsKey !== undefined) {
            const secrets = yield* readSecrets
            const next: Partial<Record<KeyName, string>> = { ...secrets }
            if (patch.anthropicKey !== undefined) next.anthropic = patch.anthropicKey.trim()
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
