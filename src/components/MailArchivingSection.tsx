import { Archive, Eye, FolderPlus, ListChecks, Pause, Play, Save, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import type { MailArchiveItem, MailArchivePolicyInput, MailArchivePreview, MailArchiveStatus } from '../mail-archive-types'
import { defaultMailArchivePolicy, isFinishedMailArchiveJob, mailArchiveFrequencyLabel, mailArchiveJobSummary, mailArchiveSupported } from '../lib/mail-archive'
import { LOCAL_FOLDERS_ACCOUNT_ID } from '../lib/local-folders'
import { isSystemMailFolder } from '../lib/mail-folders'
import { formatFileSize } from '../lib/domain'

interface MailArchivingSectionProps {
  account: MailAccountSummary
  onToast(message: string): void
}

// Provider flags and Gmail categories are not folders a user archives from.
const HIDDEN_SOURCE_LABELS = new Set(['UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'DRAFT', 'CHAT'])
const sourceFolders = (labels: MailLabel[]) => labels
  .filter((label) => !HIDDEN_SOURCE_LABELS.has(label.id) && !label.id.startsWith('CATEGORY_'))
  .sort((left, right) => left.name.localeCompare(right.name))
const folderName = (label: MailLabel) => label.id === 'INBOX' ? 'Inbox' : label.id === 'SENT' ? 'Sent' : label.name
const when = (value?: string) => value ? new Date(value).toLocaleString() : '—'
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

const STATE_LABELS: Record<MailArchiveItem['state'], string> = {
  pending: 'Waiting to copy', copied: 'Copied and verified', 'removal-queued': 'Removing from server', done: 'Archived', failed: 'Failed', skipped: 'Skipped'
}

function FolderChecklist({ labels, selected, onChange, label }: { labels: MailLabel[]; selected: string[]; onChange(ids: string[]): void; label: string }) {
  return <fieldset className="mail-archive-folders" aria-label={label}>
    {labels.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /> {folderName(item)}</label>)}
    {!labels.length && <small>No folders have been synchronized yet.</small>}
  </fieldset>
}

export default function MailArchivingSection({ account, onToast }: MailArchivingSectionProps) {
  const api = window.aerio.mail.archiving
  const [status, setStatus] = useState<MailArchiveStatus>()
  const [draft, setDraft] = useState<MailArchivePolicyInput>(() => defaultMailArchivePolicy(account.id))
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [destinations, setDestinations] = useState<MailLabel[]>([])
  const [preview, setPreview] = useState<MailArchivePreview>()
  const [items, setItems] = useState<{ jobId: string; items: MailArchiveItem[] }>()
  const [busy, setBusy] = useState<'load' | 'save' | 'preview' | 'run' | 'job' | 'folder' | undefined>('load')
  const [loadError, setLoadError] = useState<string>()

  const loadDestinations = useCallback(async () => {
    const local = await window.aerio.mail.mail.labels([LOCAL_FOLDERS_ACCOUNT_ID]).catch(() => [] as MailLabel[])
    setDestinations(local.filter((label) => label.accountId === LOCAL_FOLDERS_ACCOUNT_ID && !isSystemMailFolder(label)).sort((left, right) => left.name.localeCompare(right.name)))
  }, [])

  const load = useCallback(async () => {
    if (!api) return
    setBusy('load')
    setLoadError(undefined)
    try {
      const [next, accountLabels] = await Promise.all([api.get(account.id), window.aerio.mail.mail.labels([account.id]), loadDestinations()])
      setStatus(next)
      setLabels(sourceFolders(accountLabels.filter((label) => label.accountId === account.id)))
      if (next.policy) {
        const { createdAt: _created, updatedAt: _updated, lastRunAt: _lastRun, lastRunStatus: _lastStatus, lastError: _lastError, nextRunAt: _next, ...policy } = next.policy
        setDraft(policy)
      }
    } catch (error) {
      setLoadError(message(error, 'Automatic archiving settings could not be loaded'))
    } finally {
      setBusy(undefined)
    }
  }, [account.id, api, loadDestinations])

  useEffect(() => { void load() }, [load])

  useEffect(() => window.aerio.mail.onEvent((event) => {
    if (event.type !== 'archive-progress' || event.payload.accountId !== account.id || !api) return
    void api.get(account.id).then(setStatus).catch(() => undefined)
  }), [account.id, api])

  const update = <K extends keyof MailArchivePolicyInput>(key: K, value: MailArchivePolicyInput[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setPreview(undefined)
  }
  const updateExclude = <K extends keyof MailArchivePolicyInput['exclude']>(key: K, value: MailArchivePolicyInput['exclude'][K]) => update('exclude', { ...draft.exclude, [key]: value })
  const updateSubfolders = <K extends keyof MailArchivePolicyInput['subfolders']>(key: K, value: boolean) => update('subfolders', { ...draft.subfolders, [key]: value })

  const run = async <T,>(kind: 'save' | 'preview' | 'run' | 'job' | 'folder', action: () => Promise<T>, failure: string) => {
    setBusy(kind)
    try {
      return await action()
    } catch (error) {
      onToast(message(error, failure))
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  const createDestination = () => run('folder', async () => {
    await window.aerio.mail.imports?.ensureLocalFolders()
    const result = await window.aerio.mail.folders.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Archive' })
    await loadDestinations()
    if (result.label) update('destinationLabelId', result.label.id)
    onToast('Created the Archive folder in Local Folders')
  }, 'The Local Folders folder could not be created')

  const save = () => run('save', async () => {
    if (draft.removal === 'delete' && draft.enabled && !window.confirm('Archived messages will be permanently deleted from the server after their local copy is verified. They will exist only in Local Folders on this computer and in your backups. Continue?')) return
    const next = await api!.save(draft)
    setStatus(next)
    onToast(draft.enabled ? 'Automatic archiving is on' : 'Archive policy saved')
  }, 'The archive policy could not be saved')

  const showPreview = () => run('preview', async () => setPreview(await api!.preview(draft)), 'The preview could not be created')

  const runNow = () => run('run', async () => {
    if (!window.confirm(`Archive mail older than ${draft.olderThan} ${draft.unit} now? Each message is copied to Local Folders and verified before its server copy is ${draft.removal === 'delete' ? 'permanently deleted' : 'moved to Trash'}. Save the policy first if you changed it.`)) return
    await api!.runNow(account.id)
    setStatus(await api!.get(account.id))
    onToast('Archiving started')
  }, 'Archiving could not start')

  const jobAction = (jobId: string, action: 'resume' | 'cancel') => run('job', async () => {
    await api![action](jobId)
    setStatus(await api!.get(account.id))
  }, action === 'resume' ? 'The archive run could not be resumed' : 'The archive run could not be cancelled')

  const showItems = (jobId: string) => run('job', async () => setItems({ jobId, items: await api!.items(jobId) }), 'The archive run details could not be loaded')

  if (!api || !mailArchiveSupported(account.provider, account.archived)) return null
  const working = Boolean(busy)
  const policy = status?.policy
  const active = status?.jobs.find((job) => !isFinishedMailArchiveJob(job))

  return <section aria-labelledby="mail-archiving-heading" className="mail-archiving">
    <h3 id="mail-archiving-heading">Automatic archiving</h3>
    <p>Move old mail from this account into Local Folders on a schedule. Archived messages are then only on this computer (and in your Aerio profile backups); they are no longer on the server or other devices. Runs happen while Aerio or its tray process is running and catch up on the next launch.</p>
    {loadError && <p className="account-error">{loadError}</p>}
    {status && <fieldset className="mail-archive-form" disabled={working}>
      <label className="toggle-row"><span><strong>Archive automatically</strong><small>{policy?.nextRunAt ? `Next run ${when(policy.nextRunAt)}` : 'Off. Preview and Run now still work with a saved policy.'}</small></span><input type="checkbox" checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} /></label>
      <div className="mail-archive-row">
        <label className="field"><span>Archive mail received more than</span><input type="number" min={1} value={draft.olderThan || ''} onChange={(event) => update('olderThan', Math.max(0, Math.round(Number(event.target.value) || 0)))} /></label>
        <label className="field"><span>Unit</span><select value={draft.unit} onChange={(event) => update('unit', event.target.value as MailArchivePolicyInput['unit'])}><option value="days">days ago</option><option value="months">months ago</option></select></label>
        <label className="field"><span>How often</span><select value={draft.frequency} onChange={(event) => update('frequency', event.target.value as MailArchivePolicyInput['frequency'])}>{(['daily', 'weekly', 'monthly'] as const).map((value) => <option key={value} value={value}>{mailArchiveFrequencyLabel(value)}</option>)}</select></label>
      </div>
      <label className="field"><span>What to archive</span><select value={draft.scope} onChange={(event) => update('scope', event.target.value as MailArchivePolicyInput['scope'])}><option value="account">The whole account</option><option value="folders">Only selected folders</option></select></label>
      {draft.scope === 'folders' && <FolderChecklist label="Folders to archive" labels={labels} selected={draft.folderIds} onChange={(ids) => update('folderIds', ids)} />}
      <div className="mail-archive-keep">
        <strong>Always keep on the server</strong>
        <label><input type="checkbox" checked={draft.exclude.starred} onChange={(event) => updateExclude('starred', event.target.checked)} /> Starred or flagged messages</label>
        <label><input type="checkbox" checked={draft.exclude.unread} onChange={(event) => updateExclude('unread', event.target.checked)} /> Unread messages</label>
        <label><input type="checkbox" checked={draft.exclude.pinned} onChange={(event) => updateExclude('pinned', event.target.checked)} /> Pinned conversations</label>
        <label><input type="checkbox" checked={draft.exclude.drafts} onChange={(event) => updateExclude('drafts', event.target.checked)} /> Drafts</label>
        <label><input type="checkbox" checked={draft.exclude.sent} onChange={(event) => updateExclude('sent', event.target.checked)} /> Sent mail</label>
        <details><summary>Folders to keep ({draft.exclude.folderIds.length})</summary><FolderChecklist label="Folders to keep" labels={labels} selected={draft.exclude.folderIds} onChange={(ids) => updateExclude('folderIds', ids)} /></details>
        <small>Messages in Trash or Spam are never archived. Only messages older than the cutoff move, so newer replies stay in their conversation.</small>
      </div>
      <div className="mail-archive-row">
        <label className="field grow"><span>Local Folders destination</span><select value={draft.destinationLabelId} onChange={(event) => update('destinationLabelId', event.target.value)}>
          <option value="">Choose a folder…</option>
          {destinations.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
        </select></label>
        {!destinations.length && <button type="button" className="button ghost" onClick={() => void createDestination()}><FolderPlus size={15} /> {busy === 'folder' ? 'Creating…' : 'Create “Archive” folder'}</button>}
      </div>
      <div className="mail-archive-keep">
        <strong>Organize archived mail into subfolders</strong>
        <label><input type="checkbox" checked={draft.subfolders.perAccount} onChange={(event) => updateSubfolders('perAccount', event.target.checked)} /> One folder for this account ({account.email})</label>
        <label><input type="checkbox" checked={draft.subfolders.perYear} onChange={(event) => updateSubfolders('perYear', event.target.checked)} /> One folder per year received</label>
        <label><input type="checkbox" checked={draft.subfolders.mirrorSourcePath} onChange={(event) => updateSubfolders('mirrorSourcePath', event.target.checked)} /> Mirror the original folder path</label>
      </div>
      <label className="field"><span>After the local copy is verified</span><select value={draft.removal} onChange={(event) => update('removal', event.target.value as MailArchivePolicyInput['removal'])}>
        <option value="trash">Move the server copy to Trash</option>
        <option value="delete" disabled={Boolean(status.deleteUnavailable)}>Delete the server copy permanently</option>
      </select></label>
      {status.deleteUnavailable && <small className="mail-archive-note">{status.deleteUnavailable}</small>}
    </fieldset>}
    {status && <div className="settings-actions">
      <button className="button ghost" disabled={working} onClick={() => void showPreview()}><Eye size={15} /> {busy === 'preview' ? 'Checking…' : 'Preview'}</button>
      <button className="button ghost" disabled={working} onClick={() => void save()}><Save size={15} /> {busy === 'save' ? 'Saving…' : 'Save archive policy'}</button>
      <button className="button ghost" disabled={working || !policy || Boolean(active && active.status === 'running')} onClick={() => void runNow()}><Archive size={15} /> {busy === 'run' ? 'Starting…' : 'Run now'}</button>
    </div>}
    {preview && <div className="mail-archive-preview" role="region" aria-label="Archive preview">
      <p><strong>{preview.count.toLocaleString()} message{preview.count === 1 ? '' : 's'}</strong> ({formatFileSize(preview.bytes)}) received before {new Date(preview.cutoff).toLocaleDateString()} would move to Local Folders.</p>
      {Object.values(preview.excluded).some(Boolean) && <small>Kept: {[
        [preview.excluded.starred, 'starred'], [preview.excluded.unread, 'unread'], [preview.excluded.pinned, 'pinned'], [preview.excluded.drafts, 'drafts'],
        [preview.excluded.sent, 'sent'], [preview.excluded.folders, 'in kept folders'], [preview.excluded.notDownloaded, 'not downloaded yet'], [preview.excluded.inOtherJob, 'already being archived']
      ].filter(([count]) => count).map(([count, label]) => `${Number(count).toLocaleString()} ${label}`).join(', ')}</small>}
      {preview.sample.length > 0 && <table>
        <thead><tr><th>Subject</th><th>From</th><th>Received</th><th>Destination</th></tr></thead>
        <tbody>{preview.sample.map((item) => <tr key={item.messageId}><td>{item.subject}</td><td>{item.from}</td><td>{new Date(item.receivedAt).toLocaleDateString()}</td><td>{item.destination}</td></tr>)}</tbody>
      </table>}
      {preview.count > preview.sample.length && <small>Showing the oldest {preview.sample.length} of {preview.count.toLocaleString()}.</small>}
    </div>}
    {policy && <p>Last run: <strong>{when(policy.lastRunAt)}</strong>{policy.lastRunStatus ? ` · ${policy.lastRunStatus}` : ''}</p>}
    {policy?.lastError && <p className="account-error">{policy.lastError}</p>}
    {status && status.jobs.length > 0 && <ul className="mail-archive-history" aria-label="Archive history">
      {status.jobs.map((job) => <li key={job.id}>
        <span><strong>{new Date(job.createdAt).toLocaleString()} · {job.trigger === 'manual' ? 'Run now' : 'Scheduled'} · {job.status}</strong><small>{mailArchiveJobSummary(job)}{job.bytes ? ` · ${formatFileSize(job.bytes)}` : ''}</small>{job.error && <small className="account-error">{job.error}</small>}</span>
        <span className="mail-archive-job-actions">
          {job.status === 'paused' && <button className="button ghost" disabled={working} onClick={() => void jobAction(job.id, 'resume')}><Play size={14} /> Resume</button>}
          {!isFinishedMailArchiveJob(job) && <button className="button ghost" disabled={working} onClick={() => void jobAction(job.id, 'cancel')}>{job.status === 'paused' ? <X size={14} /> : <Pause size={14} />} Cancel</button>}
          {job.total > 0 && <button className="button ghost" disabled={working} onClick={() => void showItems(job.id)}><ListChecks size={14} /> Details</button>}
        </span>
      </li>)}
    </ul>}
    {items && <div className="mail-archive-preview" role="region" aria-label="Archive run details">
      <table>
        <thead><tr><th>Subject</th><th>Received</th><th>State</th></tr></thead>
        <tbody>{items.items.map((item) => <tr key={item.messageId}><td>{item.subject}</td><td>{new Date(item.receivedAt).toLocaleDateString()}</td><td>{STATE_LABELS[item.state]}{item.reason ? ` — ${item.reason}` : ''}</td></tr>)}</tbody>
      </table>
      <div><button className="button ghost" onClick={() => setItems(undefined)}>Close details</button></div>
    </div>}
  </section>
}
