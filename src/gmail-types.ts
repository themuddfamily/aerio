export type GmailAccountStatus = 'connecting' | 'syncing' | 'ready' | 'paused' | 'needs-auth' | 'archived' | 'error'
export type GmailSyncPhase = 'idle' | 'inventory' | 'downloading' | 'catch-up' | 'incremental' | 'paused' | 'complete' | 'error'
export type MailActionKind = 'archive' | 'unarchive' | 'read' | 'unread' | 'star' | 'unstar' | 'important' | 'unimportant' | 'trash' | 'untrash' | 'label' | 'unlabel' | 'move'
export type MailProviderId = 'gmail' | 'microsoft' | 'icloud' | 'yahoo' | 'fastmail' | 'imap' | 'proton-bridge'

export interface ImapAccountInput {
  provider: Exclude<MailProviderId, 'gmail' | 'microsoft'>
  email: string
  displayName?: string
  username: string
  password: string
  imapHost: string
  imapPort: number
  imapSecurity: 'tls' | 'starttls'
  smtpHost: string
  smtpPort: number
  smtpSecurity: 'tls' | 'starttls'
  allowInvalidCertificates?: boolean
}

export interface MailProviderPreset {
  id: MailProviderId
  name: string
  description: string
  auth: 'google-oauth' | 'microsoft-oauth' | 'app-password' | 'password' | 'bridge'
  imapHost?: string
  imapPort?: number
  imapSecurity?: 'tls' | 'starttls'
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: 'tls' | 'starttls'
  usernameHint?: string
  passwordHint?: string
}

export interface GmailCredentialStatus {
  configured: boolean
  clientIdHint?: string
  source?: 'built-in' | 'user'
}

export interface GmailAccountSummary {
  id: string
  provider: MailProviderId
  email: string
  displayName: string
  avatarUrl?: string
  color: string
  status: GmailAccountStatus
  archived: boolean
  lastSyncAt?: string
  error?: string
  signature: string
  notifications: boolean
  syncEnabled: boolean
}

export interface ImapServerSettings {
  username: string
  imapHost: string
  imapPort: number
  imapSecurity: 'tls' | 'starttls'
  smtpHost: string
  smtpPort: number
  smtpSecurity: 'tls' | 'starttls'
  allowInvalidCertificates: boolean
  passwordConfigured: boolean
}

export interface ImapServerSettingsUpdate extends Omit<ImapServerSettings, 'passwordConfigured'> {
  password?: string
}

export interface SyncProgress {
  accountId: string
  phase: GmailSyncPhase
  completed: number
  total: number
  transferredBytes: number
  estimatedRemainingSeconds?: number
  message?: string
  pausedReason?: 'user' | 'disk' | 'auth' | 'quota' | 'offline'
  updatedAt: string
}

export interface MailThreadSummary {
  accountId: string
  id: string
  subject: string
  participants: string[]
  senderEmail: string
  snippet: string
  lastDate: string
  unread: boolean
  starred: boolean
  important: boolean
  trashed: boolean
  draft: boolean
  hasAttachments: boolean
  messageCount: number
  labelIds: string[]
}

export interface GmailAttachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  contentId?: string
}

export interface GmailMessageDetail {
  accountId: string
  id: string
  threadId: string
  fromName: string
  fromEmail: string
  to: string[]
  cc: string[]
  subject: string
  messageIdHeader?: string
  references?: string[]
  date: string
  text: string
  html: string
  sanitizedHtml: string
  labelIds: string[]
  attachments: GmailAttachment[]
}

export interface GmailThreadDetail {
  accountId: string
  id: string
  subject: string
  messages: GmailMessageDetail[]
}

export interface MailPage {
  items: MailThreadSummary[]
  nextCursor?: string
  total: number
}

export interface MailQuery {
  accountIds?: string[]
  folder?: 'inbox' | 'starred' | 'important' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash' | 'all'
  labelId?: string
  search?: string
  cursor?: string
  pageSize?: number
}

export interface GmailLabel {
  accountId: string
  id: string
  name: string
  type: 'system' | 'user'
  color?: string
}

export interface ApplyMailActionInput {
  accountId: string
  threadIds: string[]
  action: MailActionKind
  labelId?: string
}

export interface PendingOperation {
  id: string
  accountId: string
  kind: MailActionKind
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  undoUntil?: string
  error?: string
}

export interface GmailDraftInput {
  id?: string
  accountId: string
  threadId?: string
  inReplyTo?: string
  references?: string[]
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html?: string
  attachmentPaths: string[]
}

export interface MailRecipientSuggestion {
  accountId: string
  email: string
  name?: string
}

export type GmailDraftStatus = 'local' | 'syncing' | 'synced' | 'queued' | 'sent' | 'failed' | 'discard-queued' | 'discarding' | 'discarded'

