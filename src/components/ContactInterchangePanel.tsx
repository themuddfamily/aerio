import { Download, Upload, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Contact } from '../types'
import type { ContactExportFormat, ContactImportPreview, InterchangeDesktopApi } from '../interchange-types'
import { contactsFromCsv, CSV_FIELD_LABELS, suggestCsvMapping, type CsvContactField } from '../lib/contact-csv'
import { planContactImport, type ContactDuplicateStrategy } from '../lib/interchange-plan'
import Modal from './Modal'

export interface ContactProviderAccount {
  id: string
  email: string
  provider: 'gmail' | 'microsoft'
}

interface ContactInterchangePanelProps {
  api: InterchangeDesktopApi
  contacts: Contact[]
  providerAccounts: ContactProviderAccount[]
  onLocalContactsChange(contacts: Contact[]): void
  onSaveProviderContact?(accountId: string, contact: Contact, exists: boolean): Promise<Contact>
  onToast(message: string): void
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
const accountOf = (contact: Contact) => 'accountId' in contact && typeof contact.accountId === 'string' ? contact.accountId : undefined
const newId = () => `contact-${crypto.randomUUID()}`

export default function ContactInterchangePanel({ api, contacts, providerAccounts, onLocalContactsChange, onSaveProviderContact, onToast }: ContactInterchangePanelProps) {
  const [preview, setPreview] = useState<ContactImportPreview>()
  const [exporting, setExporting] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div className="sidebar-group interchange-group">
      <span className="sidebar-label">Import and export</span>
      <div className="interchange-actions">
        <button className="button ghost small" disabled={busy} onClick={() => {
          setBusy(true)
          void api.chooseContactsFile()
            .then((next) => { if (next) setPreview(next) })
            .catch((error) => onToast(errorMessage(error, 'That contacts file could not be read')))
            .finally(() => setBusy(false))
        }}><Upload size={14} /> {busy ? 'Reading…' : 'Import'}</button>
        <button className="button ghost small" disabled={!contacts.length} onClick={() => setExporting(true)}><Download size={14} /> Export</button>
      </div>
      {preview && <ContactImportModal
        preview={preview}
        contacts={contacts}
        providerAccounts={onSaveProviderContact ? providerAccounts : []}
        onLocalContactsChange={onLocalContactsChange}
        onSaveProviderContact={onSaveProviderContact}
        onToast={onToast}
        onClose={() => setPreview(undefined)}
      />}
      {exporting && <ContactExportModal contacts={contacts} providerAccounts={providerAccounts} onClose={() => setExporting(false)} onExport={async (ids, format) => {
        try {
          const result = await api.exportContacts(ids, format)
          if (result.savedPath) onToast(`Exported ${result.count ?? 0} contact${result.count === 1 ? '' : 's'}`)
          setExporting(false)
        } catch (error) {
          onToast(errorMessage(error, 'Contacts could not be exported'))
        }
      }} />}
    </div>
  )
}

