// The voice orb: the ElevenLabs UI shader orb, without React or three.js (ported from
// prototypes/studio/orb.js). `use:orb={{ state, level }}` on an element draws it there.
//
//   state  '' (idle) | 'listening' | 'thinking' | 'talking', as the component's agentState
//   level  0..1 drives the input volume by hand (the voice level); undefined = by state
//
// One WebGL2 context draws every orb in turn and copies each into the orb's own 2D canvas, so any
// number of orbs costs one GPU context. The loop runs only while an orb is mounted. Without
// WebGL2 the element's CSS gradient (.orb) stays as the fallback. The dark theme inverts the ramp,
// as the component does under .dark.
import noiseUrl from '../assets/perlin-noise.png'

export type OrbState = '' | 'listening' | 'thinking' | 'talking'
export interface OrbParams {
  state?: OrbState
  level?: number
  /** A number for the same blob layout every time; random if unset. */
  seed?: number
}

const COLORS = ['#CADCFC', '#A0B9D1']

const vertexShader = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`

// The component's fragment shader as written, in GLSL ES 3.00, plus an antialiased disc edge
// (the component gets that from MSAA on a circle mesh) and premultiplied output.
const fragmentShader = `#version 300 es
precision highp float;
uniform float uTime;
uniform float uAnimation;
uniform float uInverted;
uniform float uOffsets[7];
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uInputVolume;
uniform float uOutputVolume;
uniform float uOpacity;
uniform float uPx;
uniform sampler2D uPerlinTexture;
in vec2 vUv;
out vec4 fragColor;

const float PI = 3.14159265358979323846;

bool drawOval(vec2 polarUv, vec2 polarCenter, float a, float b, bool reverseGradient, float softness, out vec4 color) {
  vec2 p = polarUv - polarCenter;
  float oval = (p.x * p.x) / (a * a) + (p.y * p.y) / (b * b);
  float edge = smoothstep(1.0, 1.0 - softness, oval);
  if (edge > 0.0) {
    float gradient = reverseGradient ? (1.0 - (p.x / a + 1.0) / 2.0) : ((p.x / a + 1.0) / 2.0);
    gradient = mix(0.5, gradient, 0.1);
    color = vec4(vec3(gradient), 0.85 * edge);
    return true;
  }
  return false;
}

vec3 colorRamp(float grayscale, vec3 color1, vec3 color2, vec3 color3, vec3 color4) {
  if (grayscale < 0.33) return mix(color1, color2, grayscale * 3.0);
  else if (grayscale < 0.66) return mix(color2, color3, (grayscale - 0.33) * 3.0);
  else return mix(color3, color4, (grayscale - 0.66) * 3.0);
}

