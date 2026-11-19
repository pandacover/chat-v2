import type { ChildProcess } from 'node:child_process'
import { makeMacPlatform } from './macos'
import type { Platform } from './types'
import { makeWindowsPlatform } from './windows'

export type * from './types'

/** Computer use runs on Windows and macOS. */
export const supported = process.platform === 'win32' || process.platform === 'darwin'

export interface PlatformOptions {
  /** chat-v2's main process, whose windows are never targets. */
  ownerPid?: number
  /** Called with every process the platform starts, so quitting can end them. */
  track?: (p: ChildProcess) => void
}

/** The real platform for this OS. Nothing starts until the first call. */
export const makePlatform = ({ ownerPid = process.pid, track = () => {} }: PlatformOptions = {}): Platform => {
  if (process.platform === 'win32') return makeWindowsPlatform({ ownerPid, track })
  if (process.platform === 'darwin') return makeMacPlatform({ ownerPid, track })
  throw new Error('Computer use needs Windows or macOS.')
}
