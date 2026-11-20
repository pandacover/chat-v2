import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { makeControl } from '../../src/main/computer/control'
import { MARK_BGRA, cropFor, describePoint, dipToInput, drawMark, frameFor, inputToDip, toImage, type PointDisplay } from '../../src/main/computer/pointing'
import { fakePlatform } from './fakes'

// A 1920x1080 monitor at 100%, and to its right a 2560x1440 one at 150% (1707x960 DIPs).
const left: PointDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  input: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  primary: true,
  index: 1,
  count: 2
}
const right: PointDisplay = {
  bounds: { x: 1920, y: 0, width: 1707, height: 960 },
  input: { x: 1920, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5,
  primary: false,
  index: 2,
  count: 2
}
const both = [left, right]
const at = (x: number, y: number) => ({ x, y, width: 0, height: 0 })

describe('Point coordinates', () => {
  test("Windows: the tools' frame is the monitor, 1024 px wide, in physical pixels", () => {
    expect(frameFor('windows', right, both)).toEqual({
      screen: right.input,
      imageWidth: 1024,
      imageHeight: 576
    })
    // A spot in the middle of the 150% monitor (DIPs relative to it).
    const p = dipToInput(right, at(853.5, 480))
    expect(p).toMatchObject({ x: 1920 + 1280, y: 720 })
    expect(toImage(frameFor('windows', right, both)!, p)).toMatchObject({
      x: 512,
      y: 288
    })
    const back = inputToDip(right, {
      x: 1920 + 1280,
      y: 720,
      width: 150,
      height: 75
    })
    expect(back.x).toBeCloseTo(853.5, 0)
    expect(back.y).toBe(480)
    expect(back.width).toBeCloseTo(100, 1)
    expect(back.height).toBe(50)
  })

  test("the note's pixels are where Control sends a click", async () => {
    // The same monitor as the agent's own screenshot sees it.
    const { p } = fakePlatform({
      screenshot: async () => ({
        data: '',
        mime: 'image/jpeg',
        imageWidth: 1024,
        imageHeight: 576,
        screen: right.input,
        window: { title: 'Notepad', process: 'notepad' }
      })
    })
    const c = makeControl(p)
    await Effect.runPromise(c.screenshot())
    for (const dip of [at(100, 50), at(853.5, 480), at(1700, 955)]) {
      const input = dipToInput(right, dip)
      const image = toImage(frameFor('windows', right, both)!, input)
      expect(c.rectToImage(input)).toEqual(image)
      const back = await Effect.runPromise(c.toScreen(image.x, image.y))
      // One image pixel is 2.5 physical pixels here.
      expect(Math.abs(back.x - input.x)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.y - input.y)).toBeLessThanOrEqual(2)
    }
  })

  test('macOS captures the main display only; Linux the whole X screen', () => {
    const mac: PointDisplay = {
      ...left,
      input: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2
    }
    expect(frameFor('macos', mac, [mac])).toEqual({
      screen: { x: 0, y: 0, width: 1440, height: 900 },
      imageWidth: 1024,
      imageHeight: 640
    })
    expect(frameFor('macos', right, both)).toBeNull()
    // A small screen is not scaled up.
    const small: PointDisplay = {
      ...mac,
      input: { x: 0, y: 0, width: 800, height: 600 },
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1
    }
    expect(frameFor('macos', small, [small])).toMatchObject({
      imageWidth: 800,
      imageHeight: 600
    })
    expect(frameFor('linux', right, both)).toEqual({
      screen: { x: 0, y: 0, width: 4480, height: 1440 },
      imageWidth: 1024,
      imageHeight: 329
    })
  })
})

