import { describe, expect, it } from 'vitest'
import { pop3ClientOptions, pop3SmtpConfig, serverSettingsOf, validatePop3Account, validatePop3Destination, validatePop3Retention } from './pop3-settings'

const input = {
  email: ' Person@Example.com ', username: ' person ', password: 'pw',
  pop3Host: ' pop.example.com ', pop3Port: 995, pop3Security: 'tls', smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls',
  retention: { leaveOnServer: true, removeWhenDeleted: false }, destination: { kind: 'account' }
}

describe('POP3 account validation', () => {
  it('normalizes a valid account and defaults to automatic sign-in', () => {
    expect(validatePop3Account(input)).toEqual({
      email: 'person@example.com', username: 'person', password: 'pw', pop3Host: 'pop.example.com', pop3Port: 995, pop3Security: 'tls', auth: 'auto',
      smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls', retention: { leaveOnServer: true, removeWhenDeleted: false }, destination: { kind: 'account' }
    })
  })

  it('requires an explicit opt-in for an unencrypted POP3 connection', () => {
    expect(() => validatePop3Account({ ...input, pop3Security: 'none' })).toThrow(/sent unencrypted/)
    expect(validatePop3Account({ ...input, pop3Security: 'none', allowPlaintext: true })).toMatchObject({ pop3Security: 'none', allowPlaintext: true })
    // The opt-in is dropped when encryption is used.
    expect(validatePop3Account({ ...input, allowPlaintext: true })).not.toHaveProperty('allowPlaintext')
    expect(() => validatePop3Account({ ...input, smtpSecurity: 'none' })).toThrow(/TLS or STARTTLS for the SMTP/)
  })

  it('rejects malformed fields', () => {
    expect(() => validatePop3Account(null)).toThrow(/Complete every/)
    expect(() => validatePop3Account({ ...input, email: 'nope' })).toThrow(/valid email/)
    expect(() => validatePop3Account({ ...input, password: '' })).toThrow(/password/)
    expect(() => validatePop3Account({ ...input, pop3Port: 0 })).toThrow(/POP3 port/)
    expect(() => validatePop3Account({ ...input, smtpPort: 70_000 })).toThrow(/SMTP port/)
    expect(() => validatePop3Account({ ...input, pop3Host: 'pop.example.com:995' })).toThrow(/hostnames/)
    expect(() => validatePop3Account({ ...input, auth: 'kerberos' })).toThrow(/sign-in method/)
    expect(() => validatePop3Account({ ...input, username: '' })).toThrow(/username/)
  })

  it('validates retention: removal after N days and on delete apply only while leaving mail on the server', () => {
    expect(validatePop3Retention({ leaveOnServer: true, deleteAfterDays: 30, removeWhenDeleted: true })).toEqual({ leaveOnServer: true, deleteAfterDays: 30, removeWhenDeleted: true })
    expect(validatePop3Retention({ leaveOnServer: false, deleteAfterDays: 30, removeWhenDeleted: true })).toEqual({ leaveOnServer: false, removeWhenDeleted: false })
    expect(() => validatePop3Retention({ leaveOnServer: true, deleteAfterDays: 1.5, removeWhenDeleted: false })).toThrow(/between 1 and 3650/)
    expect(() => validatePop3Retention({ leaveOnServer: true, deleteAfterDays: 4000, removeWhenDeleted: false })).toThrow(/between 1 and 3650/)
    expect(() => validatePop3Retention({ leaveOnServer: 'yes' })).toThrow(/what happens/)
  })

  it('validates the destination', () => {
    expect(validatePop3Destination({ kind: 'local-folder', labelId: 'folder:local-1' })).toEqual({ kind: 'local-folder', labelId: 'folder:local-1' })
    expect(() => validatePop3Destination({ kind: 'local-folder', labelId: 'INBOX' })).toThrow(/where downloaded mail/)
    expect(() => validatePop3Destination(undefined)).toThrow(/where downloaded mail/)
  })

  it('maps stored settings to the POP3 client and the SMTP sender without the password leaking into settings', () => {
    const valid = validatePop3Account(input)
    expect(serverSettingsOf({ ...valid })).not.toHaveProperty('password')
    expect(pop3ClientOptions({ ...valid }, { timeoutMs: 5 })).toEqual({ host: 'pop.example.com', port: 995, security: 'tls', allowPlaintext: undefined, username: 'person', password: 'pw', auth: 'auto', timeoutMs: 5 })
    expect(pop3SmtpConfig({ ...valid })).toMatchObject({ email: 'person@example.com', smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'starttls', username: 'person', password: 'pw' })
  })
})
