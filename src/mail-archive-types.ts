// Automatic archiving (E31): a per-account, opt-in policy that moves mail
// older than a cutoff into a Local Folders folder on a schedule. Each run is a
// durable job with one item per message. A message's server copy is only
// removed after its local copy was written and verified, and removal is
// message-level, so newer or excluded messages of the same conversation stay.

export type MailArchiveFrequency = 'daily' | 'weekly' | 'monthly'
export type MailArchiveAgeUnit = 'days' | 'months'
/** `trash` moves the server copy to the provider's Trash; `delete` removes it permanently. */
export type MailArchiveRemoval = 'trash' | 'delete'

export interface MailArchiveExclusions {
  starred: boolean
  unread: boolean
  /** Conversations pinned in Aerio (E34). */
  pinned: boolean
  drafts: boolean
  sent: boolean
  /** Folder or label ids whose messages are never archived. */
  folderIds: string[]
}

export interface MailArchiveSubfolders {
  /** Adds a folder named after the account address. */
  perAccount: boolean
  /** Adds a folder per received year. */
  perYear: boolean
  /** Recreates the message's source folder path below the destination. */
  mirrorSourcePath: boolean
}

export interface MailArchivePolicyInput {
  accountId: string
  enabled: boolean
  scope: 'account' | 'folders'
  /** Folders or labels to sweep when `scope` is `folders`. */
  folderIds: string[]
  /** Messages received before now minus this age are archived. */
  olderThan: number
  unit: MailArchiveAgeUnit
  frequency: MailArchiveFrequency
  exclude: MailArchiveExclusions
  /** A Local Folders folder id. */
  destinationLabelId: string
  subfolders: MailArchiveSubfolders
  removal: MailArchiveRemoval
}

export interface MailArchivePolicy extends MailArchivePolicyInput {
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastRunStatus?: MailArchiveJobStatus
  lastError?: string
  /** When the scheduler starts the next run; absent while the policy is off. */
  nextRunAt?: string
}

export interface MailArchivePreviewMessage {
  messageId: string
  threadId: string
  subject: string
  from: string
  receivedAt: string
  size: number
  /** Source folder name, e.g. "Inbox" or "Projects/2024". */
  folder: string
  /** Local Folders path the message would be stored in. */
  destination: string
}

export interface MailArchivePreview {
  accountId: string
  cutoff: string
  count: number
  bytes: number
  /** The oldest eligible messages, at most 50. */
  sample: MailArchivePreviewMessage[]
  /** Older messages kept by an exclusion or because no original is stored offline. */
  excluded: { starred: number; unread: number; pinned: number; drafts: number; sent: number; folders: number; notDownloaded: number; inOtherJob: number }
}

/**
 * `running`: copying or waiting for server removals. `paused`: stopped by a
 * disk problem or by the user; nothing is removed from the server while
 * paused. `completed` may still include failed items.
 */
export type MailArchiveJobStatus = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

/**
 * `pending` → `copied` (local MIME and attachments written and verified) →
 * `removal-queued` (message-level server removal queued) → `done`. `failed`
 * keeps the server copy; `skipped` was no longer eligible when its turn came.
 */
export type MailArchiveItemState = 'pending' | 'copied' | 'removal-queued' | 'done' | 'failed' | 'skipped'

export interface MailArchiveJob {
  id: string
  accountId: string
  trigger: 'schedule' | 'manual'
  status: MailArchiveJobStatus
  cutoff: string
  removal: MailArchiveRemoval
  total: number
  pending: number
  copied: number
  removalQueued: number
  done: number
  failed: number
  skipped: number
  bytes: number
  error?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export interface MailArchiveItem {
  jobId: string
  messageId: string
  threadId: string
  subject: string
  from: string
  receivedAt: string
  size: number
  state: MailArchiveItemState
  reason?: string
  destinationLabelId?: string
}

export interface MailArchiveStatus {
  accountId: string
  policy?: MailArchivePolicy
  /** Newest first; the first non-finished job, if any, is the active one. */
  jobs: MailArchiveJob[]
  /** Explains why permanent deletion is unavailable for this provider. */
  deleteUnavailable?: string
}

export interface MailArchivingApi {
  get(accountId: string): Promise<MailArchiveStatus>
  save(input: MailArchivePolicyInput): Promise<MailArchiveStatus>
  preview(input: MailArchivePolicyInput): Promise<MailArchivePreview>
  runNow(accountId: string): Promise<MailArchiveJob>
  resume(jobId: string): Promise<MailArchiveJob>
  cancel(jobId: string): Promise<MailArchiveJob>
  items(jobId: string): Promise<MailArchiveItem[]>
}
