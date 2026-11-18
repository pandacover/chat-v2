import { makeMacPlatform } from './macos'
import type { Platform } from './types'
import { makeWindowsPlatform } from './windows'

export type * from './types'

/** Computer use runs on Windows and macOS. */
export const supported = process.platform === 'win32' || process.platform === 'darwin'

/**
 * The real platform for this OS. `ownerPid` is chat-v2's main process, whose windows are never
 * targets. Nothing starts until the first call.
 */
export const makePlatform = (ownerPid = process.pid): Platform => {
  if (process.platform === 'win32') return makeWindowsPlatform({ ownerPid })
  if (process.platform === 'darwin') return makeMacPlatform({ ownerPid })
  throw new Error('Computer use needs Windows or macOS.')
}
