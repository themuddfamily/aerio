import { Building2, Copy, Edit3, Mail, MapPin, Phone, Plus, RefreshCw, Search, Star, Trash2, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import type { AppState, Contact } from '../types'
import type { SyncedContact } from '../productivity-types'
import Modal from '../components/Modal'
import { uid } from '../lib/domain'

interface ContactsViewProps {
  state: AppState
  query: string
  onCompose(contactEmail?: string): void
  onToast(message: string): void
  onSync(): Promise<void> | void
  onEnableEditing?(accountId?: string): Promise<void> | void
  onLocalContactsChange?(contacts: Contact[]): void
  onSaveProviderContact?(accountId: string, contact: Contact, exists: boolean): Promise<Contact>
  onDeleteProviderContact?(contactId: string): Promise<void>
  providerAccounts?: { id: string; email: string; provider: 'gmail' | 'microsoft' }[]
  syncing?: boolean
  sourceMessage?: string
}

const isSyncedContact = (contact: Contact): contact is SyncedContact =>
  'remoteId' in contact && 'accountId' in contact && 'provider' in contact && 'readOnly' in contact

export default function ContactsView({
  state, query, onCompose, onToast, onSync, onEnableEditing, onLocalContactsChange,
  onSaveProviderContact, onDeleteProviderContact, providerAccounts = [], syncing = false, sourceMessage
}: ContactsViewProps) {
  const { showContextMenu } = useContextMenu()
  const [group, setGroup] = useState('All contacts')
  const [selectedId, setSelectedId] = useState(state.contacts[0]?.id ?? '')
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const groups = ['All contacts', 'Favourites', ...Array.from(new Set(state.contacts.map((contact) => contact.group)))]
  const contacts = useMemo(() => state.contacts
    .filter((contact) => group === 'All contacts' || (group === 'Favourites' ? contact.favorite : contact.group === group))
    .filter((contact) => !query || `${contact.name} ${contact.email} ${contact.company ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)), [group, query, state.contacts])
  const selected = contacts.find((contact) => contact.id === selectedId) ?? contacts[0]
  const localContacts = state.contacts.filter((contact) => contact.source === 'local')

  const saveContact = async (contact: Contact, accountId?: string) => {
    try {
      if (!accountId) {
        const exists = localContacts.some((item) => item.id === contact.id)
        onLocalContactsChange?.(exists ? localContacts.map((item) => item.id === contact.id ? contact : item) : [contact, ...localContacts])
        setSelectedId(contact.id)
        setEditing(null)
        onToast(exists ? 'Contact updated' : 'Contact created')
        return
      }
      if (!onSaveProviderContact) throw new Error('Provider contact editing is unavailable')
      const providerExists = editing !== null && editing !== 'new' && isSyncedContact(editing)
      const saved = await onSaveProviderContact(accountId, contact, providerExists)
      setSelectedId(saved.id)
      setEditing(null)
      onToast(providerExists ? 'Provider contact updated' : 'Provider contact created')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Contact could not be saved')
    }
  }

  const deleteContact = async (contact: Contact) => {
    if (!window.confirm(`Delete “${contact.name}”?`)) return
    try {
      if (isSyncedContact(contact)) {
        if (!onDeleteProviderContact) throw new Error('Provider contact editing is unavailable')
        await onDeleteProviderContact(contact.id)
      } else {
        onLocalContactsChange?.(localContacts.filter((item) => item.id !== contact.id))
      }
      setSelectedId('')
      setEditing(null)
      onToast(isSyncedContact(contact) ? 'Provider contact deleted' : 'Contact deleted')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Contact could not be deleted')
    }
  }

  const contactMenu = (contact: Contact): ContextMenuItem[] => [
    { label: 'Email', icon: Mail, disabled: !contact.email, action: () => onCompose(contact.email) },
    { label: 'Copy email address', icon: Copy, separatorBefore: true, disabled: !contact.email, action: () => copyText(contact.email) },
    ...(contact.phone ? [{ label: 'Copy phone number', icon: Phone, action: () => copyText(contact.phone!) }] satisfies ContextMenuItem[] : []),
    ...(contact.source === 'local' || (isSyncedContact(contact) && !contact.readOnly) ? [
      { label: 'Edit contact', icon: Edit3, separatorBefore: true, action: () => setEditing(contact) },
      { label: 'Delete contact', icon: Trash2, danger: true, action: () => void deleteContact(contact) }
    ] satisfies ContextMenuItem[] : isSyncedContact(contact) && onEnableEditing ? [
      { label: 'Enable provider editing', icon: Edit3, separatorBefore: true, action: () => void onEnableEditing(contact.accountId) }
    ] satisfies ContextMenuItem[] : [])
  ]

  const showContactMenu = (event: React.MouseEvent, contact: Contact) => showContextMenu(event, contactMenu(contact), contact.name)

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" onClick={() => setEditing('new')}><Plus size={18} /> New contact</button>
        <button className="button ghost small sidebar-sync" title="Synchronize provider contacts" disabled={syncing} onClick={() => void onSync()}><RefreshCw className={syncing ? 'spin' : undefined} size={15} /> {syncing ? 'Syncing…' : 'Sync now'}</button>
        {providerAccounts.length > 0 && <button className="button ghost small sidebar-sync" title="Reconnect an account with permission to edit provider contacts" disabled={syncing} onClick={() => void onEnableEditing?.()}><Edit3 size={15} /> Enable editing</button>}
        <p className="provider-source-note" aria-live="polite">{sourceMessage}</p>
        <div className="sidebar-group">
          <span className="sidebar-label">Contacts</span>
          {groups.map((item) => (
            <button className={`sidebar-item ${group === item ? 'active' : ''}`} onClick={() => setGroup(item)} onContextMenu={(event) => showContextMenu(event, [
              { label: `Open ${item}`, icon: Users, action: () => setGroup(item) }
            ], item)} key={item}>
              {item === 'Favourites' ? <Star size={17} /> : <Users size={17} />}<span>{item}</span>
              <em>{item === 'All contacts' ? state.contacts.length : item === 'Favourites' ? state.contacts.filter((contact) => contact.favorite).length : state.contacts.filter((contact) => contact.group === item).length}</em>
            </button>
          ))}
        </div>
        <div className="contact-insight"><span className="insight-number">{state.contacts.length}</span><p>contacts</p></div>
      </aside>
      <section className="contact-list-panel">
        <header className="panel-heading"><div><h1>{group}</h1><p>{contacts.length} people</p></div></header>
        <div className="inline-search"><Search size={16} /><span>{query || 'Search from the top bar'}</span></div>
        <div className="contact-list" onContextMenu={(event) => showContextMenu(event, [{ label: `Show ${group}`, icon: Users, action: () => setGroup(group) }], 'Contacts')}>
          {contacts.map((contact) => (
            <button key={contact.id} className={`contact-row ${selected?.id === contact.id ? 'selected' : ''}`} onClick={() => setSelectedId(contact.id)} onContextMenu={(event) => showContactMenu(event, contact)}>
              <span className="avatar large" style={{ background: contact.color }}>{contact.name.split(' ').map((value) => value[0]).join('')}</span>
              <span><strong>{contact.name}</strong><small>{contact.title ?? contact.group}{contact.company ? ` · ${contact.company}` : ''}</small></span>
              {contact.favorite && <Star className="favourite" size={14} fill="currentColor" />}
            </button>
          ))}
        </div>
      </section>
      <section className="contact-detail-panel">
        {selected ? <>
          <header className="contact-hero" onContextMenu={(event) => showContactMenu(event, selected)}>
            <span className="avatar hero-avatar" style={{ background: selected.color }}>{selected.name.split(' ').map((value) => value[0]).join('')}</span>
            <div><h1>{selected.name}</h1><p>{selected.title}{selected.company && ` at ${selected.company}`}</p></div>
          </header>
          <div className="contact-actions">
            <button disabled={!selected.email} onClick={() => onCompose(selected.email)}><span><Mail size={19} /></span>Email</button>
            <button onClick={() => onToast(selected.phone ? `Call ${selected.phone}` : 'No phone number saved')}><span><Phone size={19} /></span>Call</button>
            {(selected.source === 'local' || (isSyncedContact(selected) && !selected.readOnly)) && <button onClick={() => setEditing(selected)}><span><Edit3 size={19} /></span>Edit</button>}
          </div>
          <div className="contact-detail-grid">
            <section className="detail-card">
              <h3>Details</h3>
              <dl>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Email contact', icon: Mail, disabled: !selected.email, action: () => onCompose(selected.email) }, { label: 'Copy email address', icon: Copy, disabled: !selected.email, action: () => copyText(selected.email) }], 'Email')}><dt><Mail size={15} /> Email</dt><dd>{selected.email || 'Not added'}</dd></div>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: selected.phone ? `Call ${selected.name}` : 'No phone number saved', icon: Phone, disabled: !selected.phone, action: () => onToast(`Call ${selected.phone}`) }, { label: 'Copy phone number', icon: Copy, disabled: !selected.phone, action: () => copyText(selected.phone!) }], 'Phone')}><dt><Phone size={15} /> Phone</dt><dd>{selected.phone ?? 'Not added'}</dd></div>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy company', icon: Copy, disabled: !selected.company, action: () => copyText(selected.company!) }], 'Company')}><dt><Building2 size={15} /> Company</dt><dd>{selected.company ?? 'Not added'}</dd></div>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy group', icon: Copy, action: () => copyText(selected.group) }], 'Group')}><dt><MapPin size={15} /> Group</dt><dd>{selected.group}</dd></div>
              </dl>
            </section>
            <section className="detail-card" onContextMenu={(event) => { if (!window.getSelection()?.toString()) showContextMenu(event, [{ label: 'Copy notes', icon: Copy, disabled: !selected.notes, action: () => copyText(selected.notes!) }], 'Contact notes') }}>
              <h3>Notes</h3><p>{selected.notes || 'No notes supplied by the provider.'}</p>
            </section>
          </div>
        </> : <div className="empty-state grow"><Users size={32} /><h3>Select a contact</h3></div>}
      </section>
      {editing && <ContactEditor
        contact={editing === 'new' ? undefined : editing}
        providerAccounts={providerAccounts}
        onClose={() => setEditing(null)}
        onSave={saveContact}
        onDelete={editing === 'new' ? undefined : () => void deleteContact(editing)}
      />}
    </div>
  )
}

function ContactEditor({
  contact, providerAccounts, onClose, onSave, onDelete
}: {
  contact?: Contact
  providerAccounts: { id: string; email: string; provider: 'gmail' | 'microsoft' }[]
  onClose(): void
  onSave(contact: Contact, accountId?: string): Promise<void> | void
  onDelete?(): void
}) {
  const [name, setName] = useState(contact?.name ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [company, setCompany] = useState(contact?.company ?? '')
  const [title, setTitle] = useState(contact?.title ?? '')
  const [group, setGroup] = useState(contact?.group ?? 'Personal')
  const [notes, setNotes] = useState(contact?.notes ?? '')
  const [favorite, setFavorite] = useState(contact?.favorite ?? false)
  const [target, setTarget] = useState(contact && isSyncedContact(contact) ? contact.accountId : 'local')
  const [saving, setSaving] = useState(false)
  const providerTarget = providerAccounts.find((account) => account.id === target)
  return (
    <Modal
      title={contact ? 'Edit contact' : 'New contact'}
      subtitle={providerTarget ? `Saved to ${providerTarget.email} through ${providerTarget.provider === 'gmail' ? 'Google Contacts' : 'Microsoft People'}.` : 'Stored locally on this PC.'}
      onClose={onClose}
    >
      <div className="form-stack">
        <label className="field-label">Save to
          <select value={target} disabled={Boolean(contact)} onChange={(event) => setTarget(event.target.value)}>
            <option value="local">Local contacts on this PC</option>
            {providerAccounts.map((account) => <option key={account.id} value={account.id}>{account.email} · {account.provider === 'gmail' ? 'Google' : 'Microsoft'}</option>)}
          </select>
        </label>
        <label className="field-label">Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="form-grid-2">
          <label className="field-label">Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="field-label">Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
          <label className="field-label">Company<input value={company} onChange={(event) => setCompany(event.target.value)} /></label>
          <label className="field-label">Job title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field-label">Group<input value={group} onChange={(event) => setGroup(event.target.value)} /></label>
          <label className="check-label"><input type="checkbox" checked={favorite} disabled={target !== 'local'} onChange={(event) => setFavorite(event.target.checked)} /> Favourite {target !== 'local' && '(local contacts only)'}</label>
        </div>
        {target !== 'local' && <small>Provider support for contact groups varies; core name, email, phone, company, title, and notes fields are synchronized.</small>}
        <label className="field-label">Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <footer className="modal-footer">
          {onDelete && <button className="button danger-subtle" onClick={onDelete}><Trash2 size={16} /> Delete</button>}
          <span className="spacer" /><button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!name.trim() || saving} onClick={() => {
            setSaving(true)
            const next: Contact = {
              id: contact?.id ?? uid('contact'), name: name.trim(), email: email.trim(), phone: phone.trim() || undefined,
              company: company.trim() || undefined, title: title.trim() || undefined, group: group.trim() || (target === 'local' ? 'Personal' : 'Contacts'),
              notes: notes.trim() || undefined, favorite: target === 'local' ? favorite : false,
              color: contact?.color ?? (providerTarget?.provider === 'microsoft' ? '#3b6fd8' : '#4d8f78'),
              ...(target === 'local' ? { source: 'local' as const } : {})
            }
            void Promise.resolve(onSave(next, target === 'local' ? undefined : target)).finally(() => setSaving(false))
          }}>{saving ? 'Saving…' : 'Save contact'}</button>
        </footer>
      </div>
    </Modal>
  )
}
