export type MailAccountStatus = 'connecting' | 'syncing' | 'ready' | 'paused' | 'needs-auth' | 'archived' | 'error'
export type MailSyncPhase = 'idle' | 'inventory' | 'downloading' | 'catch-up' | 'incremental' | 'paused' | 'complete' | 'error'
export type MailActionKind = 'archive' | 'unarchive' | 'read' | 'unread' | 'star' | 'unstar' | 'important' | 'unimportant' | 'trash' | 'untrash' | 'label' | 'unlabel' | 'move' | 'pin' | 'unpin'
export type MailProviderId = 'gmail' | 'microsoft' | 'icloud' | 'yahoo' | 'fastmail' | 'imap' | 'proton-bridge' | 'local'

export interface ImapAccountInput {
  provider: Exclude<MailProviderId, 'gmail' | 'microsoft' | 'local'>
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
  /** Local Folders are created from the import dialog, never from account setup. */
  id: Exclude<MailProviderId, 'local'>
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
  /** Local-only pin (never synced to the provider); pinned conversations list first. */
  pinned?: boolean
  pinnedAt?: string
}

/**
 * Outcome of local attachment-content extraction. `pending` means the
 * attachment has not been processed yet; every other state is final until the
 * extractor version changes or the attachment itself changes.
 */
export type MailAttachmentTextStatus =
  | 'pending'
  | 'indexed'
  | 'empty'
  | 'unsupported'
  | 'encrypted'
  | 'too-large'
  | 'timeout'
  | 'memory-limit'
  | 'failed'

export interface MailAttachmentTextIndex {
  status: MailAttachmentTextStatus
  /** The extracted text hit the per-attachment limit, so only the start is searchable. */
  truncated?: boolean
  detail?: string
  indexedAt?: string
}

export interface MailAttachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  contentId?: string
  textIndex?: MailAttachmentTextIndex
}

export type MailAttachmentFileType = 'pdf' | 'calendar' | 'spreadsheet' | 'presentation' | 'document' | 'archive' | 'image' | 'audio' | 'video' | 'other'

/** Filters for the cross-account attachments workspace. Dates are inclusive YYYY-MM-DD bounds. */
export interface MailAttachmentQuery {
  accountIds?: string[]
  /** Defaults to true: archived accounts keep their offline attachments. */
  includeArchivedAccounts?: boolean
  /** Defaults to false: inline images referenced by Content-ID (logos, signatures) are hidden. */
  includeInline?: boolean
  search?: string
  sender?: string
  recipient?: string
  dateFrom?: string
  dateTo?: string
  fileTypes?: MailAttachmentFileType[]
  minSize?: number
  maxSize?: number
  /** Exact addresses: only messages sent by or to one of them (a contact's communication history). */
  participants?: string[]
  cursor?: string
  pageSize?: number
}

/** Messages exchanged with any of a contact's addresses, newest first, across the chosen accounts. */
export interface MailContactHistoryQuery {
  addresses: string[]
  accountIds?: string[]
  /** Defaults to true; archived accounts are labelled in the results. */
  includeArchivedAccounts?: boolean
  cursor?: string
  pageSize?: number
}

export interface MailContactHistoryItem {
  accountId: string
  accountEmail: string
  accountArchived: boolean
  threadId: string
  messageId: string
  date: string
  fromName: string
  fromEmail: string
  to: string[]
  cc: string[]
  subject: string
  snippet: string
  /** 'from': the contact sent it; 'to': it was sent to the contact (To or Cc). */
  direction: 'from' | 'to'
  attachmentCount: number
}

export interface MailContactHistoryPage {
  items: MailContactHistoryItem[]
  nextCursor?: string
  total: number
}

export interface MailAttachmentListItem {
  accountId: string
  threadId: string
  messageId: string
  attachmentId: string
  filename: string
  mimeType: string
  size: number
  fileType: MailAttachmentFileType
  date: string
  fromName: string
  fromEmail: string
  to: string[]
  cc: string[]
  subject: string
  /** False when the stored original message is missing, so open/save cannot extract it. */
  available: boolean
  accountArchived: boolean
}

export interface MailAttachmentPage {
  items: MailAttachmentListItem[]
  nextCursor?: string
  total: number
}

export interface MailMessageDetail {
  local?: MailMessageLocalData
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
  /** Remote images and suspected trackers found while sanitizing `html`. */
  remoteContent?: MailRemoteContentReport
  labelIds: string[]
  attachments: MailAttachment[]
}