export interface GmailDraftResult {
  id: string
  gmailDraftId?: string
  status: GmailDraftStatus
  updatedAt: string
  error?: string
}

export interface MailAccountSettingsInput {
  accountId: string
  displayName: string
  color: string
  signature: string
  notifications: boolean
  syncEnabled: boolean
}

export interface GmailDraftRecord extends Omit<GmailDraftInput, 'id'>, GmailDraftResult {}

export interface GmailDraftAttachmentFile {
  name: string
  size: number
  path: string
}

export interface MailStorageStats {
  totalBytes: number
  freeBytes: number
  accounts: { accountId: string; bytes: number; messages: number }[]
}

export interface MailDiagnosticHealth {
  generatedAt: string
  integrity: 'ok' | 'error'
  integrityMessage: string
  accounts: Array<{
    accountId: string
    provider: MailProviderId
    status: GmailAccountStatus
    messages: number
    threads: number
    pendingDownloads: number
    failedDownloads: number
    queuedOperations: number
    failedOperations: number
    editableDrafts: number
    failedDrafts: number
  }>
  orphanedMessages: number
  orphanedAttachments: number
  missingRawFiles: number
}

export interface GmailDesktopApi {
  credentials: {
    status(): Promise<GmailCredentialStatus>
    import(): Promise<GmailCredentialStatus>
    microsoftStatus(): Promise<GmailCredentialStatus>
    configureMicrosoft(clientId: string): Promise<GmailCredentialStatus>
  }
  presets(): Promise<MailProviderPreset[]>
  accounts: {
    list(): Promise<GmailAccountSummary[]>
    connect(): Promise<GmailAccountSummary>
    connectMicrosoft(): Promise<GmailAccountSummary>
    connectImap(input: ImapAccountInput): Promise<GmailAccountSummary>
    update(input: MailAccountSettingsInput): Promise<GmailAccountSummary>
    verify(accountId: string): Promise<void>
    reconnect(accountId: string): Promise<void>
    imapSettings(accountId: string): Promise<ImapServerSettings>
    updateImap(accountId: string, input: ImapServerSettingsUpdate): Promise<ImapServerSettings>
    disconnect(accountId: string, mode: 'archive' | 'delete'): Promise<void>
  }
  mail: {
    labels(accountIds?: string[]): Promise<GmailLabel[]>
    suggestRecipients(query: string, accountIds?: string[]): Promise<MailRecipientSuggestion[]>
    list(query: MailQuery): Promise<MailPage>
    thread(accountId: string, threadId: string, allowRemoteImages?: boolean): Promise<GmailThreadDetail>
    action(input: ApplyMailActionInput): Promise<PendingOperation>
    undo(operationId: string): Promise<boolean>
  }
  drafts: {
    list(accountIds?: string[]): Promise<GmailDraftRecord[]>
    get(id: string): Promise<GmailDraftRecord | undefined>
    save(input: GmailDraftInput): Promise<GmailDraftResult>
    send(input: GmailDraftInput): Promise<GmailDraftResult>
    delete(id: string): Promise<GmailDraftResult>
    stageMessageAttachments(draftId: string, accountId: string, messageId: string): Promise<GmailDraftAttachmentFile[]>
  }
  sync: {
    start(accountId?: string): Promise<void>
    pause(accountId: string): Promise<void>
    resume(accountId: string): Promise<void>
    rebuild(accountId: string): Promise<void>
    progress(): Promise<SyncProgress[]>
  }
  attachments: {
    open(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<{ error?: string }>
    save(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<{ savedPath?: string; error?: string }>
  }
  storage(): Promise<MailStorageStats>
  diagnostics: {
    health(): Promise<MailDiagnosticHealth>
    export(): Promise<{ savedPath?: string }>
  }
  onEvent(callback: (event: GmailWorkerEvent) => void): () => void
}

export type MailDesktopApi = GmailDesktopApi
export type MailAccountSummary = GmailAccountSummary
export type MailCredentialStatus = GmailCredentialStatus
export type MailAttachment = GmailAttachment
export type MailMessageDetail = GmailMessageDetail
export type MailThreadDetail = GmailThreadDetail
export type MailLabel = GmailLabel
export type MailDraftInput = GmailDraftInput
export type MailDraftResult = GmailDraftResult
export type MailDraftRecord = GmailDraftRecord
export type MailWorkerEvent = GmailWorkerEvent

export type GmailWorkerEvent =
  | { type: 'sync-progress'; payload: SyncProgress }
  | { type: 'accounts-changed'; payload: GmailAccountSummary[] }
  | { type: 'mail-changed'; payload: { accountId: string; threadIds?: string[] } }
  | { type: 'operation'; payload: PendingOperation }
  | { type: 'connectivity'; payload: { online: boolean } }
  | { type: 'new-mail'; payload: { accountId: string; count: number; threadId?: string; subject?: string; sender?: string } }
