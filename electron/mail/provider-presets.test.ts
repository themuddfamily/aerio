import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, validateImapAccount } from './provider-presets'

describe('mail provider presets', () => {
  it('covers the common OAuth, app-password, bridge, and generic providers', () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      'gmail', 'microsoft', 'icloud', 'yahoo', 'fastmail', 'proton-bridge', 'imap'
    ])
    expect(PROVIDER_PRESETS.find((preset) => preset.id === 'icloud')).toMatchObject({ imapPort: 993, smtpPort: 587 })
    expect(PROVIDER_PRESETS.find((preset) => preset.id === 'proton-bridge')).toMatchObject({ imapHost: '127.0.0.1', smtpHost: '127.0.0.1' })
  })

  it('normalizes valid account data and rejects unsafe server settings', () => {
    const input = {
      provider: 'fastmail' as const,
      email: ' Person@Example.com ',
      username: ' person@example.com ',
      password: 'app password',
      imapHost: 'imap.fastmail.com',
      imapPort: 993,
      imapSecurity: 'tls' as const,
      smtpHost: 'smtp.fastmail.com',
      smtpPort: 465,
      smtpSecurity: 'tls' as const
    }
    expect(validateImapAccount(input)).toMatchObject({ email: 'person@example.com', username: 'person@example.com' })
    expect(() => validateImapAccount({ ...input, imapHost: 'https://imap.example.com' })).toThrow(/hostnames or IP addresses/)
    expect(() => validateImapAccount({ ...input, allowInvalidCertificates: true })).toThrow(/only for a local Proton Bridge/)
    expect(() => validateImapAccount({ ...input, smtpSecurity: 'none' as 'tls' })).toThrow(/TLS or STARTTLS/)
  })

  it('validates every required IMAP account boundary', () => {
    const valid = {
      provider: 'proton-bridge' as const, email: 'Person@Example.com', username: ' person ', password: 'secret',
      imapHost: 'localhost', imapPort: 1143, imapSecurity: 'starttls' as const,
      smtpHost: '127.0.0.1', smtpPort: 1025, smtpSecurity: 'starttls' as const, allowInvalidCertificates: true
    }
    expect(validateImapAccount(valid)).toMatchObject({ email: 'person@example.com', username: 'person' })
    expect(() => validateImapAccount(undefined as any)).toThrow(/required account/)
    expect(() => validateImapAccount({ ...valid, provider: 'gmail' as any })).toThrow(/valid IMAP/)
    expect(() => validateImapAccount({ ...valid, password: ' ' })).toThrow(/required account/)
    expect(() => validateImapAccount({ ...valid, email: 'invalid' })).toThrow(/valid email/)
    expect(() => validateImapAccount({ ...valid, imapPort: 1.5 })).toThrow(/IMAP port/)
    expect(() => validateImapAccount({ ...valid, imapPort: 65_536 })).toThrow(/IMAP port/)
    expect(() => validateImapAccount({ ...valid, smtpPort: 0 })).toThrow(/SMTP port/)
    expect(() => validateImapAccount({ ...valid, smtpPort: 65_536 })).toThrow(/SMTP port/)
    expect(() => validateImapAccount({ ...valid, allowInvalidCertificates: 'yes' as any })).toThrow(/certificate policy/)
    expect(() => validateImapAccount({ ...valid, smtpHost: 'smtp.example.test:465', allowInvalidCertificates: false })).toThrow(/hostnames or IP addresses/)
  })
})
