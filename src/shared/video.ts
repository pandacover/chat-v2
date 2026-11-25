// What the main process asks the video worker (main/video.ts → renderer/src/video/worker.ts), and its answer.

export interface GrabRequest {
  /** The file's size in bytes. */
  size: number
  /** Seconds, sorted. */
  times: number[]
  /** A time may move this far (seconds) to the nearest keyframe, which decodes alone; 0 for the exact moment. */
  snap: number
  /** The longest edge of a frame, in pixels. */
  edge: number
  /** Frames stop being taken after this long; those taken come back, marked partial. */
  budgetMs: number
}

export type GrabResult = { frames: Array<{ time: number; jpeg: Uint8Array }>; partial: boolean } | { error: string }
