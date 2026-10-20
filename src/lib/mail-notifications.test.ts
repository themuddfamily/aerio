import { describe, expect, it } from 'vitest'
import { defaultMailNotifications, mailNotificationAllowed, mailNotificationText, mailQuietHours, normalizeMailNotifications } from './mail-notifications'
const payload = { accountId: 'a', count: 1, threadId: 'thread', sender: 'Private sender', subject: 'Private subject', category: 'promotions' }
describe('mail notification preferences', () => {
  it('preserves safe defaults and bounds untrusted commands and account/category entries', () => {
    expect(normalizeMailNotifications(undefined)).toEqual(defaultMailNotifications())
    expect(normalizeMailNotifications({ actions: ['archive', 'arbitrary-command', 'archive', 'read', 'star', 'trash'], accounts: { a: false, b: 'no' }, categories: ['promotions', 'custom:receipts', 'invalid', 'promotions'], preview: 'invalid' })).toMatchObject({ actions: ['archive', 'read', 'star'], accounts: { a: false }, categories: ['promotions', 'custom:receipts'], preview: 'subject' })
    expect(normalizeMailNotifications({ actions: [], categories: [] })).toMatchObject({ actions: [], categories: [] })
  })
  it('checks quiet hours across midnight using the local clock and excludes the end boundary', () => {
    const prefs = defaultMailNotifications(); prefs.quietHours = { enabled: true, start: '22:00', end: '08:00' }
    expect(mailQuietHours(prefs, new Date(2026, 9, 20, 23))).toBe(true)
    expect(mailQuietHours(prefs, new Date(2026, 9, 20, 7, 59))).toBe(true)
    expect(mailQuietHours(prefs, new Date(2026, 9, 20, 8))).toBe(false)
    expect(mailQuietHours(prefs, new Date(2026, 9, 20, 15))).toBe(false)
    prefs.quietHours.start = '08:00'
    expect(mailQuietHours(prefs, new Date(2026, 9, 20, 8))).toBe(false)
  })
  it('filters account and categories independently and always redacts while locked', () => {
    const prefs = defaultMailNotifications()
    expect(mailNotificationText(prefs, payload, false)).toEqual({ title: 'Private sender', body: 'Private subject' })
    expect(mailNotificationText({ ...prefs, preview: 'sender' }, payload, false).body).not.toContain('Private subject')
    expect(JSON.stringify(mailNotificationText({ ...prefs, preview: 'hidden' }, payload, false))).not.toContain('Private')
    expect(JSON.stringify(mailNotificationText(prefs, payload, true))).not.toContain('Private')
    expect(mailNotificationAllowed({ ...prefs, categories: ['primary'] }, payload)).toBe(false)
    expect(mailNotificationAllowed({ ...prefs, accounts: { a: false } }, payload)).toBe(false)
    expect(mailNotificationAllowed({ ...prefs, categories: [] }, payload)).toBe(false)
  })
})
