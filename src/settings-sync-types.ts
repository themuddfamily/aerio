import type { Settings, AppPreferences } from './types'
export type PortablePreferences = Pick<Settings, 'theme' | 'density' | 'notifications' | 'startModule' | 'readReceiptPolicy' | 'profile' | 'keyboardShortcuts' | 'customThemes' | 'customThemeId' | 'messageToolbar'> & { mailNotifications?: Omit<import('./mail-notification-types').MailNotificationPreferences, 'accounts'> }
export interface PortableSignatures {
  definitions: Array<{ id: string; name: string; html: string }>
  accounts: Array<{ provider: string; email: string; html: string }>
  assignments: Array<{ provider: string; accountEmail: string; identityEmail: string; newSignatureId?: string; replySignatureId?: string }>
}
export interface SettingsSyncBundle {
  format: 'aerio-settings-sync'; version: 1
  preferences: PortablePreferences
  signatures: PortableSignatures
  templates: import('../electron/mail/template-store').MailTemplateBackup
}
export interface SettingsSyncConfiguration {
  enabled: boolean; url: string; username: string; password?: string; passphrase?: string; intervalMinutes: number; deviceName: string
}
export interface SettingsSyncReview {
  localDigest: string; remoteDigest: string; etag: string
  remoteDevice: string; updatedAt: string; differences: string[]
  local: { signatures: number; templates: number; snippets: number }
  remote: { signatures: number; templates: number; snippets: number }
}
export interface SettingsSyncStatus {
  configured: boolean; enabled: boolean; url: string; username: string; deviceName: string; intervalMinutes: number
  phase: 'disabled' | 'idle' | 'syncing' | 'review' | 'error'; recoveryPending?: boolean; lastSyncedAt?: string; message?: string; review?: SettingsSyncReview
}
export interface SettingsSyncApi {
  status(): Promise<SettingsSyncStatus>
  configure(configuration: SettingsSyncConfiguration): Promise<SettingsSyncStatus>
  sync(): Promise<SettingsSyncStatus>
  resolve(choice: 'local' | 'remote'): Promise<SettingsSyncStatus>
  disconnect(): Promise<SettingsSyncStatus>
  onApplied(callback: (preferences: AppPreferences) => void): () => void
}
