import type { App, MenuItemConstructorOptions } from 'electron'

export function applicationMenuTemplate(platform: NodeJS.Platform, reopen: () => void): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' },
      { id: 'aerio-open', label: 'Open Aerio', click: reopen }, { role: 'front' }, { role: 'close' }
    ] }
  ]
}

export function registerMacLoginItem(application: Pick<App, 'setLoginItemSettings' | 'getLoginItemSettings'>, enabled: boolean): void {
  const before = application.getLoginItemSettings()
  try {
    application.setLoginItemSettings({ openAtLogin: enabled })
    const actual = application.getLoginItemSettings()
    if (enabled && (!actual.openAtLogin || actual.status !== 'enabled')) {
      throw new Error('macOS has not enabled Aerio at login. Check Login Items in System Settings; unsigned builds may not support registration.')
    }
    if (!enabled && actual.openAtLogin) throw new Error('macOS could not remove Aerio from Login Items')
  } catch (error) {
    try { application.setLoginItemSettings({ openAtLogin: before.openAtLogin }) } catch { /* Preserve the original registration failure. */ }
    throw error
  }
}
