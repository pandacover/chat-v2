// The update state machine (src/main/updateMachine.ts) driven by a stand-in for electron-updater:
// idle → checking → available → downloading (n%) → downloaded → installing, and the ways back
// when a check or a download fails.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { UpdateState } from '../src/shared/types'
import { describeUpdateError, releaseNotesText, updateMachine, type UpdateInfoLike } from '../src/main/updateMachine'

/** electron-updater's autoUpdater, as far as the machine uses it; each call is answered by hand. */
class FakeUpdater extends EventEmitter {
  calls: string[] = []
  check: { resolve: () => void; reject: (e: unknown) => void } | null = null
  download: { resolve: () => void; reject: (e: unknown) => void } | null = null
  checkForUpdates() {
    this.calls.push('check')
    return new Promise<unknown>((resolve, reject) => (this.check = { resolve: () => resolve(null), reject }))
  }
  downloadUpdate() {
    this.calls.push('download')
    return new Promise<unknown>((resolve, reject) => (this.download = { resolve: () => resolve([]), reject }))
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.calls.push(`quitAndInstall ${isSilent} ${isForceRunAfter}`)
  }
}

const NOTES = '<p>Built from 34a9084: Capture the Mac screen with ScreenCaptureKit<br>\nand keep tags &amp; marks on screen</p>'

const setup = (over: { supported?: boolean; noInstall?: boolean } = {}) => {
  const fake = new FakeUpdater()
  const seen: UpdateState[] = []
  let clock = 1000
  const later: Array<() => void> = []
  const m = updateMachine(fake, {
    current: '0.1.10',
    supported: over.supported ?? true,
    noInstall: over.noInstall ?? false,
    emit: (s) => seen.push(s),
    platform: 'darwin',
    now: () => clock,
    later: (f) => later.push(f)
  })
  return { fake, m, seen, statuses: () => seen.map((s) => s.status), tick: (ms: number) => (clock += ms), runLater: () => later.splice(0).forEach((f) => f()) }
}

const available = (fake: FakeUpdater, version = '0.1.11', notes: UpdateInfoLike['releaseNotes'] = NOTES) =>
  fake.emit('update-available', { version, releaseNotes: notes })

