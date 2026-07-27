import {
  Building2, Edit3, Mail, MapPin, MessageCircle, Phone, Plus, Search, Star, Trash2, Users
} from 'lucide-react'
import { useMemo, useState } from 'react'
import Modal from '../components/Modal'
import { uid } from '../lib/domain'
import type { AppState, Contact, Message } from '../types'

interface ContactsViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onCompose(replyTo?: Message, contactEmail?: string): void
  onToast(message: string): void
}

export default function ContactsView({ state, query, onChange, onCompose, onToast }: ContactsViewProps) {
  const [group, setGroup] = useState('All contacts')
  const [selectedId, setSelectedId] = useState(state.contacts[0]?.id ?? '')
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const groups = ['All contacts', 'Favourites', ...Array.from(new Set(state.contacts.map((contact) => contact.group)))]
  const contacts = useMemo(() => state.contacts
    .filter((contact) => group === 'All contacts' || (group === 'Favourites' ? contact.favorite : contact.group === group))
    .filter((contact) => !query || `${contact.name} ${contact.email} ${contact.company ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)),
  [group, query, state.contacts])
  const selected = state.contacts.find((contact) => contact.id === selectedId) ?? contacts[0]
  const related = selected ? state.messages.filter((message) => message.fromEmail === selected.email || message.to.includes(selected.email)).slice(0, 4) : []

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" onClick={() => setEditing('new')}><Plus size={18} /> New contact</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Contacts</span>
          {groups.map((item) => (
            <button className={`sidebar-item ${group === item ? 'active' : ''}`} onClick={() => setGroup(item)} key={item}>
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
        <div className="contact-list">
          {contacts.map((contact) => (
            <button key={contact.id} className={`contact-row ${selected?.id === contact.id ? 'selected' : ''}`} onClick={() => setSelectedId(contact.id)}>
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
            <header className="contact-hero">
              <span className="avatar hero-avatar" style={{ background: selected.color }}>{selected.name.split(' ').map((value) => value[0]).join('')}</span>
              <div><h1>{selected.name}</h1><p>{selected.title}{selected.company && ` at ${selected.company}`}</p></div>
              <span className="spacer" />
              <button className={`icon-button ${selected.favorite ? 'active' : ''}`} onClick={() => onChange({ ...state, contacts: state.contacts.map((contact) => contact.id === selected.id ? { ...contact, favorite: !contact.favorite } : contact) })}><Star size={18} fill={selected.favorite ? 'currentColor' : 'none'} /></button>
              <button className="icon-button" onClick={() => setEditing(selected)}><Edit3 size={18} /></button>
            </header>
            <div className="contact-actions">
              <button onClick={() => onCompose(undefined, selected.email)}><span><Mail size={19} /></span>Email</button>
              <button onClick={() => onToast(`Starting a demo chat with ${selected.name}`)}><span><MessageCircle size={19} /></span>Chat</button>
              <button onClick={() => onToast(selected.phone ? `Call ${selected.phone}` : 'No phone number saved')}><span><Phone size={19} /></span>Call</button>
            </div>
            <div className="contact-detail-grid">
              <section className="detail-card">
                <h3>Details</h3>
                <dl>
                  <div><dt><Mail size={15} /> Email</dt><dd>{selected.email}</dd></div>
                  <div><dt><Phone size={15} /> Phone</dt><dd>{selected.phone ?? 'Not added'}</dd></div>
                  <div><dt><Building2 size={15} /> Company</dt><dd>{selected.company ?? 'Not added'}</dd></div>
                  <div><dt><MapPin size={15} /> Group</dt><dd>{selected.group}</dd></div>
                </dl>
              </section>
              <section className="detail-card">
                <h3>Notes</h3>
                <p>{selected.notes || 'No notes yet. Edit this contact to add some useful context.'}</p>
              </section>
            </div>
            <section className="related-section">
              <h3>Recent conversations</h3>
              {related.map((message) => (
                <button key={message.id} className="related-message">
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
      {editing && (
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
          <button className="button primary" onClick={() => name.trim() && email.trim() && onSave({
            id: contact?.id ?? uid('contact'), name: name.trim(), email: email.trim(), phone, company, title, group, notes,
            favorite: contact?.favorite ?? false, color: contact?.color ?? ['#6659e8', '#4d9f86', '#e18a65', '#d26791'][Math.floor(Math.random() * 4)]
          })}>Save contact</button>
        </footer>
      </div>
    </Modal>
  )
}
