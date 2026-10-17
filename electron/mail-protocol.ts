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
  MailSavedSearch,
  MailSavedSearchInput,
  MailQuickAction,
  MailQuickActionInput,
  MailQuickActionRunResult,
  MailQuickActionTarget,
  MailSnooze,
  MailReplyWatch,
  MailReplyWatchInput,
  MailMessageSource,
  MailReadReceiptPolicy,
  MailThreadDetail,
  MailWorkerEvent,
  ImapAccountInput,
  MailPage,
  MailAttachmentPage,
  MailAttachmentQuery,
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
import type { MailSenderIdentity, MailSenderIdentityInput, MailSignature, MailSignatureInput } from '../src/mail-identity-types'

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
  | { type: 'receipts:inspect'; payload: { accountId: string; messageId: string; policy: MailReadReceiptPolicy } }
  | { type: 'receipts:respond'; payload: { accountId: string; messageId: string; decision: 'send' | 'decline'; policy: MailReadReceiptPolicy } }
  | { type: 'invitations:source'; payload: { accountId: string; messageId: string } }
  | { type: 'invitations:send'; payload: import('../src/invitation-types').InvitationMailInput }
  | { type: 'mail:copy'; payload: { accountId: string; threadId: string; messageId: string; destination: string } }
  | { type: 'mail:export'; payload: { accountId: string; messageId: string; targetPath: string } }
  | { type: 'mail:action'; payload: ApplyMailActionInput }
  | { type: 'mail:undo'; payload: { operationId: string } }
  | { type: 'mail:snooze'; payload: { accountId: string; threadIds: string[]; until: string } }
  | { type: 'mail:unsnooze'; payload: { accountId: string; threadIds: string[] } }
  | { type: 'drafts:save'; payload: MailDraftInput }
  | { type: 'drafts:send'; payload: MailDraftInput }
  | { type: 'drafts:schedule'; payload: { input: MailDraftInput; deliveryAt: string } }
  | { type: 'drafts:cancel-send'; payload: { id: string } }
  | { type: 'reply-watches:list'; payload: { accountIds?: string[] } }
  | { type: 'reply-watches:create'; payload: MailReplyWatchInput }
  | { type: 'reply-watches:cancel'; payload: { id: string } }
  | { type: 'drafts:list'; payload: { accountIds?: string[] } }
  | { type: 'drafts:get'; payload: { id: string } }
  | { type: 'drafts:delete'; payload: { id: string } }
  | { type: 'drafts:stage-message-attachments'; payload: { draftId: string; accountId: string; messageId: string } }
  | { type: 'folders:create'; payload: import('../src/mail-types').CreateMailFolderInput }
  | { type: 'folders:update'; payload: import('../src/mail-types').UpdateMailFolderInput }
  | { type: 'folders:delete'; payload: import('../src/mail-types').DeleteMailFolderInput }
  | { type: 'folders:delete-preview'; payload: { accountId: string; labelId: string } }
  | { type: 'rules:list'; payload: { accountIds?: string[] } }
  | { type: 'rules:save'; payload: MailRuleInput }
  | { type: 'rules:delete'; payload: { id: string } }
  | { type: 'rules:run'; payload: { id: string } }
  | { type: 'identities:list'; payload: { accountIds?: string[] } }
  | { type: 'identities:save'; payload: MailSenderIdentityInput }
  | { type: 'identities:delete'; payload: { id: string } }
  | { type: 'identities:refresh'; payload: { accountId: string } }
  | { type: 'signatures:list' }
  | { type: 'signatures:save'; payload: MailSignatureInput }
  | { type: 'signatures:delete'; payload: { id: string } }
  | { type: 'saved-searches:list' }
  | { type: 'saved-searches:save'; payload: MailSavedSearchInput }
  | { type: 'saved-searches:delete'; payload: { id: string } }
  | { type: 'quick-actions:list' }
  | { type: 'quick-actions:save'; payload: MailQuickActionInput }
  | { type: 'quick-actions:delete'; payload: { id: string } }
  | { type: 'quick-actions:run'; payload: { id: string; targets: MailQuickActionTarget[] } }
  | { type: 'sync:start'; payload: { accountId?: string } }
  | { type: 'sync:pause'; payload: { accountId: string } }
  | { type: 'sync:resume'; payload: { accountId: string } }
  | { type: 'sync:rebuild'; payload: { accountId: string } }
  | { type: 'sync:progress' }
  | { type: 'storage:stats' }
  | { type: 'diagnostics:health' }
  | { type: 'attachments:list'; payload: MailAttachmentQuery }
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
  | MailSavedSearch
  | MailSavedSearch[]
  | MailSenderIdentity
  | MailSenderIdentity[]
  | MailSignature
  | MailSignature[]
  | MailQuickAction
  | MailQuickAction[]
  | MailQuickActionRunResult
  | MailSnooze[]
  | MailReplyWatch
  | MailReplyWatch[]
  | MailRecipientSuggestion[]
  | MailThreadDetail
  | MailMessageSource
  | MailPage
  | MailAttachmentPage
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
  | import('../src/mail-types').MailReceiptInfo
  | import('../src/invitation-types').InvitationMessageSource
  | import('../src/mail-types').MailFolderMutationResult
  | import('../src/mail-types').MailFolderDeletePreview

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