function ContactImportModal({ preview, contacts, providerAccounts, onLocalContactsChange, onSaveProviderContact, onToast, onClose }: {
  preview: ContactImportPreview
  contacts: Contact[]
  providerAccounts: ContactProviderAccount[]
  onLocalContactsChange(contacts: Contact[]): void
  onSaveProviderContact?(accountId: string, contact: Contact, exists: boolean): Promise<Contact>
  onToast(message: string): void
  onClose(): void
}) {
  const [mapping, setMapping] = useState<CsvContactField[]>(() => preview.format === 'csv' ? suggestCsvMapping(preview.table.headers) : [])
  const [destination, setDestination] = useState('local')
  const [strategy, setStrategy] = useState<ContactDuplicateStrategy>('merge')
  const [progress, setProgress] = useState<string>()
  const provider = providerAccounts.find((account) => account.id === destination)
  const mapped = useMemo(() => preview.format === 'vcard'
    ? { contacts: preview.contacts, skipped: 0 }
    : contactsFromCsv(preview.table, mapping, { idFactory: newId }), [mapping, preview])
  const localContacts = contacts.filter((contact) => contact.source === 'local')
  const existing = provider ? contacts.filter((contact) => accountOf(contact) === provider.id) : localContacts
  const plan = useMemo(() => planContactImport(
    mapped.contacts.map((contact) => provider ? { ...contact, favorite: false, color: provider.provider === 'microsoft' ? '#3b6fd8' : '#4d8f78' } : { ...contact, source: 'local' as const }),
    existing,
    strategy
  ), [existing, mapped.contacts, provider, strategy])
  const counts = { create: 0, merge: 0, skip: 0 }
  for (const item of plan) counts[item.action]++
  const writes = plan.filter((item) => item.action !== 'skip')
  const samples = preview.format === 'csv'
    ? preview.table.headers.map((_header, column) => preview.table.rows.find((row) => row[column])?.[column] ?? '')
    : []

  const importContacts = async () => {
    if (!writes.length) {
      onToast('Nothing to import: every contact is already saved')
      onClose()
      return
    }
    if (!provider) {
      const merged = new Map(writes.filter((item) => item.action === 'merge').map((item) => [item.contact.id, item.contact]))
      const created = writes.filter((item) => item.action === 'create').map((item) => item.contact)
      onLocalContactsChange([...created, ...localContacts.map((contact) => merged.get(contact.id) ?? contact)])
      onToast(`Imported ${created.length} new and updated ${merged.size} contact${merged.size === 1 ? '' : 's'}`)
      onClose()
      return
    }
    if (!onSaveProviderContact) return
    let failed = 0
    for (const [index, item] of writes.entries()) {
      setProgress(`Importing ${index + 1} of ${writes.length}…`)
      try { await onSaveProviderContact(provider.id, item.contact, item.action === 'merge') }
      catch { failed++ }
    }
    onToast(failed ? `Imported ${writes.length - failed} of ${writes.length} contacts; ${failed} could not be saved` : `Imported ${writes.length} contact${writes.length === 1 ? '' : 's'} to ${provider.email}`)
    onClose()
  }

  const total = preview.format === 'vcard' ? preview.contacts.length : preview.table.rows.length
  return (
    <Modal title="Import contacts" subtitle={`${preview.fileName} · ${total} ${preview.format === 'vcard' ? 'contact' : 'row'}${total === 1 ? '' : 's'}`} width="large" closeEnabled={!progress} onClose={onClose}>
      <div className="form-stack">
        <div className="form-grid-2">
          <label className="field-label">Import into
            <select value={destination} disabled={Boolean(progress)} onChange={(event) => setDestination(event.target.value)}>
              <option value="local">Local contacts on this PC</option>
              {providerAccounts.map((account) => <option key={account.id} value={account.id}>{account.email} · {account.provider === 'gmail' ? 'Google' : 'Microsoft'}</option>)}
            </select>
          </label>
          <label className="field-label">Contacts already saved
            <select value={strategy} disabled={Boolean(progress)} onChange={(event) => setStrategy(event.target.value as ContactDuplicateStrategy)}>
              <option value="merge">Merge new details into them</option>
              <option value="skip">Skip them</option>
              <option value="create">Import as separate contacts</option>
            </select>
          </label>
        </div>
        {provider && <small>Provider contacts receive the primary name, email, phone, company, title, and notes. Additional fields are kept in local contacts.</small>}
        {preview.format === 'csv' && (
          <div className="csv-mapping" role="group" aria-label="Column mapping">
            <div className="csv-mapping-row heading"><span>Column</span><span>Example</span><span>Import as</span></div>
            {preview.table.headers.map((header, column) => (
              <div className="csv-mapping-row" key={`${header}-${column}`}>
                <span title={header}>{header}</span>
                <small title={samples[column]}>{samples[column] || '—'}</small>
                <select aria-label={`Import ${header} as`} value={mapping[column]} disabled={Boolean(progress)} onChange={(event) => {
                  const next = [...mapping]
                  next[column] = event.target.value as CsvContactField
                  setMapping(next)
                }}>
                  {Object.entries(CSV_FIELD_LABELS).map(([field, label]) => <option key={field} value={field}>{label}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        <p className="interchange-summary" aria-live="polite">{counts.create} new · {counts.merge} to merge · {counts.skip} skipped{mapped.skipped ? ` · ${mapped.skipped} without a name or email` : ''}</p>
        {preview.warnings.length > 0 && <ul className="interchange-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        <ul className="interchange-preview" aria-label="Contacts to import">
          {plan.slice(0, 100).map((item, index) => (
            <li key={`${item.contact.id}-${index}`} className={item.action === 'skip' ? 'muted' : undefined}>
              <UserRound size={14} />
              <span>
                <strong>{item.contact.name}</strong>
                <small>{[item.contact.email, item.contact.phone, item.contact.company].filter(Boolean).join(' · ') || 'No email or phone'}
                  {(item.contact.emails?.length ?? 0) > 1 || (item.contact.phones?.length ?? 0) > 1 ? ` · ${(item.contact.emails?.length ?? 0) + (item.contact.phones?.length ?? 0)} addresses and numbers` : ''}</small>
              </span>
              <em>{item.action === 'create' ? 'New' : item.action === 'merge' ? `Merge with ${item.match?.name ?? 'existing'}` : 'Skip'}</em>
            </li>
          ))}
          {plan.length > 100 && <li className="muted">…and {plan.length - 100} more</li>}
        </ul>
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="button ghost" disabled={Boolean(progress)} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={Boolean(progress) || !plan.length} onClick={() => void importContacts()}><Upload size={16} /> {progress ?? `Import ${writes.length} contact${writes.length === 1 ? '' : 's'}`}</button>
        </footer>
      </div>
    </Modal>
  )
}

function ContactExportModal({ contacts, providerAccounts, onClose, onExport }: {
  contacts: Contact[]
  providerAccounts: ContactProviderAccount[]
  onClose(): void
  onExport(ids: string[], format: ContactExportFormat): Promise<void>
}) {
  const [scope, setScope] = useState('all')
  const [exportFormat, setExportFormat] = useState<ContactExportFormat>('vcard3')
  const [busy, setBusy] = useState(false)
  const groups = Array.from(new Set(contacts.map((contact) => contact.group))).sort()
  const selected = contacts.filter((contact) => scope === 'all' ||
    (scope === 'local' && contact.source === 'local') ||
    (scope.startsWith('account:') && accountOf(contact) === scope.slice(8)) ||
    (scope.startsWith('group:') && contact.group === scope.slice(6)))
  return (
    <Modal title="Export contacts" subtitle={`${selected.length} contact${selected.length === 1 ? '' : 's'} selected`} width="small" closeEnabled={!busy} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Contacts
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="all">All contacts</option>
            <option value="local">Local contacts on this PC</option>
            {providerAccounts.map((account) => <option key={account.id} value={`account:${account.id}`}>{account.email}</option>)}
            {groups.map((group) => <option key={group} value={`group:${group}`}>Group: {group}</option>)}
          </select>
        </label>
        <label className="field-label">Format
          <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ContactExportFormat)}>
            <option value="vcard3">vCard 3.0 (.vcf) — widest compatibility</option>
            <option value="vcard4">vCard 4.0 (.vcf)</option>
            <option value="csv">CSV spreadsheet (.csv)</option>
          </select>
        </label>
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || !selected.length} onClick={() => {
            setBusy(true)
            void onExport(selected.map((contact) => contact.id), exportFormat).finally(() => setBusy(false))
          }}><Download size={16} /> {busy ? 'Exporting…' : 'Export'}</button>
        </footer>
      </div>
    </Modal>
  )
}
