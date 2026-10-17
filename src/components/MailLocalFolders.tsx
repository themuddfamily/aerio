import { CheckCircle2, Copy, Eye, EyeOff, FileWarning, Folder, FolderInput, FolderOpen, HardDrive, Import, Pause, Play, Square, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Modal from './Modal'
import type {
  MailAccountSummary,
  MailImportChooseResult,
  MailImportDuplicatePolicy,
  MailImportItem,
  MailImportJob,
  MailLabel,
  MailThreadSummary,
  MailboxVariant
} from '../mail-types'
import { isLocalFoldersAccount } from '../lib/local-folders'
import { mailFolderTree } from '../lib/mail-folders'
import { folderKey, sidebarFolderRows } from '../lib/mail-folder-preferences'
import type { MailFolderAppearance } from '../mail-folder-preference-types'
import { FolderGlyph } from './MailSidebarFolders'

const NO_APPEARANCE = new Map<string, MailFolderAppearance>()
const NO_COLLAPSED = new Set<string>()
import { formatFileSize } from '../lib/domain'

const statusText: Record<MailImportJob['status'], string> = {
  queued: 'Waiting to start',
  running: 'Importing',
  paused: 'Paused',
  interrupted: 'Interrupted — resume to continue',
  cancelled: 'Cancelled',
  completed: 'Finished',
  failed: 'Stopped by an error'
}

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function localFoldersAccountOf(accounts: MailAccountSummary[]) {
  return accounts.find((account) => isLocalFoldersAccount(account))
}

function LocalFolderOptions({ accountId, labels }: { accountId?: string; labels: MailLabel[] }) {
  if (!accountId) return null
  return <>{mailFolderTree(accountId, labels).map(({ label, depth, leafName }) => <option key={label.id} value={label.id}>{`${'  '.repeat(depth)}${leafName}`}</option>)}</>
}

// Keeps a live list of import jobs from the worker's progress events.
export function useMailImportJobs() {
  const api = window.aerio?.mail?.imports
  const [jobs, setJobs] = useState<MailImportJob[]>([])
  const reload = useCallback(async () => {
    if (!api) return
    setJobs(await api.list())
  }, [api])
  useEffect(() => {
    void reload().catch(() => undefined)
    return window.aerio.mail.onEvent((event) => {
      if (event.type !== 'import-progress') return
      setJobs((items) => items.some((item) => item.id === event.payload.id)
        ? items.map((item) => item.id === event.payload.id ? event.payload : item)
        : [event.payload, ...items])
    })
  }, [reload])
  return { jobs, setJobs, reload }
}

interface ImportModalProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  onClose(): void
  onToast(message: string): void
  onLocalFoldersChanged(): void
}

function JobRow({ job, busy, onAction, onReview }: { job: MailImportJob; busy: boolean; onAction(action: 'pause' | 'resume' | 'cancel' | 'dismiss'): void; onReview(): void }) {
  const percent = job.totalBytes ? Math.min(100, Math.round(job.processedBytes / job.totalBytes * 100)) : 0
  const active = job.status === 'running' || job.status === 'queued'
  const resumable = job.status === 'paused' || job.status === 'interrupted' || job.status === 'failed'
  const summary = [
    plural(job.imported, 'message') + ' imported',
    job.duplicates ? plural(job.duplicates, 'duplicate') : '',
    job.failed ? `${job.failed.toLocaleString()} failed` : '',
    job.skipped ? `${job.skipped.toLocaleString()} deleted in the source, skipped` : ''
  ].filter(Boolean).join(' · ')
  return <article className={`mail-import-job ${job.status}`} aria-label={`Import ${job.label}`}>
    <span className="rule-copy">
      <strong>{job.label}</strong>
      <small>{statusText[job.status]}{job.currentSource && job.status === 'running' ? ` · ${fileName(job.currentSource)}` : ''}</small>
      <small>{summary}</small>
      {job.error && <small role="alert" className="mail-folder-error">{job.error}</small>}
      <progress max={100} value={percent} aria-label={`${percent}% of ${formatFileSize(job.totalBytes)}`} />
    </span>
    <span className="mail-import-job-actions">
      {(job.pendingReview > 0 || job.failed > 0) && <button className="button ghost small" disabled={busy} onClick={onReview}><FileWarning size={14} /> {job.pendingReview ? `Review ${job.pendingReview.toLocaleString()}` : 'Details'}</button>}
      {active && <button className="icon-button" title="Pause import" aria-label="Pause import" disabled={busy} onClick={() => onAction('pause')}><Pause size={14} /></button>}
      {resumable && <button className="icon-button" title="Resume import" aria-label="Resume import" disabled={busy} onClick={() => onAction('resume')}><Play size={14} /></button>}
      {(active || resumable) && <button className="icon-button danger" title="Cancel import" aria-label="Cancel import" disabled={busy} onClick={() => onAction('cancel')}><Square size={14} /></button>}
      {!active && <button className="icon-button" title="Remove from list" aria-label="Remove from list" disabled={busy} onClick={() => onAction('dismiss')}><X size={14} /></button>}
    </span>
  </article>
}

