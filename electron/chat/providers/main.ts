import { join } from 'node:path'
import { BrowserWindow, ipcMain, Notification, safeStorage } from 'electron'
import { assertSecureCredentialStorage } from '../../mail/secure-storage'
import { ChatVault } from '../chat-vault'
import type { ProviderChatAdapter } from './adapter'
import { registerProviderChatIpc } from './ipc'
import { ProviderChatRuntime } from './runtime'

export function initializeProviderChat(options: {
  userData: string; adapters: ProviderChatAdapter[]; locked(): boolean; online(): boolean
  notificationsEnabled(): boolean; quietNotifications: boolean; isServiceSender(id: number): boolean; openMainWindow(): void
}) {
  const assertSecure = () => assertSecureCredentialStorage(safeStorage)
  const vault = new ChatVault(join(options.userData, 'provider-chat-vault.dat'), { assertSecure, encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) })
  const changed = (event: import('../../../src/provider-chat-types').ProviderChatEvent) => BrowserWindow.getAllWindows().filter((window) => !options.isServiceSender(window.webContents.id)).forEach((window) => window.webContents.send('provider-chat:event', event))
  const runtime = new ProviderChatRuntime({
    path: join(options.userData, 'provider-chat.sqlite'), vault, adapters: options.adapters, assertSecure,
    locked: options.locked, online: options.online, notificationsEnabled: options.notificationsEnabled, changed,
    notify: (title, body, accountId, roomId) => {
      if (options.quietNotifications || !Notification.isSupported() || options.locked()) return
      const notification = new Notification({ title: title.slice(0, 80), body: body.slice(0, 240) })
      notification.on('click', () => { options.openMainWindow(); if (!options.locked()) changed({ type: 'open-room', accountId, roomId }) })
      notification.show()
    }
  })
  registerProviderChatIpc({ ipc: ipcMain, runtime, locked: options.locked, isServiceSender: options.isServiceSender })
  runtime.start()
  return runtime
}
