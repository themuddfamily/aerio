import { AlertTriangle, ArrowRightLeft, CheckCircle2, Copy, FileUp, HardDrive, RefreshCw, Server } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  NoteOwnerTarget, NoteTransferResult, ServerNoteResolution, ServerNotesSnapshot, VNoteDuplicateMode, VNoteImportResult, VNotePreview
} from '../server-notes-types'
import type { Note } from '../types'
import { isServerNote } from '../lib/use-server-notes'
import Modal from './Modal'

// Dialogs for server-synchronized Notes (docs/server-notes.md): copy or move between owners,
// vNote import with a preview, and conflict review.

const targetKey = (target: NoteOwnerTarget) => target.kind === 'local' ? `local:${target.folder}` : `server:${target.folderId}`
const targetFromKey = (key: string): NoteOwnerTarget => key.startsWith('server:') ? { kind: 'server', folderId: key.slice(7) } : { kind: 'local', folder: key.slice(6) }
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

interface TargetSelectProps {
  label: string
  value: string
  localFolders: string[]
  snapshot: ServerNotesSnapshot
  exclude?: string
  onChange(value: string): void
}

/** Local folders and writable provider folders, grouped by owner. */
function NoteTargetSelect({ label, value, localFolders, snapshot, exclude, onChange }: TargetSelectProps) {
  const accounts = snapshot.accounts.filter((account) => snapshot.folders.some((folder) => folder.accountId === account.id && !folder.readOnly))
  return <label className="field"><span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <optgroup label="Local">
        {localFolders.filter((folder) => `local:${folder}` !== exclude).map((folder) => <option key={folder} value={`local:${folder}`}>{folder}</option>)}
      </optgroup>
      {accounts.map((account) => <optgroup key={account.id} label={account.name}>
        {snapshot.folders.filter((folder) => folder.accountId === account.id && !folder.readOnly && `server:${folder.id}` !== exclude).map((folder) => <option key={folder.id} value={`server:${folder.id}`}>{folder.name}</option>)}
      </optgroup>)}
    </select>
  </label>
}

export function ownerLabel(note: Note, snapshot: ServerNotesSnapshot) {
  if (!isServerNote(note)) return `Local › ${note.folder}`
  const account = snapshot.accounts.find((item) => item.id === note.owner.accountId)
  return `${account?.name ?? 'Account'} › ${note.folder}`
}

interface TransferProps {
  mode: 'copy' | 'move'
  note: Note
  localFolders: string[]
  snapshot: ServerNotesSnapshot
  onClose(): void
  onDone(result: NoteTransferResult, targetName: string): void
}

