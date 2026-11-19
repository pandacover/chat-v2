import type { ChildProcess } from 'node:child_process'
import { linuxSupported, makeLinuxPlatform } from './linux'
import { makeMacPlatform } from './macos'
import type { Platform } from './types'
import { makeWindowsPlatform } from './windows'

export type * from './types'

/** Computer use runs on Windows, macOS, and Linux with an X11 display (not Wayland). */
export const supported =
  process.platform === 'win32' || process.platform === 'darwin' || (process.platform === 'linux' && linuxSupported())

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
  if (process.platform === 'linux' && linuxSupported()) return makeLinuxPlatform({ ownerPid, track })
  throw new Error('Computer use needs Windows, macOS, or Linux with an X11 display.')
}
