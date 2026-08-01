import type {
  ApplyMailActionInput,
  GmailAccountSummary,
  GmailDraftInput,
  GmailDraftRecord,
  GmailDraftAttachmentFile,
  GmailLabel,
  GmailThreadDetail,
  GmailWorkerEvent,
  ImapAccountInput,
  MailPage,
  MailAccountSettingsInput,
  MailQuery,
  MailRecipientSuggestion,
  MailStorageStats,
  MailDiagnosticHealth,
  PendingOperation,
  SyncProgress
} from '../src/gmail-types'

export type MailWorkerCommand =
  | { type: 'initialize'; payload: { databasePath: string; contentPath: string } }
  | { type: 'accounts:list' }
  | { type: 'accounts:upsert'; payload: GmailAccountSummary }
  | { type: 'accounts:verify'; payload: { accountId: string } }
  | { type: 'accounts:update'; payload: MailAccountSettingsInput }
  | { type: 'accounts:disconnect'; payload: { accountId: string; mode: 'archive' | 'delete' } }
  | { type: 'labels:list'; payload: { accountIds?: string[] } }
  | { type: 'recipients:suggest'; payload: { query: string; accountIds?: string[] } }
  | { type: 'mail:list'; payload: MailQuery }
  | { type: 'mail:thread'; payload: { accountId: string; threadId: string; allowRemoteImages?: boolean } }
  | { type: 'mail:action'; payload: ApplyMailActionInput }
  | { type: 'mail:undo'; payload: { operationId: string } }
  | { type: 'drafts:save'; payload: GmailDraftInput }
  | { type: 'drafts:send'; payload: GmailDraftInput }
  | { type: 'drafts:list'; payload: { accountIds?: string[] } }
  | { type: 'drafts:get'; payload: { id: string } }
  | { type: 'drafts:delete'; payload: { id: string } }
  | { type: 'drafts:stage-message-attachments'; payload: { draftId: string; accountId: string; messageId: string } }
  | { type: 'sync:start'; payload: { accountId?: string } }
  | { type: 'sync:pause'; payload: { accountId: string } }
  | { type: 'sync:resume'; payload: { accountId: string } }
  | { type: 'sync:rebuild'; payload: { accountId: string } }
  | { type: 'sync:progress' }
  | { type: 'storage:stats' }
  | { type: 'diagnostics:health' }
  | { type: 'attachment:extract'; payload: { accountId: string; messageId: string; attachmentId: string; targetPath: string } }
  | { type: 'network'; payload: { online: boolean } }
  | { type: 'polling'; payload: { intervalMs: number } }
  | { type: 'shutdown' }

export type MailWorkerResult =
  | void
  | boolean
  | GmailAccountSummary
  | GmailAccountSummary[]
  | GmailLabel[]
  | MailRecipientSuggestion[]
  | GmailThreadDetail
  | MailPage
  | PendingOperation
  | SyncProgress[]
  | MailStorageStats
  | MailDiagnosticHealth
  | import('../src/gmail-types').GmailDraftResult
  | GmailDraftRecord
  | GmailDraftRecord[]
  | GmailDraftAttachmentFile[]

export interface WorkerRequest {
  kind: 'request'
  id: string
  command: MailWorkerCommand
}

export interface WorkerResponse {
  kind: 'response'
  id: string
  result?: MailWorkerResult
  error?: { code: string; message: string }
}

export type AccountCredential =
  | { type: 'oauth'; accessToken: string }
  | { type: 'imap'; config: ImapAccountInput }

export interface WorkerCredentialRequest {
  kind: 'credential-request'
  id: string
  accountId: string
}

export interface WorkerCredentialResponse {
  kind: 'credential-response'
  id: string
  credential?: AccountCredential
  error?: string
}

export interface WorkerEventMessage {
  kind: 'event'
  event: GmailWorkerEvent
}