export function NoteTransferDialog({ mode, note, localFolders: allLocalFolders, snapshot, onClose, onDone }: TransferProps) {
  // A Local note changes Local folders with its folder menu; here it goes to a provider folder.
  const localFolders = isServerNote(note) ? allLocalFolders : []
  const own = isServerNote(note) ? `server:${note.owner.folderId}` : `local:${note.folder}`
  const options = useMemo(() => [
    ...localFolders.map((folder) => `local:${folder}`),
    ...snapshot.folders.filter((folder) => !folder.readOnly).map((folder) => `server:${folder.id}`)
  ].filter((key) => key !== own), [localFolders, own, snapshot.folders])
  const [target, setTarget] = useState(options[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const moveBlocked = mode === 'move' && isServerNote(note) && note.readOnly
  const targetName = (key: string) => {
    const parsed = targetFromKey(key)
    if (parsed.kind === 'local') return `Local › ${parsed.folder}`
    const folder = snapshot.folders.find((item) => item.id === parsed.folderId)
    return `${snapshot.accounts.find((account) => account.id === folder?.accountId)?.name ?? 'Account'} › ${folder?.name ?? 'Notes'}`
  }
  const submit = async () => {
    const api = window.aerio.serverNotes
    if (!api || !target) return
    setBusy(true)
    setError('')
    try {
      const result = await api.transfer({ mode, target: targetFromKey(target), ...(isServerNote(note) ? { serverNoteIds: [note.id] } : { localNotes: [note] }) })
      if (result.errors.length && !result.copied) throw new Error(result.errors[0])
      onDone(result, targetName(target))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The note could not be copied')
      setBusy(false)
    }
  }
  return <Modal title={mode === 'copy' ? 'Copy note' : 'Move note'} subtitle={`“${note.title}” · ${ownerLabel(note, snapshot)}`} width="small" onClose={onClose}>
    <div className="server-notes-dialog">
      {options.length ? <NoteTargetSelect label={mode === 'copy' ? 'Copy to' : 'Move to'} value={target} localFolders={localFolders} snapshot={snapshot} exclude={own} onChange={setTarget} />
        : <p>There is no other notes folder to {mode} this note to.</p>}
      <p className="server-notes-hint">
        {mode === 'copy' ? 'Pictures and attachments are copied with the note. The original stays where it is.'
          : 'The note is created in the new folder first. The original is deleted only after the copy exists; if the server has not confirmed it yet, the original is kept.'}
      </p>
      {moveBlocked && <p role="alert">This note is in a read-only folder, so it can be copied but not moved.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
      <span className="spacer" />
      <button className="button primary" disabled={busy || !target || moveBlocked} onClick={() => void submit()}>{mode === 'copy' ? <Copy size={15} /> : <ArrowRightLeft size={15} />} {busy ? 'Working…' : mode === 'copy' ? 'Copy' : 'Move'}</button>
    </footer>
  </Modal>
}

export function transferMessage(result: NoteTransferResult, mode: 'copy' | 'move', targetName: string) {
  if (result.errors.length) return result.errors[0]
  if (mode === 'copy') return `Copied to ${targetName}`
  return result.pendingMoves ? `Copied to ${targetName}. The original was kept until the server confirms the copy.` : `Moved to ${targetName}`
}

interface ImportProps {
  localFolders: string[]
  snapshot: ServerNotesSnapshot
  initialTarget: NoteOwnerTarget
  onClose(): void
  onImported(result: VNoteImportResult, targetName: string): void
}

export function VNoteImportDialog({ localFolders, snapshot, initialTarget, onClose, onImported }: ImportProps) {
  const [target, setTarget] = useState(() => {
    const key = targetKey(initialTarget)
    const writable = initialTarget.kind === 'local' || snapshot.folders.some((folder) => folder.id === initialTarget.folderId && !folder.readOnly)
    return writable ? key : `local:${localFolders[0] ?? 'Personal'}`
  })
  const [preview, setPreview] = useState<VNotePreview>()
  const [duplicates, setDuplicates] = useState<VNoteDuplicateMode>('skip')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.aerio.serverNotes

  useEffect(() => {
    if (!preview || !api) return
    let active = true
    void api.previewVNote(preview.token, targetFromKey(target)).then((next) => { if (active) setPreview(next) }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The preview could not be updated'))
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const choose = async () => {
    if (!api) return
    setBusy(true)
    setError('')
    try {
      const next = await api.chooseVNoteFile(targetFromKey(target))
      if (next) setPreview(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file could not be read')
    } finally { setBusy(false) }
  }
  const run = async () => {
    if (!api || !preview) return
    setBusy(true)
    setError('')
    try {
      const result = await api.importVNote({ token: preview.token, target: targetFromKey(target), duplicates })
      const parsed = targetFromKey(target)
      onImported(result, parsed.kind === 'local' ? `Local › ${parsed.folder}` : snapshot.folders.find((folder) => folder.id === parsed.folderId)?.name ?? 'Notes')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The notes could not be imported')
      setBusy(false)
    }
  }
  const importable = preview ? preview.valid - (duplicates === 'skip' ? preview.entries.filter((entry) => entry.duplicate && !entry.error).length : 0) : 0
  return <Modal title="Import vNote file" subtitle={preview ? preview.fileName : 'Notes from .vnt files (vNote 1.1)'} width="medium" onClose={onClose}>
    <div className="server-notes-dialog">
      <NoteTargetSelect label="Import into" value={target} localFolders={localFolders} snapshot={snapshot} onChange={setTarget} />
      <button className="button ghost" disabled={busy} onClick={() => void choose()}><FileUp size={15} /> {preview ? 'Choose another file…' : 'Choose .vnt file…'}</button>
      {preview && <>
        <p className="server-notes-summary">{plural(preview.count, 'note')} found · {preview.valid} readable · {plural(preview.duplicates, 'duplicate')} in this folder</p>
        {preview.errors.map((item) => <p key={item} className="server-notes-hint">{item}</p>)}
        <ul className="vnote-preview" aria-label="Notes in the file">
          {preview.entries.map((entry) => <li key={entry.index} className={entry.error ? 'error' : entry.duplicate ? 'duplicate' : ''}>
            <strong>{entry.title}</strong>
            <span>{entry.error ?? (entry.excerpt || 'Empty note')}</span>
            {entry.duplicate && <small>Duplicate of “{entry.duplicate.title}” ({entry.duplicate.reason === 'luid' ? 'same X-IRMC-LUID' : 'same title and text'})</small>}
          </li>)}
        </ul>
        {preview.duplicates > 0 && <fieldset className="vnote-duplicates"><legend>Duplicates</legend>
          {([['skip', 'Skip them'], ['replace', 'Replace the existing notes'], ['copy', 'Import them as copies']] as const).map(([value, label]) => <label key={value}><input type="radio" name="vnote-duplicates" checked={duplicates === value} onChange={() => setDuplicates(value)} /> {label}</label>)}
        </fieldset>}
      </>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
      <span className="spacer" />
      <button className="button primary" disabled={busy || !preview || (importable <= 0 && duplicates !== 'replace')} onClick={() => void run()}>{busy ? 'Importing…' : preview ? `Import ${plural(duplicates === 'replace' ? preview.valid : importable, 'note')}` : 'Import'}</button>
    </footer>
  </Modal>
}

export function importMessage(result: VNoteImportResult, targetName: string) {
  const parts = [`${plural(result.imported, 'note')} imported into ${targetName}`]
  if (result.replaced) parts.push(`${result.replaced} replaced`)
  if (result.skipped) parts.push(`${result.skipped} skipped`)
  if (result.failed) parts.push(`${result.failed} could not be read`)
  return parts.join(' · ')
}

interface ReviewProps {
  snapshot: ServerNotesSnapshot
  onClose(): void
  onLocalNotes(notes: Note[]): void
  onToast(message: string): void
}

export function ServerNotesReviewDialog({ snapshot, onClose, onLocalNotes, onToast }: ReviewProps) {
  const [busy, setBusy] = useState('')
  const resolve = async (id: string, resolution: ServerNoteResolution) => {
    const api = window.aerio.serverNotes
    if (!api) return
    setBusy(id)
    try {
      const result = await api.resolve(id, resolution)
      if (result.localNotes.length) onLocalNotes(result.localNotes)
      onToast(resolution === 'keep-mine' ? 'Your version will be sent again' : resolution === 'keep-server' ? 'Kept the server version' : resolution === 'keep-both' ? 'Kept both versions' : 'Saved your version in Local Notes')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The change could not be resolved')
    } finally { setBusy('') }
  }
  const folderName = (id: string) => snapshot.folders.find((folder) => folder.id === id)?.name ?? 'Removed folder'
  return <Modal title="Notes to review" subtitle="Changes the server did not accept. Nothing is overwritten until you choose." width="medium" onClose={onClose}>
    <div className="server-notes-dialog">
      {!snapshot.review.length && <p><CheckCircle2 size={15} /> Every note change has been accepted.</p>}
      <ul className="server-notes-review">
        {snapshot.review.map((item) => <li key={item.id}>
          <header><AlertTriangle size={15} /><strong>{item.title}</strong><small>{folderName(item.folderId)} · {item.action === 'delete' ? 'Delete' : item.action === 'create' ? 'New note' : 'Edit'}</small></header>
          <p>{item.error}</p>
          {item.mineExcerpt !== undefined && item.action !== 'delete' && <p className="server-notes-version"><span>Yours</span>{item.mineExcerpt || 'Empty note'}</p>}
          {item.serverDeleted ? <p className="server-notes-version"><span>Server</span>Deleted</p> : item.serverTitle !== undefined && <p className="server-notes-version"><span>Server</span>{item.serverTitle}{item.serverExcerpt ? ` — ${item.serverExcerpt}` : ''}</p>}
          <div className="settings-actions">
            <button className="button primary" disabled={Boolean(busy)} onClick={() => void resolve(item.id, 'keep-mine')}>{item.action === 'delete' ? 'Delete anyway' : item.status === 'conflict' ? 'Keep mine' : 'Send again'}</button>
            <button className="button ghost" disabled={Boolean(busy)} onClick={() => void resolve(item.id, 'keep-server')}>{item.status === 'conflict' ? 'Keep server' : 'Discard my change'}</button>
            {item.canKeepBoth && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void resolve(item.id, 'keep-both')}>Keep both</button>}
            {item.action !== 'delete' && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void resolve(item.id, 'copy-local')}><HardDrive size={14} /> Save mine to Local</button>}
          </div>
        </li>)}
      </ul>
    </div>
    <footer className="modal-footer"><span className="spacer" /><button className="button ghost" onClick={onClose}>Close</button></footer>
  </Modal>
}

/** One line of account status for the Notes sidebar. */
export function ServerNotesAccountHeading({ name, status, error, onSync, syncing }: { name: string; status: string; error?: string; syncing: boolean; onSync(): void }) {
  return <div className="sidebar-label server-notes-account" title={error}>
    <Server size={12} /><span>{name}</span>
    {status === 'error' || status === 'needs-auth' ? <AlertTriangle size={12} aria-label={error ?? 'Needs attention'} /> : null}
    <button className="icon-button" aria-label={`Synchronize notes for ${name}`} title="Synchronize" disabled={syncing} onClick={onSync}><RefreshCw size={12} className={syncing ? 'spinning' : ''} /></button>
  </div>
}
