import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Layer } from 'effect'

export class AppPaths extends Context.Service<
  AppPaths,
  {
    readonly root: string
    readonly dbFile: string
    readonly configFile: string
    readonly secretsFile: string
    /** The custom MCP servers (services/McpStore.ts). */
    readonly mcpFile: string
    readonly attachmentsDir: string
  }
>()('chat-v2/AppPaths') {
  static readonly layer = (root: string) =>
    Layer.sync(AppPaths, () => {
      const attachmentsDir = join(root, 'attachments')
      mkdirSync(attachmentsDir, { recursive: true })
      return AppPaths.of({
        root,
        dbFile: join(root, 'chat.db'),
        configFile: join(root, 'config.json'),
        secretsFile: join(root, 'secrets.json'),
        mcpFile: join(root, 'mcp.json'),
        attachmentsDir
      })
    })
}
