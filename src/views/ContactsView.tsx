import { Building2, Copy, Mail, MapPin, Phone, RefreshCw, Search, Star, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import type { AppState, Contact } from '../types'

interface ContactsViewProps {
  state: AppState
  query: string
  onCompose(contactEmail?: string): void
  onToast(message: string): void
  onSync(): Promise<void> | void
  syncing?: boolean
  sourceMessage?: string
}

export default function ContactsView({ state, query, onCompose, onToast, onSync, syncing = false, sourceMessage }: ContactsViewProps) {
  const { showContextMenu } = useContextMenu()
  const [group, setGroup] = useState('All contacts')
  const [selectedId, setSelectedId] = useState(state.contacts[0]?.id ?? '')
  const groups = ['All contacts', 'Favourites', ...Array.from(new Set(state.contacts.map((contact) => contact.group)))]
  const contacts = useMemo(() => state.contacts
    .filter((contact) => group === 'All contacts' || (group === 'Favourites' ? contact.favorite : contact.group === group))
    .filter((contact) => !query || `${contact.name} ${contact.email} ${contact.company ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)), [group, query, state.contacts])
  const selected = contacts.find((contact) => contact.id === selectedId) ?? contacts[0]

  const contactMenu = (contact: Contact): ContextMenuItem[] => [
    { label: 'Email', icon: Mail, disabled: !contact.email, action: () => onCompose(contact.email) },
    { label: 'Copy email address', icon: Copy, separatorBefore: true, disabled: !contact.email, action: () => copyText(contact.email) },
    ...(contact.phone ? [{ label: 'Copy phone number', icon: Phone, action: () => copyText(contact.phone!) }] satisfies ContextMenuItem[] : [])
  ]

  const showContactMenu = (event: React.MouseEvent, contact: Contact) => showContextMenu(event, contactMenu(contact), contact.name)

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" disabled={syncing} onClick={() => void onSync()}><RefreshCw className={syncing ? 'spin' : undefined} size={18} /> {syncing ? 'Syncing…' : 'Sync now'}</button>
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
        <div className="contact-insight"><span className="insight-number">{state.contacts.length}</span><p>provider contacts</p></div>
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
    </div>
  )
}
