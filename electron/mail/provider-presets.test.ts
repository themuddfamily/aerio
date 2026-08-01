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
})
