import { Bookmark, Pencil, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MailAccountSummary, MailFolder, MailLabel, MailSavedSearch, MailSavedSearchInput, MailSearchFilters } from '../mail-types'
import { MAIL_FOLDERS, savedSearchMatchesView } from '../lib/mail-saved-search'
import { mailSearchQueryError } from '../lib/mail-search-query'
import { useContextMenu } from './ContextMenu'
import Modal from './Modal'

/** The mail view state a saved search captures and restores. */
export interface MailSearchView {
  accountId: string
  folder: MailFolder
  labelId?: string
  query: string
  filters: MailSearchFilters
}

export const savedSearchFromView = (view: MailSearchView, name: string, id?: string): MailSavedSearchInput => ({
  ...(id ? { id } : {}),
  name,
  query: view.query.trim(),
  folder: view.folder,
  ...(view.accountId !== 'all' ? { accountId: view.accountId } : {}),
  ...(view.labelId && view.accountId !== 'all' ? { labelId: view.labelId } : {}),
  filters: view.filters
})

export function useMailSavedSearches(onToast: (message: string) => void) {
  const [searches, setSearches] = useState<MailSavedSearch[]>([])

  const load = useCallback(async () => {
    try {
      setSearches(await window.aerio.mail.savedSearches.list())
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Saved searches could not be loaded')
    }
  }, [onToast])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async (input: MailSavedSearchInput) => {
    const saved = await window.aerio.mail.savedSearches.save(input)
    setSearches((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })))
    return saved
  }, [])

  const remove = useCallback(async (search: MailSavedSearch) => {
    try {
      await window.aerio.mail.savedSearches.delete(search.id)
      setSearches((current) => current.filter((item) => item.id !== search.id))
      onToast(`Deleted “${search.name}”`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The saved search could not be deleted')
    }
  }, [onToast])

  return { searches, save, remove, reload: load }
}

interface MailSavedSearchListProps {
  searches: MailSavedSearch[]
  view: MailSearchView
  onOpen(search: MailSavedSearch): void
  onEdit(search: MailSavedSearch): void
  onReplace(search: MailSavedSearch): void
  onDelete(search: MailSavedSearch): void
}

export function MailSavedSearchList({ searches, view, onOpen, onEdit, onReplace, onDelete }: MailSavedSearchListProps) {
  const { showContextMenu } = useContextMenu()
  if (!searches.length) return null
  return (
    <div className="sidebar-group">
      <span className="sidebar-label">Saved searches</span>
      {searches.map((search) => {
        const active = savedSearchMatchesView(search, view)
        return <button key={search.id} className={`sidebar-item ${active ? 'active' : ''}`} aria-pressed={active} title={search.query || 'Filters only'} onClick={() => onOpen(search)} onContextMenu={(event) => showContextMenu(event, [
          { label: `Open ${search.name}`, icon: Search, action: () => onOpen(search) },
          { label: 'Edit saved search…', icon: Pencil, action: () => onEdit(search) },
          { label: 'Replace with current search', icon: RefreshCw, disabled: active || Boolean(mailSearchQueryError(view.query)), action: () => onReplace(search) },
          { label: 'Delete saved search', icon: Trash2, danger: true, separatorBefore: true, action: () => onDelete(search) }
        ], search.name)}><Bookmark size={15} /><span>{search.name}</span></button>
      })}
    </div>
  )
}

const folderLabels: Record<MailFolder, string> = {
  inbox: 'Inbox', starred: 'Starred', important: 'Important', sent: 'Sent', drafts: 'Drafts', scheduled: 'Scheduled',
  snoozed: 'Snoozed', archive: 'Archive', spam: 'Spam', trash: 'Trash', all: 'All mail'
}

interface MailSaveSearchModalProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  initial: MailSavedSearchInput
  onSave(input: MailSavedSearchInput): Promise<unknown>
  onClose(): void
}

export function MailSaveSearchModal({ accounts, labels, initial, onSave, onClose }: MailSaveSearchModalProps) {
  const [draft, setDraft] = useState<MailSavedSearchInput>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const queryError = mailSearchQueryError(draft.query)
  const filterCount = Object.values(draft.filters).filter((value) => value !== undefined && value !== '').length
  const label = labels.find((item) => item.accountId === draft.accountId && item.id === draft.labelId)

  const submit = async () => {
    if (queryError) return
    setBusy(true)
    setError(undefined)
    try {
      await onSave({ ...draft, name: draft.name.trim() })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The search could not be saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={initial.id ? 'Edit saved search' : 'Save search'} subtitle="Saved searches update as new mail arrives" width="small" onClose={onClose}>
      <form className="mail-save-search" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label className="field"><span>Name</span><input autoFocus value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Unpaid invoices" /></label>
        <label className="field"><span>Search</span><input value={draft.query} aria-invalid={Boolean(queryError)} aria-describedby="mail-save-search-hint" onChange={(event) => setDraft({ ...draft, query: event.target.value })} placeholder='from:ada "launch plan" -draft' /></label>
        <small id="mail-save-search-hint" className={queryError ? 'mail-search-error' : 'mail-search-hint'} role={queryError ? 'alert' : undefined}>{queryError ?? 'Use quotes for phrases, AND, OR, NOT (or -word), parentheses, and from:, to:, subject:, body:, attachment:.'}</small>
        <label className="field"><span>Account</span><select value={draft.accountId ?? ''} onChange={(event) => setDraft({ ...draft, accountId: event.target.value || undefined, labelId: undefined })}><option value="">All accounts</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label>
        <label className="field"><span>Mailbox</span><select value={draft.folder} onChange={(event) => setDraft({ ...draft, folder: event.target.value as MailFolder })}>{MAIL_FOLDERS.filter((folder) => folder !== 'scheduled').map((folder) => <option key={folder} value={folder}>{folderLabels[folder]}</option>)}</select></label>
        {(label || filterCount > 0) && <p className="mail-search-hint">{[label && `Label: ${label.name}`, filterCount > 0 && `${filterCount} advanced filter${filterCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</p>}
        {error && <p className="mail-search-error" role="alert">{error}</p>}
        <footer className="modal-footer"><button type="button" className="button ghost" disabled={busy} onClick={onClose}>Cancel</button><span className="spacer" /><button type="submit" className="button primary" disabled={busy || Boolean(queryError) || !draft.name.trim()}><Save size={15} /> {busy ? 'Saving…' : 'Save search'}</button></footer>
      </form>
    </Modal>
  )
}
