import type { MailProviderId } from './mail-types'

/**
 * Google Drive and OneDrive are reached through the mail account's own OAuth grant;
 * Dropbox, ownCloud and Nextcloud are storage accounts connected separately.
 */
export type CloudStorageProvider = 'google-drive' | 'onedrive' | LinkedCloudStorageProvider
/** Storage accounts that connect independently of any mail account. */
export type LinkedCloudStorageProvider = 'dropbox' | 'owncloud' | 'nextcloud'

/**
 * Who can open a shared file. `anyone` is a link that works without signing in,
 * `organization` is OneDrive's "people in your organization" (or Dropbox team) link,
 * `recipients` grants access only to the message's To/Cc/Bcc addresses, and
 * `members` is a Dropbox link that opens only for people who already have access.
 */
export type CloudShareAudience = 'anyone' | 'organization' | 'recipients' | 'members'
export type CloudShareRole = 'view' | 'edit'

export interface CloudShareOptions {
  audience: CloudShareAudience
  role: CloudShareRole
  /** Required for the `recipients` audience; ignored otherwise. */
  recipients?: string[]
  /** Link password, for storage accounts that support or enforce one. Kept only in the encrypted upload record until the link exists. */
  password?: string
  /** Last day the link opens (YYYY-MM-DD), for storage accounts that support link expiry. */
  expiresOn?: string
}

/** Whether a link setting is required by the server, optional, or not offered. */
export type CloudCapabilityState = 'enforced' | 'available' | 'unavailable'

export interface CloudStorageCapabilities {
  audiences: CloudShareAudience[]
  password: CloudCapabilityState
  expiry: CloudCapabilityState
  edit: CloudCapabilityState
  /** Longest expiry the server allows (enforced expiry), in days. */
  maxExpiryDays?: number
  /** Default expiry the server applies when none is chosen, in days. */
  defaultExpiryDays?: number
  /** True when uploads go in chunks that survive interruption; false means a single PUT that restarts. */
  resumableUpload: boolean
  /** Plain-language notes about the account's limits. */
  notes: string[]
}

export interface CloudStorageAccount {
  id: string
  provider: LinkedCloudStorageProvider
  name: string
  username: string
  serverUrl?: string
  status: 'ready' | 'needs-auth' | 'error'
  capabilities: CloudStorageCapabilities
  capabilitiesCheckedAt?: string
  connectedAt: string
  error?: string
}

export interface CloudStorageSnapshot {
  accounts: CloudStorageAccount[]
  /** True when a Dropbox app key is available (built in or entered by the user). */
  dropboxConfigured: boolean
  /** True when the app key is part of this build and cannot be changed. */
  dropboxBuiltIn: boolean
}

export interface CloudServerConnectInput {
  provider: 'owncloud' | 'nextcloud'
  serverUrl: string
  username: string
  /** An app password; it is kept in OS secure storage and never returned to the renderer. */
  password: string
  name?: string
}

/** A link Aerio created in a connected storage account. */
export interface CloudStorageLink {
  url: string
  name: string
  storageAccountId: string
  scopeLabel: string
  expiresAt?: string
}

export interface CloudStorageApi {
  snapshot(): Promise<CloudStorageSnapshot>
  /** Saves a Dropbox app key when this build has none built in. */
  configureDropbox(appKey: string): Promise<CloudStorageSnapshot>
  /** Interactive Dropbox sign-in (OAuth 2 with PKCE); each call adds or renews one account. */
  connectDropbox(): Promise<CloudStorageSnapshot>
  connectServer(input: CloudServerConnectInput): Promise<CloudStorageSnapshot>
  /** Re-reads what the server allows (password, expiry, edit, chunked upload). */
  refresh(storageAccountId: string): Promise<CloudStorageSnapshot>
  /** Removes the account, its stored credentials, its interrupted uploads and its link records. */
  disconnect(storageAccountId: string): Promise<CloudStorageSnapshot>
  links(storageAccountId: string): Promise<CloudStorageLink[]>
  /** Turns off a link Aerio created, so it no longer opens. */
  revoke(url: string): Promise<CloudStorageLink[]>
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
  /** Set when the file went to a connected Dropbox, ownCloud or Nextcloud account. */
  storageAccountId?: string
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
  storageAccountId?: string
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
  /** `storageAccountId` sends the file to a connected Dropbox, ownCloud or Nextcloud account instead. */
  upload(uploadId: string, accountId: string, path: string, share: CloudShareOptions, storageAccountId?: string): Promise<CloudUploadResult>
  cancel(uploadId: string): Promise<void>
  pending(accountId: string): Promise<CloudPendingUpload[]>
  resume(uploadId: string): Promise<CloudUploadResult>
  discard(uploadId: string): Promise<void>
  /** Re-checks links Aerio created; unknown URLs and network failures are not reported. */
  verify(accountId: string, urls: string[]): Promise<CloudLinkIssue[]>
  onProgress(callback: (progress: CloudUploadProgress) => void): () => void
  storage: CloudStorageApi
}