describe('Point crop', () => {
  const size = { width: 1920, height: 1080 }
  test('around a click, kept on the display', () => {
    expect(cropFor({ point: { x: 960, y: 540 }, rect: null }, null, size)).toEqual({ x: 720, y: 390, width: 480, height: 300 })
    expect(cropFor({ point: { x: 5, y: 1078 }, rect: null }, null, size)).toEqual({ x: 0, y: 780, width: 480, height: 300 })
  })
  test('a box or a control, with room around it and a minimum size', () => {
    expect(
      cropFor(
        {
          point: { x: 0, y: 0 },
          rect: { x: 100, y: 100, width: 800, height: 400 }
        },
        null,
        size
      )
    ).toEqual({ x: -100 + 100, y: 0, width: 1200, height: 800 })
    expect(cropFor({ point: { x: 120, y: 110 }, rect: null }, { x: 100, y: 100, width: 40, height: 20 }, size)).toEqual({ x: 0, y: 0, width: 360, height: 220 })
    // Never bigger than the display.
    expect(
      cropFor(
        {
          point: { x: 0, y: 0 },
          rect: { x: 0, y: 0, width: 1920, height: 1080 }
        },
        null,
        size
      )
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
})

describe('Point mark', () => {
  const blank = (w: number, h: number) => new Uint8Array(w * h * 4).fill(255)
  const px = (b: Uint8Array, w: number, x: number, y: number) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]
  test('a box outline on its edge, the inside left alone', () => {
    const b = blank(100, 80)
    drawMark(b, 100, 80, { box: { x: 20, y: 20, width: 60, height: 40 }, point: null }, 1)
    expect(px(b, 100, 50, 20)).toEqual([...MARK_BGRA])
    expect(px(b, 100, 50, 40)).toEqual([255, 255, 255, 255])
    expect(px(b, 100, 5, 5)).toEqual([255, 255, 255, 255])
  })
  test('a light edge around the mark, so it reads on a dark screen', () => {
    const b = new Uint8Array(100 * 80 * 4)
    drawMark(b, 100, 80, { box: { x: 20, y: 20, width: 60, height: 40 }, point: null }, 1)
    expect(px(b, 100, 50, 20)).toEqual([...MARK_BGRA])
    expect(px(b, 100, 50, 18)).toEqual([0xf9, 0xfc, 0xfd, 0xff])
    expect(px(b, 100, 50, 16)).toEqual([0, 0, 0, 0])
  })
  test('inside a picked control, a dot without the ring', () => {
    const b = blank(100, 100)
    drawMark(b, 100, 100, { box: { x: 20, y: 30, width: 60, height: 40 }, point: { x: 50, y: 50 } }, 2)
    expect(px(b, 100, 50, 50)).toEqual([...MARK_BGRA])
    expect(px(b, 100, 50 + 12, 50)).toEqual([255, 255, 255, 255])
    expect(px(b, 100, 50 + 24, 50)).toEqual([255, 255, 255, 255])
  })
  test('a ring and a dot for a click, scaled by the display', () => {
    const b = blank(100, 100)
    drawMark(b, 100, 100, { box: null, point: { x: 50, y: 50 } }, 2)
    expect(px(b, 100, 50, 50)).toEqual([...MARK_BGRA])
    expect(px(b, 100, 50 + 24, 50)).toEqual([...MARK_BGRA])
    expect(px(b, 100, 50 + 12, 50)).toEqual([255, 255, 255, 255])
  })
})

describe('Point note', () => {
  test('a picked control, in the tools pixels and screen coordinates', () => {
    const note = describePoint({
      image: 'point-101500.png',
      platform: 'windows',
      display: right,
      all: both,
      point: { x: 3200, y: 720 },
      rect: null,
      crop: { x: 2600, y: 400, width: 1200, height: 640 },
      hit: {
        window: { title: 'Untitled - Notepad', process: 'notepad' },
        control: {
          x: 3150,
          y: 700,
          width: 100,
          height: 40,
          type: 'Button',
          name: 'Save'
        }
      }
    })
    expect(note).toContain('The user pointed at a control on their screen for you. point-101500.png shows it')
    expect(note).toContain('look_at_screen screenshot of this display (1024x576)')
    expect(note).toContain('- Point: 512, 288')
    expect(note).toContain('- Control there: Button "Save", 492, 280 to 532, 296 (centre 512, 288)')
    expect(note).toContain('- Window: "Untitled - Notepad" (notepad)')
    expect(note).toContain('display 2 of 2, 2560x1440 physical pixels at 150%')
    expect(note).toContain('focus_window "Untitled - Notepad" first')
  })
  test('a box with no control reading (macOS), off the captured display', () => {
    const note = describePoint({
      image: 'p.png',
      platform: 'macos',
      display: right,
      all: both,
      point: { x: 3200, y: 720 },
      rect: { x: 3000, y: 600, width: 400, height: 240 },
      crop: right.input,
      hit: null
    })
    expect(note).toContain('marked a box')
    expect(note).toContain("doesn't capture")
    expect(note).not.toContain('Control there')
  })
  test('a box on Windows gives its corners and centre', () => {
    const note = describePoint({
      image: 'p.png',
      platform: 'windows',
      display: left,
      all: both,
      point: { x: 960, y: 540 },
      rect: { x: 480, y: 270, width: 960, height: 540 },
      crop: left.input,
      hit: null
    })
    expect(note).toContain('- Box: 256, 144 to 768, 432 (centre 512, 288, 512x288)')
    expect(note).toContain('bring the window there to the front first')
  })
})
