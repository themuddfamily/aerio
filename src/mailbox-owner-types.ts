// Shared/delegated mailboxes, delegation permissions, and public folders (E40).
//
// Every cached folder, message, sync checkpoint, and queued mail action belongs to a "mailbox
// owner": the account's own mailbox (`primary`), another user's mailbox opened as a delegate or a
// shared mailbox, or the Exchange public folder tree. Folders of other owners are stored as
// `owner:<ownerId>:<folderId>` labels so that two folders with the same name (two Inboxes) can
// never collide. See docs/shared-mailboxes-delegation.md.

export const PRIMARY_MAILBOX_OWNER = 'primary'
export const PUBLIC_FOLDERS_OWNER = 'public'

export type MailboxOwnerProvider = 'exchange' | 'microsoft'
export type MailboxOwnerKind = 'shared' | 'delegated' | 'public-folders'
/** `access-removed`: the server refused the mailbox (revoked or deleted); the cache stays read-only until it is removed. */
export type MailboxOwnerStatus = 'active' | 'syncing' | 'access-removed' | 'error'
/** Effective rights for the signed-in user: `read` (Reviewer), `write` (can change and file items), or `none`. */
export type MailboxAccess = 'none' | 'read' | 'write'
export type MailboxFolderKind = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes' | 'other'
/** How messages "from" a shared mailbox are sent. */
export type MailboxSendMode = 'none' | 'send-as' | 'send-on-behalf'

export interface MailboxFolderAccess {
  folderId: string
  /** The mail label of a synchronized mail folder (`owner:<ownerId>:<folderId>`). */
  labelId?: string
  parentFolderId?: string
  name: string
  kind: MailboxFolderKind
  /** Distinguished name (inbox, sentitems, deleteditems, ...) when known. */
  distinguished?: string
  access: MailboxAccess
  canCreate: boolean
  canModify: boolean
  canDelete: boolean
  /** Public folders: shown in the sidebar and synchronized. */
  subscribed?: boolean
  error?: string
}

export interface MailboxOwnerSummary {
  id: string
  accountId: string
  provider: MailboxOwnerProvider
  kind: MailboxOwnerKind
  /** SMTP address of the mailbox; the public folder mailbox used for routing for public folders. */
  address: string
  displayName: string
  status: MailboxOwnerStatus
  error?: string
  /** The best access to any of its mail folders. */
  access: MailboxAccess
  folders: MailboxFolderAccess[]
  sendMode: MailboxSendMode
  /** Sender identity created for send-as/send-on-behalf. */
  identityId?: string
  discoveredBy: 'manual' | 'autodiscover'
  heldOperations: number
  lastSyncAt?: string
  createdAt: string
  updatedAt: string
}

/** Owner information attached to every mail label that belongs to another mailbox. */
export interface MailLabelOwner {
  id: string
  kind: MailboxOwnerKind
  address: string
  displayName: string
  status: MailboxOwnerStatus
  /** Access to this folder (the owner's root label carries the mailbox-wide value). */
  access: MailboxAccess
  root?: boolean
}

export interface AttachMailboxInput {
  accountId: string
  address: string
  displayName?: string
  kind: 'shared' | 'delegated'
  sendMode?: MailboxSendMode
  discoveredBy?: 'manual' | 'autodiscover'
}

export interface UpdateMailboxOwnerInput {
  accountId: string
  ownerId: string
  displayName?: string
  sendMode?: MailboxSendMode
}

export interface DiscoveredMailbox {
  address: string
  displayName: string
  kind: 'shared' | 'delegated'
  attached: boolean
}

export interface MailboxDiscoveryResult {
  supported: boolean
  mailboxes: DiscoveredMailbox[]
  publicFolderMailbox?: string
  note?: string
}

export interface PublicFolderNode {
  folderId: string
  parentFolderId?: string
  name: string
  folderClass: string
  kind: MailboxFolderKind
  childCount: number
  access: MailboxAccess
  subscribed: boolean
}

export type DelegateFolderPermission = 'None' | 'Reviewer' | 'Author' | 'Editor'
export const DELEGATE_FOLDERS = ['calendar', 'tasks', 'inbox', 'contacts', 'notes'] as const
export type DelegateFolder = typeof DELEGATE_FOLDERS[number]
/** Who receives meeting requests sent to the owner (Exchange DeliverMeetingRequests). */
export type MeetingRequestDelivery = 'DelegatesOnly' | 'DelegatesAndMe' | 'DelegatesAndSendInformationToMe' | 'NoForward'

export interface MailboxDelegate {
  address: string
  displayName?: string
  permissions: Record<DelegateFolder, DelegateFolderPermission>
  receiveCopiesOfMeetingMessages: boolean
  viewPrivateItems: boolean
}

export interface MailboxDelegation {
  accountId: string
  supported: boolean
  note?: string
  delegates: MailboxDelegate[]
  deliverMeetingRequests: MeetingRequestDelivery
}

export interface SaveDelegateInput {
  accountId: string
  delegate: MailboxDelegate
  /** `add` creates the delegate; `update` changes an existing one. */
  mode: 'add' | 'update'
  deliverMeetingRequests?: MeetingRequestDelivery
}

export interface HeldMailboxOperation {
  id: string
  accountId: string
  ownerId: string
  ownerName: string
  kind: string
  threadCount: number
  error?: string
  createdAt: string
}

export interface MailboxOwnersApi {
  list(accountId?: string): Promise<MailboxOwnerSummary[]>
  discover(accountId: string): Promise<MailboxDiscoveryResult>
  attach(input: AttachMailboxInput): Promise<MailboxOwnerSummary>
  update(input: UpdateMailboxOwnerInput): Promise<MailboxOwnerSummary>
  remove(accountId: string, ownerId: string): Promise<void>
  sync(accountId: string, ownerId?: string): Promise<MailboxOwnerSummary[]>
  publicFolders: {
    browse(accountId: string, parentFolderId?: string): Promise<PublicFolderNode[]>
    subscribe(accountId: string, folderId: string, subscribed: boolean): Promise<MailboxOwnerSummary | undefined>
  }
  delegates: {
    get(accountId: string): Promise<MailboxDelegation>
    save(input: SaveDelegateInput): Promise<MailboxDelegation>
    remove(accountId: string, address: string): Promise<MailboxDelegation>
    setMeetingDelivery(accountId: string, delivery: MeetingRequestDelivery): Promise<MailboxDelegation>
  }
  held: {
    list(accountId?: string): Promise<HeldMailboxOperation[]>
    resolve(operationId: string, decision: 'retry' | 'discard'): Promise<HeldMailboxOperation[]>
  }
}

export const ownerRootLabel = (ownerId: string) => `owner:${ownerId}`
export const ownerFolderLabel = (ownerId: string, folderId: string) => `owner:${ownerId}:${folderId}`

/** `owner:<ownerId>[:<folderId>]` → its parts; undefined for the account's own labels. */
export function parseOwnerLabel(labelId: string | undefined) {
  if (!labelId?.startsWith('owner:')) return undefined
  const rest = labelId.slice(6)
  const split = rest.indexOf(':')
  return split < 0 ? { ownerId: rest } : { ownerId: rest.slice(0, split), folderId: rest.slice(split + 1) }
}

export const isEmailAddress = (value: string) => /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(value) && value.length <= 320
