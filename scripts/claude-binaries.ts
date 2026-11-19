// Installs the Claude Code binary for both Mac processors (CI, before electron-builder). bun only
// installs the one for the machine it runs on, and the arm64 and x64 builds each ship their own
// (electron-builder.yml leaves out every other platform's). Each is fetched at the SDK's version.
//
//   bun scripts/claude-binaries.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')
const scope = join(root, 'node_modules/@anthropic-ai')
const { version } = JSON.parse(readFileSync(join(scope, 'claude-agent-sdk/package.json'), 'utf8')) as { version: string }

for (const arch of ['arm64', 'x64']) {
  const name = `claude-agent-sdk-darwin-${arch}`
  const dir = join(scope, name)
  if (existsSync(join(dir, 'claude'))) {
    console.log(`${name} is installed`)
    continue
  }
  const tmp = mkdtempSync(join(tmpdir(), 'claude-binary-'))
  try {
    const file = execFileSync('npm', ['pack', `@anthropic-ai/${name}@${version}`, '--silent'], { cwd: tmp, encoding: 'utf8', shell: process.platform === 'win32' }).trim()
    mkdirSync(dir, { recursive: true })
    // An npm tarball holds the package under package/. A relative path: GNU tar reads C: as a host name.
    execFileSync('tar', ['-xzf', relative(dir, join(tmp, file)), '--strip-components=1'], { cwd: dir })
    console.log(`Installed ${name}@${version}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
