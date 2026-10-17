import { useCallback, useEffect, useState } from 'react'
import type { Contact, ContactList } from '../types'
import type { ProductivitySnapshot } from '../productivity-types'
import type { ContactAssociation, ContactMergeDesktopApi, ContactMergeEntry } from '../contact-merge-types'
import { isSyncedContact } from '../lib/contact-duplicates'
import { buildMergedContact, relinkListMembers, restoreListMembers, sameContact, type MergeChoices } from '../lib/contact-merge'

export interface ContactMergeOptions {
  api?: ContactMergeDesktopApi
  contacts: Contact[]
  localLists: ContactList[]
  onLocalContactsChange?(contacts: Contact[]): void
  onLocalListsChange?(lists: ContactList[]): void
  onProviderSnapshot?(snapshot: ProductivitySnapshot): void
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

// Runs merges, undo, and links. Local contacts are owned by the renderer, so local merges are
// applied here and only journaled in the main process; provider merges run in the main process.
export function useContactMerge({ api, contacts, localLists, onLocalContactsChange, onLocalListsChange, onProviderSnapshot }: ContactMergeOptions) {
  const [associations, setAssociations] = useState<ContactAssociation[]>([])
  const [merges, setMerges] = useState<ContactMergeEntry[]>([])

  useEffect(() => {
    if (!api) return
    let active = true
    void api.associations().then((value) => { if (active) setAssociations(value) }).catch(() => undefined)
    void api.merges().then((value) => { if (active) setMerges(value) }).catch(() => undefined)
    return () => { active = false }
  }, [api])

  const remember = (entry: ContactMergeEntry) => setMerges((current) => [entry, ...current.filter((item) => item.id !== entry.id)])

  const merge = useCallback(async (survivor: Contact, other: Contact, choices: MergeChoices) => {
    const merged = buildMergedContact(survivor, other, choices)
    const relink = relinkListMembers(localLists, other.id, survivor.id)
    if (isSyncedContact(survivor) || isSyncedContact(other)) {
      if (!api || !isSyncedContact(survivor) || !isSyncedContact(other)) throw new Error('Provider contacts can only be merged with contacts from the same account')
      const result = await api.mergeProvider({
        survivorId: survivor.id, loserId: other.id, merged, survivorRevision: survivor.revision, loserRevision: other.revision,
        ...(relink.relinked.length ? { relinkedLists: relink.relinked } : {})
      }).catch((error: unknown) => { throw new Error(errorMessage(error, 'The contacts could not be merged')) })
      onProviderSnapshot?.(result.snapshot)
      if (result.entry.loserDeleted && relink.relinked.length) onLocalListsChange?.(relink.lists)
      remember(result.entry)
      return result.entry
    }
    if (!onLocalContactsChange) throw new Error('Local contact editing is unavailable')
    const local = contacts.filter((contact) => contact.source === 'local')
    onLocalContactsChange(local.filter((contact) => contact.id !== other.id).map((contact) => contact.id === survivor.id ? merged : contact))
    if (relink.relinked.length) onLocalListsChange?.(relink.lists)
    const record = { survivorBefore: survivor, loserBefore: other, merged, ...(relink.relinked.length ? { relinkedLists: relink.relinked } : {}) }
    // Without the journal the merge still happens, but it cannot be undone later.
    const entry = api ? await api.recordLocalMerge(record).catch(() => undefined) : undefined
    if (entry) remember(entry)
    return entry
  }, [api, contacts, localLists, onLocalContactsChange, onLocalListsChange, onProviderSnapshot])

  const undo = useCallback(async (entry: ContactMergeEntry) => {
    if (!api) throw new Error('Undo is unavailable')
    if (entry.kind === 'local') {
      const current = contacts.find((contact) => contact.id === entry.survivorId)
      if (!current || !sameContact(current, entry.merged)) throw new Error('The kept contact changed after the merge, so it was not undone. Edit it by hand instead.')
      if (contacts.some((contact) => contact.id === entry.loserId)) throw new Error('The merged contact already exists again')
      if (!onLocalContactsChange) throw new Error('Local contact editing is unavailable')
      const result = await api.undo(entry.id).catch((error: unknown) => { throw new Error(errorMessage(error, 'The merge could not be undone')) })
      const local = contacts.filter((contact) => contact.source === 'local')
      onLocalContactsChange(local.flatMap((contact) => contact.id === entry.survivorId ? [entry.survivorBefore, entry.loserBefore] : [contact]))
      if (entry.relinkedLists?.length) onLocalListsChange?.(restoreListMembers(localLists, entry.relinkedLists, entry.survivorId, entry.loserId))
      remember(result.entry)
      return result.entry
    }
    const result = await api.undo(entry.id).catch((error: unknown) => { throw new Error(errorMessage(error, 'The merge could not be undone')) })
    onProviderSnapshot?.(result.snapshot)
    if (result.entry.restoredLoserId && entry.relinkedLists?.length) onLocalListsChange?.(restoreListMembers(localLists, entry.relinkedLists, entry.survivorId, result.entry.restoredLoserId))
    remember(result.entry)
    return result.entry
  }, [api, contacts, localLists, onLocalContactsChange, onLocalListsChange, onProviderSnapshot])

  const associate = useCallback(async (kind: ContactAssociation['kind'], first: Contact, second: Contact) => {
    if (!api) throw new Error('Contact links are unavailable')
    setAssociations(await api.associate(kind, first.id, second.id).catch((error: unknown) => { throw new Error(errorMessage(error, 'The contacts could not be linked')) }))
  }, [api])

  const removeAssociation = useCallback(async (id: string) => {
    if (!api) throw new Error('Contact links are unavailable')
    setAssociations(await api.removeAssociation(id))
  }, [api])

  return { available: Boolean(api), associations, merges, merge, undo, associate, removeAssociation }
}
