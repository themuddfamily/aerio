import { Building2, Cake, Copy, Edit3, GitMerge, Globe, HardDrive, Link2, Mail, MapPin, Phone, Plus, RefreshCw, Search, Star, Trash2, Users, UsersRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import type { AppState, Contact, ContactField, MessageWindowRequest } from '../types'
import type { ProductivitySnapshot, SyncedContact } from '../productivity-types'
import type { ContactMergeDesktopApi } from '../contact-merge-types'
import Modal from '../components/Modal'
import { ContactFieldList, ContactPhotoPicker } from '../components/ContactFieldsEditor'
import { ContactListEditor, ContactListsSidebar, deleteRecipientList, saveRecipientList, type ContactListActions } from '../components/ContactListsPanel'
import { uid } from '../lib/domain'
import { preserveContactInterchangeFields } from '../lib/interchange-plan'
import { ADDRESS_TYPES, contactEmailAddresses, contactGroupNames, editableFields, EMAIL_TYPES, isContactBirthday, PHONE_TYPES, withContactFields } from '../lib/contact-fields'
import { buildRecipientLists, formatRecipient, listContactIds, recipientListLabel, recipientListPreview, type RecipientList } from '../lib/distribution-lists'
import { contactPairKey, linkedContactIds, type DuplicateCandidate } from '../lib/contact-duplicates'
import { ContactDuplicatesModal, ContactMergePreview } from '../components/ContactMergePanel'
import ContactHistoryPanel, { type ContactHistoryMailApi } from '../components/ContactHistoryPanel'
import { useContactMerge } from '../components/use-contact-merge'

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
  providerAccounts?: { id: string; email: string; provider: 'gmail' | 'microsoft' | 'dav' | 'exchange' }[]
  syncing?: boolean
  sourceMessage?: string
  interchangePanel?: React.ReactNode
  // Distribution lists: local lists and provider group management. Omitted in read-only embeddings.
  listActions?: Omit<ContactListActions, 'saveProviderContact'>
  // Duplicate detection, merge with undo, and cross-account links (E28). Omitted in read-only embeddings.
  mergeApi?: ContactMergeDesktopApi
  onProviderSnapshot?(snapshot: ProductivitySnapshot): void
  // Communication history read from the offline mail cache.
  historyMail?: ContactHistoryMailApi
  onOpenMessage?(request: MessageWindowRequest): void
}

const isSyncedContact = (contact: Contact): contact is SyncedContact =>
  'remoteId' in contact && 'accountId' in contact && 'provider' in contact && 'readOnly' in contact
const initials = (name: string) => name.split(' ').map((value) => value[0]).join('')

function ContactAvatar({ contact, className }: { contact: Contact; className: string }) {
  return contact.photo
    ? <img className={`avatar ${className} contact-photo`} src={contact.photo} alt="" />
    : <span className={`avatar ${className}`} style={{ background: contact.color }}>{initials(contact.name)}</span>
}

