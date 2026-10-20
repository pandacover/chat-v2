// Proves on a Mac (CI: .github/workflows/mac-signing-proof.yml) that Squirrel.Mac updates one
// self-signed build to the next in place: the check the whole Mac update path rests on, since
// Squirrel only installs an update that satisfies the running app's designated requirement.
//
//   bun scripts/mac-update-proof.ts <old chat-v2.app> <new version's zip> <new version>
//
// Copies the old app into /Applications (where users run it, and where macOS's App Management
// protection applies to replacing it), serves the new zip with a latest-mac.yml from a local
// server, and starts the old app hidden (CHAT_V2_HEADLESS=1) pointed at it, with
// CHAT_V2_UPDATE_AUTO_INSTALL=1 so it restarts into the update as soon as it has it
// (src/main/updater.ts). Passes once the copy on disk is the new version and still satisfies the
// old one's designated requirement. The relaunched app is closed at the end.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const [oldApp, newZip, newVersion] = process.argv.slice(2)
if (!oldApp || !newZip || !newVersion) {
  console.error('Usage: bun scripts/mac-update-proof.ts <old chat-v2.app> <new zip> <new version>')
  process.exit(2)
}

/** Runs a command; codesign prints its details on stderr, so both streams come back. */
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${out}`)
  return out
}
const plistVersion = (app: string) => run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).trim()
const requirementOf = (app: string) => /designated => (.*)/.exec(run('codesign', ['-d', '-r-', app]))?.[1] ?? ''

const app = '/Applications/chat-v2-proof.app'
rmSync(app, { recursive: true, force: true })
// ditto keeps the bundle's symlinks and attributes, so the copy's signature stays valid.
run('ditto', [oldApp, app])
const oldVersion = plistVersion(app)
const oldDr = requirementOf(app)
console.log(`Old app ${oldVersion}, designated requirement: ${oldDr}`)
if (!oldDr) throw new Error("Couldn't read the old app's designated requirement")

// The feed electron-updater's generic provider reads: latest-mac.yml beside the zip.
const zip = readFileSync(newZip)
const zipName = basename(newZip)
const sha512 = createHash('sha512').update(zip).digest('base64')
const yml = [
  `version: ${newVersion}`,
  'files:',
  `  - url: ${zipName}`,
  `    sha512: ${sha512}`,
  `    size: ${statSync(newZip).size}`,
  `path: ${zipName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n')

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname
    console.log(`[feed] ${req.method} ${path}`)
    if (path.endsWith('/latest-mac.yml')) return new Response(yml)
    if (path.endsWith(`/${zipName}`)) return new Response(zip, { headers: { 'content-type': 'application/zip' } })
    return new Response('not found', { status: 404 })
  }
})

const env: Record<string, string | undefined> = {
  ...process.env,
  CHAT_V2_HEADLESS: '1',
  CHAT_V2_UPDATE_FEED: `http://127.0.0.1:${server.port}/`,
  CHAT_V2_UPDATE_AUTO_INSTALL: '1'
}
delete env.ELECTRON_RUN_AS_NODE
const data = mkdtempSync(join(tmpdir(), 'chat-v2-update-proof-data-'))
const child = spawn(join(app, 'Contents/MacOS/chat-v2'), [`--user-data-dir=${data}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (c: Buffer) => process.stdout.write(`[app] ${c}`))
child.stderr.on('data', (c: Buffer) => process.stdout.write(`[app] ${c}`))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + 180_000
const exited = new Promise<void>((resolve) => child.once('exit', (code, signal) => (console.log(`Old app exited (code ${code}, signal ${signal})`), resolve())))

let installed = false
try {
  await Promise.race([exited, sleep(150_000)])
  // ShipIt swaps the bundle once the old process is gone.
  while (Date.now() < deadline) {
    const version = (() => {
      try {
        return plistVersion(app)
      } catch {
        return ''
      }
    })()
    if (version === newVersion) {
      installed = true
      break
    }
    await sleep(1000)
  }
} finally {
  // The relaunched app (started by ShipIt, so not hidden) and anything else from the scratch copy.
  try {
    execFileSync('pkill', ['-f', app])
  } catch {}
  if (child.exitCode === null) child.kill('SIGKILL')
  server.stop(true)
}
const finalVersion = (() => {
  try {
    return plistVersion(app)
  } catch {
    return 'unreadable'
  }
})()

if (!installed) {
  console.error(`The copy is ${finalVersion}: Squirrel.Mac did not install ${newVersion}.`)
  console.error('ShipIt logs: ~/Library/Caches/com.pandacover.chatv2.ShipIt/ShipIt_stderr.log')
  try {
    console.error(readFileSync(join(process.env.HOME ?? '', 'Library/Caches/com.pandacover.chatv2.ShipIt/ShipIt_stderr.log'), 'utf8').slice(-4000))
  } catch {}
  process.exit(1)
}
// "=" makes -R take the requirement's text rather than a file.
run('codesign', ['--verify', '--deep', '--strict', '-R', `=${oldDr}`, app])
rmSync(app, { recursive: true, force: true })
console.log(`Squirrel.Mac updated ${oldVersion} to ${newVersion} in place, and the result satisfies the old designated requirement.`)
process.exit(0)
