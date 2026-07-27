import type {
  ApplyMailActionInput,
  GmailAccountSummary,
  GmailDraftInput,
  GmailLabel,
  GmailThreadDetail,
  GmailWorkerEvent,
  MailPage,
  MailQuery,
  MailStorageStats,
  PendingOperation,
  SyncProgress
} from '../src/gmail-types'

export type MailWorkerCommand =
  | { type: 'initialize'; payload: { databasePath: string; contentPath: string } }
  | { type: 'accounts:list' }
  | { type: 'accounts:upsert'; payload: GmailAccountSummary }
  | { type: 'accounts:disconnect'; payload: { accountId: string; mode: 'archive' | 'delete' } }
  | { type: 'labels:list'; payload: { accountIds?: string[] } }
  | { type: 'mail:list'; payload: MailQuery }
  | { type: 'mail:thread'; payload: { accountId: string; threadId: string; allowRemoteImages?: boolean } }
  | { type: 'mail:action'; payload: ApplyMailActionInput }
  | { type: 'mail:undo'; payload: { operationId: string } }
  | { type: 'drafts:save'; payload: GmailDraftInput }
  | { type: 'drafts:send'; payload: GmailDraftInput }
  | { type: 'sync:start'; payload: { accountId?: string } }
  | { type: 'sync:pause'; payload: { accountId: string } }
  | { type: 'sync:resume'; payload: { accountId: string } }
  | { type: 'sync:progress' }
  | { type: 'storage:stats' }
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
  | GmailThreadDetail
  | MailPage
  | PendingOperation
  | SyncProgress[]
  | MailStorageStats
  | import('../src/gmail-types').GmailDraftResult

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

export interface WorkerTokenRequest {
  kind: 'token-request'
  id: string
  accountId: string
}

export interface WorkerTokenResponse {
  kind: 'token-response'
  id: string
  token?: string
  error?: string
}

export interface WorkerEventMessage {
  kind: 'event'
  event: GmailWorkerEvent
}
