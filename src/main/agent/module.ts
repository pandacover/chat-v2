// The contract between the chat driver (Claude Agent SDK) and the tool sets it offers the model.
// Each tool set (the browser, computer use) is one in-process SDK MCP server plus the prompt
// section that explains it and the permission rule for its tools. The driver builds the modules
// a reply needs, passes them to `query()`, and calls `end` when the reply ends however it ends.
import type { McpSdkServerConfigWithInstance, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Step } from '@shared/steps'
import type { NewAttachmentInput } from '@shared/types'

/** What a tool set may do to the reply it runs in. */
export interface RunContext {
  readonly sessionId: string
  /** The assistant message being written. */
  readonly messageId: string
  /** The job the reply works on, for tool sets that keep job notes (agent/notes.ts). TODO(jobs): set by the driver once sessions have a job_id. */
  readonly jobId?: string | null
  /** Adds a step line to the reply; it is saved with the message and shown at once. */
  readonly step: (step: Step) => Promise<void>
  /** Adds a file the user asked for (a screenshot) to the reply. */
  readonly attach: (file: NewAttachmentInput) => Promise<void>
  /** Aborted when the reply ends: done, failed, or stopped. */
  readonly signal: AbortSignal
}

export interface ToolModule {
  /** The MCP server name; the model sees its tools as `mcp__<name>__<tool>`. */
  readonly name: string
  /** The system prompt section that tells the model how to use these tools. */
  readonly instructions: string
  readonly server: McpSdkServerConfigWithInstance
  /** SDK built-in tools this set brings along, e.g. 'WebSearch'. */
  readonly builtins?: ReadonlyArray<string>
  /**
   * The step line for a call of one of `builtins`. Claude Code runs those itself, so the driver
   * adds the line when the call's result comes back. Null for no line.
   */
  readonly stepFor?: (name: string, input: Record<string, unknown>) => Step | null
  /**
   * Whether a tool call may run. Called for every call in the reply; returns null for calls that
   * belong to another module. Without it, this module's own tools are allowed.
   */
  readonly canUseTool?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult | null>
  /** Called once when the reply ends, however it ends. */
  readonly end?: () => Promise<void>
}

/** Builds a tool set for one reply. The driver calls each factory once per reply it runs. */
export type ToolModuleFactory = (ctx: RunContext) => ToolModule