describe('update state machine', () => {
  test('a development build has nothing to check', async () => {
    const { m, fake } = setup({ supported: false })
    expect(m.state().status).toBe('unsupported')
    await m.check()
    expect(fake.calls).toEqual([])
  })

  test('idle → checking → available → downloading (n%) → downloaded → installing', async () => {
    const { m, fake, statuses, runLater } = setup()
    expect(m.state()).toMatchObject({ status: 'idle', current: '0.1.10', next: null, checkedAt: null })

    const checking = m.check()
    expect(m.state().status).toBe('checking')
    available(fake)
    fake.check!.resolve()
    await checking
    expect(m.state()).toMatchObject({ status: 'available', next: '0.1.11', error: null, checkedAt: 1000 })
    expect(m.state().notes).toBe('Capture the Mac screen with ScreenCaptureKit\nand keep tags & marks on screen')

    const downloading = m.download()
    expect(m.state()).toMatchObject({ status: 'downloading', percent: 0 })
    fake.emit('download-progress', { percent: 12.7 })
    expect(m.state().percent).toBe(12)
    fake.emit('download-progress', { percent: 64.2 })
    expect(m.state().percent).toBe(64)
    fake.emit('update-downloaded', { version: '0.1.11' })
    fake.download!.resolve()
    await downloading
    expect(m.state()).toMatchObject({ status: 'downloaded', next: '0.1.11', percent: 100 })

    m.install()
    expect(m.state().status).toBe('installing')
    expect(fake.calls).toEqual(['check', 'download'])
    runLater()
    expect(fake.calls).toEqual(['check', 'download', 'quitAndInstall true true'])
    expect(statuses()).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloading', 'downloaded', 'installing'])
  })

  test('nothing newer: back to idle, with the time of the check', async () => {
    const { m, fake, tick } = setup()
    tick(500)
    const checking = m.check()
    fake.emit('update-not-available')
    fake.check!.resolve()
    await checking
    expect(m.state()).toMatchObject({ status: 'idle', next: null, notes: null, error: null, checkedAt: 1500 })
  })

  test('a failed check goes back to idle with the error, then the next check clears it', async () => {
    const { m, fake } = setup()
    const checking = m.check()
    // electron-updater both emits error and rejects.
    const e = new Error('net::ERR_INTERNET_DISCONNECTED\n<long HTTP dump>')
    fake.emit('error', e)
    fake.check!.reject(e)
    await checking
    expect(m.state()).toMatchObject({ status: 'idle', error: "Couldn't reach GitHub to check for updates.", checkedAt: null })

    const again = m.check()
    expect(m.state()).toMatchObject({ status: 'checking', error: null })
    fake.emit('update-not-available')
    fake.check!.resolve()
    await again
    expect(m.state()).toMatchObject({ status: 'idle', error: null })
  })

  test('a failed check with an update already found keeps offering it', async () => {
    const { m, fake } = setup()
    const first = m.check()
    available(fake)
    fake.check!.resolve()
    await first
    const second = m.check()
    fake.check!.reject(new Error('HttpError: 404 releases.atom'))
    await second
    expect(m.state()).toMatchObject({ status: 'available', next: '0.1.11', error: 'No published releases found yet.' })
  })

  test('a failed download goes back to available with the error; downloading again retries', async () => {
    const { m, fake } = setup()
    available(fake)
    const first = m.download()
    fake.emit('download-progress', { percent: 40 })
    fake.download!.reject(new Error('sha512 checksum mismatch'))
    await first
    expect(m.state()).toMatchObject({ status: 'available', percent: null, error: 'sha512 checksum mismatch' })

    const second = m.download()
    expect(m.state()).toMatchObject({ status: 'downloading', percent: 0, error: null })
    fake.emit('update-downloaded', { version: '0.1.11' })
    fake.download!.resolve()
    await second
    expect(m.state().status).toBe('downloaded')
  })

  test('background checks are quiet and never touch a download or a finished one', async () => {
    const { m, fake, statuses } = setup()
    const quiet = m.check(false)
    expect(m.state().status).toBe('idle')
    fake.emit('update-not-available')
    fake.check!.resolve()
    await quiet
    expect(statuses()).toEqual(['idle'])

    available(fake)
    void m.download()
    await m.check(false)
    await m.check(true)
    expect(fake.calls).toEqual(['check', 'download'])
    // A late event from an earlier check doesn't undo the download either.
    fake.emit('update-not-available')
    fake.emit('update-available', { version: '0.1.11' })
    expect(m.state().status).toBe('downloading')
  })

  test('clicking while a background check runs shows it, without starting another', async () => {
    const { m, fake } = setup()
    const quiet = m.check(false)
    await m.check(true)
    expect(m.state().status).toBe('checking')
    expect(fake.calls).toEqual(['check'])
    fake.emit('update-not-available')
    fake.check!.resolve()
    await quiet
    expect(m.state().status).toBe('idle')
  })

  test('a check answered without either event returns to where it was', async () => {
    const { m, fake } = setup()
    const checking = m.check()
    fake.check!.resolve()
    await checking
    expect(m.state().status).toBe('idle')
  })

  test('only an available update downloads, and only a downloaded one installs', async () => {
    const { m, fake, runLater } = setup()
    await m.download()
    m.install()
    runLater()
    expect(fake.calls).toEqual([])
    expect(m.state().status).toBe('idle')
  })

  test('progress outside a download, or not a number, is ignored or clamped', () => {
    const { m, fake } = setup()
    fake.emit('download-progress', { percent: 50 })
    expect(m.state().percent).toBeNull()
    available(fake)
    void m.download()
    fake.emit('download-progress', { percent: Number.NaN })
    expect(m.state().percent).toBe(0)
    fake.emit('download-progress', { percent: 140 })
    expect(m.state().percent).toBe(100)
  })

  test('install failing goes back to downloaded with the error; noInstall stops short', () => {
    const failing = setup()
    available(failing.fake)
    void failing.m.download()
    failing.fake.emit('update-downloaded', { version: '0.1.11' })
    failing.fake.quitAndInstall = () => {
      throw new Error('Squirrel: read-only volume')
    }
    failing.m.install()
    failing.runLater()
    expect(failing.m.state()).toMatchObject({ status: 'downloaded', error: 'Move chat-v2 into Applications to update it.' })

    const held = setup({ noInstall: true })
    available(held.fake)
    void held.m.download()
    held.fake.emit('update-downloaded', { version: '0.1.11' })
    held.m.install()
    held.runLater()
    expect(held.m.state().status).toBe('installing')
    expect(held.fake.calls).toEqual(['download'])
  })
})

describe('release notes', () => {
  test("a GitHub release's HTML becomes the commit message", () => {
    expect(releaseNotesText(NOTES)).toBe('Capture the Mac screen with ScreenCaptureKit\nand keep tags & marks on screen')
    expect(releaseNotesText('<p>Built from abcdef1: Fix &quot;quotes&quot; &#39;here&#39; &#x2014; ok</p>')).toBe('Fix "quotes" \'here\' — ok')
  })

  test('empty, missing or a full changelog', () => {
    expect(releaseNotesText(null)).toBeNull()
    expect(releaseNotesText('')).toBeNull()
    expect(releaseNotesText('<p>Built from abcdef1: </p>')).toBeNull()
    expect(releaseNotesText([{ version: '0.1.12', note: '<p>Newest</p>' }, { version: '0.1.11', note: 'Older' }])).toBe('Newest')
  })

  test('errors read as one line', () => {
    expect(describeUpdateError(new Error('first line\nsecond'), 'win32')).toBe('first line')
    expect(describeUpdateError(new Error('EROFS: read-only file system'), 'win32')).toBe('EROFS: read-only file system')
    expect(describeUpdateError(new Error('EROFS: read-only file system'), 'darwin')).toBe('Move chat-v2 into Applications to update it.')
  })
})
