import { randomUUID } from 'node:crypto'
import type { Contact } from '../../src/types'
import type { ProductivityProvider, SyncedContact, SyncedContactGroup } from '../../src/productivity-types'
import type {
  ContactAssociation, ContactListRelink, ContactMergeEntry, ContactMergeResult, LocalContactMergeRecord, ProviderContactMergeInput
} from '../../src/contact-merge-types'
import { contactEditConflict } from '../../src/lib/contact-fields'
import type { ProductivityStore } from './store'

// Merges and links contacts (E28). Provider merges go through the same connector write paths as
// the contact editor: update the survivor (with its revision), then delete the duplicate. The
// originals are journaled first so a merge can be undone; see docs/contact-merge.md for limits.

export interface ContactWriteConnector {
  createContact(contact: Contact): Promise<SyncedContact>
  updateContact(current: SyncedContact, contact: Contact): Promise<SyncedContact>
  deleteContact(contact: SyncedContact): Promise<void>
  modifyContactGroupMembers?(group: SyncedContactGroup, add: SyncedContact[], remove: SyncedContact[]): Promise<{ contacts: SyncedContact[] }>
}

type MergeStore = Pick<ProductivityStore,
  'snapshot' | 'upsertContact' | 'deleteContact' | 'saveContactMerge' | 'contactMerge' | 'contactMerges' |
  'contactAssociations' | 'saveContactAssociation' | 'deleteContactAssociation'>

export interface ContactMergeDeps {
  store: MergeStore
  connector(accountId: string, provider: ProductivityProvider): ContactWriteConnector
  now?(): string
  id?(): string
  log?(event: string, accountId: string | undefined, details: Record<string, unknown>): void
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const validId = (value: unknown): value is string => typeof value === 'string' && Boolean(value) && value.length <= 500
const validRevision = (value: unknown) => value === undefined || (typeof value === 'string' && value.length <= 2_000)

export function validRelinks(value: unknown): value is ContactListRelink[] {
  return value === undefined || (Array.isArray(value) && value.length <= 10_000 && value.every((item) =>
    item && typeof item === 'object' && validId((item as ContactListRelink).listId) &&
    typeof (item as ContactListRelink).email === 'string' && (item as ContactListRelink).email.length <= 1_000))
}

export function validProviderMergeInput(value: unknown, validContact: (contact: unknown) => contact is Contact): value is ProviderContactMergeInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<ProviderContactMergeInput>
  return validId(input.survivorId) && validId(input.loserId) && input.survivorId !== input.loserId && validContact(input.merged) &&
    input.merged.id === input.survivorId && validRevision(input.survivorRevision) && validRevision(input.loserRevision) && validRelinks(input.relinkedLists)
}

export function validLocalMergeRecord(value: unknown, validContact: (contact: unknown) => contact is Contact): value is LocalContactMergeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<LocalContactMergeRecord>
  return validContact(record.survivorBefore) && validContact(record.loserBefore) && validContact(record.merged) &&
    record.survivorBefore.id !== record.loserBefore.id && record.merged.id === record.survivorBefore.id &&
    record.survivorBefore.source === 'local' && record.loserBefore.source === 'local' && validRelinks(record.relinkedLists)
}

// Provider bookkeeping is dropped before a snapshot is written back as a new contact.
function contactInput(contact: Contact): Contact {
  const { remoteId: _remoteId, accountId: _accountId, provider: _provider, readOnly: _readOnly, revision: _revision, sourceId: _sourceId,
    folderId: _folderId, groupIds: _groupIds, providerData: _providerData, ...rest } = contact as SyncedContact
  return rest
}

function findContact(store: MergeStore, id: string) {
  return store.snapshot().contacts.find((contact) => contact.id === id)
}

function writableGroups(store: MergeStore, accountId: string, groupIds: string[]) {
  const groups = (store.snapshot().contactGroups ?? []).filter((group) => group.accountId === accountId && !group.readOnly)
  return groupIds.flatMap((remoteId) => groups.filter((group) => group.remoteId === remoteId))
}

// Every Google contact belongs to My Contacts, so that membership is never changed here.
const MY_CONTACTS = 'contactGroups/myContacts'