export type MailTrackingReason = 'tiny-dimensions' | 'hidden-style' | 'known-tracker-host' | 'tracking-path'

export interface MailTrackingFinding {
  host: string
  reasons: MailTrackingReason[]
  count: number
}

export interface MailRemoteContentReport {
  /** Remote images in the message, including suspected trackers. */
  remoteImages: number
  /** Suspected trackers stay blocked even after remote images are permitted. */
  trackers: MailTrackingFinding[]
}

export interface MailMessageSource {
  headers: string
  source: string
}

export interface MailMessageLocalData {
  categories: string[]
  format: 'auto' | 'plain' | 'html'
  fontSize: number
  noteIds: string[]
  taskIds: string[]
}

export interface MailMessageRef { accountId: string; threadId: string; messageId: string }

/** One destination from a List-Unsubscribe header (RFC 2369), with RFC 8058 one-click support for HTTPS. */
export interface MailUnsubscribeOption {
  kind: 'https' | 'mailto'
  /** The exact URI from the header; actions are only accepted for URIs that the stored message still advertises. */
  url: string
  /** Host for HTTPS links or the recipient address for mailto links, shown to the user before acting. */
  destination: string
  oneClick: boolean
  mailto?: { to: string[]; subject: string; body: string }
}

export interface MailListUnsubscribeInfo {
  listId?: string
  options: MailUnsubscribeOption[]
  /** Problems found while reading the headers, such as ignored insecure or malformed entries. */
  warnings: string[]
}

export type MailUnsubscribeMethod = 'one-click' | 'browser' | 'mailto'

export interface MailUnsubscribeResult {
  method: MailUnsubscribeMethod
  destination: string
  status: 'unsubscribed' | 'opened' | 'queued'
}

export interface MessageToolsApi {
  /** Reads list-unsubscribe metadata only; it never contacts the list. */
  unsubscribeInfo(ref: MailMessageRef): Promise<MailListUnsubscribeInfo>
  unsubscribe(ref: MailMessageRef, request: { url: string; method: MailUnsubscribeMethod }): Promise<MailUnsubscribeResult>
  updateLocal(ref: MailMessageRef, updates: Partial<Pick<MailMessageLocalData, 'categories' | 'format' | 'fontSize'>>): Promise<MailMessageLocalData>
  save(ref: MailMessageRef): Promise<{ savedPath?: string }>
  saveAttachments(ref: MailMessageRef): Promise<{ savedPath?: string; count: number }>
  copy(ref: MailMessageRef, destination: string): Promise<void>
  print(ref: MailMessageRef, format: MailMessageLocalData['format']): Promise<void>
  createTask(ref: MailMessageRef, input: { title: string; notes: string; due?: string }): Promise<void>
  addNote(ref: MailMessageRef, input: { title: string; content: string }): Promise<void>
  notes(ref: MailMessageRef): Promise<import('./types').Note[]>
  translate(ref: MailMessageRef, input: { endpoint: string; apiKey?: string; target: string; source: string }): Promise<string>
}

/** Who outside the account's organization (or contacts) receives an automatic reply. */
export type MailAutomaticReplyAudience = 'none' | 'contacts' | 'all'

export interface MailAutomaticReplySettings {
  enabled: boolean
  /** ISO 8601 UTC instants. Omitted when the reply has no scheduled boundary. */
  startAt?: string
  endAt?: string
  /** Gmail only; Microsoft replies have no separate subject. */
  subject: string
  /** Plain text. Gmail sends this to everyone it replies to. */
  internalMessage: string
  /** Plain text for people outside the organization (Microsoft only). */
  externalMessage: string
  externalAudience: MailAutomaticReplyAudience
}

export interface MailAutomaticReplyCapabilities {
  subject: boolean
  separateExternalMessage: boolean
  audiences: MailAutomaticReplyAudience[]
  /** Microsoft schedules need both a start and an end; Gmail accepts either boundary alone. */
  requiresBothDates: boolean
}

export type MailAutomaticReplyPhase = 'off' | 'active' | 'scheduled' | 'ended'

export interface MailAutomaticRepliesState {
  accountId: string
  provider: MailProviderId
  /** False for accounts whose protocol has no provider-side automatic reply API, such as IMAP. */
  supported: boolean
  /** Explains an unsupported account or a missing permission. */
  message?: string
  canRead: boolean
  canWrite: boolean
  /** True when signing in again would grant the missing provider permission. */
  needsReconnect: boolean
  missingScopes: string[]
  settings?: MailAutomaticReplySettings
  capabilities?: MailAutomaticReplyCapabilities
  phase?: MailAutomaticReplyPhase
  /** Mailbox time zone reported by the provider, when it has one. */
  serverTimeZone?: string
  warnings: string[]
  readAt?: string
}