vec2 hash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float n = mix(
    mix(dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
  return 0.5 + 0.5 * n;
}

float sharpRing(vec3 decomposed, float time) {
  float ringStart = 1.0;
  float ringWidth = 0.3;
  float noiseScale = 5.0;
  float noise = mix(noise2D(vec2(decomposed.x, time) * noiseScale), noise2D(vec2(decomposed.y, time) * noiseScale), decomposed.z);
  noise = (noise - 0.5) * 2.5;
  return ringStart + noise * ringWidth * 1.5;
}

float smoothRing(vec3 decomposed, float time) {
  float ringStart = 0.9;
  float ringWidth = 0.2;
  float noiseScale = 6.0;
  float noise = mix(noise2D(vec2(decomposed.x, time) * noiseScale), noise2D(vec2(decomposed.y, time) * noiseScale), decomposed.z);
  noise = (noise - 0.5) * 5.0;
  return ringStart + noise * ringWidth;
}

float flow(vec3 decomposed, float time) {
  return mix(
    texture(uPerlinTexture, vec2(time, decomposed.x / 2.0)).r,
    texture(uPerlinTexture, vec2(time, decomposed.y / 2.0)).r,
    decomposed.z
  );
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  float radius = length(uv);
  float theta = atan(uv.y, uv.x);
  if (theta < 0.0) theta += 2.0 * PI;

  vec3 decomposed = vec3(
    theta / (2.0 * PI),
    mod(theta / (2.0 * PI) + 0.5, 1.0) + 1.0,
    abs(theta / PI - 1.0)
  );

  float noise = flow(decomposed, radius * 0.03 - uAnimation * 0.2) - 0.5;
  theta += noise * mix(0.08, 0.25, uOutputVolume);

  vec4 color = vec4(1.0, 1.0, 1.0, 1.0);

  float originalCenters[7] = float[7](0.0, 0.5 * PI, 1.0 * PI, 1.5 * PI, 2.0 * PI, 2.5 * PI, 3.0 * PI);
  float centers[7];
  for (int i = 0; i < 7; i++) {
    centers[i] = originalCenters[i] + 0.5 * sin(uTime / 20.0 + uOffsets[i]);
  }

  float a, b;
  vec4 ovalColor;
  for (int i = 0; i < 7; i++) {
    float noise = texture(uPerlinTexture, vec2(mod(centers[i] + uTime * 0.05, 1.0), 0.5)).r;
    a = 0.5 + noise * 0.3;
    b = noise * mix(3.5, 2.5, uInputVolume);
    bool reverseGradient = (i % 2 == 1);
    float distTheta = min(abs(theta - centers[i]), min(abs(theta + 2.0 * PI - centers[i]), abs(theta - 2.0 * PI - centers[i])));
    float distRadius = radius;
    float softness = 0.6;
    if (drawOval(vec2(distTheta, distRadius), vec2(0.0, 0.0), a, b, reverseGradient, softness, ovalColor)) {
      color.rgb = mix(color.rgb, ovalColor.rgb, ovalColor.a);
      color.a = max(color.a, ovalColor.a);
    }
  }

  float ringRadius1 = sharpRing(decomposed, uTime * 0.1);
  float ringRadius2 = smoothRing(decomposed, uTime * 0.1);
  float inputRadius1 = radius + uInputVolume * 0.2;
  float inputRadius2 = radius + uInputVolume * 0.15;
  float opacity1 = mix(0.2, 0.6, uInputVolume);
  float opacity2 = mix(0.15, 0.45, uInputVolume);
  float ringAlpha1 = (inputRadius2 >= ringRadius1) ? opacity1 : 0.0;
  float ringAlpha2 = smoothstep(ringRadius2 - 0.05, ringRadius2 + 0.05, inputRadius1) * opacity2;
  float totalRingAlpha = max(ringAlpha1, ringAlpha2);
  vec3 ringColor = vec3(1.0);
  color.rgb = 1.0 - (1.0 - color.rgb) * (1.0 - ringColor * totalRingAlpha);

  vec3 color1 = vec3(0.0, 0.0, 0.0);
  vec3 color2 = uColor1;
  vec3 color3 = uColor2;
  vec3 color4 = vec3(1.0, 1.0, 1.0);
  float luminance = mix(color.r, 1.0 - color.r, uInverted);
  color.rgb = colorRamp(luminance, color1, color2, color3, color4);

  color.a *= uOpacity;
  color.a *= smoothstep(1.0, 1.0 - uPx, radius);
  fragColor = vec4(color.rgb * color.a, color.a);
}`

// three.js keeps colour uniforms in linear space and this shader writes them out unconverted,
// so the hex goes through the same sRGB-to-linear step to look the same.
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const hexToLinear = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255))
}
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const splitmix32 = (a: number) => () => {
  a |= 0
  a = (a + 0x9e3779b9) | 0
  let t = a ^ (a >>> 16)
  t = Math.imul(t, 0x21f0aaad)
  t = t ^ (t >>> 15)
  t = Math.imul(t, 0x735a2d97)
  return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296
}

interface Orb {
  el: HTMLElement
  params: OrbParams
  cvs: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  offsets: Float32Array
  time: number
  anim: number
  speed: number
  opacity: number
  cin: number
  cout: number
  c1: number[]
  c2: number[]
}

const TARGET = [hexToLinear(COLORS[0]!), hexToLinear(COLORS[1]!)] as const
const orbs = new Set<Orb>()

let gl: WebGL2RenderingContext | null | undefined
let glCanvas: HTMLCanvasElement
let loc: Record<string, WebGLUniformLocation | null> = {}
let ready = false
let image: HTMLImageElement | null = null
let raf = 0
let last = 0

const compile = (g: WebGL2RenderingContext, type: number, src: string) => {
  const s = g.createShader(type)!
  g.shaderSource(s, src)
  g.compileShader(s)
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader')
  return s
}

const init = () => {
  const g = gl
  if (!g || !image) return
  const prog = g.createProgram()
  g.attachShader(prog, compile(g, g.VERTEX_SHADER, vertexShader))
  g.attachShader(prog, compile(g, g.FRAGMENT_SHADER, fragmentShader))
  g.linkProgram(prog)
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog) ?? 'program')
  g.useProgram(prog)
  loc = {}
  for (const n of ['uTime', 'uAnimation', 'uInverted', 'uOffsets', 'uColor1', 'uColor2', 'uInputVolume', 'uOutputVolume', 'uOpacity', 'uPx', 'uPerlinTexture'])
    loc[n] = g.getUniformLocation(prog, n)
  const buf = g.createBuffer()
  g.bindBuffer(g.ARRAY_BUFFER, buf)
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW)
  const pos = g.getAttribLocation(prog, 'position')
  g.enableVertexAttribArray(pos)
  g.vertexAttribPointer(pos, 2, g.FLOAT, false, 0, 0)
  // As three.js loads it: flipped, repeating, mipmapped.
  const texture = g.createTexture()
  g.activeTexture(g.TEXTURE0)
  g.bindTexture(g.TEXTURE_2D, texture)
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true)
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, image)
  g.generateMipmap(g.TEXTURE_2D)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.REPEAT)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
  g.uniform1i(loc.uPerlinTexture!, 0)
  g.disable(g.BLEND)
  g.clearColor(0, 0, 0, 0)
  ready = true
}

/** Sets up the shared context once; false without WebGL2. */
const setup = () => {
  if (gl !== undefined) return gl !== null
  glCanvas = document.createElement('canvas')
  gl = glCanvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true })
  if (!gl) return false
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    ready = false
  })
  glCanvas.addEventListener('webglcontextrestored', () => init())
  image = new Image()
  image.onload = () => {
    try {
      init()
    } catch (e) {
      console.warn('orb: shader failed', e)
    }
  }
  image.src = noiseUrl
  return true
}

/** One step of the component's useFrame, for one orb. */
const step = (o: Orb, delta: number) => {
  o.time += delta * 0.5
  if (o.opacity < 1) o.opacity = Math.min(1, o.opacity + delta * 2)
  const state = o.params.state || ''
  const t = o.time * 2
  let targetIn = 0
  let targetOut = 0.3
  if (state === 'listening') {
    targetIn = clamp01(0.55 + Math.sin(t * 3.2) * 0.35)
    targetOut = 0.45
  } else if (state === 'talking') {
    targetIn = clamp01(0.65 + Math.sin(t * 4.8) * 0.22)
    targetOut = clamp01(0.75 + Math.sin(t * 3.6) * 0.22)
  } else if (state === 'thinking') {
    const base = 0.38 + 0.07 * Math.sin(t * 0.7)
    const wander = 0.05 * Math.sin(t * 2.1) * Math.sin(t * 0.37 + 1.2)
    targetIn = clamp01(base + wander)
    targetOut = clamp01(0.48 + 0.12 * Math.sin(t * 1.05 + 0.6))
  }
  if (typeof o.params.level === 'number') targetIn = clamp01(o.params.level)
  o.cin += (targetIn - o.cin) * 0.2
  o.cout += (targetOut - o.cout) * 0.2
  const targetSpeed = 0.1 + (1 - Math.pow(o.cout - 1, 2)) * 0.9
  o.speed += (targetSpeed - o.speed) * 0.12
  o.anim += delta * o.speed
  for (let k = 0; k < 3; k++) {
    o.c1[k]! += (TARGET[0][k]! - o.c1[k]!) * 0.08
    o.c2[k]! += (TARGET[1][k]! - o.c2[k]!) * 0.08
  }
}

const draw = (o: Orb, px: number, inverted: number) => {
  const g = gl!
  if (glCanvas.width < px || glCanvas.height < px) {
    glCanvas.width = Math.max(glCanvas.width, px)
    glCanvas.height = Math.max(glCanvas.height, px)
  }
  g.viewport(0, 0, px, px)
  g.clear(g.COLOR_BUFFER_BIT)
  g.uniform1f(loc.uTime!, o.time)
  g.uniform1f(loc.uAnimation!, o.anim)
  g.uniform1f(loc.uInverted!, inverted)
  g.uniform1fv(loc.uOffsets!, o.offsets)
  g.uniform3fv(loc.uColor1!, o.c1)
  g.uniform3fv(loc.uColor2!, o.c2)
  g.uniform1f(loc.uInputVolume!, o.cin)
  g.uniform1f(loc.uOutputVolume!, o.cout)
  g.uniform1f(loc.uOpacity!, o.opacity)
  g.uniform1f(loc.uPx!, 2.0 / px)
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
  if (o.cvs.width !== px) o.cvs.width = o.cvs.height = px
  o.ctx.clearRect(0, 0, px, px)
  // WebGL's origin is the bottom-left, so the drawn square sits at the bottom of the canvas.
  o.ctx.drawImage(glCanvas, 0, glCanvas.height - px, px, px, 0, 0, px, px)
}

const frame = (now: number) => {
  raf = 0
  if (orbs.size === 0) return
  const delta = Math.max(0, (now - last) / 1000)
  last = now
  if (ready && !document.hidden) {
    const inverted = document.documentElement.dataset.theme === 'dark' ? 1 : 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    for (const o of orbs) {
      const size = o.el.offsetWidth
      if (!size) continue // hidden
      step(o, delta)
      const r = o.el.getBoundingClientRect()
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue
      draw(o, Math.max(1, Math.round(size * dpr)), inverted)
    }
  }
  raf = requestAnimationFrame(frame)
}

/** Svelte action: draws the orb into `el` (which keeps its CSS gradient as the fallback). */
export const orb = (el: HTMLElement, params: OrbParams = {}) => {
  if (!setup()) return {}
  const random = splitmix32(params.seed ?? Math.floor(Math.random() * 2 ** 32))
  const cvs = document.createElement('canvas')
  el.prepend(cvs)
  el.classList.add('gl')
  const o: Orb = {
    el,
    params,
    cvs,
    ctx: cvs.getContext('2d')!,
    offsets: new Float32Array(Array.from({ length: 7 }, () => random() * Math.PI * 2)),
    time: 0,
    anim: 0.1,
    speed: 0.1,
    opacity: 0,
    cin: 0,
    cout: 0,
    c1: TARGET[0].slice(),
    c2: TARGET[1].slice()
  }
  orbs.add(o)
  if (!raf) {
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }
  return {
    update(next: OrbParams = {}) {
      o.params = next
    },
    destroy() {
      orbs.delete(o)
      cvs.remove()
      el.classList.remove('gl')
      if (orbs.size === 0 && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
  }
}
