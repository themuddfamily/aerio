export type GmailAccountStatus = 'connecting' | 'syncing' | 'ready' | 'paused' | 'needs-auth' | 'archived' | 'error'
export type GmailSyncPhase = 'idle' | 'inventory' | 'downloading' | 'catch-up' | 'incremental' | 'paused' | 'complete' | 'error'
export type MailActionKind = 'archive' | 'unarchive' | 'read' | 'unread' | 'star' | 'unstar' | 'important' | 'unimportant' | 'trash' | 'untrash' | 'label' | 'unlabel'

export interface GmailCredentialStatus {
  configured: boolean
  clientIdHint?: string
}

export interface GmailAccountSummary {
  id: string
  email: string
  displayName: string
  avatarUrl?: string
  color: string
  status: GmailAccountStatus
  archived: boolean
  lastSyncAt?: string
  error?: string
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

export interface GmailDraftResult {
  id: string
  gmailDraftId?: string
  status: 'local' | 'syncing' | 'synced' | 'queued' | 'sent' | 'failed'
  updatedAt: string
  error?: string
}

export interface MailStorageStats {
  totalBytes: number
  freeBytes: number
  accounts: { accountId: string; bytes: number; messages: number }[]
}

export interface GmailDesktopApi {
  credentials: {
    status(): Promise<GmailCredentialStatus>
    import(): Promise<GmailCredentialStatus>
  }
  accounts: {
    list(): Promise<GmailAccountSummary[]>
    connect(): Promise<GmailAccountSummary>
    disconnect(accountId: string, mode: 'archive' | 'delete'): Promise<void>
  }
  mail: {
    labels(accountIds?: string[]): Promise<GmailLabel[]>
    list(query: MailQuery): Promise<MailPage>
    thread(accountId: string, threadId: string, allowRemoteImages?: boolean): Promise<GmailThreadDetail>
    action(input: ApplyMailActionInput): Promise<PendingOperation>
    undo(operationId: string): Promise<boolean>
  }
  drafts: {
    save(input: GmailDraftInput): Promise<GmailDraftResult>
    send(input: GmailDraftInput): Promise<GmailDraftResult>
  }
  sync: {
    start(accountId?: string): Promise<void>
    pause(accountId: string): Promise<void>
    resume(accountId: string): Promise<void>
    progress(): Promise<SyncProgress[]>
  }
  attachments: {
    open(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<{ error?: string }>
    save(accountId: string, messageId: string, attachmentId: string, filename: string): Promise<{ savedPath?: string; error?: string }>
  }
  storage(): Promise<MailStorageStats>
  onEvent(callback: (event: GmailWorkerEvent) => void): () => void
}

export type GmailWorkerEvent =
  | { type: 'sync-progress'; payload: SyncProgress }
  | { type: 'accounts-changed'; payload: GmailAccountSummary[] }
  | { type: 'mail-changed'; payload: { accountId: string; threadIds?: string[] } }
  | { type: 'operation'; payload: PendingOperation }
  | { type: 'connectivity'; payload: { online: boolean } }
