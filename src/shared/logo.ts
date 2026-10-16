// The chat-v2 mark: a halftone dot lattice whose dots swell along a "C".
// One source of geometry for the in-app logo, the SVG files and the installer icon
// (see scripts/make-icons.ts).

export interface Dot {
  x: number
  y: number
  r: number
}

/** Dots in a unit box: x and y span 0..1 with the mark centred at 0.5, 0.5. */
export const logoDots = (): Dot[] => {
  const dx = 0.1 // spacing between dots in a row
  const dy = dx * 0.58 // row spacing; alternate rows shift by half a step
  const R = 0.47 // circumradius of the pointy-top hexagon that bounds the lattice
  const cx = 0.5
  const cy = 0.5

  // The "C": an arc opening to the right.
  const arcR = 0.235
  const stroke = 0.07
  const gap = (48 * Math.PI) / 180 // half-angle of the opening
  const arcCx = cx + 0.012

  const distToC = (x: number, y: number) => {
    const a = Math.atan2(y - cy, x - arcCx)
    if (Math.abs(a) >= gap) return Math.abs(Math.hypot(x - arcCx, y - cy) - arcR)
    // Inside the opening: distance to the nearer rounded end of the stroke.
    const end = (s: number) => Math.hypot(x - (arcCx + arcR * Math.cos(s * gap)), y - (cy + arcR * Math.sin(s * gap)))
    return Math.min(end(1), end(-1))
  }

  const dots: Dot[] = []
  const rows = Math.ceil(R / dy)
  for (let j = -rows; j <= rows; j++) {
    const y = cy + j * dy
    const shift = (Math.abs(j) % 2) * (dx / 2)
    const cols = Math.ceil(R / dx) + 1
    for (let i = -cols; i <= cols; i++) {
      const x = cx + i * dx + shift
      const ax = Math.abs(x - cx)
      const ay = Math.abs(y - cy)
      // Inside the hexagon (pointed at top and bottom).
      if (ax > (R * Math.sqrt(3)) / 2 + 1e-9 || ay > R - ax / Math.sqrt(3) + 1e-9) continue
      // 0 at the hexagon's rim, 1 at its centre: outer dots stay pin-sized.
      const rim = Math.min(1 - ax / ((R * Math.sqrt(3)) / 2), (R - ax / Math.sqrt(3) - ay) / R)
      const body = Math.pow(Math.min(1, Math.max(0, 1 - distToC(x, y) / (stroke * 1.55))), 0.9)
      const base = dx * (0.05 + 0.06 * Math.min(1, rim * 2.2))
      const r = base + (dx * 0.36 - base) * body
      dots.push({ x, y, r })
    }
  }
  return dots
}

/** SVG markup for the mark; `fill` colours the dots, `background` is optional. */
export const logoSvg = (opts: { size?: number; fill?: string; background?: string; inset?: number } = {}) => {
  const size = opts.size ?? 64
  const inset = opts.inset ?? 0
  const scale = size * (1 - inset * 2)
  const off = size * inset
  const circles = logoDots()
    .map((d) => `<circle cx="${(off + d.x * scale).toFixed(2)}" cy="${(off + d.y * scale).toFixed(2)}" r="${(d.r * scale).toFixed(2)}"/>`)
    .join('')
  const bg = opts.background ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${opts.background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}<g fill="${opts.fill ?? '#fff'}">${circles}</g></svg>`
}
