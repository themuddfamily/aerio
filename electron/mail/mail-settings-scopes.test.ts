import { describe, expect, it } from 'vitest'
import {
  GMAIL_SETTINGS_BASIC_SCOPE,
  MailSettingsPermissionError,
  grantedScopeSet,
  isMailSettingsPermissionFailure,
  mailSettingsScopeStatus,
  requiredMailSettingsScopes
} from './mail-settings-scopes'

describe('mail settings scopes', () => {
  it('normalizes Graph resource prefixes in granted scopes', () => {
    expect([...grantedScopeSet('openid https://graph.microsoft.com/MailboxSettings.ReadWrite  Mail.Send')]).toEqual(['openid', 'MailboxSettings.ReadWrite', 'Mail.Send'])
    expect(grantedScopeSet(undefined).size).toBe(0)
  })

  it('requires gmail.settings.basic and MailboxSettings.ReadWrite only for OAuth providers', () => {
    expect(requiredMailSettingsScopes('gmail')).toEqual([GMAIL_SETTINGS_BASIC_SCOPE])
    expect(requiredMailSettingsScopes('microsoft')).toEqual(['MailboxSettings.ReadWrite'])
    expect(requiredMailSettingsScopes('imap')).toEqual([])
  })

  it('reports granted, missing, and unsupported settings access with a reconnect explanation', () => {
    expect(mailSettingsScopeStatus('gmail', `x ${GMAIL_SETTINGS_BASIC_SCOPE}`, 'server-rules')).toEqual({ provider: 'gmail', supported: true, granted: true, required: [GMAIL_SETTINGS_BASIC_SCOPE], missing: [] })
    expect(mailSettingsScopeStatus('microsoft', 'mailboxsettings.readwrite', 'automatic-replies').granted).toBe(true)
    const missing = mailSettingsScopeStatus('microsoft', 'MailboxSettings.Read', 'automatic-replies')
    expect(missing).toMatchObject({ granted: false, missing: ['MailboxSettings.ReadWrite'] })
    expect(missing.message).toMatch(/Reconnect the account.*automatic replies/)
    expect(mailSettingsScopeStatus('fastmail', undefined, 'server-rules')).toMatchObject({ supported: false, granted: false, message: expect.stringContaining('server rules') })
  })

  it('recognizes provider permission failures without treating expired tokens as scope problems', () => {
    expect(isMailSettingsPermissionFailure(403)).toBe(true)
    expect(isMailSettingsPermissionFailure(401, 'Request had insufficient authentication scopes')).toBe(true)
    expect(isMailSettingsPermissionFailure(401, 'Invalid Credentials')).toBe(false)
    expect(isMailSettingsPermissionFailure(500, 'insufficient')).toBe(false)
    expect(isMailSettingsPermissionFailure(403, 'User rate limit exceeded', 'userRateLimitExceeded')).toBe(false)
    const error = new MailSettingsPermissionError('gmail', 'server-rules')
    expect(error.message).toContain('gmail.settings.basic')
    expect(error.name).toBe('MailSettingsPermissionError')
  })
})
