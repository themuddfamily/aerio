import type { MailFolder } from './mail-types'

/**
 * Configurable offline download and synchronization scope (E36).
 *
 * - `full`: the original message (raw MIME) and every attachment are kept on this computer.
 * - `bodies`: headers and the text/HTML body are kept; attachments are fetched when opened.
 * - `headers`: only the header row (sender, subject, date, snippet) is kept; the body is fetched when the message is opened.
 */
export type MailDownloadMode = 'full' | 'bodies' | 'headers'

export type MailSyncWindowUnit = 'all' | 'days' | 'months'

/** How far back mail is synchronized. `amount` is ignored for `all`. */
export interface MailSyncWindow {
  unit: MailSyncWindowUnit
  amount: number
}

export interface MailOfflinePolicy {
  downloadMode: MailDownloadMode
  window: MailSyncWindow
}

/** A folder or label override; an omitted field inherits the account default. */
export interface MailFolderOfflineOverride {
  labelId: string
  downloadMode?: MailDownloadMode
  window?: MailSyncWindow
  updatedAt: string
}

/**
 * Temporary widening from the message list footer. "Load more" adds one
 * window length per step; "Load all" lifts the window until `loadAllUntil`.
 * An empty labelId applies to every folder of the account.
 */
export interface MailFolderViewExtension {
  labelId: string
  extraSteps: number
  loadAllUntil?: string
}

export interface MailOfflineSettings {
  accountId: string
  /** False for Local Folders and POP3 (stored only on this computer) and on-premises Exchange (always full). */
  supported: boolean
  /** Why the scope cannot be changed, when `supported` is false. */
  unsupportedReason?: string
  defaults: MailOfflinePolicy
  overrides: MailFolderOfflineOverride[]
  extensions: MailFolderViewExtension[]
}

/** What is stored locally for one message. */
export type MailOfflineContentState = 'full' | 'body' | 'headers'

export interface MailOfflineContentInfo {
  state: MailOfflineContentState
  /** Shown instead of the body when it could not be loaded. */
  notice?: string
}

export interface MailOfflineAvailability {
  accountId: string
  /** Absent for the whole account. */
  labelId?: string
  /** Cached header rows (every message the list can show). */
  total: number
  /** Original message and attachments available offline. */
  full: number
  /** Text/HTML body available offline; attachments are fetched when opened. */
  bodyOnly: number
  /** Only the header row is stored; the body is fetched when opened. */
  headersOnly: number
  /** Cached rows older than the current window (kept as header rows). */
  outsideWindow: number
  /** Approximate bytes used by stored originals and bodies. */
  bytes: number
  policy: MailOfflinePolicy
  /** ISO start of the effective window; absent when all mail is synchronized. */
  windowStart?: string
  extraSteps: number
  loadAllUntil?: string
}

export interface MailSearchCoverage {
  accountId: string
  /** True when every message in the mailbox is downloaded with its body, so local search sees everything. */
  complete: boolean
  /** The provider can search the whole mailbox on the server. */
  serverSearch: boolean
  reasons: string[]
}

export interface MailServerSearchInput {
  accountIds: string[]
  query: string
  labelId?: string
}

export interface MailServerSearchResult {
  /** Pass as `MailQuery.serverSearchId` to list the matching conversations. */
  searchId: string
  matched: number
  /** Matches that were not in the local cache and were added as header rows. */
  added: number
  errors: { accountId: string; message: string }[]
}

export interface MailOfflineExtendInput {
  accountIds: string[]
  folder: MailFolder
  labelId?: string
  mode: 'more' | 'all'
}

export interface MailOfflineReclaimResult {
  messages: number
  bytes: number
}

export interface MailOfflineApi {
  settings(accountId: string): Promise<MailOfflineSettings>
  setAccountPolicy(accountId: string, policy: MailOfflinePolicy): Promise<MailOfflineSettings>
  /** `null` removes the override so the folder follows the account default again. */
  setFolderOverride(accountId: string, labelId: string, override: { downloadMode?: MailDownloadMode; window?: MailSyncWindow } | null): Promise<MailOfflineSettings>
  extend(input: MailOfflineExtendInput): Promise<MailOfflineSettings[]>
  availability(accountId: string, labelId?: string): Promise<MailOfflineAvailability>
  searchCoverage(accountIds?: string[]): Promise<MailSearchCoverage[]>
  serverSearch(input: MailServerSearchInput): Promise<MailServerSearchResult>
  reclaim(accountId: string): Promise<MailOfflineReclaimResult>
}
