import { Folder, FolderPlus, Lock, Pencil, Save, Tag, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MailAccountSummary, MailFolderDeletePreview, MailFolderMutationResult, MailLabel } from '../mail-types'
import {
  GMAIL_LABEL_COLORS,
  isSystemMailFolder,
  mailFolderCapabilities,
  mailFolderDescendants,
  mailFolderLeafName,
  mailFolderNameConflict,
  mailFolderNameError,
  mailFolderTree
} from '../lib/mail-folders'
import Modal from './Modal'

interface MailFolderManagerModalProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  initialAccountId?: string
  onChanged(accountId: string, result: MailFolderMutationResult): void
  onToast(message: string): void
  onClose(): void
}

interface FolderEditor {
  labelId?: string
  name: string
  parentId: string
  color?: string
}

interface FolderDeletion {
  label: MailLabel
  preview: MailFolderDeletePreview
  confirmed: boolean
}

// Mirrors FOLDER_NOT_EMPTY_PATTERN in electron/mail/folder-errors.ts.
const NOT_EMPTY = /contains ([\d,]+) messages? on the server/
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`

export default function MailFolderManagerModal({ accounts, labels, initialAccountId, onChanged, onToast, onClose }: MailFolderManagerModalProps) {
  const writable = accounts.filter((account) => !account.archived)
  const [accountId, setAccountId] = useState(() => writable.find((account) => account.id === initialAccountId)?.id ?? writable[0]?.id ?? '')
  const [current, setCurrent] = useState(labels)
  const [editor, setEditor] = useState<FolderEditor>()
  const [deletion, setDeletion] = useState<FolderDeletion>()
  const [busy, setBusy] = useState(false)
  const account = writable.find((item) => item.id === accountId)
  const capabilities = mailFolderCapabilities(account?.provider)
  const noun = capabilities.kind
  const scoped = useMemo(() => current.filter((label) => label.accountId === accountId), [accountId, current])
  // Gmail exposes many system labels (categories, chats); only user labels
  // are manageable there. Folder providers show system folders as parents.
  const rows = useMemo(() => mailFolderTree(accountId, account?.provider === 'gmail' ? scoped.filter((label) => label.type === 'user') : scoped), [account?.provider, accountId, scoped])
  const editing = editor?.labelId ? scoped.find((label) => label.id === editor.labelId) : undefined
  const excluded = new Set(editing ? [editing.id, ...mailFolderDescendants(editing, scoped).map((label) => label.id)] : [])
  const parents = rows.filter((row) => !excluded.has(row.label.id) && (account?.provider !== 'gmail' || row.label.type === 'user'))
  const nameError = editor ? mailFolderNameError(editor.name, account?.provider) ?? (mailFolderNameConflict(accountId, editor.name, editor.parentId || undefined, scoped, editor.labelId) ? `A ${noun} with this name already exists here` : undefined) : undefined

  const apply = (result: MailFolderMutationResult) => {
    setCurrent((items) => [...items.filter((label) => label.accountId !== accountId), ...result.labels])
    onChanged(accountId, result)
  }

  const save = async () => {
    if (!editor || !account || nameError) return
    setBusy(true)
    try {
      if (editing) {
        const name = editor.name.trim() !== mailFolderLeafName(editing, scoped) ? editor.name.trim() : undefined
        const parentId = (editor.parentId || undefined) !== editing.parentId ? editor.parentId || null : undefined
        const color = editor.color && editor.color !== editing.color ? editor.color : undefined
        apply(await window.aerio.mail.folders.update({ accountId, labelId: editing.id, ...(name !== undefined ? { name } : {}), ...(parentId !== undefined ? { parentId } : {}), ...(color ? { color } : {}) }))
        onToast(`${noun === 'label' ? 'Label' : 'Folder'} updated`)
      } else {
        apply(await window.aerio.mail.folders.create({ accountId, name: editor.name.trim(), ...(editor.parentId ? { parentId: editor.parentId } : {}), ...(editor.color ? { color: editor.color } : {}) }))
        onToast(`${noun === 'label' ? 'Label' : 'Folder'} created`)
      }
      setEditor(undefined)
    } catch (error) {
      onToast(error instanceof Error ? error.message : `The ${noun} could not be saved`)
    } finally {
      setBusy(false)
    }
  }

  const beginDelete = async (label: MailLabel) => {
    try {
      setDeletion({ label, preview: await window.aerio.mail.folders.deletePreview(accountId, label.id), confirmed: false })
    } catch (error) {
      onToast(error instanceof Error ? error.message : `The ${noun} could not be checked`)
    }
  }

  const remove = async () => {
    if (!deletion) return
    setBusy(true)
    try {
      apply(await window.aerio.mail.folders.delete({ accountId, labelId: deletion.label.id, confirmNonEmpty: deletion.confirmed }))
      onToast(`${noun === 'label' ? 'Label' : 'Folder'} deleted`)
      setDeletion(undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : `The ${noun} could not be deleted`
      const remote = message.match(NOT_EMPTY)
      // The server holds more mail than Aerio has cached: ask again with
      // the server's count rather than deleting anything.
      if (remote) setDeletion((value) => value && { ...value, confirmed: false, preview: { ...value.preview, messages: Math.max(value.preview.messages, Number(remote[1].replaceAll(',', ''))) } })
      onToast(message)
    } finally {
      setBusy(false)
    }
  }

  if (deletion) {
    const { label, preview } = deletion
    const blocked = preview.childFolders > 0 ? `Delete or move its ${plural(preview.childFolders, 'subfolder')} first.`
      : preview.pendingOperations > 0 ? `${plural(preview.pendingOperations, 'pending mail change')} still use${preview.pendingOperations === 1 ? 's' : ''} this ${noun}. Wait for them to finish or undo them first.` : undefined
    const consequence = account?.provider === 'gmail' ? `The label is removed from ${plural(preview.messages, 'message')}; the messages stay in All Mail.`
      : `${plural(preview.messages, 'message')} will be moved to ${preview.messagesMoveTo ?? 'Trash'} before the folder is deleted.`
    return <Modal title={`Delete ${noun}`} subtitle={label.name} width="small" onClose={() => setDeletion(undefined)}>
      <div className="mail-folder-delete">
        {blocked ? <p role="alert">{blocked}</p> : preview.messages > 0 ? <>
          <p>“{mailFolderLeafName(label, scoped)}” contains {plural(preview.messages, 'message')} in {plural(preview.threads, 'conversation')}. {consequence}</p>
          <label className="rule-enabled"><input type="checkbox" checked={deletion.confirmed} onChange={(event) => setDeletion({ ...deletion, confirmed: event.target.checked })} /> I understand — delete this non-empty {noun}</label>
        </> : <p>“{mailFolderLeafName(label, scoped)}” is empty. Deleting it cannot be undone from Aerio.</p>}
      </div>
      <footer className="modal-footer">
        <button className="button ghost" disabled={busy} onClick={() => setDeletion(undefined)}>Cancel</button>
        <span className="spacer" />
        <button className="button danger-subtle" disabled={busy || Boolean(blocked) || (preview.messages > 0 && !deletion.confirmed)} onClick={() => void remove()}><Trash2 size={15} /> {busy ? 'Deleting…' : `Delete ${noun}`}</button>
      </footer>
    </Modal>
  }

  return <Modal title={noun === 'label' ? 'Manage labels' : 'Manage folders'} subtitle={account?.provider === 'local' ? 'Local Folders are stored only on this computer' : 'Changes are made on the mail provider'} width="medium" onClose={onClose}>
    {!editor ? <>
      <div className="mail-rules-list mail-folder-list">
        {writable.length > 1 && <label className="field"><span>Account</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{writable.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>}
        {!writable.length && <p className="rules-empty">Connect a mail account to manage its folders.</p>}
        {writable.length > 0 && !rows.length && <p className="rules-empty">No {noun}s yet.</p>}
        {rows.map(({ label, depth, leafName }) => {
          const system = isSystemMailFolder(label)
          return <article key={label.id} style={{ marginInlineStart: depth * 18 }}>
            {noun === 'label' ? <Tag size={15} style={{ color: label.color }} /> : <Folder size={15} />}
            <span className="rule-copy"><strong>{leafName}</strong>{system && <small>System {noun}</small>}</span>
            {system ? <Lock size={14} aria-label="Managed by the provider" /> : <>
              {capabilities.canRename && <button className="icon-button" title={`Edit ${leafName}`} aria-label={`Edit ${leafName}`} disabled={busy} onClick={() => setEditor({ labelId: label.id, name: leafName, parentId: label.parentId ?? '', color: label.color })}><Pencil size={15} /></button>}
              {capabilities.canDelete && <button className="icon-button danger" title={`Delete ${leafName}`} aria-label={`Delete ${leafName}`} disabled={busy} onClick={() => void beginDelete(label)}><Trash2 size={15} /></button>}
            </>}
          </article>
        })}
      </div>
      <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Close</button><span className="spacer" /><button className="button primary" disabled={!account || !capabilities.canCreate} onClick={() => setEditor({ name: '', parentId: '' })}><FolderPlus size={15} /> New {noun}</button></footer>
    </> : <>
      <div className="mail-rule-editor">
        <label className="field"><span>Name</span><input autoFocus value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void save() }} placeholder={noun === 'label' ? 'e.g. Receipts' : 'e.g. Projects'} /></label>
        {editor.name.trim() && nameError && <small role="alert" className="mail-folder-error">{nameError}</small>}
        {capabilities.canNest && <label className="field"><span>Nest under</span><select value={editor.parentId} onChange={(event) => setEditor({ ...editor, parentId: event.target.value })}><option value="">Top level</option>{parents.map(({ label, depth, leafName }) => <option key={label.id} value={label.id}>{`${'  '.repeat(depth)}${leafName}`}</option>)}</select></label>}
        {capabilities.canColor && <fieldset className="mail-folder-colors"><legend>Color</legend>{GMAIL_LABEL_COLORS.map((color) => <button type="button" key={color.backgroundColor} aria-label={color.name} aria-pressed={editor.color === color.backgroundColor} title={color.name} style={{ background: color.backgroundColor }} onClick={() => setEditor({ ...editor, color: color.backgroundColor })} />)}</fieldset>}
      </div>
      <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={() => setEditor(undefined)}>Cancel</button><span className="spacer" /><button className="button primary" disabled={busy || Boolean(nameError)} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : editing ? 'Save' : `Create ${noun}`}</button></footer>
    </>}
  </Modal>
}
