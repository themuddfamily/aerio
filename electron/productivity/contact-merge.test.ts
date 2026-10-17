import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '../../src/types'
import type { SyncedContact, SyncedContactGroup } from '../../src/productivity-types'
import { ProductivityStore } from './store'
import { associateContacts, mergeProviderContacts, recordLocalMerge, undoContactMerge, type ContactMergeDeps, type ContactWriteConnector } from './contact-merge'
import { registerContactMerge } from './contact-merge-ipc'

const directories: string[] = []
const stores: ProductivityStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const google = (id: string, extra: Partial<SyncedContact> = {}): SyncedContact => ({
  id: `g1:google-contact:people/${id}`, remoteId: `people/${id}`, accountId: 'g1', provider: 'gmail', readOnly: false, revision: `etag-${id}`,
  name: 'Ada Lovelace', email: `${id}@example.test`, group: 'Google', favorite: false, color: '#000', groupIds: ['contactGroups/myContacts'], ...extra
})
const groups: SyncedContactGroup[] = [
  { id: 'g1:group:team', remoteId: 'contactGroups/team', accountId: 'g1', provider: 'gmail', name: 'Team', system: false, readOnly: false },
  { id: 'g1:group:locked', remoteId: 'contactGroups/locked', accountId: 'g1', provider: 'gmail', name: 'Locked', system: true, readOnly: true }
]

function setup(contacts: SyncedContact[]) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-contact-merge-'))
  directories.push(directory)
  const store = new ProductivityStore(join(directory, 'productivity.sqlite'))
  stores.push(store)
  store.replaceAccount('g1', 'gmail', { calendars: [], events: [], contacts: contacts.filter((contact) => contact.accountId === 'g1'), contactGroups: groups })
  const other = contacts.filter((contact) => contact.accountId !== 'g1')
  if (other.length) store.replaceAccount(other[0].accountId, other[0].provider, { calendars: [], events: [], contacts: other })
  let created = 0
  let revision = 0
  const connector = {
    createContact: vi.fn(async (contact: Contact) => ({ ...contact, id: `g1:google-contact:people/new-${++created}`, remoteId: `people/new-${created}`, accountId: 'g1', provider: 'gmail', readOnly: false, revision: 'etag-new', groupIds: ['contactGroups/myContacts'] }) as SyncedContact),
    updateContact: vi.fn(async (current: SyncedContact, contact: Contact) => ({ ...current, ...contact, remoteId: current.remoteId, accountId: current.accountId, provider: current.provider, readOnly: false, revision: `etag-updated-${++revision}` }) as SyncedContact),
    deleteContact: vi.fn(async () => undefined),
    modifyContactGroupMembers: vi.fn(async (group: SyncedContactGroup, add: SyncedContact[], remove: SyncedContact[]) => ({
      contacts: [...add.map((contact) => ({ ...contact, groupIds: [...(contact.groupIds ?? []), group.remoteId], revision: `${contact.revision}+g` })), ...remove.map((contact) => ({ ...contact, groupIds: (contact.groupIds ?? []).filter((id) => id !== group.remoteId) }))]
    }))
  } satisfies ContactWriteConnector
  let ids = 0
  const deps: ContactMergeDeps = { store, connector: vi.fn(() => connector), now: () => `2026-10-17T10:00:0${ids}.000Z`, id: () => `merge-${++ids}`, log: vi.fn() }
  return { store, connector, deps }
}

