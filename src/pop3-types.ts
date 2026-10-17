// POP3 accounts (E38): mail is downloaded over POP3 into folders that Aerio
// manages locally, and sent through the existing SMTP Outbox.

/**
 * `tls` connects with implicit TLS (usually port 995), `starttls` upgrades a
 * plain connection with STLS (usually port 110), and `none` sends everything,
 * including the password, unencrypted. `none` also needs `allowPlaintext`.
 */
export type Pop3Security = 'tls' | 'starttls' | 'none'

/** `auto` picks the strongest method the server advertises. */
export type Pop3AuthMethod = 'auto' | 'user' | 'apop' | 'plain'

/**
 * What happens to a message on the POP3 server after Aerio has stored it.
 * Nothing is ever removed from the server before the downloaded copy is
 * committed to Aerio's mail store.
 */
export interface Pop3RetentionPolicy {
  /** False removes each message from the server once it is stored in Aerio. */
  leaveOnServer: boolean
  /** With `leaveOnServer`, remove messages this many days after they were downloaded. */
  deleteAfterDays?: number
  /** Remove a message from the server when it is moved to Trash in Aerio, or no longer exists in Aerio. */
  removeWhenDeleted: boolean
}

export const DEFAULT_POP3_RETENTION: Pop3RetentionPolicy = { leaveOnServer: true, removeWhenDeleted: false }

/**
 * Where downloaded mail is stored: the account's own folder tree (Inbox,
 * Sent, Drafts and Trash, kept by Aerio) or an existing Local Folders folder.
 */
export type Pop3Destination = { kind: 'account' } | { kind: 'local-folder'; labelId: string }

export interface Pop3ServerSettings {
  username: string
  pop3Host: string
  pop3Port: number
  pop3Security: Pop3Security
  /** Required to use `pop3Security: 'none'`; never assumed. */
  allowPlaintext?: boolean
  auth?: Pop3AuthMethod
  smtpHost: string
  smtpPort: number
  smtpSecurity: 'tls' | 'starttls'
}

export interface Pop3AccountInput extends Pop3ServerSettings {
  email: string
  displayName?: string
  password: string
  retention: Pop3RetentionPolicy
  destination: Pop3Destination
}

/** What the vault keeps for a POP3 account: the connection details and password. */
export interface Pop3ConnectionConfig extends Pop3ServerSettings {
  email: string
  password: string
}

export interface Pop3AccountSettings extends Pop3ServerSettings {
  retention: Pop3RetentionPolicy
  destination: Pop3Destination
  passwordConfigured: boolean
}

export interface Pop3AccountSettingsUpdate extends Pop3ServerSettings {
  /** Leave empty to keep the saved password. */
  password?: string
  retention: Pop3RetentionPolicy
  destination: Pop3Destination
}

export interface Pop3ConnectionTestResult {
  /** Capabilities from CAPA; empty when the server does not support CAPA. */
  capabilities: string[]
  authMethod: Exclude<Pop3AuthMethod, 'auto'>
  encrypted: boolean
  messages: number
  bytes: number
  smtpVerified: boolean
}

export interface Pop3AccountStatus {
  accountId: string
  /** Messages Aerio has downloaded and still tracks by UIDL. */
  downloaded: number
  /** Downloaded messages the server still lists. */
  onServer: number
  /** Messages selected for removal that the server has not confirmed yet. */
  pendingRemoval: number
  removedFromServer: number
  /** Messages skipped because they exceed the size limit. */
  skipped: number
  lastCheckAt?: string
  lastError?: string
}

export interface Pop3Api {
  /** Connects, authenticates and checks SMTP without saving anything. */
  test(input: Pop3AccountInput): Promise<Pop3ConnectionTestResult>
  connect(input: Pop3AccountInput): Promise<import('./mail-types').MailAccountSummary>
  settings(accountId: string): Promise<Pop3AccountSettings>
  update(accountId: string, input: Pop3AccountSettingsUpdate): Promise<Pop3AccountSettings>
  status(accountId: string): Promise<Pop3AccountStatus>
}
