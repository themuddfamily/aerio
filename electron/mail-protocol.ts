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
  MailContactHistoryPage,
  MailContactHistoryQuery,
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
import type { MailMergeJob, MailMergeJobInput, MailMergeJobSummary, MailMergeResolution } from '../src/mail-merge-types'

export type MailWorkerCommand =
  | { type: 'initialize'; payload: { databasePath: string; contentPath: string; proxy?: import('./network-proxy-store').ProxyRuntimeConfig } }
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
  | import('./mail/folder-preferences').MailFolderPreferenceCommand
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
  | { type: 'merge:list' }
  | { type: 'merge:get'; payload: { id: string } }
  | { type: 'merge:create'; payload: MailMergeJobInput }
  | { type: 'merge:pause'; payload: { id: string } }
  | { type: 'merge:resume'; payload: { id: string } }
  | { type: 'merge:cancel'; payload: { id: string } }
  | { type: 'merge:resolve'; payload: { id: string; positions: number[]; resolution: MailMergeResolution } }
  | { type: 'merge:delete'; payload: { id: string } }
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
  | { type: 'offline:settings' | 'offline:reclaim'; payload: { accountId: string } }
  | { type: 'offline:set-account-policy'; payload: { accountId: string; policy: import('../src/offline-sync-types').MailOfflinePolicy } }
  | { type: 'offline:set-folder-override'; payload: { accountId: string; labelId: string; override: { downloadMode?: import('../src/offline-sync-types').MailDownloadMode; window?: import('../src/offline-sync-types').MailSyncWindow } | null } }
  | { type: 'offline:extend'; payload: import('../src/offline-sync-types').MailOfflineExtendInput }
  | { type: 'offline:availability'; payload: { accountId: string; labelId?: string } }
  | { type: 'offline:search-coverage'; payload: { accountIds?: string[] } }
  | { type: 'offline:server-search'; payload: import('../src/offline-sync-types').MailServerSearchInput }
  | { type: 'diagnostics:health' }
  | { type: 'attachments:list'; payload: MailAttachmentQuery }
  | { type: 'contacts:history'; payload: MailContactHistoryQuery }
  | { type: 'attachment:extract'; payload: { accountId: string; messageId: string; attachmentId: string; targetPath: string } }
  | { type: 'local:ensure' }
  | { type: 'local:transfer'; payload: import('../src/mail-types').MailLocalTransferInput }
  | { type: 'import:start'; payload: import('../src/mail-types').MailImportStartInput }
  | { type: 'import:list' }
  | { type: 'import:pause' | 'import:resume' | 'import:cancel' | 'import:dismiss'; payload: { id: string } }
  | { type: 'import:items'; payload: { jobId: string } }
  | { type: 'import:resolve'; payload: { jobId: string; keys: string[]; decision: 'import' | 'discard' } }
  | { type: 'archive:get'; payload: { accountId: string } }
  | { type: 'archive:save' | 'archive:preview'; payload: import('../src/mail-archive-types').MailArchivePolicyInput }
  | { type: 'archive:run'; payload: { accountId: string } }
  | { type: 'archive:resume' | 'archive:cancel' | 'archive:items'; payload: { jobId: string } }
  | { type: 'duplicates:scan'; payload: { scopes: import('./mail/mail-duplicates').MailDuplicateScope[] } }
  | { type: 'duplicates:trash'; payload: import('./mail/mail-duplicates').MailDuplicateTrashInput }
  | { type: 'network'; payload: { online: boolean } }
  | { type: 'polling'; payload: { intervalMs: number; immediate?: boolean } }
  | { type: 'pop3'; payload: import('./mail/pop3-sync').Pop3WorkerCommand }
  | { type: 'shutdown' }
  | import('./mail/inbox-category-worker').InboxCategoryCommand
  | import('./mail/mailbox-owner-worker').MailboxOwnerCommand

export type MailWorkerResult =
  | void
  | import('../src/mail-folder-preference-types').MailFolderPreferences
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
  | MailMergeJob
  | MailMergeJobSummary
  | MailMergeJobSummary[]
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
  | MailContactHistoryPage
  | MailFolderUnreadCounts
  | MailAccountUnreadCounts
  | PendingOperation
  | SyncProgress[]
  | MailStorageStats
  | import('../src/offline-sync-types').MailOfflineSettings
  | import('../src/offline-sync-types').MailOfflineSettings[]
  | import('../src/offline-sync-types').MailOfflineAvailability
  | import('../src/offline-sync-types').MailSearchCoverage[]
  | import('../src/offline-sync-types').MailServerSearchResult
  | import('../src/offline-sync-types').MailOfflineReclaimResult
  | MailDiagnosticHealth
  | import('../src/mail-types').MailDraftResult
  | MailDraftRecord
  | MailDraftRecord[]
  | MailDraftAttachmentFile[]
  | import('../src/mail-types').MailReceiptInfo
  | import('../src/invitation-types').InvitationMessageSource
  | import('../src/mail-types').MailFolderMutationResult
  | import('../src/mail-types').MailFolderDeletePreview
  | import('../src/mail-types').MailImportJob
  | import('../src/mail-types').MailImportJob[]
  | import('../src/mail-types').MailImportItem[]
  | import('../src/mail-types').MailLocalTransferResult
  | import('./mail/pop3-store').Pop3StoredSettings
  | import('../src/pop3-types').Pop3AccountStatus
  | import('../src/mail-archive-types').MailArchiveStatus
  | import('../src/mail-archive-types').MailArchivePreview
  | import('../src/mail-archive-types').MailArchiveJob
  | import('../src/mail-archive-types').MailArchiveItem[]
  | import('./mail/inbox-category-worker').InboxCategoryResult
  | import('./mail/mail-duplicates').MailDuplicateScan
  | import('./mail/mail-duplicates').MailDuplicateTrashResult
  | import('./mail/mailbox-owner-worker').MailboxOwnerResult

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
  | { type: 'pop3'; config: import('../src/pop3-types').Pop3ConnectionConfig }
  | { type: 'exchange'; config: import('./exchange/exchange-config').ExchangeAccountConfig }

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

/** Asks the main process to sign and/or encrypt an outgoing message (OpenPGP or S/MIME); crypto never runs in the worker. */
export interface WorkerOpenPgpRequest {
  kind: 'openpgp-request'
  id: string
  message: string
  from: string
  recipients: string[]
  options: import('../src/openpgp-types').MailOpenPgpOptions
  /** Present when the draft asks for S/MIME instead of OpenPGP. */
  smime?: import('../src/smime-types').MailSmimeOptions
}

export interface WorkerOpenPgpResponse {
  kind: 'openpgp-response'
  id: string
  message?: string
  error?: string
}

export interface WorkerEventMessage {
  kind: 'event'
  event: MailWorkerEvent
}