async function changeGroups(deps: ContactMergeDeps, connector: ContactWriteConnector, contact: SyncedContact, requested: string[], mode: 'add' | 'remove', warnings: string[]) {
  const groupIds = requested.filter((id) => id !== MY_CONTACTS)
  let current = contact
  const changed: string[] = []
  if (!connector.modifyContactGroupMembers || !groupIds.length) return { contact: current, changed }
  for (const group of writableGroups(deps.store, contact.accountId, groupIds)) {
    try {
      const result = await connector.modifyContactGroupMembers(group, mode === 'add' ? [current] : [], mode === 'remove' ? [current] : [])
      const refreshed = result.contacts.find((item) => item.id === current.id)
      if (refreshed) {
        deps.store.upsertContact(refreshed)
        current = refreshed
      }
      changed.push(group.remoteId)
    } catch (error) {
      warnings.push(`The contact group “${group.name}” could not be ${mode === 'add' ? 'joined' : 'left'}: ${message(error)}`)
    }
  }
  const skipped = groupIds.length - writableGroups(deps.store, contact.accountId, groupIds).length
  if (skipped > 0) warnings.push(`${skipped} contact group${skipped === 1 ? '' : 's'} could not be edited and ${skipped === 1 ? 'was' : 'were'} skipped.`)
  return { contact: current, changed }
}

export async function mergeProviderContacts(deps: ContactMergeDeps, input: ProviderContactMergeInput): Promise<ContactMergeResult> {
  const { store } = deps
  const survivor = findContact(store, input.survivorId)
  const loser = findContact(store, input.loserId)
  if (!survivor || !loser) throw new Error('One of these contacts is no longer available; synchronize Contacts and try again')
  // Provider records are only ever merged within one account; across accounts they are linked.
  if (survivor.accountId !== loser.accountId || survivor.provider !== loser.provider) throw new Error('Contacts from different accounts cannot be merged. Link them instead.')
  if (survivor.readOnly || loser.readOnly) throw new Error('Reconnect this account once to enable Contacts editing')
  const conflict = contactEditConflict(survivor, { revision: input.survivorRevision }) ?? contactEditConflict(loser, { revision: input.loserRevision })
  if (conflict) throw new Error(conflict)
  const connector = deps.connector(survivor.accountId, survivor.provider)
  const warnings: string[] = []
  let saved = await connector.updateContact(survivor, input.merged)
  store.upsertContact(saved)
  // Google memberships are not part of a person update, so the survivor joins the duplicate's groups separately.
  let addedGroupIds: string[] = []
  if (survivor.provider === 'gmail') {
    const missing = (loser.groupIds ?? []).filter((id) => !(survivor.groupIds ?? []).includes(id))
    const result = await changeGroups(deps, connector, saved, missing, 'add', warnings)
    saved = result.contact
    addedGroupIds = result.changed
  }
  const entry: ContactMergeEntry = {
    id: deps.id?.() ?? randomUUID(),
    kind: 'provider',
    accountId: survivor.accountId,
    provider: survivor.provider,
    survivorId: survivor.id,
    loserId: loser.id,
    survivorBefore: survivor,
    loserBefore: loser,
    merged: saved,
    ...(input.relinkedLists?.length ? { relinkedLists: input.relinkedLists } : {}),
    ...(addedGroupIds.length ? { addedGroupIds } : {}),
    loserDeleted: false,
    createdAt: deps.now?.() ?? new Date().toISOString()
  }
  // Journal the survivor update before deleting, so a failed delete can still be undone.
  store.saveContactMerge(entry)
  try {
    await connector.deleteContact(loser)
    store.deleteContact(loser.id)
    entry.loserDeleted = true
  } catch (error) {
    warnings.push(`The duplicate could not be deleted: ${message(error)}. Undo restores the kept contact, or delete the duplicate yourself.`)
  }
  if (warnings.length) entry.warnings = warnings
  store.saveContactMerge(entry)
  deps.log?.('contact-merged', survivor.accountId, { provider: survivor.provider, loserDeleted: entry.loserDeleted, warnings: warnings.length })
  return { entry, snapshot: store.snapshot() }
}

