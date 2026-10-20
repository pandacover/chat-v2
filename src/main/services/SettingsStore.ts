import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Context, Effect, Layer } from 'effect'
import type { Settings, SettingsPatch, SettingsView } from '@shared/types'
import { ConfigError, MissingApiKey, errorMessage } from '../errors'
import { AppPaths } from './AppPaths'

/**
 * OpenRouter's auto-router, the default before DEFAULT_MODEL. It can route each request of one
 * reply to a different model, so nothing is cached between steps.
 */
export const AUTO_ROUTER = 'openrouter/auto'

/**
 * A fixed, inexpensive model that sees screenshots and takes tools. DeepSeek caches the unchanged
 * start of each request on its own, so every step reads the steps before it from the cache.
 */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash'

/** The model a reply that uses tools runs on: the chat's, unless that is the auto-router. */
export const toolModel = (model: string) => (model === AUTO_ROUTER ? DEFAULT_MODEL : model)

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: DEFAULT_MODEL,
  systemPrompt: 'You are a helpful, concise assistant. Format answers with Markdown.',
  temperature: 0.7,
  sttModel: 'scribe_v2',
  sttLanguage: '',
  pdfEngine: 'cloudflare-ai',
  artifactsEnabled: true,
  visionModel: '',
  // About $0.008 per sketch at 768px.
  sketchModel: 'black-forest-labs/flux-3-image-klein',
  // About $0.00001 per title.
  titleModel: 'mistralai/mistral-nemo',
  // Reads messages that talk about the user for facts; about $0.0003 a message, thinking off.
  // Small models (Mistral NeMo) made facts up and missed ones said in passing.
  memoryModel: 'google/gemini-2.5-flash',
  alwaysOnTop: false,
  computerProtected: [],
  computerBorrowPointer: true,
  // Each step is a small decision on a fresh screenshot; deep thinking mostly adds waiting.
  computerReasoningEffort: 'low',
  computerModel: ''
}

const PDF_ENGINES: ReadonlyArray<Settings['pdfEngine']> = ['cloudflare-ai', 'mistral-ocr', 'native']
const EFFORTS: ReadonlyArray<Settings['computerReasoningEffort']> = ['minimal', 'low', 'medium', 'high']

/** Merges whatever is in config.json over the defaults, ignoring values of the wrong type. */
export const normalizeSettings = (raw: unknown): Settings => {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: keyof Settings, fallback: string) => (typeof input[k] === 'string' ? (input[k] as string) : fallback)
  const temperature = typeof input.temperature === 'number' ? Math.min(2, Math.max(0, input.temperature)) : undefined
  const pdfEngine = PDF_ENGINES.find((e) => e === input.pdfEngine)
  const effort = EFFORTS.find((e) => e === input.computerReasoningEffort)
  return {
    defaultModel: str('defaultModel', DEFAULT_SETTINGS.defaultModel).trim() || DEFAULT_SETTINGS.defaultModel,
    systemPrompt: str('systemPrompt', DEFAULT_SETTINGS.systemPrompt),
    temperature: temperature ?? DEFAULT_SETTINGS.temperature,
    sttModel: str('sttModel', DEFAULT_SETTINGS.sttModel).trim() || DEFAULT_SETTINGS.sttModel,
    sttLanguage: str('sttLanguage', DEFAULT_SETTINGS.sttLanguage).trim(),
    pdfEngine: pdfEngine ?? DEFAULT_SETTINGS.pdfEngine,
    artifactsEnabled:
      typeof input.artifactsEnabled === 'boolean' ? input.artifactsEnabled : DEFAULT_SETTINGS.artifactsEnabled,
    visionModel: str('visionModel', DEFAULT_SETTINGS.visionModel).trim(),
    sketchModel: str('sketchModel', DEFAULT_SETTINGS.sketchModel).trim() || DEFAULT_SETTINGS.sketchModel,
    titleModel: str('titleModel', DEFAULT_SETTINGS.titleModel).trim(),
    memoryModel: str('memoryModel', DEFAULT_SETTINGS.memoryModel).trim(),
    alwaysOnTop: typeof input.alwaysOnTop === 'boolean' ? input.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    computerProtected: Array.isArray(input.computerProtected)
      ? [...new Set(input.computerProtected.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean))].slice(0, 100)
      : DEFAULT_SETTINGS.computerProtected,
    computerBorrowPointer: typeof input.computerBorrowPointer === 'boolean' ? input.computerBorrowPointer : DEFAULT_SETTINGS.computerBorrowPointer,
    computerReasoningEffort: effort ?? DEFAULT_SETTINGS.computerReasoningEffort,
    computerModel: str('computerModel', DEFAULT_SETTINGS.computerModel).trim()
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

/**
 * The version of config.json itself, kept in the file next to the settings. A file older than
 * this is brought up to date once, at startup (MIGRATIONS), and every write stamps this version,
 * so a migration never runs twice.
 */
export const CONFIG_VERSION = 2

/** What reaching each version changes in the file as it was. Files from before versions are 1. */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => void> = {
  // The default moved off the auto-router. Choosing it again later is kept: the file is version 2 by then.
  2: (raw) => {
    if (raw.defaultModel === AUTO_ROUTER) raw.defaultModel = DEFAULT_MODEL
  }
}

const configText = (settings: object) => JSON.stringify({ configVersion: CONFIG_VERSION, ...settings }, null, 2) + '\n'

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

        // Once, at startup: an older config.json is brought up to date, keeping everything else in
        // it as it was. A file that can't be read is left alone (reading it says why).
        yield* attempt('Could not update config.json', () => {
          if (!existsSync(paths.configFile)) return
          const { configVersion, ...raw } = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>
          const from = typeof configVersion === 'number' ? configVersion : 1
          if (from >= CONFIG_VERSION) return
          for (let v = from + 1; v <= CONFIG_VERSION; v++) MIGRATIONS[v]?.(raw)
          writeAtomic(paths.configFile, configText(raw))
        }).pipe(Effect.catch((e) => Effect.logWarning(e.message)))

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
              writeAtomic(paths.configFile, configText(next))
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