export interface MailAutomaticRepliesApi {
  /** Reads the active configuration from the provider; nothing is cached locally. */
  get(accountId: string): Promise<MailAutomaticRepliesState>
  /** Writes the configuration to the provider and returns what the provider reports back. */
  update(accountId: string, settings: MailAutomaticReplySettings): Promise<MailAutomaticRepliesState>
  /** Turns replies off on the provider while keeping the saved message text. */
  disable(accountId: string): Promise<MailAutomaticRepliesState>
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

/** A named search scoped to an account (or all accounts), mailbox, and optional label. */
export interface MailSavedSearchInput {
  id?: string
  name: string
  query: string
  accountId?: string
  folder: MailFolder
  labelId?: string
  filters: MailSearchFilters
}

export interface MailSavedSearch extends MailSavedSearchInput {
  id: string
  createdAt: string
  updatedAt: string
}

export type MailFolderUnreadCounts = Record<MailFolder, number>
export type MailAccountUnreadCounts = Record<string, number>

export interface MailLabel {
  accountId: string
  id: string
  name: string
  type: 'system' | 'user'
  color?: string
  parentId?: string
}

export interface MailFolderCapabilities {
  kind: 'label' | 'folder'
  canCreate: boolean
  canRename: boolean
  canDelete: boolean
  canNest: boolean
  canColor: boolean
  /** True when the provider keeps messages after the folder/label is removed. */
  deleteKeepsMessages: boolean
}

export interface CreateMailFolderInput {
  accountId: string
  name: string
  parentId?: string
  color?: string
}

export interface UpdateMailFolderInput {
  accountId: string
  labelId: string
  name?: string
  /** null moves the folder to the top level. */
  parentId?: string | null
  color?: string
}

export interface DeleteMailFolderInput {
  accountId: string
  labelId: string
  /** Required when the folder still contains messages. */
  confirmNonEmpty?: boolean
}

export interface MailFolderDeletePreview {
  labelId: string
  messages: number
  threads: number
  childFolders: number
  pendingOperations: number
  deleteKeepsMessages: boolean
  /** Where messages go when the provider would otherwise remove them. */
  messagesMoveTo?: string
}

export interface MailFolderMutationResult {
  label?: MailLabel
  labels: MailLabel[]
  /** Old label id to new label id, for providers whose ids follow the folder path. */
  renamed: Record<string, string>
  deletedId?: string
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
  expectedRemoteRevision?: string
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
  /** Sender identity (alias) id; omitted means the account's primary address. */
  fromIdentityId?: string
  replyTo?: string[]
  sendOptions?: MailSendOptions
  /** OpenPGP Sign/Encrypt choice; delivery aborts rather than sending plaintext when it cannot be honored. */
  openPgp?: import('./openpgp-types').MailOpenPgpOptions
  /** S/MIME Sign/Encrypt choice; never combined with OpenPGP, and delivery never falls back to plaintext. */
  smime?: import('./smime-types').MailSmimeOptions
}

export type MailImportance = 'low' | 'normal' | 'high'

// Outgoing importance and receipt requests. Receipts are requests only: the
// recipient's client or server decides whether one is ever returned.
export interface MailSendOptions {
  importance?: MailImportance
  requestReadReceipt?: boolean
  requestDeliveryReceipt?: boolean
}

export type MailReadReceiptPolicy = 'never' | 'ask' | 'always'

export type MailReceiptRequestStatus = 'pending' | 'sent' | 'declined' | 'failed' | 'suppressed'

export interface MailReceiptRequestInfo {
  notifyTo: string
  status: MailReceiptRequestStatus
  policy: MailReadReceiptPolicy
  automatic?: boolean
  respondedAt?: string
  // Why an automatic receipt was held back for the user to decide.
  reason?: string
  error?: string
}

export interface MailReceiptReportInfo {
  kind: 'read' | 'delivery'
  reporter?: string
  originalMessageId?: string
  originalSubject?: string
  originalSentAt?: string
  disposition?: string
  recipients: { recipient: string; action?: string; status?: string }[]
}

export interface MailReceiptInfo {
  request?: MailReceiptRequestInfo
  report?: MailReceiptReportInfo
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
  remoteRevision?: string
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

export type MailReplyWatchStatus = 'pending' | 'watching' | 'replied' | 'expired' | 'cancelled'

export interface MailReplyWatch {
  id: string
  accountId: string
  draftId?: string
  messageIdHeader?: string
  threadId?: string
  subject: string
  recipients: string[]
  deadlineAt?: string
  status: MailReplyWatchStatus
  createdAt: string
  sentAt?: string
  resolvedAt?: string
  replyMessageId?: string
  replyThreadId?: string
  replyFrom?: string
}

/** Watches an outgoing draft (activated when delivered) or an already sent message. */
export interface MailReplyWatchInput {
  accountId: string
  draftId?: string
  messageId?: string
  deadlineAt?: string
}

// Text fields compare with contains/equals/starts-with/ends-with; the others
// use 'is' (has-attachment yes|no, importance high|normal|low, label <labelId>)
// or greater-than/less-than (size in KB, age in days).
export type MailRuleConditionField = 'from' | 'to' | 'cc' | 'subject' | 'body' | 'header' | 'has-attachment' | 'size' | 'age' | 'importance' | 'label'
export type MailRuleConditionOperator = 'contains' | 'equals' | 'starts-with' | 'ends-with' | 'is' | 'greater-than' | 'less-than'

export interface MailRuleCondition {
  field: MailRuleConditionField
  operator: MailRuleConditionOperator
  value: string
  /** Header name for field 'header', e.g. List-Id. */
  headerName?: string
}

/** incoming: newly received mail; outgoing: newly synced Sent mail. */
export type MailRuleTrigger = 'incoming' | 'outgoing'
/** local: Aerio applies the rule; server: the provider runs its copy and Aerio skips it. */
export type MailRuleExecution = 'local' | 'server'

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
  /** "Except if" clauses: the rule is skipped when any exception matches. */
  exceptions?: MailRuleCondition[]
  trigger?: MailRuleTrigger
  execution?: MailRuleExecution
  /** Provider filter/rule id once the rule is uploaded to the server. */
  serverRuleId?: string
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

/** One step of a user-defined Quick Action; label, unlabel, and move steps need an account-specific destination. */
export interface MailQuickActionStep {
  action: MailActionKind
  labelId?: string
}

/** A named, ordered sequence of mail actions. Destinations require the action to be scoped to one account. */
export interface MailQuickActionInput {
  id?: string
  name: string
  accountId?: string
  steps: MailQuickActionStep[]
  /** Keyboard slot 1-9, bound to Ctrl/Cmd+Shift+number. */
  shortcut?: number
  showInToolbar: boolean
}

export interface MailQuickAction extends MailQuickActionInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface MailQuickActionTarget {
  accountId: string
  threadIds: string[]
}

export interface MailQuickActionRunFailure {
  accountId: string
  threadCount: number
  /** Zero-based step that failed; absent when the whole account group was rejected before any step ran. */
  step?: number
  appliedSteps: number
  error: string
}

export interface MailQuickActionRunResult {
  operations: PendingOperation[]
  updatedThreads: number
  failures: MailQuickActionRunFailure[]
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
  messageTools: MessageToolsApi
  automaticReplies: MailAutomaticRepliesApi
  cloudAttachments: import('./cloud-attachment-types').CloudAttachmentsApi
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
    list(query: MailAttachmentQuery): Promise<MailAttachmentPage>
    open(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<{ error?: string }>
    save(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<{ savedPath?: string; error?: string }>
  }
  contactHistory?: {
    messages(query: MailContactHistoryQuery): Promise<MailContactHistoryPage>
  }
  storage(): Promise<MailStorageStats>
  diagnostics: {
    health(): Promise<MailDiagnosticHealth>
    export(): Promise<{ savedPath?: string }>
  }
  templates: import('./mail-template-types').MailTemplatesApi
  identities: import('./mail-identity-types').MailIdentitiesApi
  folders: {
    create(input: CreateMailFolderInput): Promise<MailFolderMutationResult>
    update(input: UpdateMailFolderInput): Promise<MailFolderMutationResult>
    delete(input: DeleteMailFolderInput): Promise<MailFolderMutationResult>
    deletePreview(accountId: string, labelId: string): Promise<MailFolderDeletePreview>
  }
  rules: {
    list(accountIds?: string[]): Promise<MailRule[]>
    save(input: MailRuleInput): Promise<MailRule>
    delete(id: string): Promise<void>
    run(id: string): Promise<MailRuleRunResult>
  }
  serverRules?: import('./mail-server-rule-types').MailServerRulesApi
  merge?: import('./mail-merge-types').MailMergeApi
  /** Automatic archiving into Local Folders (E31); optional so test doubles stay valid. */
  archiving?: import('./mail-archive-types').MailArchivingApi
  savedSearches: {
    list(): Promise<MailSavedSearch[]>
    save(input: MailSavedSearchInput): Promise<MailSavedSearch>
    delete(id: string): Promise<void>
  }
  receipts?: {
    inspect(accountId: string, messageId: string): Promise<MailReceiptInfo>
    respond(accountId: string, messageId: string, decision: 'send' | 'decline'): Promise<MailReceiptInfo>
  }
  replyWatches: {
    list(accountIds?: string[]): Promise<MailReplyWatch[]>
    create(input: MailReplyWatchInput): Promise<MailReplyWatch>
    cancel(id: string): Promise<boolean>
  }
  quickActions: {
    list(): Promise<MailQuickAction[]>
    save(input: MailQuickActionInput): Promise<MailQuickAction>
    delete(id: string): Promise<void>
    run(id: string, targets: MailQuickActionTarget[]): Promise<MailQuickActionRunResult>
  }
  /** Mail import and Local Folders; optional so test doubles of the API stay valid. */
  imports?: MailImportApi
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
  | { type: 'mail-merge'; payload: import('./mail-merge-types').MailMergeJobSummary }
  | { type: 'archive-progress'; payload: import('./mail-archive-types').MailArchiveJob }
  | { type: 'reply-watch'; payload: { watch: MailReplyWatch; reason: 'replied' | 'expired' } }
  | { type: 'import-progress'; payload: MailImportJob }

export type MailImportStatus = 'queued' | 'running' | 'paused' | 'interrupted' | 'cancelled' | 'completed' | 'failed'
export type MailImportDuplicatePolicy = 'review' | 'import'
export type MailboxVariant = 'mboxrd' | 'mboxo'

export interface MailImportStartInput {
  paths: string[]
  /** Existing Local Folders folder that receives the imported hierarchy; top level when omitted. */
  parentLabelId?: string
  duplicates: MailImportDuplicatePolicy
  mboxVariant: MailboxVariant
}

export interface MailImportJob {
  id: string
  accountId: string
  status: MailImportStatus
  /** Short description of what is imported, such as the chosen file or folder name. */
  label: string
  sources: number
  imported: number
  duplicates: number
  failed: number
  skipped: number
  /** Held duplicates still waiting for a decision. */
  pendingReview: number
  processedBytes: number
  totalBytes: number
  currentSource?: string
  error?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export type MailImportItemStatus = 'duplicate' | 'failed' | 'skipped' | 'imported' | 'discarded'

export interface MailImportItem {
  key: string
  jobId: string
  status: MailImportItemStatus
  reason: string
  source: string
  subject: string
  from: string
  date?: string
  size: number
  messageIdHeader?: string
  /** The Local Folders message this one duplicates. */
  duplicateOf?: { messageId: string; subject: string }
}

export interface MailImportChooseResult {
  paths: string[]
  /** Chosen paths Aerio cannot import, with the reason shown to the user. */
  unsupported: { path: string; reason: string }[]
}

export interface MailLocalTransferInput {
  sourceAccountId: string
  threadIds: string[]
  destinationLabelId: string
  mode: 'copy' | 'move'
}

export interface MailLocalTransferResult {
  copied: number
  /** Messages already present in the destination folder. */
  skipped: number
  /** Messages whose original was not downloaded, so there was nothing to copy. */
  missing: number
  trashOperation?: PendingOperation
}

export interface MailImportApi {
  ensureLocalFolders(): Promise<MailAccountSummary>
  choose(kind: 'files' | 'folder'): Promise<MailImportChooseResult>
  start(input: MailImportStartInput): Promise<MailImportJob>
  list(): Promise<MailImportJob[]>
  pause(id: string): Promise<MailImportJob>
  resume(id: string): Promise<MailImportJob>
  cancel(id: string): Promise<MailImportJob>
  dismiss(id: string): Promise<void>
  items(jobId: string): Promise<MailImportItem[]>
  resolve(jobId: string, keys: string[], decision: 'import' | 'discard'): Promise<MailImportJob>
  transfer(input: MailLocalTransferInput): Promise<MailLocalTransferResult>
}
