import type { ImapAccountInput } from '../../src/mail-types'
import type {
  Pop3AccountInput,
  Pop3AuthMethod,
  Pop3ConnectionConfig,
  Pop3Destination,
  Pop3RetentionPolicy,
  Pop3Security,
  Pop3ServerSettings
} from '../../src/pop3-types'
import type { Pop3ClientOptions } from './pop3-client'

// Validation of untrusted renderer input for POP3 accounts, and conversion
// between the stored settings and the client configurations.

const SECURITY: Pop3Security[] = ['tls', 'starttls', 'none']
const AUTH: Pop3AuthMethod[] = ['auto', 'user', 'apop', 'plain']
export const POP3_MAX_RETENTION_DAYS = 3650

const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const port = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
const host = (value: unknown) => text(value, 253) && !/[:/\\\s]/.test(String(value).trim())

export function validatePop3Retention(value: unknown): Pop3RetentionPolicy {
  const input = value as Partial<Pop3RetentionPolicy> | undefined
  if (!input || typeof input !== 'object' || typeof input.leaveOnServer !== 'boolean' || typeof input.removeWhenDeleted !== 'boolean') throw new Error('Choose what happens to messages on the server')
  if (input.deleteAfterDays !== undefined && input.deleteAfterDays !== null) {
    if (!Number.isInteger(input.deleteAfterDays) || input.deleteAfterDays < 1 || input.deleteAfterDays > POP3_MAX_RETENTION_DAYS) throw new Error(`Enter a number of days between 1 and ${POP3_MAX_RETENTION_DAYS}`)
  }
  return {
    leaveOnServer: input.leaveOnServer,
    removeWhenDeleted: input.leaveOnServer ? input.removeWhenDeleted : false,
    ...(input.leaveOnServer && input.deleteAfterDays ? { deleteAfterDays: input.deleteAfterDays } : {})
  }
}

export function validatePop3Destination(value: unknown): Pop3Destination {
  const input = value as Partial<{ kind: string; labelId: string }> | undefined
  if (input?.kind === 'account') return { kind: 'account' }
  if (input?.kind === 'local-folder' && text(input.labelId, 300) && String(input.labelId).startsWith('folder:')) return { kind: 'local-folder', labelId: String(input.labelId) }
  throw new Error('Choose where downloaded mail is stored')
}

export function validatePop3Server(value: unknown): Pop3ServerSettings {
  const input = value as Partial<Pop3ServerSettings> | undefined
  if (!input || typeof input !== 'object') throw new Error('Complete every required server field')
  if (!text(input.username, 500)) throw new Error('Enter the POP3 username')
  if (!host(input.pop3Host) || !host(input.smtpHost)) throw new Error('Server names must be hostnames or IP addresses, without a protocol or port')
  if (!port(input.pop3Port)) throw new Error('Enter a valid POP3 port')
  if (!port(input.smtpPort)) throw new Error('Enter a valid SMTP port')
  if (!SECURITY.includes(input.pop3Security as Pop3Security)) throw new Error('Choose TLS, STARTTLS or no encryption for the POP3 server')
  if (!['tls', 'starttls'].includes(String(input.smtpSecurity))) throw new Error('Choose TLS or STARTTLS for the SMTP server')
  if (input.allowPlaintext !== undefined && typeof input.allowPlaintext !== 'boolean') throw new Error('Choose a valid encryption policy')
  if (input.pop3Security === 'none' && input.allowPlaintext !== true) throw new Error('Confirm that the password and mail may be sent unencrypted, or choose TLS or STARTTLS')
  if (input.auth !== undefined && !AUTH.includes(input.auth)) throw new Error('Choose a valid sign-in method')
  return {
    username: String(input.username).trim(),
    pop3Host: String(input.pop3Host).trim(),
    pop3Port: Number(input.pop3Port),
    pop3Security: input.pop3Security as Pop3Security,
    ...(input.pop3Security === 'none' ? { allowPlaintext: true } : {}),
    auth: input.auth ?? 'auto',
    smtpHost: String(input.smtpHost).trim(),
    smtpPort: Number(input.smtpPort),
    smtpSecurity: input.smtpSecurity as 'tls' | 'starttls'
  }
}

export function validatePop3Account(value: unknown): Pop3AccountInput {
  const input = value as Partial<Pop3AccountInput> | undefined
  if (!input || typeof input !== 'object') throw new Error('Complete every required account and server field')
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) throw new Error('Enter a valid email address')
  if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length > 200)) throw new Error('Enter a valid display name')
  if (!text(input.password, 1_000)) throw new Error('Enter the password')
  return {
    ...validatePop3Server(input),
    email,
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    password: String(input.password),
    retention: validatePop3Retention(input.retention),
    destination: validatePop3Destination(input.destination)
  }
}

export const serverSettingsOf = (input: Pop3ServerSettings): Pop3ServerSettings => ({
  username: input.username,
  pop3Host: input.pop3Host,
  pop3Port: input.pop3Port,
  pop3Security: input.pop3Security,
  ...(input.allowPlaintext ? { allowPlaintext: true } : {}),
  auth: input.auth ?? 'auto',
  smtpHost: input.smtpHost,
  smtpPort: input.smtpPort,
  smtpSecurity: input.smtpSecurity
})

export const connectionConfigOf = (input: Pop3ServerSettings & { email: string; password: string }): Pop3ConnectionConfig => ({ ...serverSettingsOf(input), email: input.email, password: input.password })

export function pop3ClientOptions(config: Pop3ConnectionConfig, extra: Pick<Pop3ClientOptions, 'tls' | 'timeoutMs'> = {}): Pop3ClientOptions {
  return {
    host: config.pop3Host,
    port: config.pop3Port,
    security: config.pop3Security,
    allowPlaintext: config.allowPlaintext,
    username: config.username,
    password: config.password,
    auth: config.auth,
    ...extra
  }
}

/**
 * The SMTP half of a POP3 account in the shape the existing SMTP sender
 * (ImapSmtpClient.send, the Outbox path) expects. Only sending is used; the
 * IMAP fields are never connected to.
 */
export function pop3SmtpConfig(config: Pop3ConnectionConfig): ImapAccountInput {
  return {
    provider: 'imap',
    email: config.email,
    username: config.username,
    password: config.password,
    imapHost: config.pop3Host,
    imapPort: config.pop3Port,
    imapSecurity: config.pop3Security === 'tls' ? 'tls' : 'starttls',
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecurity: config.smtpSecurity
  }
}
