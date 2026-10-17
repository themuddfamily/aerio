import type { CloudLinkProblem, CloudShareOptions, CloudStorageCapabilities } from '../../src/cloud-attachment-types'
import type { StoredLink, StoredUpload } from './cloud-attachments'

/** The folder Aerio uploads into on every connected storage account. */
export const LINKED_UPLOAD_FOLDER = 'Aerio attachments'

export interface LinkedFile {
  id: string
  name: string
}

export interface LinkedShare {
  url: string
  /** Provider ids Aerio needs to check or revoke the link later (an OCS share id, a Dropbox link id). */
  permissionIds: string[]
  expiresAt?: string
}

export interface LinkedUploadSession {
  /** What a later resume needs: a Dropbox session id, a Nextcloud chunk folder URL, or '' for a single PUT. */
  sessionUrl: string
  remotePath: string
  expiresAt?: string
}

/** Thrown when stored credentials no longer work; the account is marked as needing sign-in. */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudAuthError'
  }
}

/**
 * One connected Dropbox, ownCloud or Nextcloud account. Connectors only speak HTTP; the
 * linked-storage service owns session records, cancellation and link bookkeeping.
 */
export interface LinkedStorageConnector {
  capabilities(): Promise<CloudStorageCapabilities & { chunkedUpload?: boolean; serverVersion?: number }>
  startUpload(name: string, size: number, signal: AbortSignal): Promise<LinkedUploadSession>
  /** Bytes the provider already holds for an interrupted upload. */
  confirmedOffset(record: StoredUpload, signal: AbortSignal): Promise<number>
  /** Sends bytes from `start`, reporting each offset the provider acknowledged. */
  transfer(record: StoredUpload, start: number, signal: AbortSignal, confirmed: (offset: number) => void): Promise<LinkedFile>
  /** Discards an unfinished upload session where the provider allows it. */
  cancelUpload(record: StoredUpload): Promise<void>
  share(file: LinkedFile, share: CloudShareOptions): Promise<LinkedShare>
  deleteFile(file: LinkedFile): Promise<void>
  /** Pre-send check of a link Aerio created; undefined when it still opens. */
  check(link: StoredLink): Promise<CloudLinkProblem | undefined>
  revoke(link: StoredLink): Promise<void>
  /** Best-effort server-side sign-out when the account is disconnected. */
  signOut(): Promise<void>
}

/** YYYY-MM-DD validation shared by connectors; the date must not be in the past. */
export function validExpiryDate(value: string, now: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error('Choose a valid expiry date')
  if (Date.parse(`${value}T23:59:59Z`) < now) throw new Error('Choose an expiry date in the future')
  return value
}