export function recordLocalMerge(deps: ContactMergeDeps, record: LocalContactMergeRecord): ContactMergeEntry {
  const entry: ContactMergeEntry = {
    id: deps.id?.() ?? randomUUID(),
    kind: 'local',
    survivorId: record.survivorBefore.id,
    loserId: record.loserBefore.id,
    survivorBefore: record.survivorBefore,
    loserBefore: record.loserBefore,
    merged: record.merged,
    ...(record.relinkedLists?.length ? { relinkedLists: record.relinkedLists } : {}),
    loserDeleted: true,
    createdAt: deps.now?.() ?? new Date().toISOString()
  }
  deps.store.saveContactMerge(entry)
  deps.log?.('contact-merged', undefined, { provider: 'local' })
  return entry
}

export async function undoContactMerge(deps: ContactMergeDeps, entryId: string): Promise<ContactMergeResult> {
  const { store } = deps
  const entry = store.contactMerge(entryId)
  if (!entry) throw new Error('That merge can no longer be undone')
  if (entry.undoneAt) throw new Error('That merge has already been undone')
  if (entry.kind === 'local') {
    const undone = { ...entry, undoneAt: deps.now?.() ?? new Date().toISOString() }
    store.saveContactMerge(undone)
    return { entry: undone, snapshot: store.snapshot() }
  }
  const survivor = findContact(store, entry.survivorId) as SyncedContact | undefined
  if (!survivor) throw new Error('The kept contact is no longer available, so this merge cannot be undone')
  if (survivor.readOnly) throw new Error('Reconnect this account once to enable Contacts editing')
  const merged = entry.merged as SyncedContact
  if (merged.revision && survivor.revision && merged.revision !== survivor.revision) {
    throw new Error('The kept contact changed after the merge. Review it and split the details by hand.')
  }
  const connector = deps.connector(survivor.accountId, survivor.provider)
  const warnings: string[] = []
  let restored = await connector.updateContact(survivor, contactInput(entry.survivorBefore))
  store.upsertContact(restored)
  if (entry.addedGroupIds?.length) restored = (await changeGroups(deps, connector, restored, entry.addedGroupIds, 'remove', warnings)).contact
  let restoredLoserId: string | undefined
  if (entry.loserDeleted) {
    // The provider assigns a new id; the original creation date and unmodelled fields are gone.
    let recreated = await connector.createContact(contactInput(entry.loserBefore))
    store.upsertContact(recreated)
    if (survivor.provider === 'gmail') recreated = (await changeGroups(deps, connector, recreated, (entry.loserBefore as SyncedContact).groupIds ?? [], 'add', warnings)).contact
    restoredLoserId = recreated.id
  }
  const undone: ContactMergeEntry = {
    ...entry,
    undoneAt: deps.now?.() ?? new Date().toISOString(),
    ...(restoredLoserId ? { restoredLoserId } : {}),
    ...(warnings.length ? { warnings: [...(entry.warnings ?? []), ...warnings] } : {})
  }
  store.saveContactMerge(undone)
  deps.log?.('contact-merge-undone', survivor.accountId, { provider: survivor.provider, recreated: Boolean(restoredLoserId), warnings: warnings.length })
  return { entry: undone, snapshot: store.snapshot() }
}

export const associationId = (firstId: string, secondId: string) => [firstId, secondId].sort().join('|')

// Owners come from the stored provider snapshot, never from the renderer.
export function associateContacts(deps: ContactMergeDeps, kind: ContactAssociation['kind'], firstId: string, secondId: string) {
  if (firstId === secondId) throw new Error('Choose two different contacts')
  const contacts = deps.store.snapshot().contacts
  const owner = (id: string) => contacts.find((contact) => contact.id === id)?.accountId ?? 'local'
  const [a, b] = [firstId, secondId].sort()
  if (kind === 'link' && owner(a) === owner(b)) throw new Error('Contacts from the same address book can be merged instead of linked')
  deps.store.saveContactAssociation({ id: associationId(a, b), kind, contactIds: [a, b], owners: [owner(a), owner(b)], createdAt: deps.now?.() ?? new Date().toISOString() })
  return deps.store.contactAssociations()
}

export function validAssociationKind(value: unknown): value is ContactAssociation['kind'] {
  return value === 'link' || value === 'dismissed'
}

export { validId as validContactMergeId }