describe('provider contact merges', () => {
  const survivor = google('1', { phones: [{ value: '+44 1' }] })
  const loser = google('2', { name: 'Ada King', groupIds: ['contactGroups/myContacts', 'contactGroups/team', 'contactGroups/locked'], groups: ['Team', 'Locked'] })
  const merged = { ...survivor, emails: [{ value: survivor.email }, { value: loser.email }] }

  it('updates the survivor with its revision, joins the duplicate groups, deletes the duplicate, and journals the originals', async () => {
    const { store, connector, deps } = setup([survivor, loser])
    const result = await mergeProviderContacts(deps, { survivorId: survivor.id, loserId: loser.id, merged, survivorRevision: survivor.revision, loserRevision: loser.revision, relinkedLists: [{ listId: 'l1', email: loser.email }] })
    expect(connector.updateContact).toHaveBeenCalledWith(expect.objectContaining({ id: survivor.id, revision: 'etag-1' }), merged)
    expect(connector.modifyContactGroupMembers).toHaveBeenCalledTimes(1)
    expect(connector.modifyContactGroupMembers).toHaveBeenCalledWith(groups[0], [expect.objectContaining({ id: survivor.id })], [])
    expect(connector.deleteContact).toHaveBeenCalledWith(expect.objectContaining({ id: loser.id }))
    expect(result.snapshot.contacts.map((contact) => contact.id)).toEqual([survivor.id])
    expect(result.entry).toMatchObject({ kind: 'provider', accountId: 'g1', loserDeleted: true, addedGroupIds: ['contactGroups/team'], relinkedLists: [{ listId: 'l1', email: loser.email }], survivorBefore: survivor, loserBefore: loser })
    expect(result.entry.warnings?.join(' ')).toMatch(/1 contact group could not be edited/)
    expect(store.contactMerges()).toEqual([result.entry])
  })

  it('rejects stale revisions, other accounts, and read-only contacts before writing anything', async () => {
    const outlook: SyncedContact = { ...google('3'), id: 'm1:contact:3', accountId: 'm1', provider: 'microsoft' }
    const readOnly = google('4', { readOnly: true })
    const { connector, deps } = setup([survivor, loser, outlook, readOnly])
    await expect(mergeProviderContacts(deps, { survivorId: survivor.id, loserId: loser.id, merged, survivorRevision: 'etag-old', loserRevision: loser.revision })).rejects.toThrow(/changed since you opened it/)
    await expect(mergeProviderContacts(deps, { survivorId: survivor.id, loserId: loser.id, merged, survivorRevision: survivor.revision, loserRevision: 'etag-old' })).rejects.toThrow(/changed since you opened it/)
    await expect(mergeProviderContacts(deps, { survivorId: survivor.id, loserId: outlook.id, merged })).rejects.toThrow(/Link them instead/)
    await expect(mergeProviderContacts(deps, { survivorId: survivor.id, loserId: readOnly.id, merged })).rejects.toThrow(/enable Contacts editing/)
    await expect(mergeProviderContacts(deps, { survivorId: survivor.id, loserId: 'missing', merged })).rejects.toThrow(/no longer available/)
    expect(connector.updateContact).not.toHaveBeenCalled()
    expect(connector.deleteContact).not.toHaveBeenCalled()
  })

  it('keeps an undoable journal entry when the duplicate cannot be deleted', async () => {
    const { store, connector, deps } = setup([survivor, loser])
    connector.deleteContact.mockRejectedValueOnce(new Error('Gone'))
    const result = await mergeProviderContacts(deps, { survivorId: survivor.id, loserId: loser.id, merged, survivorRevision: survivor.revision, loserRevision: loser.revision })
    expect(result.entry.loserDeleted).toBe(false)
    expect(result.entry.warnings?.join(' ')).toMatch(/could not be deleted: Gone/)
    expect(store.snapshot().contacts).toHaveLength(2)
    // Undo then restores the survivor and does not recreate a contact that still exists.
    const undone = await undoContactMerge(deps, result.entry.id)
    expect(connector.createContact).not.toHaveBeenCalled()
    expect(undone.entry.undoneAt).toBeDefined()
  })

  it('undoes a merge by restoring the survivor, leaving added groups, and recreating the duplicate', async () => {
    const { store, connector, deps } = setup([survivor, loser])
    const { entry } = await mergeProviderContacts(deps, { survivorId: survivor.id, loserId: loser.id, merged, survivorRevision: survivor.revision, loserRevision: loser.revision })
    connector.modifyContactGroupMembers.mockClear()
    const undone = await undoContactMerge(deps, entry.id)
    const restoredInput = connector.updateContact.mock.calls.at(-1)![1]
    expect(restoredInput).toMatchObject({ id: survivor.id, name: survivor.name, phones: survivor.phones })
    expect(restoredInput).not.toHaveProperty('remoteId')
    expect(restoredInput).not.toHaveProperty('providerData')
    expect(connector.modifyContactGroupMembers).toHaveBeenCalledWith(groups[0], [], [expect.objectContaining({ id: survivor.id })])
    expect(connector.createContact).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ada King', email: loser.email }))
    expect(connector.createContact.mock.calls[0][0]).not.toHaveProperty('remoteId')
    expect(connector.modifyContactGroupMembers).toHaveBeenCalledWith(groups[0], [expect.objectContaining({ id: 'g1:google-contact:people/new-1' })], [])
    expect(undone.entry).toMatchObject({ restoredLoserId: 'g1:google-contact:people/new-1', undoneAt: expect.any(String) })
    expect(store.snapshot().contacts.map((contact) => contact.id).sort()).toEqual([survivor.id, 'g1:google-contact:people/new-1'].sort())
    await expect(undoContactMerge(deps, entry.id)).rejects.toThrow(/already been undone/)
  })

  it('refuses to undo when the survivor changed after the merge', async () => {
    const { store, connector, deps } = setup([survivor, loser])
    const { entry } = await mergeProviderContacts(deps, { survivorId: survivor.id, loserId: loser.id, merged, survivorRevision: survivor.revision, loserRevision: loser.revision })
    store.upsertContact({ ...(store.snapshot().contacts[0]), revision: 'etag-synced-later' })
    connector.updateContact.mockClear()
    await expect(undoContactMerge(deps, entry.id)).rejects.toThrow(/changed after the merge/)
    expect(connector.updateContact).not.toHaveBeenCalled()
    await expect(undoContactMerge(deps, 'missing')).rejects.toThrow(/can no longer be undone/)
  })
})

