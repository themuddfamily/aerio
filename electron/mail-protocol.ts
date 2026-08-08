import type {
  ApplyMailActionInput,
  MailAccountSummary,
  MailDraftInput,
  MailDraftRecord,
  MailDraftAttachmentFile,
  MailLabel,
  MailRule,
  MailRuleInput,
  MailRuleRunResult,
  MailSnooze,
  MailMessageSource,
  MailThreadDetail,
  MailWorkerEvent,
  ImapAccountInput,
  MailPage,
  MailFolderUnreadCounts,
  MailAccountUnreadCounts,
  MailAccountSettingsInput,
  MailQuery,
  MailRecipientSuggestion,
  MailStorageStats,
  MailDiagnosticHealth,
  PendingOperation,
  SyncProgress
} from '../src/mail-types'

export type MailWorkerCommand =
  | { type: 'initialize'; payload: { databasePath: string; contentPath: string } }
  | { type: 'accounts:list' }
  | { type: 'accounts:upsert'; payload: MailAccountSummary }
  | { type: 'accounts:verify'; payload: { accountId: string } }
  | { type: 'accounts:update'; payload: MailAccountSettingsInput }
  | { type: 'accounts:disconnect'; payload: { accountId: string; mode: 'archive' | 'delete' } }
  | { type: 'labels:list'; payload: { accountIds?: string[] } }
  | { type: 'recipients:suggest'; payload: { query: string; accountIds?: string[] } }
  | { type: 'mail:list'; payload: MailQuery }
  | { type: 'mail:unread-counts'; payload: { accountIds?: string[] } }
  | { type: 'mail:account-unread-counts' }
  | { type: 'mail:thread'; payload: { accountId: string; threadId: string; allowRemoteImages?: boolean } }
  | { type: 'mail:source'; payload: { accountId: string; messageId: string } }
  | { type: 'mail:action'; payload: ApplyMailActionInput }
  | { type: 'mail:undo'; payload: { operationId: string } }
  | { type: 'mail:snooze'; payload: { accountId: string; threadIds: string[]; until: string } }
  | { type: 'mail:unsnooze'; payload: { accountId: string; threadIds: string[] } }
  | { type: 'drafts:save'; payload: MailDraftInput }
  | { type: 'drafts:send'; payload: MailDraftInput }
  | { type: 'drafts:schedule'; payload: { input: MailDraftInput; deliveryAt: string } }
  | { type: 'drafts:cancel-send'; payload: { id: string } }
  | { type: 'drafts:list'; payload: { accountIds?: string[] } }
  | { type: 'drafts:get'; payload: { id: string } }
  | { type: 'drafts:delete'; payload: { id: string } }
  | { type: 'drafts:stage-message-attachments'; payload: { draftId: string; accountId: string; messageId: string } }
  | { type: 'rules:list'; payload: { accountIds?: string[] } }
  | { type: 'rules:save'; payload: MailRuleInput }
  | { type: 'rules:delete'; payload: { id: string } }
  | { type: 'rules:run'; payload: { id: string } }
  | { type: 'sync:start'; payload: { accountId?: string } }
  | { type: 'sync:pause'; payload: { accountId: string } }
  | { type: 'sync:resume'; payload: { accountId: string } }
  | { type: 'sync:rebuild'; payload: { accountId: string } }
  | { type: 'sync:progress' }
  | { type: 'storage:stats' }
  | { type: 'diagnostics:health' }
  | { type: 'attachment:extract'; payload: { accountId: string; messageId: string; attachmentId: string; targetPath: string } }
  | { type: 'network'; payload: { online: boolean } }
  | { type: 'polling'; payload: { intervalMs: number; immediate?: boolean } }
  | { type: 'shutdown' }

export type MailWorkerResult =
  | void
  | boolean
  | MailAccountSummary
  | MailAccountSummary[]
  | MailLabel[]
  | MailRule
  | MailRule[]
  | MailRuleRunResult
  | MailSnooze[]
  | MailRecipientSuggestion[]
  | MailThreadDetail
  | MailMessageSource
  | MailPage
  | MailFolderUnreadCounts
  | MailAccountUnreadCounts
  | PendingOperation
  | SyncProgress[]
  | MailStorageStats
  | MailDiagnosticHealth
  | import('../src/mail-types').MailDraftResult
  | MailDraftRecord
  | MailDraftRecord[]
  | MailDraftAttachmentFile[]

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
  event: MailWorkerEvent
}
