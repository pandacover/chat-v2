// App updates from this repository's GitHub releases (see electron-builder.yml), driven by the
// state machine in updateMachine.ts and shown as one icon button in the sidebar (UpdateButton).
// Checks run in the background; downloading and restarting into an update are the user's call.
// A downloaded update also installs on the next normal quit.
// Windows installs in place with NSIS. macOS builds are signed with one long-lived self-signed
// certificate (scripts/make-mac-cert.sh), so each version satisfies the previous one's designated
// requirement: that lets Squirrel.Mac replace the app in place, and keeps macOS's privacy
// permissions across updates.
import { BrowserWindow, app, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { errorMessage } from './errors'
import { updateMachine } from './updateMachine'

const { autoUpdater } = electronUpdater

const CHECK_EVERY = 30 * 60 * 1000
const mac = process.platform === 'darwin'

/** For the update proof (scripts/mac-update-proof.ts): download and install as soon as it can. */
const unattended = process.env.CHAT_V2_UPDATE_AUTO_INSTALL === '1'

const updates = updateMachine(autoUpdater, {
  current: app.getVersion(),
  supported: app.isPackaged,
  noInstall: process.env.CHAT_V2_UPDATE_NO_INSTALL === '1',
  emit: (state: UpdateState) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('updates:event', state)
    if (unattended && state.status === 'available') void updates.download()
    if (unattended && state.status === 'downloaded') updates.install()
  }
})

export const updateState = () => updates.state()
/** The user asked: shows the checking state. */
export const checkForUpdates = () => updates.check(true)
export const downloadUpdate = () => updates.download()
export const installUpdate = async () => updates.install()

/**
 * macOS: Squirrel.Mac can only replace an app it can write to, so one run from the DMG or from
 * Downloads (where macOS runs it from a read-only copy) offers to move itself into Applications.
 * Asked once per launch, on a packaged build only.
 */
export const offerMoveToApplications = async () => {
  if (!mac || !app.isPackaged || app.isInApplicationsFolder() || process.env.CHAT_V2_HEADLESS === '1') return
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Move chat-v2 to Applications?',
    detail: 'chat-v2 can only update itself from the Applications folder.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return
  try {
    // Moves the app, quits and relaunches the moved copy.
    app.moveToApplicationsFolder()
  } catch (e) {
    await dialog.showMessageBox({ type: 'warning', message: "Couldn't move chat-v2", detail: errorMessage(e) })
  }
}

export const initUpdater = () => {
  if (!app.isPackaged) return
  // Downloads start from the update button; a finished one installs on restart or the next quit.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  if (process.env.CHAT_V2_UPDATE_FEED) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.CHAT_V2_UPDATE_FEED })
    autoUpdater.logger = console
  }
  setTimeout(() => void updates.check(false), unattended ? 1000 : 8000)
  setInterval(() => void updates.check(false), CHECK_EVERY)
}