describe('local merges, links, and account removal', () => {
  const localA: Contact = { id: 'a', name: 'Ada', email: 'ada@x.test', group: 'Personal', favorite: false, color: '#000', source: 'local' }
  const localB: Contact = { ...localA, id: 'b', name: 'Ada L' }

  it('journals local merges and only marks them as undone in the main process', async () => {
    const { store, connector, deps } = setup([])
    const entry = recordLocalMerge(deps, { survivorBefore: localA, loserBefore: localB, merged: { ...localA, name: 'Ada L' } })
    expect(entry).toMatchObject({ kind: 'local', survivorId: 'a', loserId: 'b', loserDeleted: true })
    const undone = await undoContactMerge(deps, entry.id)
    expect(undone.entry.undoneAt).toBeDefined()
    expect(connector.updateContact).not.toHaveBeenCalled()
    expect(store.contactMerge(entry.id)?.undoneAt).toBeDefined()
  })

  it('links contacts across owners only and records dismissals; removing an account drops its links and journal', async () => {
    const providerContact = google('1')
    const outlook: SyncedContact = { ...google('9'), id: 'm1:contact:9', accountId: 'm1', provider: 'microsoft' }
    const { store, deps } = setup([providerContact, google('2'), outlook])
    expect(associateContacts(deps, 'link', providerContact.id, 'local-a')).toEqual([expect.objectContaining({ kind: 'link', owners: expect.arrayContaining(['g1', 'local']) })])
    expect(() => associateContacts(deps, 'link', providerContact.id, google('2').id)).toThrow(/merged instead/)
    associateContacts(deps, 'dismissed', providerContact.id, google('2').id)
    associateContacts(deps, 'link', outlook.id, 'local-a')
    expect(store.contactAssociations()).toHaveLength(3)
    await mergeProviderContacts(deps, { survivorId: providerContact.id, loserId: google('2').id, merged: providerContact, survivorRevision: providerContact.revision, loserRevision: 'etag-2' })
    recordLocalMerge(deps, { survivorBefore: localA, loserBefore: localB, merged: localA })
    store.removeAccount('g1')
    expect(store.contactAssociations().map((association) => association.owners)).toEqual([['local', 'm1']])
    expect(store.contactMerges().map((entry) => entry.kind)).toEqual(['local'])
  })

  it('keeps only the most recent journal entries', () => {
    const { store } = setup([])
    for (let index = 0; index < 5; index += 1) {
      store.saveContactMerge({ id: `e${index}`, kind: 'local', survivorId: 'a', loserId: 'b', survivorBefore: localA, loserBefore: localB, merged: localA, loserDeleted: true, createdAt: `2026-10-0${index + 1}T00:00:00.000Z` }, 3)
    }
    expect(store.contactMerges().map((entry) => entry.id)).toEqual(['e4', 'e3', 'e2'])
  })
})

describe('contact merge IPC', () => {
  it('validates renderer input before reaching the stores', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const { deps } = setup([google('1'), google('2')])
    const validContact = (value: unknown): value is Contact => Boolean(value && typeof value === 'object' && typeof (value as Contact).id === 'string' && typeof (value as Contact).name === 'string')
    registerContactMerge({ handle: (channel, listener) => { handlers.set(channel, listener) } }, () => deps, validContact)
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
    expect(() => invoke('contacts:merge-provider', { survivorId: 'x', loserId: 'x', merged: { id: 'x', name: 'A' } })).toThrow(/review the merged details/)
    expect(() => invoke('contacts:merge-provider', { survivorId: 'x', loserId: 'y', merged: { id: 'y', name: 'A' } })).toThrow(/review the merged details/)
    expect(() => invoke('contacts:merge-local-record', { survivorBefore: { id: 'a', name: 'A', source: 'local' }, loserBefore: { id: 'b', name: 'B' }, merged: { id: 'a', name: 'A' } })).toThrow(/invalid/)
    expect(() => invoke('contacts:merge-undo', '')).toThrow(/Choose a merge/)
    expect(() => invoke('contacts:associate', 'merge', 'a', 'b')).toThrow(/Choose two contacts/)
    expect(invoke('contacts:associate', 'dismissed', 'a', 'b')).toHaveLength(1)
    expect(invoke('contacts:association-remove', 'a|b')).toEqual([])
    expect(invoke('contacts:merges')).toEqual([])
    await expect(invoke('contacts:merge-provider', { survivorId: google('1').id, loserId: google('2').id, merged: google('1'), survivorRevision: 'etag-1', loserRevision: 'etag-2' })).resolves.toMatchObject({ entry: { kind: 'provider' } })
  })
})
