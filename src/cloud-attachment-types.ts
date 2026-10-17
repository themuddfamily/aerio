import type { MailProviderId } from './mail-types'

/** Cloud storage reached through the mail account's own OAuth grant. */
export type CloudStorageProvider = 'google-drive' | 'onedrive'

/**
 * Who can open a shared file. `anyone` is a link that works without signing in,
 * `organization` is OneDrive's "people in your organization" link, and
 * `recipients` grants access only to the message's To/Cc/Bcc addresses.
 */
export type CloudShareAudience = 'anyone' | 'organization' | 'recipients'
export type CloudShareRole = 'view' | 'edit'

export interface CloudShareOptions {
  audience: CloudShareAudience
  role: CloudShareRole
  /** Required for the `recipients` audience; ignored otherwise. */
  recipients?: string[]
}

export interface CloudAttachmentStatus {
  accountId: string
  mailProvider: MailProviderId
  provider?: CloudStorageProvider
  /** False for IMAP accounts, which have no matching storage connector. */
  supported: boolean
  /** True when the stored grant includes the storage permission. */
  connected: boolean
  /** The permission an opt-in reconnect will ask for. */
  requiredScope?: string
  audiences: CloudShareAudience[]
  /** Largest total the mail provider is expected to accept as ordinary attachments, in bytes. */
  attachmentLimitBytes: number
  message?: string
}

export interface CloudUploadProgress {
  uploadId: string
  name: string
  sentBytes: number
  totalBytes: number
}

export interface CloudSharedLink {
  provider: CloudStorageProvider
  accountId: string
  fileId: string
  name: string
  size: number
  url: string
  share: CloudShareOptions
  /** Plain-language summary shown before and after insertion. */
  scopeLabel: string
  expiresAt?: string
}

export type CloudUploadResult =
  | { status: 'shared'; uploadId: string; link: CloudSharedLink }
  | { status: 'cancelled'; uploadId: string }

/** An upload interrupted by quitting Aerio, kept so it can resume from the last confirmed byte. */
export interface CloudPendingUpload {
  uploadId: string
  accountId: string
  provider: CloudStorageProvider
  name: string
  path: string
  totalBytes: number
  share: CloudShareOptions
  createdAt: string
  expiresAt?: string
}

export type CloudLinkProblem = 'expired' | 'revoked' | 'deleted' | 'permission-denied'

export interface CloudLinkIssue {
  url: string
  name: string
  problem: CloudLinkProblem
  message: string
}

export interface CloudAttachmentsApi {
  status(accountId: string): Promise<CloudAttachmentStatus>
  /** Opt-in reconnect that adds only the storage permission to the existing grant. */
  connect(accountId: string): Promise<CloudAttachmentStatus>
  upload(uploadId: string, accountId: string, path: string, share: CloudShareOptions): Promise<CloudUploadResult>
  cancel(uploadId: string): Promise<void>
  pending(accountId: string): Promise<CloudPendingUpload[]>
  resume(uploadId: string): Promise<CloudUploadResult>
  discard(uploadId: string): Promise<void>
  /** Re-checks links Aerio created; unknown URLs and network failures are not reported. */
  verify(accountId: string, urls: string[]): Promise<CloudLinkIssue[]>
  onProgress(callback: (progress: CloudUploadProgress) => void): () => void
}
