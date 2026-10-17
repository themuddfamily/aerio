import { Edit3, ListPlus, Mail, Search, Trash2, UsersRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Contact, ContactList } from '../types'
import type { ProductivitySnapshot, SyncedContact, SyncedContactGroup } from '../productivity-types'
import { contactEmailAddresses } from '../lib/contact-fields'
import { categoryMembershipEdits, formatRecipient, recipientListLabel, splitRecipients, type RecipientList } from '../lib/distribution-lists'
import { isCompleteMailAddress } from '../lib/mail-address'
import { uid } from '../lib/domain'
import { useContextMenu } from './ContextMenu'
import Modal from './Modal'

export interface ContactListActions {
  localLists: ContactList[]
  groups: SyncedContactGroup[]
  onLocalListsChange(lists: ContactList[]): void
  createGroup?(accountId: string, name: string): Promise<ProductivitySnapshot>
  renameGroup?(groupId: string, name: string): Promise<ProductivitySnapshot>
  deleteGroup?(groupId: string): Promise<ProductivitySnapshot>
  updateGroupMembers?(groupId: string, add: string[], remove: string[]): Promise<ProductivitySnapshot>
  saveProviderContact?(accountId: string, contact: Contact, exists: boolean): Promise<Contact>
}

type ListTarget = { kind: 'list' } | { kind: 'group' | 'category'; accountId: string }

const isSynced = (contact: Contact): contact is SyncedContact => 'remoteId' in contact && 'accountId' in contact && 'provider' in contact
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

// Contacts a list of this kind can hold: any contact with an address for local lists, otherwise
// writable contacts from the same provider account.
export function eligibleListContacts(target: ListTarget, contacts: Contact[]) {
  if (target.kind === 'list') return contacts.filter((contact) => contactEmailAddresses(contact).length)
  return contacts.filter((contact) => isSynced(contact) && contact.accountId === target.accountId && !contact.readOnly &&
    contact.provider === (target.kind === 'group' ? 'gmail' : 'microsoft'))
}

export function ContactListsSidebar({ lists, selectedId, onSelect, onCreate, onEdit, onDelete, onEmail }: {
  lists: RecipientList[]
  selectedId?: string
  onSelect(list: RecipientList): void
  onCreate?(): void
  onEdit(list: RecipientList): void
  onDelete(list: RecipientList): void
  onEmail(list: RecipientList): void
}) {
  const { showContextMenu } = useContextMenu()
  return (
    <div className="sidebar-group">
      <span className="sidebar-label">Distribution lists {onCreate && <button className="icon-button" title="New distribution list" onClick={onCreate}><ListPlus size={14} /></button>}</span>
      {!lists.length && <p className="provider-source-note">No lists yet. Lists expand to every member when typed in To, Cc, or Bcc.</p>}
      {lists.map((list) => (
        <button key={list.id} className={`sidebar-item ${selectedId === list.id ? 'active' : ''}`} title={`${recipientListLabel(list)}${list.readOnly ? ' · read-only' : ''}`}
          onClick={() => onSelect(list)} onContextMenu={(event) => showContextMenu(event, [
            { label: `Email ${list.name}`, icon: Mail, disabled: !list.members.length, action: () => onEmail(list) },
            { label: 'Edit list', icon: Edit3, separatorBefore: true, disabled: list.readOnly, action: () => onEdit(list) },
            { label: 'Delete list', icon: Trash2, danger: true, disabled: list.readOnly || (list.kind === 'group' && !list.manageable), action: () => onDelete(list) }
          ], list.name)}>
          <UsersRound size={17} /><span>{list.name}</span><em>{list.members.length}</em>
        </button>
      ))}
    </div>
  )
}

