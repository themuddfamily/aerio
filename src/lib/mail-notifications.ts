import type { MailNotificationAction, MailNotificationPayload, MailNotificationPreferences } from '../mail-notification-types'
import { isMailCategoryId } from './mail-categories'

export const MAIL_NOTIFICATION_ACTION_LABELS: Record<MailNotificationAction, string> = { open: 'Open message', read: 'Mark as read', archive: 'Archive', star: 'Add star', trash: 'Move to Trash' }
export const MAIL_NOTIFICATION_ACTIONS = Object.keys(MAIL_NOTIFICATION_ACTION_LABELS) as MailNotificationAction[]
export const defaultMailNotifications = (): MailNotificationPreferences => ({ actions: ['open'], preview: 'subject', silent: false, onlyWhenUnfocused: false, quietHours: { enabled: false, start: '22:00', end: '08:00' }, accounts: {} })
const time = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)

/** Older profiles inherit current behavior; arbitrary saved commands never reach native callbacks. */
export function normalizeMailNotifications(value: unknown): MailNotificationPreferences {
  const defaults = defaultMailNotifications()
  if (!value || typeof value !== 'object') return defaults
  const input = value as Partial<MailNotificationPreferences>
  const quiet = input.quietHours
  const accounts = input.accounts && typeof input.accounts === 'object' && !Array.isArray(input.accounts) ? Object.fromEntries(Object.entries(input.accounts).filter(([id, enabled]) => id.length > 0 && id.length <= 200 && typeof enabled === 'boolean').slice(0, 100)) : {}
  return {
    actions: Array.isArray(input.actions) ? [...new Set(input.actions.filter((action) => MAIL_NOTIFICATION_ACTIONS.includes(action)))].slice(0, 3) : defaults.actions,
    preview: input.preview === 'sender' || input.preview === 'hidden' ? input.preview : 'subject',
    silent: input.silent === true, onlyWhenUnfocused: input.onlyWhenUnfocused === true,
    quietHours: { enabled: quiet?.enabled === true, start: time(quiet?.start) ? quiet.start : defaults.quietHours.start, end: time(quiet?.end) ? quiet.end : defaults.quietHours.end }, accounts,
    ...(Array.isArray(input.categories) ? { categories: [...new Set(input.categories.filter(isMailCategoryId))].slice(0, 15) } : {})
  }
}
export function mailQuietHours(preferences: MailNotificationPreferences, date: Date) {
  if (!preferences.quietHours.enabled) return false
  const { start, end } = preferences.quietHours
  const now = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (start === end) return false
  return start < end ? now >= start && now < end : now >= start || now < end
}
export function mailNotificationAllowed(preferences: MailNotificationPreferences, payload: MailNotificationPayload) {
  return preferences.accounts[payload.accountId] !== false && (preferences.categories === undefined || preferences.categories.includes(payload.category ?? 'primary'))
}
export function mailNotificationText(preferences: MailNotificationPreferences, payload: MailNotificationPayload, locked: boolean) {
  const genericTitle = payload.count === 1 ? 'New message' : `${payload.count.toLocaleString()} new messages`
  if (locked) return { title: genericTitle, body: 'Unlock Aerio to view your inbox' }
  if (payload.count !== 1 || preferences.preview === 'hidden') return { title: genericTitle, body: 'Open Aerio to view your inbox' }
  return { title: payload.sender || 'New message', body: preferences.preview === 'sender' ? 'New email — open Aerio to read it' : payload.subject || 'Open Aerio to read it' }
}
