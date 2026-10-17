import { useEffect, useState } from 'react'
import { Archive, FolderOpen, RotateCcw, ShieldCheck } from 'lucide-react'
import type { ProfileBackupPreview, ProfileBackupSchedule, ProfileBackupStatus } from '../profile-backup-types'

const intervals: [number, string][] = [[24, 'Daily'], [72, 'Every 3 days'], [168, 'Weekly']]

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
const formatTime = (value?: string) => value ? new Date(value).toLocaleString() : ''
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export default function ProfileBackupSection() {
  const api = window.aerio.profileBackup
  const [status, setStatus] = useState<ProfileBackupStatus>()
  const [busy, setBusy] = useState<'backup' | 'preview' | 'restore' | 'schedule'>()
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const [preview, setPreview] = useState<ProfileBackupPreview>()

  useEffect(() => {
    let active = true
    void api.status().then((next) => { if (active) setStatus(next) }).catch((error) => {
      if (active) { setMessageIsError(true); setMessage(errorText(error, 'Profile backup status is unavailable.')) }
    })
    return () => { active = false }
  }, [api])

  const report = (text: string, isError = false) => { setMessage(text); setMessageIsError(isError) }

  const saveSchedule = async (updates: Partial<ProfileBackupSchedule>) => {
    if (!status) return
    setBusy('schedule')
    try { setStatus(await api.saveSchedule({ ...status.schedule, ...updates })); report('') }
    catch (error) { report(errorText(error, 'The backup schedule could not be saved.'), true) }
    finally { setBusy(undefined) }
  }

  const chooseDirectory = async () => {
    try {
      const directory = await api.chooseDirectory()
      if (directory) await saveSchedule({ directory })
    } catch (error) { report(errorText(error, 'That folder cannot be used for backups.'), true) }
  }

  const backupNow = async () => {
    setBusy('backup')
    report('')
    try {
      const summary = await api.backupNow()
      report(`Profile backup created (${summary.fileCount.toLocaleString()} files, ${formatBytes(summary.totalBytes)}).`)
      setStatus(await api.status())
    } catch (error) {
      report(errorText(error, 'The profile backup failed.'), true)
      setStatus(await api.status().catch(() => status))
    } finally { setBusy(undefined) }
  }

  const previewRestore = async (path?: string) => {
    setBusy('preview')
    report('')
    try {
      const result = await api.preview(path)
      if (result) setPreview(result)
    } catch (error) { report(errorText(error, 'That profile backup could not be verified.'), true) }
    finally { setBusy(undefined) }
  }

  const restore = async () => {
    if (!preview) return
    setBusy('restore')
    try {
      await api.restore(preview.path)
      report('Backup verified and staged. Aerio is restarting to finish the restore…')
    } catch (error) {
      report(errorText(error, 'The profile backup could not be restored.'), true)
      setBusy(undefined)
    }
  }

  const dismissOutcome = async () => {
    await api.dismissRestoreOutcome().catch(() => undefined)
    setStatus((current) => current ? { ...current, lastRestore: undefined } : current)
  }

  const outcome = status?.lastRestore
  return (
    <section className="settings-section">
      <div className="settings-icon"><Archive size={18} /></div>
      <div className="settings-content">
        <h3>Full profile backup</h3>
        <p>Back up the mail cache, drafts, queued changes, rules, templates, local Tasks/Notes/Contacts, and preferences as a verified snapshot. Sign-in tokens and passwords are never included.</p>
        {outcome && <div className={`profile-restore-outcome ${outcome.status}`} role="status">
          <strong>{outcome.status === 'applied' ? `Restored the backup from ${formatTime(outcome.backupCreatedAt)}.` : 'The profile restore was not applied.'}</strong>
          {outcome.status === 'applied' && outcome.report && <span>
            {outcome.report.heldSends > 0 && `${outcome.report.heldSends.toLocaleString()} outgoing message${outcome.report.heldSends === 1 ? ' is' : 's are'} held in Drafts for review. `}
            {outcome.report.heldTaskWrites > 0 && `${outcome.report.heldTaskWrites.toLocaleString()} connected task change${outcome.report.heldTaskWrites === 1 ? ' is' : 's are'} waiting for review. `}
            {outcome.report.accountsToReauthorize > 0 && 'Accounts that cannot sign in with this device’s saved credentials need to be reconnected.'}
          </span>}
          {outcome.error && <span>{outcome.error}</span>}
          <button className="button ghost" onClick={() => void dismissOutcome()}>Dismiss</button>
        </div>}
        <label className="toggle-row">
          <span><strong>Back up automatically</strong><small>Runs while Aerio is open or in the tray and keeps the newest backups.</small></span>
          <input type="checkbox" disabled={!status || busy === 'schedule'} checked={Boolean(status?.schedule.enabled)} onChange={(event) => void saveSchedule({ enabled: event.target.checked })} />
        </label>
        <div className="profile-backup-fields">
          <label className="field-label">Frequency
            <select disabled={!status || busy === 'schedule'} value={status?.schedule.intervalHours ?? 24} onChange={(event) => void saveSchedule({ intervalHours: Number(event.target.value) })}>
              {intervals.map(([hours, label]) => <option key={hours} value={hours}>{label}</option>)}
            </select>
          </label>
          <label className="field-label">Backups to keep
            <select disabled={!status || busy === 'schedule'} value={status?.schedule.keep ?? 7} onChange={(event) => void saveSchedule({ keep: Number(event.target.value) })}>
              {[...new Set([1, 3, 5, 7, 10, 14, 30, status?.schedule.keep ?? 7])].sort((a, b) => a - b).map((keep) => <option key={keep} value={keep}>{keep}</option>)}
            </select>
          </label>
        </div>
        <small title={status?.schedule.directory}>Folder: {status?.schedule.directory ?? 'Loading…'}</small>
        <div className="settings-actions">
          <button className="button ghost" disabled={!status || Boolean(busy)} onClick={() => void chooseDirectory()}><FolderOpen size={16} /> Change folder</button>
          <button className="button ghost" disabled={!status || Boolean(busy)} onClick={() => void backupNow()}><ShieldCheck size={16} /> {busy === 'backup' ? 'Backing up…' : 'Back up now'}</button>
          <button className="button ghost" disabled={!status || Boolean(busy)} onClick={() => void previewRestore()}><RotateCcw size={16} /> {busy === 'preview' ? 'Verifying…' : 'Restore from folder…'}</button>
        </div>
        {status?.lastBackupAt && <small>Last backup {formatTime(status.lastBackupAt)}{status.nextBackupAt ? ` · next ${formatTime(status.nextBackupAt)}` : ''}</small>}
        {status?.lastError && <small className="diagnostic-error">Last automatic attempt failed: {status.lastError}</small>}
        {Boolean(status?.backups.length) && <ul className="profile-backup-list" aria-label="Profile backups">
          {status!.backups.slice(0, 10).map((backup) => <li key={backup.path}>
            <span><strong>{formatTime(backup.createdAt)}</strong><small>{backup.trigger === 'scheduled' ? 'Automatic' : 'Manual'} · {formatBytes(backup.totalBytes)} · Aerio {backup.appVersion}</small></span>
            <button className="button ghost" disabled={Boolean(busy)} onClick={() => void previewRestore(backup.path)}>Preview restore</button>
          </li>)}
        </ul>}
        {preview && <div className="profile-restore-preview" role="region" aria-label="Restore preview">
          <strong>Restore the backup from {formatTime(preview.createdAt)}?</strong>
          <small>Verified {preview.fileCount.toLocaleString()} files ({formatBytes(preview.totalBytes)}) against their checksums.</small>
          <ul>{preview.counts.filter((item) => item.count > 0).map((item) => <li key={item.label}>{item.label}: {item.count.toLocaleString()}</li>)}</ul>
          <ul className="profile-restore-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <div className="settings-actions">
            <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => void restore()}>{busy === 'restore' ? 'Restoring…' : 'Restore and restart'}</button>
            <button className="button ghost" disabled={busy === 'restore'} onClick={() => setPreview(undefined)}>Cancel</button>
          </div>
        </div>}
        {message && <small className={messageIsError ? 'diagnostic-error' : 'diagnostic-result'} aria-live="polite">{message}</small>}
      </div>
    </section>
  )
}
