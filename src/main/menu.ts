// The macOS menu bar, made of Electron's standard roles. Electron would install a default one, but
// an explicit one keeps Quit (Cmd+Q), the Edit shortcuts (copy and paste need the menu on a Mac)
// and the Window commands whatever Electron's default becomes, and leaves out Reload, which would
// throw away the open chat's state. Minimize has no shortcut: Cmd+M is voice input (Composer).
import { Menu, type MenuItemConstructorOptions, app } from 'electron'

export const setAppMenu = () => {
  if (process.platform !== 'darwin') return
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  if (!app.isPackaged) view.unshift({ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: view },
      {
        role: 'windowMenu',
        submenu: [
          { label: 'Minimize', click: (_item, win) => win?.minimize() },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'close' },
          { role: 'front' }
        ]
      }
    ])
  )
}
