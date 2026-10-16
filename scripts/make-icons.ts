// Regenerates every logo asset from src/shared/logo.ts:
//   bun scripts/make-icons.ts
// Writes assets/icon.svg, src/renderer/public/icon.svg and build/icon.png (1024 px,
// which electron-builder turns into the Windows .ico and macOS .icns).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { logoDots, logoSvg } from '../src/shared/logo'

const root = join(import.meta.dir, '..')
const out = (rel: string, data: string | Uint8Array) => {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log('wrote', rel)
}

const BG = '#0b0b0c'
out('assets/icon.svg', logoSvg({ size: 64, background: BG, inset: 0.1 }))
out('src/renderer/public/icon.svg', logoSvg({ size: 64, background: BG, inset: 0.1 }))

// ── Minimal PNG rasteriser: anti-aliased dots on a rounded square ─────────
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const encodePng = (w: number, h: number, rgba: Uint8Array) => {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())])
}

const render = (size: number) => {
  const px = new Uint8Array(size * size * 4)
  const bg = [0x0b, 0x0b, 0x0c]
  // macOS-style rounded square with a little margin, so the icon sits well in docks.
  const margin = size * 0.06
  const radius = size * 0.2
  const inRect = (x: number, y: number) => {
    const lo = margin + radius
    const hi = size - margin - radius
    const qx = Math.max(lo - x, 0, x - hi)
    const qy = Math.max(lo - y, 0, y - hi)
    return radius - Math.hypot(qx, qy)
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const a = Math.min(1, Math.max(0, inRect(x + 0.5, y + 0.5) + 0.5))
      const i = (y * size + x) * 4
      px[i] = bg[0]!
      px[i + 1] = bg[1]!
      px[i + 2] = bg[2]!
      px[i + 3] = Math.round(a * 255)
    }
  const inset = 0.16
  const scale = size * (1 - inset * 2)
  for (const d of logoDots()) {
    const cx = size * inset + d.x * scale
    const cy = size * inset + d.y * scale
    const r = d.r * scale
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const cover = Math.min(1, Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5))
        if (cover <= 0) continue
        const i = (y * size + x) * 4
        for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k]! + (255 - px[i + k]!) * cover)
      }
  }
  return encodePng(size, size, px)
}

out('build/icon.png', render(1024))
out('assets/icon-256.png', render(256))
if (process.argv.includes('--preview')) out('build/icon-preview.png', render(512))
