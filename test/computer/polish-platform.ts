// CHAT_V2_FAKE_COMPUTER for render-chat.mjs: the e2e's fake platform, with revealing a file failing,
// so a reply has a failed step to show.
import { capture, platform as base } from './e2e-platform'
import type { Platform } from '../../src/main/computer/platform/types'

export const platform: Platform = {
  ...base,
  reveal: async (path) => {
    throw new Error(`No file at ${path}`)
  }
}
export { capture }
