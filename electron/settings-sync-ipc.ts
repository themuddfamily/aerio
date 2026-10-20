import type { SettingsSyncConfiguration } from '../src/settings-sync-types'
import type { SettingsSyncService } from './settings-sync'
export function registerSettingsSync(ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void }, service: SettingsSyncService) {
  ipcMain.handle('settings-sync:status', () => service.status())
  ipcMain.handle('settings-sync:configure', (_event, input) => service.configure(input as SettingsSyncConfiguration))
  ipcMain.handle('settings-sync:sync', () => service.sync())
  ipcMain.handle('settings-sync:resolve', (_event, choice) => {
    if (choice !== 'local' && choice !== 'remote') throw new Error('Choose local or remote settings.')
    return service.sync(choice)
  })
  ipcMain.handle('settings-sync:disconnect', () => service.disconnect())
}