// Applies a list edit through the right backend: local storage, Google contactGroups, or the
// categories of each Outlook contact. Returns a short summary for the toast.
export async function saveRecipientList(
  actions: ContactListActions,
  contacts: Contact[],
  original: RecipientList | undefined,
  target: ListTarget,
  name: string,
  memberIds: Set<string>,
  extraAddresses: string[]
) {
  const trimmed = name.trim()
  if (target.kind === 'list') {
    const byId = new Map(contacts.map((contact) => [contact.id, contact]))
    const members = [
      ...[...memberIds].flatMap((id) => {
        const contact = byId.get(id)
        const email = contact ? contactEmailAddresses(contact)[0] : undefined
        return contact && email ? [{ contactId: contact.id, email, name: contact.name }] : []
      }),
      ...extraAddresses.map((email) => ({ email }))
    ]
    const list: ContactList = { id: original?.id ?? uid('list'), name: trimmed, members, source: 'local' }
    actions.onLocalListsChange(original ? actions.localLists.map((item) => item.id === list.id ? { ...item, ...list } : item) : [...actions.localLists, list])
    return original ? 'List updated' : 'List created'
  }
  const previous = new Set((original?.members ?? []).flatMap((member) => member.contactId ? [member.contactId] : []))
  const add = [...memberIds].filter((id) => !previous.has(id))
  const remove = [...previous].filter((id) => !memberIds.has(id))
  if (target.kind === 'group') {
    let groupId = original?.id
    if (!groupId) {
      if (!actions.createGroup) throw new Error('Google contact groups are unavailable')
      const before = new Set(actions.groups.map((group) => group.id))
      const snapshot = await actions.createGroup(target.accountId, trimmed)
      groupId = (snapshot.contactGroups ?? []).find((group) => !before.has(group.id) && group.accountId === target.accountId)?.id
      if (!groupId) throw new Error('Google created the group but did not return it; synchronize Contacts')
    } else if (trimmed !== original?.name) {
      if (!actions.renameGroup) throw new Error('Google contact groups are unavailable')
      await actions.renameGroup(groupId, trimmed)
    }
    if (add.length || remove.length) {
      if (!actions.updateGroupMembers) throw new Error('Google contact groups are unavailable')
      await actions.updateGroupMembers(groupId, add, remove)
    }
    return original ? 'Google group updated' : 'Google group created'
  }
  // Outlook categories live on each contact; rename touches every current member.
  if (!actions.saveProviderContact) throw new Error('Provider contact editing is unavailable')
  const category = original?.name ?? trimmed
  const edits = [
    ...categoryMembershipEdits(contacts.filter((contact) => add.includes(contact.id)), trimmed, { add }),
    ...categoryMembershipEdits(contacts.filter((contact) => remove.includes(contact.id)), category, { remove }),
    ...(original && trimmed !== original.name ? categoryMembershipEdits(contacts.filter((contact) => previous.has(contact.id) && memberIds.has(contact.id)), category, { rename: trimmed }) : [])
  ]
  let failed = 0
  for (const contact of edits) {
    try {
      await actions.saveProviderContact(target.accountId, contact, true)
    } catch {
      failed += 1
    }
  }
  if (failed) throw new Error(`${failed} of ${edits.length} Outlook contacts could not be updated; synchronize Contacts and try again`)
  return `Updated ${edits.length} Outlook contact${edits.length === 1 ? '' : 's'}`
}

export async function deleteRecipientList(actions: ContactListActions, contacts: Contact[], list: RecipientList) {
  if (list.kind === 'list') {
    actions.onLocalListsChange(actions.localLists.filter((item) => item.id !== list.id))
    return 'List deleted'
  }
  if (list.kind === 'group') {
    if (!actions.deleteGroup) throw new Error('Google contact groups are unavailable')
    await actions.deleteGroup(list.id)
    return 'Google group deleted; its members stay in Google Contacts'
  }
  const ids = list.members.flatMap((member) => member.contactId ? [member.contactId] : [])
  const edits = categoryMembershipEdits(contacts.filter((contact) => ids.includes(contact.id)), list.name, { remove: ids })
  for (const contact of edits) await actions.saveProviderContact?.(list.accountId!, contact, true)
  return `Removed the ${list.name} category from ${edits.length} Outlook contact${edits.length === 1 ? '' : 's'}`
}

