export type MailAccountStatus = 'connecting' | 'syncing' | 'ready' | 'paused' | 'needs-auth' | 'archived' | 'error'
export type MailSyncPhase = 'idle' | 'inventory' | 'downloading' | 'catch-up' | 'incremental' | 'paused' | 'complete' | 'error'
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

export interface MailCredentialStatus {
  configured: boolean
  clientIdHint?: string
  source?: 'built-in' | 'user'
}

export interface MailAccountSummary {
  id: string
  provider: MailProviderId
  email: string
  displayName: string
  avatarUrl?: string
  color: string
  status: MailAccountStatus
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
  phase: MailSyncPhase
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
  snoozedUntil?: string
}

export interface MailAttachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  contentId?: string
}

export interface MailMessageDetail {
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
  attachments: MailAttachment[]
}

export interface MailMessageSource {
  headers: string
  source: string
}

export interface MailThreadDetail {
  accountId: string
  id: string
  subject: string
  messages: MailMessageDetail[]
}

export interface MailPage {
  items: MailThreadSummary[]
  nextCursor?: string
  total: number
}

export interface MailSearchFilters {
  from?: string
  to?: string
  subject?: string
  attachmentName?: string
  dateFrom?: string
  dateTo?: string
  hasAttachments?: boolean
  unread?: boolean
  starred?: boolean
  important?: boolean
}

export type MailFolder = 'inbox' | 'starred' | 'important' | 'sent' | 'drafts' | 'scheduled' | 'snoozed' | 'archive' | 'spam' | 'trash' | 'all'

export interface MailQuery {
  accountIds?: string[]
  folder?: MailFolder
  labelId?: string
  search?: string
  filters?: MailSearchFilters
  cursor?: string
  pageSize?: number
}

export type MailFolderUnreadCounts = Record<MailFolder, number>
export type MailAccountUnreadCounts = Record<string, number>

export interface MailLabel {
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

export interface MailDraftInput {
  id?: string
  expectedUpdatedAt?: string
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

export type MailDraftStatus = 'local' | 'syncing' | 'synced' | 'send-pending' | 'scheduled' | 'queued' | 'sent' | 'failed' | 'discard-queued' | 'discarding' | 'discarded'

export interface MailDraftResult {
  id: string
  remoteDraftId?: string
  status: MailDraftStatus
  updatedAt: string
  deliveryAt?: string
  undoUntil?: string
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

export interface MailDraftRecord extends Omit<MailDraftInput, 'id'>, MailDraftResult {}

export interface MailDraftAttachmentFile {
  name: string
  size: number
  path: string
}

export interface MailSnooze {
  accountId: string
  threadId: string
  snoozedUntil: string
}

export type MailRuleConditionField = 'from' | 'to' | 'subject' | 'body'
export type MailRuleConditionOperator = 'contains' | 'equals' | 'starts-with' | 'ends-with'

export interface MailRuleCondition {
  field: MailRuleConditionField
  operator: MailRuleConditionOperator
  value: string
}

export interface MailRuleAction {
  action: Extract<MailActionKind, 'archive' | 'read' | 'star' | 'important' | 'trash' | 'label' | 'move'>
  labelId?: string
}

export interface MailRuleInput {
  id?: string
  accountId: string
  name: string
  enabled: boolean
  match: 'all' | 'any'
  conditions: MailRuleCondition[]
  actions: MailRuleAction[]
}

export interface MailRule extends Omit<MailRuleInput, 'id'> {
  id: string
  createdAt: string
  updatedAt: string
  lastMatchedAt?: string
  matchCount: number
}

export interface MailRuleRunResult {
  matched: number
  operations: number
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
    status: MailAccountStatus
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

export interface MailDesktopApi {
  credentials: {
    status(): Promise<MailCredentialStatus>
    import(): Promise<MailCredentialStatus>
    microsoftStatus(): Promise<MailCredentialStatus>
    configureMicrosoft(clientId: string): Promise<MailCredentialStatus>
  }
  presets(): Promise<MailProviderPreset[]>
  accounts: {
    list(): Promise<MailAccountSummary[]>
    connect(): Promise<MailAccountSummary>
    connectMicrosoft(): Promise<MailAccountSummary>
    connectImap(input: ImapAccountInput): Promise<MailAccountSummary>
    update(input: MailAccountSettingsInput): Promise<MailAccountSummary>
    verify(accountId: string): Promise<void>
    reconnect(accountId: string): Promise<void>
    imapSettings(accountId: string): Promise<ImapServerSettings>
    updateImap(accountId: string, input: ImapServerSettingsUpdate): Promise<ImapServerSettings>
    disconnect(accountId: string, mode: 'archive' | 'delete'): Promise<void>
  }
  mail: {
    labels(accountIds?: string[]): Promise<MailLabel[]>
    suggestRecipients(query: string, accountIds?: string[]): Promise<MailRecipientSuggestion[]>
    list(query: MailQuery): Promise<MailPage>
    unreadCounts(accountIds?: string[]): Promise<MailFolderUnreadCounts>
    accountUnreadCounts(): Promise<MailAccountUnreadCounts>
    thread(accountId: string, threadId: string, allowRemoteImages?: boolean): Promise<MailThreadDetail>
    source(accountId: string, messageId: string): Promise<MailMessageSource>
    action(input: ApplyMailActionInput): Promise<PendingOperation>
    undo(operationId: string): Promise<boolean>
    snooze(accountId: string, threadIds: string[], until: string): Promise<MailSnooze[]>
    unsnooze(accountId: string, threadIds: string[]): Promise<boolean>
  }
  drafts: {
    list(accountIds?: string[]): Promise<MailDraftRecord[]>
    get(id: string): Promise<MailDraftRecord | undefined>
    save(input: MailDraftInput): Promise<MailDraftResult>
    send(input: MailDraftInput): Promise<MailDraftResult>
    schedule(input: MailDraftInput, deliveryAt: string): Promise<MailDraftResult>
    cancelSend(id: string): Promise<MailDraftResult>
    delete(id: string): Promise<MailDraftResult>
    stageMessageAttachments(draftId: string, accountId: string, messageId: string): Promise<MailDraftAttachmentFile[]>
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
  rules: {
    list(accountIds?: string[]): Promise<MailRule[]>
    save(input: MailRuleInput): Promise<MailRule>
    delete(id: string): Promise<void>
    run(id: string): Promise<MailRuleRunResult>
  }
  onEvent(callback: (event: MailWorkerEvent) => void): () => void
}

export type MailWorkerEvent =
  | { type: 'sync-progress'; payload: SyncProgress }
  | { type: 'accounts-changed'; payload: MailAccountSummary[] }
  | { type: 'mail-changed'; payload: { accountId: string; threadIds?: string[] } }
  | { type: 'operation'; payload: PendingOperation }
  | { type: 'connectivity'; payload: { online: boolean } }
  | { type: 'new-mail'; payload: { accountId: string; count: number; threadId?: string; subject?: string; sender?: string } }
  | { type: 'draft-delivery'; payload: MailDraftResult }
