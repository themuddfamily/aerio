import {
  Building2, Copy, Edit3, Mail, MapPin, MessageCircle, Phone, Plus, RefreshCw, Search, Star, Trash2, Users
} from 'lucide-react'
import { useMemo, useState } from 'react'
import Modal from '../components/Modal'
import { uid } from '../lib/domain'
import type { AppState, Contact, Message } from '../types'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'

interface ContactsViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onCompose(replyTo?: Message, contactEmail?: string): void
  onChat(contact: Contact): void
  onOpenMessage(messageId: string): void
  onToast(message: string): void
  readOnly?: boolean
  onSync?(): Promise<void> | void
  syncing?: boolean
  sourceMessage?: string
}

export default function ContactsView({ state, query, onChange, onCompose, onChat, onOpenMessage, onToast, readOnly = false, onSync, syncing = false, sourceMessage }: ContactsViewProps) {
  const { showContextMenu } = useContextMenu()
  const [group, setGroup] = useState('All contacts')
  const [selectedId, setSelectedId] = useState(state.contacts[0]?.id ?? '')
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const groups = ['All contacts', 'Favourites', ...Array.from(new Set(state.contacts.map((contact) => contact.group)))]
  const contacts = useMemo(() => state.contacts
    .filter((contact) => group === 'All contacts' || (group === 'Favourites' ? contact.favorite : contact.group === group))
    .filter((contact) => !query || `${contact.name} ${contact.email} ${contact.company ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)),
  [group, query, state.contacts])
  const selected = contacts.find((contact) => contact.id === selectedId) ?? contacts[0]
  const related = selected ? state.messages.filter((message) => message.fromEmail === selected.email || message.to.includes(selected.email)).slice(0, 4) : []

  const toggleFavourite = (contact: Contact) => {
    if (readOnly) return
    onChange({
      ...state,
      contacts: state.contacts.map((item) => item.id === contact.id ? { ...item, favorite: !item.favorite } : item)
    })
  }

  const deleteContact = (contact: Contact) => {
    if (readOnly) return
    if (!window.confirm(`Delete ${contact.name} from your contacts?`)) return
    onChange({ ...state, contacts: state.contacts.filter((item) => item.id !== contact.id) })
    if (selectedId === contact.id) setSelectedId('')
    onToast('Contact deleted')
  }

  const contactMenu = (contact: Contact): ContextMenuItem[] => [
    { label: 'Email', icon: Mail, disabled: !contact.email, action: () => onCompose(undefined, contact.email) },
    ...(!readOnly ? [{ label: 'Start chat', icon: MessageCircle, action: () => onChat(contact) }] satisfies ContextMenuItem[] : []),
    ...(!readOnly ? [
      { label: 'Edit contact', icon: Edit3, separatorBefore: true, action: () => setEditing(contact) },
      { label: contact.favorite ? 'Remove from favourites' : 'Add to favourites', icon: Star, checked: contact.favorite, action: () => toggleFavourite(contact) }
    ] satisfies ContextMenuItem[] : []),
    { label: 'Copy email address', icon: Copy, separatorBefore: true, disabled: !contact.email, action: () => copyText(contact.email) },
    ...(contact.phone ? [{ label: 'Copy phone number', icon: Phone, action: () => copyText(contact.phone!) }] satisfies ContextMenuItem[] : []),
    ...(!readOnly ? [{ label: 'Delete contact', icon: Trash2, separatorBefore: true, danger: true, action: () => deleteContact(contact) }] satisfies ContextMenuItem[] : [])
  ]

  const showContactMenu = (event: React.MouseEvent, contact: Contact) => showContextMenu(event, contactMenu(contact), contact.name)

  const showRelatedMenu = (event: React.MouseEvent, message: Message) => showContextMenu(event, [
    { label: 'Open message', icon: Mail, action: () => onOpenMessage(message.id) },
    { label: 'Reply', icon: MessageCircle, action: () => onCompose(message) },
    { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(message.subject) },
    { label: 'Copy sender address', icon: Copy, action: () => copyText(message.fromEmail) }
  ], message.subject)

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        {readOnly
          ? <><button className="compose-button" disabled={syncing} onClick={() => void onSync?.()}><RefreshCw className={syncing ? 'spin' : undefined} size={18} /> {syncing ? 'Syncing…' : 'Sync now'}</button><p className="provider-source-note" aria-live="polite">{sourceMessage}</p></>
          : <button className="compose-button" onClick={() => setEditing('new')}><Plus size={18} /> New contact</button>}
        <div className="sidebar-group">
          <span className="sidebar-label">Contacts</span>
          {groups.map((item) => (
            <button className={`sidebar-item ${group === item ? 'active' : ''}`} onClick={() => setGroup(item)} onContextMenu={(event) => showContextMenu(event, [
              { label: `Open ${item}`, icon: Users, action: () => setGroup(item) },
              ...(!readOnly ? [{ label: 'New contact', icon: Plus, separatorBefore: true, action: () => setEditing('new') }] satisfies ContextMenuItem[] : [])
            ], item)} key={item}>
              {item === 'Favourites' ? <Star size={17} /> : <Users size={17} />}<span>{item}</span>
              <em>{item === 'All contacts' ? state.contacts.length : item === 'Favourites' ? state.contacts.filter((contact) => contact.favorite).length : state.contacts.filter((contact) => contact.group === item).length}</em>
            </button>
          ))}
        </div>
        <div className="contact-insight">
          <span className="insight-number">{state.contacts.length}</span>
          <p>people in your quiet little universe</p>
        </div>
      </aside>
      <section className="contact-list-panel">
        <header className="panel-heading"><div><h1>{group}</h1><p>{contacts.length} people</p></div></header>
        <div className="inline-search"><Search size={16} /><span>{query || 'Search from the top bar'}</span></div>
        <div className="contact-list" onContextMenu={(event) => showContextMenu(event, [
          ...(!readOnly ? [{ label: 'New contact', icon: Plus, action: () => setEditing('new') }] satisfies ContextMenuItem[] : []),
          { label: `Show ${group}`, icon: Users, action: () => setGroup(group) }
        ], 'Contacts')}>
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
        {selected ? (
          <>
            <header className="contact-hero" onContextMenu={(event) => showContactMenu(event, selected)}>
              <span className="avatar hero-avatar" style={{ background: selected.color }}>{selected.name.split(' ').map((value) => value[0]).join('')}</span>
              <div><h1>{selected.name}</h1><p>{selected.title}{selected.company && ` at ${selected.company}`}</p></div>
              <span className="spacer" />
              {!readOnly && <><button className={`icon-button ${selected.favorite ? 'active' : ''}`} aria-label={selected.favorite ? 'Remove from favourites' : 'Add to favourites'} title={selected.favorite ? 'Remove from favourites' : 'Add to favourites'} onClick={() => toggleFavourite(selected)}><Star size={18} fill={selected.favorite ? 'currentColor' : 'none'} /></button>
              <button className="icon-button" aria-label="Edit contact" title="Edit contact" onClick={() => setEditing(selected)}><Edit3 size={18} /></button></>}
            </header>
            <div className="contact-actions">
              <button disabled={!selected.email} onClick={() => onCompose(undefined, selected.email)}><span><Mail size={19} /></span>Email</button>
              {!readOnly && <button onClick={() => onChat(selected)}><span><MessageCircle size={19} /></span>Chat</button>}
              <button onClick={() => onToast(selected.phone ? `Call ${selected.phone}` : 'No phone number saved')}><span><Phone size={19} /></span>Call</button>
            </div>
            <div className="contact-detail-grid">
              <section className="detail-card">
                <h3>Details</h3>
                <dl>
                  <div onContextMenu={(event) => showContextMenu(event, [
                    { label: 'Email contact', icon: Mail, disabled: !selected.email, action: () => onCompose(undefined, selected.email) },
                    { label: 'Copy email address', icon: Copy, disabled: !selected.email, action: () => copyText(selected.email) }
                  ], 'Email')}><dt><Mail size={15} /> Email</dt><dd>{selected.email || 'Not added'}</dd></div>
                  <div onContextMenu={(event) => showContextMenu(event, [
                    { label: selected.phone ? `Call ${selected.name}` : 'No phone number saved', icon: Phone, disabled: !selected.phone, action: () => onToast(`Call ${selected.phone}`) },
                    { label: 'Copy phone number', icon: Copy, disabled: !selected.phone, action: () => copyText(selected.phone!) }
                  ], 'Phone')}><dt><Phone size={15} /> Phone</dt><dd>{selected.phone ?? 'Not added'}</dd></div>
                  <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy company', icon: Copy, disabled: !selected.company, action: () => copyText(selected.company!) }], 'Company')}><dt><Building2 size={15} /> Company</dt><dd>{selected.company ?? 'Not added'}</dd></div>
                  <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy group', icon: Copy, action: () => copyText(selected.group) }], 'Group')}><dt><MapPin size={15} /> Group</dt><dd>{selected.group}</dd></div>
                </dl>
              </section>
              <section className="detail-card" onContextMenu={(event) => {
                if (window.getSelection()?.toString()) return
                showContextMenu(event, [
                  ...(!readOnly ? [{ label: 'Edit contact notes', icon: Edit3, action: () => setEditing(selected) }] satisfies ContextMenuItem[] : []),
                  { label: 'Copy notes', icon: Copy, disabled: !selected.notes, action: () => copyText(selected.notes!) }
                ], 'Contact notes')
              }}>
                <h3>Notes</h3>
                <p>{selected.notes || 'No notes yet. Edit this contact to add some useful context.'}</p>
              </section>
            </div>
            <section className="related-section">
              <h3>Recent conversations</h3>
              {related.map((message) => (
                <button key={message.id} className="related-message" onClick={() => onOpenMessage(message.id)} onContextMenu={(event) => showRelatedMenu(event, message)}>
                  <span className="related-icon"><Mail size={16} /></span>
                  <span><strong>{message.subject}</strong><small>{message.preview}</small></span>
                  <time>{new Date(message.date).toLocaleDateString()}</time>
                </button>
              ))}
              {related.length === 0 && <p className="muted-copy">No conversations yet.</p>}
            </section>
          </>
        ) : <div className="empty-state grow"><Users size={32} /><h3>Select a contact</h3></div>}
      </section>
      {editing && !readOnly && (
        <ContactEditor
          contact={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(contact) => {
            const exists = state.contacts.some((item) => item.id === contact.id)
            onChange({ ...state, contacts: exists ? state.contacts.map((item) => item.id === contact.id ? contact : item) : [contact, ...state.contacts] })
            setSelectedId(contact.id)
            setEditing(null)
            onToast(exists ? 'Contact updated' : 'Contact created')
          }}
          onDelete={editing === 'new' ? undefined : () => {
            onChange({ ...state, contacts: state.contacts.filter((contact) => contact.id !== editing.id) })
            setEditing(null)
            onToast('Contact deleted')
          }}
        />
      )}
    </div>
  )
}

function ContactEditor({ contact, onClose, onSave, onDelete }: { contact?: Contact; onClose(): void; onSave(contact: Contact): void; onDelete?(): void }) {
  const [name, setName] = useState(contact?.name ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [company, setCompany] = useState(contact?.company ?? '')
  const [title, setTitle] = useState(contact?.title ?? '')
  const [group, setGroup] = useState(contact?.group ?? 'Contacts')
  const [notes, setNotes] = useState(contact?.notes ?? '')
  return (
    <Modal title={contact ? 'Edit contact' : 'New contact'} onClose={onClose}>
      <div className="form-stack">
        <div className="form-grid-2">
          <label className="field-label">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field-label">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field-label">Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label className="field-label">Group<input value={group} onChange={(e) => setGroup(e.target.value)} /></label>
          <label className="field-label">Company<input value={company} onChange={(e) => setCompany(e.target.value)} /></label>
          <label className="field-label">Job title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <label className="field-label">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <footer className="modal-footer">
          {onDelete && <button className="button danger-subtle" onClick={onDelete}><Trash2 size={16} /> Delete</button>}
          <span className="spacer" /><button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!name.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())} title={email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim()) ? 'Enter a valid email address' : undefined} onClick={() => onSave({
            id: contact?.id ?? uid('contact'), name: name.trim(), email: email.trim(), phone, company, title, group, notes,
            favorite: contact?.favorite ?? false, color: contact?.color ?? ['#6659e8', '#4d9f86', '#e18a65', '#d26791'][Math.floor(Math.random() * 4)]
          })}>Save contact</button>
        </footer>
      </div>
    </Modal>
  )
}
