import type { Contact } from '../../src/types'
import {
  associateContacts, mergeProviderContacts, recordLocalMerge, undoContactMerge, validAssociationKind, validContactMergeId,
  validLocalMergeRecord, validProviderMergeInput, type ContactMergeDeps
} from './contact-merge'

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

// Contact merge, undo, and link handlers. Every write is validated here; provider ownership and
// revisions are checked again against the stored snapshot in contact-merge.ts.
export function registerContactMerge(ipc: IpcRegistrar, deps: () => ContactMergeDeps, validContact: (value: unknown) => value is Contact) {
  ipc.handle('contacts:merges', () => deps().store.contactMerges())
  ipc.handle('contacts:merge-provider', (_event, input: unknown) => {
    if (!validProviderMergeInput(input, validContact)) throw new Error('Choose two contacts and review the merged details')
    return mergeProviderContacts(deps(), input)
  })
  ipc.handle('contacts:merge-local-record', (_event, record: unknown) => {
    if (!validLocalMergeRecord(record, validContact)) throw new Error('The local contact merge is invalid')
    return recordLocalMerge(deps(), record)
  })
  ipc.handle('contacts:merge-undo', (_event, entryId: unknown) => {
    if (!validContactMergeId(entryId)) throw new Error('Choose a merge to undo')
    return undoContactMerge(deps(), entryId)
  })
  ipc.handle('contacts:associations', () => deps().store.contactAssociations())
  ipc.handle('contacts:associate', (_event, kind: unknown, firstId: unknown, secondId: unknown) => {
    if (!validAssociationKind(kind) || !validContactMergeId(firstId) || !validContactMergeId(secondId)) throw new Error('Choose two contacts')
    return associateContacts(deps(), kind, firstId, secondId)
  })
  ipc.handle('contacts:association-remove', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 1_001) throw new Error('Choose a contact link')
    const store = deps().store
    store.deleteContactAssociation(id)
    return store.contactAssociations()
  })
}