function DuplicateReview({ job, onBack, onToast, onResolved }: { job: MailImportJob; onBack(): void; onToast(message: string): void; onResolved(job: MailImportJob): void }) {
  const api = window.aerio.mail.imports!
  const [items, setItems] = useState<MailImportItem[]>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const next = await api.items(job.id)
    setItems(next)
    setSelected(new Set(next.filter((item) => item.status === 'duplicate').map((item) => item.key)))
  }, [api, job.id])
  useEffect(() => { void load().catch((error) => onToast(errorText(error, 'The import details could not be loaded'))) }, [load, onToast])
  const pending = items?.filter((item) => item.status === 'duplicate') ?? []
  const resolve = async (decision: 'import' | 'discard') => {
    setBusy(true)
    try {
      const updated = await api.resolve(job.id, [...selected], decision)
      onResolved(updated)
      onToast(decision === 'import' ? `Imported ${plural(selected.size, 'message')}` : `Discarded ${plural(selected.size, 'duplicate')}`)
      await load()
    } catch (error) {
      onToast(errorText(error, 'The duplicates could not be updated'))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  return <>
    <div className="mail-rules-list mail-import-review">
      <p className="mail-import-hint">Aerio held back messages already in Local Folders, matched by Message-ID or by identical content. Import the ones you want to keep as separate copies; discarding leaves the existing message untouched.</p>
      {!items && <p className="rules-empty">Loading…</p>}
      {items && !items.length && <p className="rules-empty">Nothing needs review.</p>}
      {items?.map((item) => <article key={item.key} className={item.status}>
        {item.status === 'duplicate'
          ? <input type="checkbox" aria-label={`Select ${item.subject || 'message'}`} checked={selected.has(item.key)} onChange={() => toggle(item.key)} />
          : item.status === 'imported' ? <CheckCircle2 size={15} aria-label="Imported" /> : <FileWarning size={15} aria-label={item.status} />}
        <span className="rule-copy">
          <strong>{item.subject || '(No subject)'}</strong>
          <small>{[item.from, item.date ? new Date(item.date).toLocaleString() : '', formatFileSize(item.size)].filter(Boolean).join(' · ')}</small>
          <small>{item.reason}{item.duplicateOf ? ` — existing: “${item.duplicateOf.subject}”` : ''}</small>
          <small className="mail-import-source">{fileName(item.source)}</small>
        </span>
      </article>)}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" disabled={busy} onClick={onBack}>Back</button>
      <span className="spacer" />
      <button className="button ghost" disabled={busy || !selected.size || !pending.length} onClick={() => void resolve('discard')}><Trash2 size={15} /> Discard selected</button>
      <button className="button primary" disabled={busy || !selected.size || !pending.length} onClick={() => void resolve('import')}><Import size={15} /> Import selected</button>
    </footer>
  </>
}

/**
 * Imports MBOX, EML and Outlook PST/OST files into Local Folders and shows the progress,
 * pause/resume/cancel controls and duplicate review of every import job.
 */
export function MailImportModal({ accounts, labels, onClose, onToast, onLocalFoldersChanged }: ImportModalProps) {
  const api = window.aerio.mail.imports
  const local = localFoldersAccountOf(accounts)
  const { jobs, setJobs, reload } = useMailImportJobs()
  const [chosen, setChosen] = useState<MailImportChooseResult>({ paths: [], unsupported: [] })
  const [parentLabelId, setParentLabelId] = useState('')
  const [duplicates, setDuplicates] = useState<MailImportDuplicatePolicy>('review')
  const [mboxVariant, setMboxVariant] = useState<MailboxVariant>('mboxrd')
  const [reviewing, setReviewing] = useState<string>()
  const [busy, setBusy] = useState(false)
  const reviewJob = jobs.find((job) => job.id === reviewing)

  // Folder lists change while an import creates folders; refresh as jobs move on.
  const progressKey = jobs.map((job) => `${job.id}:${job.status}:${job.currentSource ?? ''}`).join('|')
  useEffect(() => { if (progressKey) onLocalFoldersChanged() }, [progressKey, onLocalFoldersChanged])

  if (!api) return <Modal title="Import mail" width="small" onClose={onClose}><p className="rules-empty">Mail import is not available in this version of Aerio.</p></Modal>

  const choose = async (kind: 'files' | 'folder') => {
    try {
      const result = await api.choose(kind)
      setChosen((current) => ({ paths: [...new Set([...current.paths, ...result.paths])], unsupported: [...current.unsupported, ...result.unsupported] }))
    } catch (error) {
      onToast(errorText(error, 'The files could not be chosen'))
    }
  }

  const start = async () => {
    setBusy(true)
    try {
      const job = await api.start({ paths: chosen.paths, duplicates, mboxVariant, ...(parentLabelId ? { parentLabelId } : {}) })
      setJobs((items) => [job, ...items.filter((item) => item.id !== job.id)])
      setChosen({ paths: [], unsupported: [] })
      onLocalFoldersChanged()
      onToast(`Importing ${job.label}`)
    } catch (error) {
      onToast(errorText(error, 'The import could not start'))
    } finally {
      setBusy(false)
    }
  }

  const act = async (job: MailImportJob, action: 'pause' | 'resume' | 'cancel' | 'dismiss') => {
    setBusy(true)
    try {
      if (action === 'dismiss') {
        await api.dismiss(job.id)
        setJobs((items) => items.filter((item) => item.id !== job.id))
      } else {
        const updated = await api[action](job.id)
        setJobs((items) => items.map((item) => item.id === updated.id ? updated : item))
        if (action === 'cancel') onToast(`Import cancelled. ${plural(updated.imported, 'message')} already imported stay in Local Folders.`)
      }
    } catch (error) {
      onToast(errorText(error, 'The import could not be changed'))
      await reload().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  const createLocalFolders = async () => {
    setBusy(true)
    try {
      await api.ensureLocalFolders()
      onLocalFoldersChanged()
      onToast('Local Folders created')
    } catch (error) {
      onToast(errorText(error, 'Local Folders could not be created'))
    } finally {
      setBusy(false)
    }
  }

  if (reviewJob) return <Modal title="Review import" subtitle={reviewJob.label} width="medium" onClose={onClose}>
    <DuplicateReview job={reviewJob} onBack={() => setReviewing(undefined)} onToast={onToast} onResolved={(updated) => { setJobs((items) => items.map((item) => item.id === updated.id ? updated : item)); onLocalFoldersChanged() }} />
  </Modal>

  return <Modal title="Import mail" subtitle="Into Local Folders, stored only on this computer" width="medium" onClose={onClose}>
    <div className="mail-rule-editor mail-import">
      {!local && <div className="mail-import-local">
        <HardDrive size={18} />
        <p>Local Folders hold mail that is not on any server: imported archives and messages you copy out of other accounts. Nothing in them is ever sent to a mail server.</p>
        <button className="button ghost small" disabled={busy} onClick={() => void createLocalFolders()}>Create Local Folders</button>
      </div>}
      <div className="mail-import-choose">
        <button className="button ghost" disabled={busy} onClick={() => void choose('files')}><Upload size={15} /> Choose MBOX, EML or PST files…</button>
        <button className="button ghost" disabled={busy} onClick={() => void choose('folder')}><FolderOpen size={15} /> Choose a folder…</button>
      </div>
      <p className="mail-import-hint">Folders keep their structure: each mbox file, Outlook data file (.pst/.ost) and directory becomes a folder, including Thunderbird and Apple Mail exports and the folders inside a PST.</p>
      {chosen.paths.length > 0 && <ul className="mail-import-chosen" aria-label="Chosen for import">
        {chosen.paths.map((path) => <li key={path}><Folder size={13} /> <span title={path}>{fileName(path)}</span><button className="icon-button" aria-label={`Remove ${fileName(path)}`} onClick={() => setChosen((current) => ({ ...current, paths: current.paths.filter((item) => item !== path) }))}><X size={13} /></button></li>)}
      </ul>}
      {chosen.unsupported.map((item) => <p key={item.path} role="alert" className="mail-import-unsupported"><FileWarning size={14} /> <span><strong>{fileName(item.path)}</strong> — {item.reason}</span></p>)}
      <label className="field"><span>Import into</span><select value={parentLabelId} onChange={(event) => setParentLabelId(event.target.value)}><option value="">Top level of Local Folders</option><LocalFolderOptions accountId={local?.id} labels={labels} /></select></label>
      <label className="field"><span>Duplicates</span><select value={duplicates} onChange={(event) => setDuplicates(event.target.value as MailImportDuplicatePolicy)}><option value="review">Hold for review (same Message-ID or identical content)</option><option value="import">Import everything</option></select></label>
      <label className="field"><span>MBOX format</span><select value={mboxVariant} onChange={(event) => setMboxVariant(event.target.value as MailboxVariant)}><option value="mboxrd">mboxrd — Thunderbird, Apple Mail, Gmail Takeout</option><option value="mboxo">mboxo — older mail programs</option></select></label>
    </div>
    {jobs.length > 0 && <div className="mail-rules-list mail-import-jobs" aria-label="Imports">
      {jobs.map((job) => <JobRow key={job.id} job={job} busy={busy} onAction={(action) => void act(job, action)} onReview={() => setReviewing(job.id)} />)}
    </div>}
    <footer className="modal-footer">
      <button className="button ghost" onClick={onClose}>Close</button>
      <span className="spacer" />
      <button className="button primary" disabled={busy || !chosen.paths.length} onClick={() => void start()}><Import size={15} /> {busy ? 'Starting…' : 'Import'}</button>
    </footer>
  </Modal>
}

interface TransferModalProps {
  items: Pick<MailThreadSummary, 'accountId' | 'id'>[]
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  onClose(): void
  onToast(message: string): void
  onDone(): void
}

/** Copies or moves the selected conversations from other accounts into a Local Folders folder. */
export function MailLocalTransferModal({ items, accounts, labels, onClose, onToast, onDone }: TransferModalProps) {
  const api = window.aerio.mail.imports
  const local = localFoldersAccountOf(accounts)
  const rows = useMemo(() => local ? mailFolderTree(local.id, labels) : [], [labels, local])
  const [destination, setDestination] = useState(() => rows[0]?.label.id ?? '')
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const [busy, setBusy] = useState(false)
  const sources = useMemo(() => {
    const groups = new Map<string, string[]>()
    for (const item of items) if (item.accountId !== local?.id) groups.set(item.accountId, [...(groups.get(item.accountId) ?? []), item.id])
    return [...groups]
  }, [items, local?.id])
  const archivedSource = sources.some(([accountId]) => accounts.find((account) => account.id === accountId)?.archived)

  const run = async () => {
    if (!api || !destination) return
    setBusy(true)
    let copied = 0
    let skipped = 0
    let missing = 0
    try {
      for (const [sourceAccountId, threadIds] of sources) {
        for (let index = 0; index < threadIds.length; index += 500) {
          const result = await api.transfer({ sourceAccountId, threadIds: threadIds.slice(index, index + 500), destinationLabelId: destination, mode })
          copied += result.copied
          skipped += result.skipped
          missing += result.missing
        }
      }
      const parts = [`${mode === 'move' ? 'Moved' : 'Copied'} ${plural(copied, 'message')} to Local Folders`]
      if (skipped) parts.push(`${skipped.toLocaleString()} already there`)
      if (missing) parts.push(`${missing.toLocaleString()} not downloaded${mode === 'move' ? ', so those conversations were left in place' : ''}`)
      onToast(parts.join(' · '))
      onDone()
      onClose()
    } catch (error) {
      onToast(errorText(error, 'The messages could not be copied'))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={mode === 'move' ? 'Move to Local Folders' : 'Copy to Local Folders'} subtitle={plural(sources.reduce((sum, [, ids]) => sum + ids.length, 0), 'conversation')} width="small" onClose={onClose}>
    <div className="mail-rule-editor">
      {!rows.length ? <p className="rules-empty">Create a folder in Local Folders first.</p> : <>
        <label className="field"><span>Folder</span><select value={destination} onChange={(event) => setDestination(event.target.value)}>{rows.map(({ label, depth, leafName }) => <option key={label.id} value={label.id}>{`${'  '.repeat(depth)}${leafName}`}</option>)}</select></label>
        <label className="field"><span>Action</span><select value={mode} onChange={(event) => setMode(event.target.value as 'copy' | 'move')}><option value="copy">Copy — keep the originals</option><option value="move" disabled={archivedSource}>Move — copy, then move the originals to Trash</option></select></label>
        <p className="mail-import-hint">The original message source is copied, including attachments, dates and read and starred state. Only downloaded messages can be copied.</p>
      </>}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
      <span className="spacer" />
      <button className="button primary" disabled={busy || !destination || !sources.length} onClick={() => void run()}>{mode === 'move' ? <FolderInput size={15} /> : <Copy size={15} />} {busy ? 'Working…' : mode === 'move' ? 'Move' : 'Copy'}</button>
    </footer>
  </Modal>
}

interface SidebarProps {
  account: MailAccountSummary
  labels: MailLabel[]
  selectedAccountId: string
  selectedLabelId?: string
  onOpen(label: MailLabel): void
  onContextMenu(event: React.MouseEvent, label: MailLabel): void
  onManage(): void
  onImport(): void
  /** Local icon, name color, and visibility (E35); defaults to the plain folder look. */
  appearance?: Map<string, MailFolderAppearance>
  showHidden?: boolean
  onToggleHidden?(): void
}

/** The Local Folders folder tree in the mail sidebar, nested like the source mailboxes. */
export function LocalFoldersSidebar({ account, labels, selectedAccountId, selectedLabelId, onOpen, onContextMenu, onManage, onImport, appearance = NO_APPEARANCE, showHidden = false, onToggleHidden }: SidebarProps) {
  const rows = sidebarFolderRows(account.id, labels, { appearance, showHidden, collapsed: NO_COLLAPSED })
  const hiddenCount = labels.filter((label) => label.accountId === account.id && appearance.get(folderKey(account.id, label.id))?.hidden).length
  return <div className="sidebar-group local-folders-sidebar">
    <span className="sidebar-label">Local Folders</span>
    {hiddenCount > 0 && onToggleHidden && <button className="sidebar-item mail-folder-hidden-toggle" aria-pressed={showHidden} onClick={onToggleHidden}>{showHidden ? <EyeOff size={14} /> : <Eye size={14} />}<span>{showHidden ? 'Hide hidden folders' : `Show hidden folders (${hiddenCount.toLocaleString()})`}</span></button>}
    {rows.map(({ label, depth, leafName, hidden }) => {
      const selected = selectedAccountId === account.id && selectedLabelId === label.id
      const look = appearance.get(folderKey(account.id, label.id))
      return <button key={label.id} className={`sidebar-item ${selected ? 'active' : ''} ${hidden ? 'is-hidden' : ''}`} aria-pressed={selected} style={{ paddingInlineStart: 10 + depth * 14 }} title={label.name} onClick={() => onOpen(label)} onContextMenu={(event) => onContextMenu(event, label)}>
        {look?.icon ? <FolderGlyph icon={look.icon} /> : selected ? <FolderOpen size={15} /> : <Folder size={15} />}<span style={look?.color ? { color: look.color } : undefined}>{leafName}</span>
      </button>
    })}
    {!rows.length && !hiddenCount && <button className="sidebar-item" onClick={onManage}><Folder size={15} /><span>Create a folder</span></button>}
    <button className="sidebar-item" onClick={onImport}><Import size={15} /><span>Import mail…</span></button>
  </div>
}
