// The Claude models a chat can use. Replies run on Claude Code through the Claude Agent SDK.

export interface ClaudeModel {
  id: string
  name: string
  /** One line for the picker. */
  note: string
}

export const MODELS: readonly ClaudeModel[] = [
  { id: 'claude-fable-5-2', name: 'Fable 5.2', note: 'The most capable, for the hardest work' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Deep reasoning and long tasks' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: 'Fast and capable, for most chats' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'The fastest and cheapest' }
]

/** New chats start on this. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Names chats and reads messages for memory. */
export const SMALL_MODEL = 'claude-haiku-5-5'

/**
 * Whether Claude Code can run `id`: one of the list, or another Claude model id typed into
 * config.json. Chats from before held OpenRouter ids such as "deepseek/deepseek-v4.1-flash".
 */
export const isClaudeModel = (id: string | null | undefined): id is string => !!id && /^claude-[\w.-]+$/.test(id)

export const modelName = (id: string) => MODELS.find((m) => m.id === id)?.name ?? id
