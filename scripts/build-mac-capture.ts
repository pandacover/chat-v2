// Builds the macOS screen capture helper (native/mac-capture/main.swift) as one universal binary,
// arm64 and x86_64, at native/mac-capture/out/chat-v2-capture, where the app finds it in
// development and electron-builder.yml copies it into the app. macOS only (it needs Xcode's
// swiftc); elsewhere it says so and does nothing, and the app captures without it.
//
//   bun scripts/build-mac-capture.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Electron 44's minimum macOS (Chromium dropped 12), so the helper runs wherever the app does. */
const MAC_MIN_VERSION = '13.0'

const root = join(import.meta.dir, '..')
const source = join(root, 'native/mac-capture/main.swift')
const outDir = join(root, 'native/mac-capture/out')
const output = join(outDir, 'chat-v2-capture')

if (process.platform !== 'darwin') {
  console.log('Skipping the macOS capture helper: it can only be built on macOS. The app still captures without it.')
  process.exit(0)
}

const run = (command: string, args: string[]) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { stdio: 'inherit' })
}

mkdirSync(outDir, { recursive: true })
const slices: string[] = []
for (const arch of ['arm64', 'x86_64']) {
  const slice = join(outDir, `chat-v2-capture-${arch}`)
  run('xcrun', [
    'swiftc',
    '-O',
    '-swift-version',
    '5',
    '-target',
    `${arch}-apple-macos${MAC_MIN_VERSION}`,
    '-framework',
    'ScreenCaptureKit',
    source,
    '-o',
    slice
  ])
  slices.push(slice)
}
run('lipo', ['-create', ...slices, '-output', output])
for (const s of slices) rmSync(s)
run('lipo', ['-info', output])
console.log(`Built ${output}`)
