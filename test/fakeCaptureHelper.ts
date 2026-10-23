// A pretend macOS capture helper (native/mac-capture/main.swift) for tests: it speaks the helper's
// protocol over stdin and stdout and logs each request, but captures nothing. Run with bun:
//   bun test/fakeCaptureHelper.ts --log <file> [flags]
// Flags:
//   --no-permission  its ready line says Screen Recording isn't granted
//   --old-os         ScreenCaptureKit isn't available
//   --no-app         the app isn't listed by ScreenCaptureKit, so only its windows are left out
//   --die-on-grab    it exits on its first grab, as a crash would
//   --no-input       it can't list the windows or type (an older helper)
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const log = args[args.indexOf('--log') + 1]!

const send = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`)
send({ ready: true, os: flag('--old-os') ? '12.2.0' : '15.4.0', arch: 'arm64', sck: !flag('--old-os'), permission: !flag('--no-permission') })

let streaming = false
let looks = 0

const handle = (line: string) => {
  const [id, op, ...rest] = line.split(' ')
  appendFileSync(log, `${[op, ...rest].join(' ')}\n`)
  const ok = (o: object = {}) => send({ id: Number(id), ok: true, ...o })
  const fail = (error: string) => send({ id: Number(id), ok: false, error })
  switch (op) {
    case 'start':
      streaming = true
      return ok({ appExcluded: !flag('--no-app'), w: Number(rest[2]), h: Number(rest[3]), ms: 40 })
    case 'stop':
      streaming = false
      return ok()
    case 'changes':
      if (!streaming) return fail("the stream isn't running")
      return ok({ count: ++looks, stillMs: 42, frames: looks, area: 0.01 })
    case 'windows':
      if (flag('--no-input')) return fail('unknown request windows')
      return ok({ cursor: { x: 10, y: 20 }, foreground: 7, windows: [{ hwnd: 7, pid: 100, exe: 'TextEdit', bundle: 'com.apple.TextEdit', title: 'Untitled', cls: 'layer 0', layer: 0, x: 0, y: 25, w: 800, h: 600, clickThrough: false }] })
    case 'type':
      if (flag('--no-input')) return fail('unknown request type')
      return ok()
    case 'grab':
      if (flag('--die-on-grab')) process.exit(3)
      if (!streaming) return fail("the stream isn't running")
      return ok({ jpeg: Buffer.from('SCK').toString('base64'), w: Number(rest[0]), h: Number(rest[1]), ms: { draw: 4, cover: 1, encode: 6 } })
    default:
      return fail(`unknown request ${op}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let i: number
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (line) handle(line)
  }
})
process.stdin.on('end', () => process.exit(0))