export function ContactListEditor({ list, contacts, providerAccounts, canCreateGroups, onClose, onSave, onToast }: {
  list?: RecipientList
  contacts: Contact[]
  providerAccounts: { id: string; email: string; provider: 'gmail' | 'microsoft' | 'dav' }[]
  canCreateGroups: boolean
  onClose(): void
  onSave(target: ListTarget, name: string, memberIds: Set<string>, extraAddresses: string[]): Promise<void>
  onToast(message: string): void
}) {
  const initialTarget = list ? (list.kind === 'list' ? 'list' : `${list.kind}:${list.accountId}`) : 'list'
  const [targetKey, setTargetKey] = useState(initialTarget)
  const target: ListTarget = targetKey === 'list' ? { kind: 'list' } : { kind: targetKey.split(':')[0] as 'group' | 'category', accountId: targetKey.slice(targetKey.indexOf(':') + 1) }
  const [name, setName] = useState(list?.name ?? '')
  const [filter, setFilter] = useState('')
  const [memberIds, setMemberIds] = useState(() => new Set((list?.members ?? []).flatMap((member) => member.contactId ? [member.contactId] : [])))
  const [extra, setExtra] = useState(() => (list?.members ?? []).filter((member) => !member.contactId).map(formatRecipient).join(', '))
  const [saving, setSaving] = useState(false)
  const eligible = useMemo(() => eligibleListContacts(target, contacts).sort((a, b) => a.name.localeCompare(b.name)), [contacts, targetKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = eligible.filter((contact) => !filter || `${contact.name} ${contactEmailAddresses(contact).join(' ')}`.toLowerCase().includes(filter.toLowerCase()))
  const renameLocked = Boolean(list && list.kind === 'group' && !list.manageable)
  const extraAddresses = splitRecipients(extra).map((value) => value.match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? value)
  const invalidExtra = extraAddresses.filter((value) => !isCompleteMailAddress(value))
  return (
    <Modal title={list ? `Edit ${list.name}` : 'New distribution list'} subtitle={target.kind === 'list' ? 'Stored locally on this PC.' : target.kind === 'group' ? 'Saved as a Google contact group.' : 'Saved as an Outlook category on each member contact.'} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Save to
          <select value={targetKey} disabled={Boolean(list)} onChange={(event) => { setTargetKey(event.target.value); setMemberIds(new Set()) }}>
            <option value="list">Local list on this PC</option>
            {providerAccounts.filter((account) => account.provider !== 'dav').map((account) => account.provider === 'gmail'
              ? canCreateGroups && <option key={account.id} value={`group:${account.id}`}>{account.email} · Google contact group</option>
              : <option key={account.id} value={`category:${account.id}`}>{account.email} · Outlook category</option>)}
          </select>
        </label>
        <label className="field-label">Name<input autoFocus value={name} disabled={renameLocked} maxLength={300} onChange={(event) => setName(event.target.value)} /></label>
        {renameLocked && <small>Google system groups keep their names; members can still be changed.</small>}
        <div className="inline-search"><Search size={16} /><input aria-label="Filter contacts" placeholder="Filter contacts" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <div className="list-member-picker" role="group" aria-label="Members">
          {shown.map((contact) => (
            <label className="check-label" key={contact.id}>
              <input type="checkbox" checked={memberIds.has(contact.id)} onChange={(event) => setMemberIds((current) => {
                const next = new Set(current)
                if (event.target.checked) next.add(contact.id)
                else next.delete(contact.id)
                return next
              })} />
              <span><strong>{contact.name}</strong> <small>{contactEmailAddresses(contact)[0] ?? 'No email address'}</small></span>
            </label>
          ))}
          {!shown.length && <small>{target.kind === 'list' ? 'No contacts with an email address match.' : 'No editable contacts from this account match. Enable provider editing to manage members.'}</small>}
        </div>
        {target.kind === 'list' && <label className="field-label">Other addresses<textarea value={extra} placeholder="name@example.com, Team Lead <lead@example.com>" onChange={(event) => setExtra(event.target.value)} /></label>}
        {invalidExtra.length > 0 && target.kind === 'list' && <small role="alert">Fix these addresses: {invalidExtra.join(', ')}</small>}
        <footer className="modal-footer">
          <small>{memberIds.size + (target.kind === 'list' ? extraAddresses.length : 0)} members</small>
          <span className="spacer" /><button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!name.trim() || saving || (target.kind === 'list' && invalidExtra.length > 0) || (target.kind === 'category' && !memberIds.size)} onClick={() => {
            setSaving(true)
            void onSave(target, name, memberIds, target.kind === 'list' ? extraAddresses : [])
              .catch((error: unknown) => onToast(errorMessage(error, 'The list could not be saved')))
              .finally(() => setSaving(false))
          }}>{saving ? 'Saving…' : 'Save list'}</button>
        </footer>
        {target.kind === 'category' && <small>Microsoft Graph has no distribution-list API for personal contacts; Aerio stores the list as an Outlook category on each member. An empty category cannot be saved.</small>}
      </div>
    </Modal>
  )
}
