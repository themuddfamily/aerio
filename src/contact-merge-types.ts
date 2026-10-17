import type { Contact } from './types'
import type { ProductivitySnapshot } from './productivity-types'

// Contact duplicate handling (E28). A contact's owner is where its record lives: 'local' for the
// address book on this PC, or the provider account id for synchronized contacts. Only contacts of
// the same owner are merged; contacts of different owners are linked locally instead.
export type ContactOwner = 'local' | string

// A distribution-list member whose contact reference moved from the merged-away contact to the survivor.
export interface ContactListRelink {
  listId: string
  email: string
}

// One entry of the local undo journal. `survivorBefore` and `loserBefore` are snapshots of the
// originals taken before anything was written, so the merge can be reversed later.
export interface ContactMergeEntry {
  id: string
  kind: 'local' | 'provider'
  accountId?: string
  provider?: 'gmail' | 'microsoft'
  survivorId: string
  loserId: string
  survivorBefore: Contact
  loserBefore: Contact
  // The survivor as saved by the merge; undo refuses when the survivor has changed since.
  merged: Contact
  relinkedLists?: ContactListRelink[]
  // Google contact groups the survivor joined because the merged-away contact belonged to them.
  addedGroupIds?: string[]
  // False when the provider update succeeded but deleting the duplicate failed.
  loserDeleted: boolean
  createdAt: string
  undoneAt?: string
  // Provider undo recreates the merged-away contact, which gets a new id.
  restoredLoserId?: string
  warnings?: string[]
}

export interface LocalContactMergeRecord {
  survivorBefore: Contact
  loserBefore: Contact
  merged: Contact
  relinkedLists?: ContactListRelink[]
}

export interface ProviderContactMergeInput {
  survivorId: string
  loserId: string
  merged: Contact
  // Revisions the merge preview was built from; a mismatch means a sync changed either contact.
  survivorRevision?: string
  loserRevision?: string
  // Local distribution-list members the renderer moves to the survivor once the merge succeeds.
  relinkedLists?: ContactListRelink[]
}

export interface ContactMergeResult {
  entry: ContactMergeEntry
  snapshot: ProductivitySnapshot
}

// A local association between two contacts: `link` marks the same person across owners, and
// `dismissed` records that a suggested pair is not a duplicate so it is not suggested again.
export interface ContactAssociation {
  id: string
  kind: 'link' | 'dismissed'
  contactIds: [string, string]
  owners: [ContactOwner, ContactOwner]
  createdAt: string
}

export interface ContactMergeDesktopApi {
  merges(): Promise<ContactMergeEntry[]>
  mergeProvider(input: ProviderContactMergeInput): Promise<ContactMergeResult>
  recordLocalMerge(record: LocalContactMergeRecord): Promise<ContactMergeEntry>
  // Provider entries are reversed in the main process. Local entries are only marked as undone;
  // the renderer restores the snapshots because it owns the local address book.
  undo(entryId: string): Promise<ContactMergeResult>
  associations(): Promise<ContactAssociation[]>
  associate(kind: ContactAssociation['kind'], firstId: string, secondId: string): Promise<ContactAssociation[]>
  removeAssociation(id: string): Promise<ContactAssociation[]>
}
