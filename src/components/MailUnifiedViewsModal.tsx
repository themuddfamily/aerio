import { useState } from 'react'
import type { MailAccountSummary, MailFolder } from '../mail-types'
import type { MailUnifiedView } from '../mail-unified-view-types'
import { UNIFIED_MAIL_FOLDERS } from '../lib/mail-unified-views'
import Modal from './Modal'

export default function MailUnifiedViewsModal({ accounts, views, onSave, onRemove, onClose }: {
  accounts: MailAccountSummary[]; views: MailUnifiedView[]
  onSave(view: Omit<MailUnifiedView, 'id'> & { id?: string }): Promise<void>
  onRemove(id: string): Promise<void>; onClose(): void
}) {
  const [id, setId] = useState<string>()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [overrides, setOverrides] = useState<MailUnifiedView['folderAccountIds']>({})
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const available = accounts.map((account) => account.id)
  const validMembers = members.filter((member) => available.includes(member))
  const edit = (view?: MailUnifiedView) => { setId(view?.id); setName(view?.name ?? ''); setMembers(view?.accountIds ?? []); setOverrides(view?.folderAccountIds ?? {}); setError('') }
  const toggle = (values: string[], member: string) => values.includes(member) ? values.filter((value) => value !== member) : [...values, member]
  return <Modal title="Unified account views" subtitle="Save account groups for the Mailboxes above the account list." onClose={onClose} closeEnabled={!busy}>
    <div className="form-stack">
      <label className="field-label">Saved view<select value={id ?? ''} disabled={busy} onChange={(event) => edit(views.find((view) => view.id === event.target.value))}><option value="">New view</option>{views.map((view) => <option value={view.id} key={view.id}>{view.name}</option>)}</select></label>
      <label className="field-label">View name<input value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <fieldset disabled={busy}><legend>Included accounts</legend>{accounts.map((account) => <label className="check-label" key={account.id}><input type="checkbox" checked={members.includes(account.id)} onChange={() => {
        const next = toggle(members, account.id); setMembers(next)
        setOverrides((current) => Object.fromEntries(Object.entries(current ?? {}).map(([key, ids]) => [key, ids.filter((member) => next.includes(member))])))
      }} />{account.email}{account.archived ? ' · archive' : ''}</label>)}</fieldset>
      <fieldset disabled={busy}><legend>Folder membership</legend>
        <label className="field-label">Unified folder<select value={folder} onChange={(event) => setFolder(event.target.value as MailFolder)}>{UNIFIED_MAIL_FOLDERS.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label className="check-label"><input type="checkbox" checked={overrides?.[folder] !== undefined} onChange={(event) => setOverrides((current) => {
          const next = { ...current }; if (event.target.checked) next[folder] = validMembers; else delete next[folder]; return next
        })} />Customize accounts for this folder</label>
        {overrides?.[folder] !== undefined && accounts.filter((account) => members.includes(account.id)).map((account) => <label className="check-label" key={account.id}><input type="checkbox" checked={overrides[folder]!.includes(account.id)} onChange={() => setOverrides((current) => ({ ...current, [folder]: toggle(current?.[folder] ?? [], account.id) }))} />{account.email}</label>)}
        <p className="recurrence-note">Folders inherit the included accounts unless customized. A custom folder with no checked accounts stays empty.</p>
      </fieldset>
      {members.some((member) => !available.includes(member)) && <p role="status">Unavailable accounts will be removed when this view is saved.</p>}
      {error && <p role="alert">{error}</p>}
      <footer className="modal-footer">
        {id && <button className="button danger" disabled={busy} onClick={() => {
          setBusy(true); setError(''); void onRemove(id).then(() => edit()).catch((reason) => setError(reason instanceof Error ? reason.message : 'View could not be removed')).finally(() => setBusy(false))
        }}>Delete view</button>}
        <button className="button primary" disabled={busy || !name.trim() || !validMembers.length} onClick={() => {
          setBusy(true); setError('')
          const folderAccountIds = Object.fromEntries(Object.entries(overrides ?? {}).map(([key, ids]) => [key, ids.filter((member) => validMembers.includes(member))]))
          void onSave({ id, name: name.trim(), accountIds: validMembers, folderAccountIds }).then(() => edit()).catch((reason) => setError(reason instanceof Error ? reason.message : 'View could not be saved')).finally(() => setBusy(false))
        }}>{busy ? 'Saving…' : 'Save view'}</button>
      </footer>
    </div>
  </Modal>
}
