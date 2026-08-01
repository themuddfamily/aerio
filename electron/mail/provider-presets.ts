import type { ImapAccountInput, MailProviderPreset } from '../../src/gmail-types'

export const PROVIDER_PRESETS: MailProviderPreset[] = [
  { id: 'gmail', name: 'Google Gmail', description: 'Gmail API with labels, drafts, and History sync.', auth: 'google-oauth' },
  { id: 'microsoft', name: 'Outlook & Microsoft 365', description: 'Microsoft Graph for Outlook.com and work or school mailboxes.', auth: 'microsoft-oauth' },
  { id: 'icloud', name: 'Apple iCloud Mail', description: 'IMAP and SMTP using an Apple app-specific password.', auth: 'app-password', imapHost: 'imap.mail.me.com', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecurity: 'starttls', passwordHint: 'Apple app-specific password' },
  { id: 'yahoo', name: 'Yahoo Mail & AOL', description: 'IMAP and SMTP using a Yahoo app password.', auth: 'app-password', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecurity: 'tls', passwordHint: 'Yahoo app password' },
  { id: 'fastmail', name: 'Fastmail', description: 'IMAP and SMTP using a Fastmail app password.', auth: 'app-password', imapHost: 'imap.fastmail.com', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecurity: 'tls', passwordHint: 'Fastmail app password' },
  { id: 'proton-bridge', name: 'Proton Mail Bridge', description: 'Connect to the local IMAP/SMTP service exposed by Proton Mail Bridge.', auth: 'bridge', imapHost: '127.0.0.1', imapPort: 1143, imapSecurity: 'starttls', smtpHost: '127.0.0.1', smtpPort: 1025, smtpSecurity: 'starttls', usernameHint: 'Bridge username', passwordHint: 'Bridge password' },
  { id: 'imap', name: 'Other IMAP/SMTP', description: 'Any standards-compatible mail provider or custom domain.', auth: 'password', imapPort: 993, imapSecurity: 'tls', smtpPort: 465, smtpSecurity: 'tls' }
]

export function validateImapAccount(input: ImapAccountInput) {
  if (!input || typeof input !== 'object') throw new Error('Complete every required account and server field')
  if (!['icloud', 'yahoo', 'fastmail', 'imap', 'proton-bridge'].includes(input.provider)) throw new Error('Choose a valid IMAP/SMTP provider')
  const textFields = [input.email, input.username, input.password, input.imapHost, input.smtpHost]
  if (textFields.some((value) => !value?.trim())) throw new Error('Complete every required account and server field')
  const email = input.email.trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
  if (!Number.isInteger(input.imapPort) || input.imapPort < 1 || input.imapPort > 65_535) throw new Error('Enter a valid IMAP port')
  if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65_535) throw new Error('Enter a valid SMTP port')
  if (!['tls', 'starttls'].includes(input.imapSecurity) || !['tls', 'starttls'].includes(input.smtpSecurity)) throw new Error('Choose TLS or STARTTLS for each mail server')
  if (input.allowInvalidCertificates !== undefined && typeof input.allowInvalidCertificates !== 'boolean') throw new Error('Choose a valid certificate policy')
  if (/[:/\\\s]/.test(input.imapHost) || /[:/\\\s]/.test(input.smtpHost)) throw new Error('Server names must be hostnames or IP addresses, without a protocol or port')
  const localBridge = ['127.0.0.1', 'localhost'].includes(input.imapHost.trim().toLowerCase()) && ['127.0.0.1', 'localhost'].includes(input.smtpHost.trim().toLowerCase())
  if (input.allowInvalidCertificates && (input.provider !== 'proton-bridge' || !localBridge)) throw new Error('Invalid TLS certificates are allowed only for a local Proton Bridge connection')
  return { ...input, email, username: input.username.trim(), imapHost: input.imapHost.trim(), smtpHost: input.smtpHost.trim() }
}
