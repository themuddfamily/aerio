import { defaultSettings } from '../preferences'
import type { Settings } from '../types'
import type { PortablePreferences } from '../settings-sync-types'
import { normalizeThemeSettings } from './themes'
import { normalizeKeymapOverrides } from './keymap'
import { normalizeMailNotifications } from './mail-notifications'
import { normalizeMessageToolbar } from './message-toolbar'

/** An explicit allowlist prevents account credentials or machine startup/security choices from crossing devices. */
export function portablePreferences(value: unknown): PortablePreferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid synchronized preferences.')
  const input = value as Settings
  if (!['system', 'light', 'dark'].includes(input.theme) || !['comfortable', 'compact'].includes(input.density) || typeof input.notifications !== 'boolean' || !['mail', 'calendar', 'contacts', 'tasks', 'notes', 'chat'].includes(input.startModule)) throw new Error('Invalid synchronized appearance or startup module.')
  if (input.readReceiptPolicy !== undefined && !['never', 'ask', 'always'].includes(input.readReceiptPolicy)) throw new Error('Invalid synchronized receipt policy.')
  const profile = input.profile
  if (profile && (typeof profile.displayName !== 'string' || profile.displayName.length > 200 || profile.email !== undefined && (typeof profile.email !== 'string' || profile.email.length > 320) || profile.avatarDataUrl !== undefined && (typeof profile.avatarDataUrl !== 'string' || profile.avatarDataUrl.length > 2_000_000 || !/^data:image\/(png|jpeg|webp);base64,/i.test(profile.avatarDataUrl)))) throw new Error('Invalid synchronized display profile.')
  const { accounts: _localAccounts, ...mailNotifications } = normalizeMailNotifications(input.mailNotifications)
  return {
    mailNotifications,
    theme: input.theme, density: input.density, notifications: input.notifications, startModule: input.startModule,
    readReceiptPolicy: input.readReceiptPolicy ?? defaultSettings.readReceiptPolicy,
    ...normalizeThemeSettings(input), messageToolbar: normalizeMessageToolbar(input.messageToolbar),
    keyboardShortcuts: normalizeKeymapOverrides(input.keyboardShortcuts),
    profile: profile ? { displayName: profile.displayName, ...(profile.email ? { email: profile.email } : {}), ...(profile.avatarDataUrl ? { avatarDataUrl: profile.avatarDataUrl } : {}) } : undefined
  }
}