export default function ContactsView({
  state, query, onCompose, onToast, onSync, onEnableEditing, onLocalContactsChange,
  onSaveProviderContact, onDeleteProviderContact, providerAccounts = [], syncing = false, sourceMessage, interchangePanel, listActions,
  mergeApi, onProviderSnapshot, historyMail, onOpenMessage
}: ContactsViewProps) {
  const { showContextMenu } = useContextMenu()
  const [group, setGroup] = useState('All contacts')
  const [listId, setListId] = useState<string>()
  const [selectedId, setSelectedId] = useState(state.contacts[0]?.id ?? '')
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const [editingList, setEditingList] = useState<RecipientList | 'new' | null>(null)
  const groups = ['All contacts', 'Favourites', ...Array.from(new Set(state.contacts.flatMap(contactGroupNames)))]
  const lists = useMemo(() => buildRecipientLists({ contacts: state.contacts, lists: listActions?.localLists, groups: listActions?.groups }), [listActions?.groups, listActions?.localLists, state.contacts])
  const activeList = lists.find((list) => list.id === listId)
  const listMembers = useMemo(() => activeList ? listContactIds(activeList, state.contacts) : undefined, [activeList, state.contacts])
  const contacts = useMemo(() => state.contacts
    .filter((contact) => listMembers ? listMembers.has(contact.id) : group === 'All contacts' || (group === 'Favourites' ? contact.favorite : contactGroupNames(contact).includes(group)))
    .filter((contact) => !query || `${contact.name} ${contactEmailAddresses(contact).join(' ')} ${contact.company ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)), [group, listMembers, query, state.contacts])
  const selected = contacts.find((contact) => contact.id === selectedId) ?? contacts[0]
  const localContacts = state.contacts.filter((contact) => contact.source === 'local')
  const actions: ContactListActions | undefined = listActions && { ...listActions, saveProviderContact: onSaveProviderContact }
  const selectedLists = selected ? lists.filter((list) => listContactIds(list, [selected]).size) : []
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [reviewing, setReviewing] = useState<DuplicateCandidate>()
  const merging = useContactMerge({
    api: mergeApi, contacts: state.contacts, localLists: listActions?.localLists ?? [],
    onLocalContactsChange, onLocalListsChange: listActions?.onLocalListsChange, onProviderSnapshot
  })
  // Where a record lives decides what can be done with it: merged within one owner, linked across owners.
  const ownerLabel = (contact: Contact) => {
    if (!isSyncedContact(contact)) return 'Local contacts on this PC'
    const account = providerAccounts.find((item) => item.id === contact.accountId)
    return `${account?.email ?? 'Disconnected account'} · ${contact.provider === 'gmail' ? 'Google' : 'Microsoft'}`
  }
  // Linked contacts of removed accounts are no longer in the address book and drop out here.
  const linked = selected ? [...linkedContactIds(selected.id, merging.associations)].flatMap((id) => state.contacts.filter((contact) => contact.id === id)) : []
  const historyAddresses = selected ? [...new Map([selected, ...linked].flatMap(contactEmailAddresses).map((address) => [address.toLowerCase(), address])).values()] : []
  const report = async (action: () => Promise<unknown>, success: string, failure: string) => {
    try {
      await action()
      onToast(success)
    } catch (error) {
      onToast(error instanceof Error ? error.message : failure)
    }
  }

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
      // The revision the editor started from lets the main process reject a stale overwrite.
      const payload = providerExists && editing.revision ? { ...contact, revision: editing.revision } as Contact : contact
      const saved = await onSaveProviderContact(accountId, payload, providerExists)
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

  const deleteList = async (list: RecipientList) => {
    if (!actions || !window.confirm(`Delete the list “${list.name}”? Its members stay in your contacts.`)) return
    try {
      onToast(await deleteRecipientList(actions, state.contacts, list))
      setListId(undefined)
      setEditingList(null)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The list could not be deleted')
    }
  }

  const emailList = (list: RecipientList) => onCompose(list.members.map(formatRecipient).join(', '))

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
  const heading = activeList?.name ?? group

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" onClick={() => setEditing('new')}><Plus size={18} /> New contact</button>
        <button className="button ghost small sidebar-sync" title="Synchronize provider contacts" disabled={syncing} onClick={() => void onSync()}><RefreshCw className={syncing ? 'spin' : undefined} size={15} /> {syncing ? 'Syncing…' : 'Sync now'}</button>
        {providerAccounts.length > 0 && <button className="button ghost small sidebar-sync" title="Reconnect an account with permission to edit provider contacts" disabled={syncing} onClick={() => void onEnableEditing?.()}><Edit3 size={15} /> Enable editing</button>}
        {merging.available && <button className="button ghost small sidebar-sync" title="Review possible duplicate contacts" onClick={() => setDuplicatesOpen(true)}><GitMerge size={15} /> Find duplicates</button>}
        <p className="provider-source-note" aria-live="polite">{sourceMessage}</p>
        <div className="sidebar-group">
          <span className="sidebar-label">Contacts</span>
          {groups.map((item) => (
            <button className={`sidebar-item ${!activeList && group === item ? 'active' : ''}`} onClick={() => { setGroup(item); setListId(undefined) }} onContextMenu={(event) => showContextMenu(event, [
              { label: `Open ${item}`, icon: Users, action: () => { setGroup(item); setListId(undefined) } }
            ], item)} key={item}>
              {item === 'Favourites' ? <Star size={17} /> : <Users size={17} />}<span>{item}</span>
              <em>{item === 'All contacts' ? state.contacts.length : item === 'Favourites' ? state.contacts.filter((contact) => contact.favorite).length : state.contacts.filter((contact) => contactGroupNames(contact).includes(item)).length}</em>
            </button>
          ))}
        </div>
        {actions && <ContactListsSidebar
          lists={lists}
          selectedId={activeList?.id}
          onSelect={(list) => setListId(list.id)}
          onCreate={() => setEditingList('new')}
          onEdit={setEditingList}
          onDelete={(list) => void deleteList(list)}
          onEmail={emailList}
        />}
        {interchangePanel}
        <div className="contact-insight"><span className="insight-number">{state.contacts.length}</span><p>contacts</p></div>
      </aside>
      <section className="contact-list-panel">
        <header className="panel-heading"><div><h1>{heading}</h1><p>{activeList ? `${recipientListLabel(activeList)} · ${activeList.members.length} addresses${activeList.unreachable ? ` · ${activeList.unreachable} without email` : ''}` : `${contacts.length} people`}</p></div>
          {activeList && <div className="panel-heading-actions">
            <button className="button ghost small" disabled={!activeList.members.length} onClick={() => emailList(activeList)}><Mail size={14} /> Email list</button>
            <button className="button ghost small" disabled={activeList.readOnly} title={activeList.readOnly ? 'Enable provider editing to change this list' : undefined} onClick={() => setEditingList(activeList)}><Edit3 size={14} /> Edit list</button>
          </div>}
        </header>
        {activeList && <p className="provider-source-note list-preview">{recipientListPreview(activeList, 6)}</p>}
        <div className="inline-search"><Search size={16} /><span>{query || 'Search from the top bar'}</span></div>
        <div className="contact-list" onContextMenu={(event) => showContextMenu(event, [{ label: `Show ${heading}`, icon: Users, action: () => undefined }], 'Contacts')}>
          {contacts.map((contact) => (
            <button key={contact.id} className={`contact-row ${selected?.id === contact.id ? 'selected' : ''}`} onClick={() => setSelectedId(contact.id)} onContextMenu={(event) => showContactMenu(event, contact)}>
              <ContactAvatar contact={contact} className="large" />
              <span><strong>{contact.name}</strong><small>{contact.title ?? contact.group}{contact.company ? ` · ${contact.company}` : ''}</small></span>
              {contact.favorite && <Star className="favourite" size={14} fill="currentColor" />}
            </button>
          ))}
          {activeList && activeList.members.filter((member) => !member.contactId).map((member) => (
            <div key={member.email} className="contact-row external-member"><span className="avatar large">@</span><span><strong>{member.name || member.email}</strong><small>{member.email} · not a saved contact</small></span></div>
          ))}
        </div>
      </section>
      <section className="contact-detail-panel">
        {selected ? <>
          <header className="contact-hero" onContextMenu={(event) => showContactMenu(event, selected)}>
            <ContactAvatar contact={selected} className="hero-avatar" />
            <div><h1>{selected.name}</h1><p>{selected.title}{selected.company && ` at ${selected.company}`}</p></div>
          </header>
          <div className="contact-actions">
            <button disabled={!selected.email} onClick={() => onCompose(selected.email)}><span><Mail size={19} /></span>Email</button>
            <button onClick={() => onToast(selected.phone ? `Call ${selected.phone}` : 'No phone number saved')}><span><Phone size={19} /></span>Call</button>
            {(selected.source === 'local' || (isSyncedContact(selected) && !selected.readOnly)) && <button onClick={() => setEditing(selected)}><span><Edit3 size={19} /></span>Edit</button>}
          </div>
          {isSyncedContact(selected) && selected.readOnly && <p className="provider-source-note">Read-only: reconnect this account with Contacts editing to change it.</p>}
          <div className="contact-detail-grid">
            <section className="detail-card">
              <h3>Details</h3>
              <dl>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Email contact', icon: Mail, disabled: !selected.email, action: () => onCompose(selected.email) }, { label: 'Copy email address', icon: Copy, disabled: !selected.email, action: () => copyText(selected.email) }], 'Email')}><dt><Mail size={15} /> Email</dt><dd>{selected.email || 'Not added'}</dd></div>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: selected.phone ? `Call ${selected.name}` : 'No phone number saved', icon: Phone, disabled: !selected.phone, action: () => onToast(`Call ${selected.phone}`) }, { label: 'Copy phone number', icon: Copy, disabled: !selected.phone, action: () => copyText(selected.phone!) }], 'Phone')}><dt><Phone size={15} /> Phone</dt><dd>{selected.phone ?? 'Not added'}</dd></div>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy company', icon: Copy, disabled: !selected.company, action: () => copyText(selected.company!) }], 'Company')}><dt><Building2 size={15} /> Company</dt><dd>{selected.company ?? 'Not added'}</dd></div>
                <div onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy group', icon: Copy, action: () => copyText(contactGroupNames(selected).join(', ')) }], 'Group')}><dt><Users size={15} /> {contactGroupNames(selected).length > 1 ? 'Groups' : 'Group'}</dt><dd>{contactGroupNames(selected).join(', ') || selected.group}</dd></div>
                {[
                  ...(selected.emails ?? []).filter((field) => field.value !== selected.email).map((field) => ({ icon: Mail, label: 'Email', field })),
                  ...(selected.phones ?? []).filter((field) => field.value !== selected.phone).map((field) => ({ icon: Phone, label: 'Phone', field })),
                  ...(selected.addresses ?? []).map((field) => ({ icon: MapPin, label: 'Address', field })),
                  ...(selected.urls ?? []).map((field) => ({ icon: Globe, label: 'Website', field }))
                ].map(({ icon: Icon, label, field }, index) => (
                  <div key={`${label}-${index}`} onContextMenu={(event) => showContextMenu(event, [{ label: `Copy ${label.toLowerCase()}`, icon: Copy, action: () => copyText(field.value) }], label)}>
                    <dt><Icon size={15} /> {label}{field.type ? ` (${field.type})` : ''}</dt><dd>{field.value}</dd>
                  </div>
                ))}
                {selected.birthday && <div><dt><Cake size={15} /> Birthday</dt><dd>{selected.birthday}</dd></div>}
                {selectedLists.length > 0 && <div><dt><UsersRound size={15} /> Lists</dt><dd>{selectedLists.map((list) => list.name).join(', ')}</dd></div>}
                {merging.available && <div><dt><HardDrive size={15} /> Stored in</dt><dd>{ownerLabel(selected)}</dd></div>}
                {linked.length > 0 && <div><dt><Link2 size={15} /> Linked</dt><dd className="linked-contacts">{linked.map((contact) => {
                  const association = merging.associations.find((item) => item.kind === 'link' && item.id === contactPairKey(selected.id, contact.id))
                  return <span key={contact.id}>
                    <button className="text-button" onClick={() => setSelectedId(contact.id)}>{contact.name}</button> <small>({ownerLabel(contact)})</small>
                    {association && <button className="text-button" aria-label={`Unlink ${contact.name}`} onClick={() => void report(() => merging.removeAssociation(association.id), 'Contacts unlinked', 'The link could not be removed')}>Unlink</button>}
                  </span>
                })}</dd></div>}
              </dl>
            </section>
            <section className="detail-card" onContextMenu={(event) => { if (!window.getSelection()?.toString()) showContextMenu(event, [{ label: 'Copy notes', icon: Copy, disabled: !selected.notes, action: () => copyText(selected.notes!) }], 'Contact notes') }}>
              <h3>Notes</h3><p>{selected.notes || 'No notes supplied by the provider.'}</p>
            </section>
          </div>
          {historyMail && onOpenMessage && <ContactHistoryPanel addresses={historyAddresses} mail={historyMail} onOpenMessage={onOpenMessage} onToast={onToast} />}
        </> : <div className="empty-state grow"><Users size={32} /><h3>Select a contact</h3></div>}
      </section>
      {editing && <ContactEditor
        contact={editing === 'new' ? undefined : editing}
        providerAccounts={providerAccounts}
        onClose={() => setEditing(null)}
        onSave={saveContact}
        onDelete={editing === 'new' ? undefined : () => void deleteContact(editing)}
        onToast={onToast}
      />}
      {duplicatesOpen && !reviewing && <ContactDuplicatesModal
        contacts={state.contacts}
        associations={merging.associations}
        merges={merging.merges}
        ownerLabel={ownerLabel}
        onReview={setReviewing}
        onLink={(candidate) => report(() => merging.associate('link', candidate.first, candidate.second), 'Contacts linked. Their messages appear together in the history.', 'The contacts could not be linked')}
        onDismiss={(candidate) => report(() => merging.associate('dismissed', candidate.first, candidate.second), 'This pair will not be suggested again', 'The suggestion could not be dismissed')}
        onUndo={(entry) => report(() => merging.undo(entry), 'Merge undone', 'The merge could not be undone')}
        onClose={() => setDuplicatesOpen(false)}
      />}
      {reviewing && <ContactMergePreview
        first={reviewing.first}
        second={reviewing.second}
        ownerLabel={ownerLabel}
        onClose={() => setReviewing(undefined)}
        onMerge={async (survivor, other, choices) => {
          try {
            const entry = await merging.merge(survivor, other, choices)
            setReviewing(undefined)
            setSelectedId(survivor.id)
            onToast(entry?.warnings?.length ? `Contacts merged. ${entry.warnings[0]}` : entry ? 'Contacts merged. Undo it from Find duplicates.' : 'Contacts merged')
          } catch (error) {
            onToast(error instanceof Error ? error.message : 'The contacts could not be merged')
          }
        }}
      />}
      {editingList && actions && <ContactListEditor
        list={editingList === 'new' ? undefined : editingList}
        contacts={state.contacts}
        providerAccounts={providerAccounts}
        canCreateGroups={Boolean(actions.createGroup)}
        onClose={() => setEditingList(null)}
        onToast={onToast}
        onSave={async (target, name, memberIds, extra) => {
          const original = editingList === 'new' ? undefined : editingList
          onToast(await saveRecipientList(actions, state.contacts, original, target, name, memberIds, extra))
          setEditingList(null)
        }}
      />}
    </div>
  )
}

const withBlankRow = (fields: ContactField[], type: string) => fields.length ? fields : [{ value: '', type }]

function ContactEditor({
  contact, providerAccounts, onClose, onSave, onDelete, onToast
}: {
  contact?: Contact
  providerAccounts: { id: string; email: string; provider: 'gmail' | 'microsoft' | 'dav' | 'exchange' }[]
  onClose(): void
  onSave(contact: Contact, accountId?: string): Promise<void> | void
  onDelete?(): void
  onToast(message: string): void
}) {
  const initial = editableFields(contact)
  const [name, setName] = useState(contact?.name ?? '')
  const [emails, setEmails] = useState(() => withBlankRow(initial.emails, 'home'))
  const [phones, setPhones] = useState(() => withBlankRow(initial.phones, 'mobile'))
  const [addresses, setAddresses] = useState(initial.addresses)
  const [company, setCompany] = useState(contact?.company ?? '')
  const [title, setTitle] = useState(contact?.title ?? '')
  const [groupText, setGroupText] = useState(initial.groups.filter((group) => !['Google', 'Outlook'].includes(group)).join(', ') || (contact ? '' : 'Personal'))
  const [birthday, setBirthday] = useState(contact?.birthday ?? '')
  const [photo, setPhoto] = useState(contact?.photo)
  const [notes, setNotes] = useState(contact?.notes ?? '')
  const [favorite, setFavorite] = useState(contact?.favorite ?? false)
  const [target, setTarget] = useState(contact && isSyncedContact(contact) ? contact.accountId : 'local')
  const [saving, setSaving] = useState(false)
  const providerTarget = providerAccounts.find((account) => account.id === target)
  const provider = providerTarget?.provider ?? (contact && isSyncedContact(contact) ? contact.provider : undefined)
  const birthdayInvalid = Boolean(birthday.trim()) && !isContactBirthday(birthday) && birthday !== contact?.birthday
  return (
    <Modal
      title={contact ? 'Edit contact' : 'New contact'}
      subtitle={providerTarget ? `Saved to ${providerTarget.email} through ${providerTarget.provider === 'gmail' ? 'Google Contacts' : providerTarget.provider === 'dav' ? 'CardDAV' : providerTarget.provider === 'exchange' ? 'Exchange Server' : 'Microsoft People'}.` : 'Stored locally on this PC.'}
      onClose={onClose}
    >
      <div className="form-stack">
        <label className="field-label">Save to
          <select value={target} disabled={Boolean(contact)} onChange={(event) => setTarget(event.target.value)}>
            <option value="local">Local contacts on this PC</option>
            {providerAccounts.map((account) => <option key={account.id} value={account.id}>{account.email} · {account.provider === 'gmail' ? 'Google' : account.provider === 'dav' ? 'CardDAV' : account.provider === 'exchange' ? 'Exchange' : 'Microsoft'}</option>)}
          </select>
        </label>
        <ContactPhotoPicker photo={photo} name={name} color={contact?.color ?? '#4d8f78'} disabled={provider === 'microsoft'} onChange={setPhoto} onError={onToast} />
        {provider === 'microsoft' && <small>Microsoft contact photos are not synchronized by Aerio.</small>}
        <label className="field-label">Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <ContactFieldList label="Emails" itemLabel="Email" fields={emails} types={EMAIL_TYPES} inputType="email" onChange={setEmails} />
        <ContactFieldList label="Phones" itemLabel="Phone" fields={phones} types={PHONE_TYPES} inputType="tel" onChange={setPhones} />
        <ContactFieldList label="Addresses" itemLabel="Address" fields={addresses} types={ADDRESS_TYPES} placeholder="Street, city, postal code, country" onChange={setAddresses} />
        {provider === 'microsoft' && <small>Outlook keeps up to three email addresses, one mobile number, and one home, work, and other address; values beyond those slots are not saved to Outlook.</small>}
        <div className="form-grid-2">
          <label className="field-label">Company<input value={company} onChange={(event) => setCompany(event.target.value)} /></label>
          <label className="field-label">Job title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field-label">Birthday<input value={birthday} placeholder="YYYY-MM-DD or --MM-DD" aria-invalid={birthdayInvalid} onChange={(event) => setBirthday(event.target.value)} /></label>
          <label className="field-label">{provider === 'microsoft' ? 'Categories' : 'Groups'}<input value={groupText} disabled={provider === 'gmail'} placeholder="Comma-separated" onChange={(event) => setGroupText(event.target.value)} /></label>
          <label className="check-label"><input type="checkbox" checked={favorite} disabled={target !== 'local'} onChange={(event) => setFavorite(event.target.checked)} /> Favourite {target !== 'local' && '(local contacts only)'}</label>
        </div>
        {provider === 'gmail' && <small>Google contact groups are managed from Distribution lists in the sidebar.</small>}
        <label className="field-label">Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <footer className="modal-footer">
          {onDelete && <button className="button danger-subtle" onClick={onDelete}><Trash2 size={16} /> Delete</button>}
          <span className="spacer" /><button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!name.trim() || saving || birthdayInvalid} onClick={() => {
            setSaving(true)
            const fallbackGroup = target === 'local' ? 'Personal' : provider === 'microsoft' ? 'Outlook' : 'Google'
            const base = preserveContactInterchangeFields(contact, {
              id: contact?.id ?? uid('contact'), name: name.trim(), email: '', company: company.trim() || undefined, title: title.trim() || undefined,
              group: fallbackGroup, notes: notes.trim() || undefined, favorite: target === 'local' ? favorite : false,
              color: contact?.color ?? (providerTarget?.provider === 'microsoft' ? '#3b6fd8' : '#4d8f78'),
              ...(target === 'local' ? { source: 'local' as const } : {})
            })
            // Google memberships are edited through contact groups, so the editor keeps them as synchronized.
            const groupNames = provider === 'gmail' ? (contact?.groups ?? []) : groupText.split(',')
            const next = withContactFields(base, { emails, phones, addresses, groups: groupNames }, provider === 'gmail' ? contact?.group ?? fallbackGroup : fallbackGroup)
            if (birthday.trim()) next.birthday = birthday.trim()
            else delete next.birthday
            if (photo) next.photo = photo
            else delete next.photo
            void Promise.resolve(onSave(next, target === 'local' ? undefined : target)).finally(() => setSaving(false))
          }}>{saving ? 'Saving…' : 'Save contact'}</button>
        </footer>
      </div>
    </Modal>
  )
}
