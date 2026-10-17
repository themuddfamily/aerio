// Duplicate cleanup (E32): find and remove existing duplicate mail, events, and tasks.
// Scans are scoped and read-only; removal goes through each owner's normal delete path
// (mail Trash queue, calendar delete, task queue) and is journaled for undo. See
// docs/duplicate-cleanup.md for matching criteria, supported owners, and recovery.

export type DuplicateKind = 'mail' | 'event' | 'task'
export type DuplicateConfidence = 'high' | 'medium' | 'low'
export type DuplicateReasonCode =
  | 'message-id'
  | 'content-hash'
  | 'message-fingerprint'
  | 'ical-uid'
  | 'event-details'
  | 'task-details'

// A place that can be scanned: a mail folder or label, a calendar, or a task list.
export interface DuplicateScopeContainer {
  id: string
  label: string
  readOnly: boolean
  readOnlyReason?: string
}

// The account (or "on this PC" store) that owns containers. Mail can scan a whole
// account; calendars and tasks are always scanned per container.
export interface DuplicateScopeOwner {
  id: string
  label: string
  readOnly: boolean
  readOnlyReason?: string
  containers: DuplicateScopeContainer[]
}

export type DuplicateScanRequest =
  // An empty or missing `labelIds` scans every folder of the account.
  | { kind: 'mail'; scopes: { accountId: string; labelIds?: string[] }[] }
  | { kind: 'event'; calendarIds: string[] }
  | { kind: 'task'; listIds: string[] }

export interface DuplicateReason {
  code: DuplicateReasonCode
  label: string
}

export interface DuplicateItemDetail {
  label: string
  value: string
}

export interface DuplicateItem {
  id: string
  title: string
  ownerLabel: string
  containerLabel: string
  date?: string
  summary: string
  // Rows for the side-by-side comparison; every item of a group lists the same labels.
  details: DuplicateItemDetail[]
  // Higher is more complete; used with `createdAt` to suggest the copy to keep.
  completeness: number
  createdAt?: string
  removable: boolean
  blockedReason?: string
}

export interface DuplicateGroup {
  id: string
  kind: DuplicateKind
  confidence: DuplicateConfidence
  reasons: DuplicateReason[]
  items: DuplicateItem[]
  // Suggested copy to keep: the most complete, then the oldest.
  keeperId: string
  notes: string[]
}

export interface DuplicateExclusion {
  label: string
  reason: string
}

export interface DuplicateScanResult {
  scanId: string
  kind: DuplicateKind
  scannedAt: string
  scanned: number
  groups: DuplicateGroup[]
  excluded: DuplicateExclusion[]
  // Groups hidden because they were marked "Not duplicates" earlier.
  dismissed: number
}

export interface DuplicateGroupRemoval {
  groupId: string
  keeperId: string
  removeIds: string[]
}

export interface DuplicateRemovalRequest {
  scanId: string
  groups: DuplicateGroupRemoval[]
}

export type DuplicateItemOutcome = 'removed' | 'stale' | 'failed' | 'skipped'

export interface DuplicateRemovalItemResult {
  groupId: string
  itemId: string
  title: string
  outcome: DuplicateItemOutcome
  message?: string
}

export interface DuplicateCleanupEntry {
  id: string
  kind: DuplicateKind
  createdAt: string
  removed: number
  titles: string[]
  undoneAt?: string
  warnings?: string[]
}

export interface DuplicateRemovalResult {
  // Present when at least one item was removed.
  entry?: DuplicateCleanupEntry
  results: DuplicateRemovalItemResult[]
}

export interface DuplicateUndoItemResult {
  itemId: string
  title: string
  outcome: 'restored' | 'failed'
  message?: string
}

export interface DuplicateUndoResult {
  entry: DuplicateCleanupEntry
  results: DuplicateUndoItemResult[]
}

// "Not duplicates": a group whose items are all covered by one dismissal is not suggested again.
export interface DuplicateDismissal {
  id: string
  kind: DuplicateKind
  itemIds: string[]
  titles: string[]
  createdAt: string
}

export interface DuplicateCleanupApi {
  scopes(kind: DuplicateKind): Promise<DuplicateScopeOwner[]>
  scan(request: DuplicateScanRequest): Promise<DuplicateScanResult>
  remove(request: DuplicateRemovalRequest): Promise<DuplicateRemovalResult>
  dismiss(scanId: string, groupId: string): Promise<DuplicateDismissal[]>
  dismissals(): Promise<DuplicateDismissal[]>
  removeDismissal(id: string): Promise<DuplicateDismissal[]>
  history(): Promise<DuplicateCleanupEntry[]>
  undo(entryId: string): Promise<DuplicateUndoResult>
}
