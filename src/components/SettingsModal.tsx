import { useEffect, useState } from 'react'
import { Bell, DatabaseBackup, Download, LockKeyhole, Monitor, Palette, RefreshCw, Stethoscope, Upload } from 'lucide-react'
import type { AppLockStatus, AppPreferences, AppUpdateStatus, DensityPreference, ModuleId, ThemePreference } from '../types'
import type { MailDiagnosticHealth } from '../mail-types'
import type { LocalModuleSnapshot } from '../productivity-types'
import Modal from './Modal'

interface SettingsModalProps {
  preferences: AppPreferences
  onChange(next: AppPreferences): void
  onClose(): void
  onLocalDataRestored?(snapshot: LocalModuleSnapshot): void
}

export default function SettingsModal({ preferences, onChange, onClose, onLocalDataRestored }: SettingsModalProps) {
  const [health, setHealth] = useState<MailDiagnosticHealth>()
  const [diagnosticStatus, setDiagnosticStatus] = useState<'idle' | 'checking' | 'exporting'>('idle')
  const [diagnosticMessage, setDiagnosticMessage] = useState('')
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>()
  const [localDataStatus, setLocalDataStatus] = useState<'idle' | 'exporting' | 'importing'>('idle')
  const [localDataMessage, setLocalDataMessage] = useState('')
  const [appLockStatus, setAppLockStatus] = useState<AppLockStatus>()
  const [appLockAction, setAppLockAction] = useState(false)
  const [appLockPassphrase, setAppLockPassphrase] = useState('')
  const [appLockConfirmation, setAppLockConfirmation] = useState('')
  const [appLockMessage, setAppLockMessage] = useState('')
  const [appLockMessageIsError, setAppLockMessageIsError] = useState(false)

  useEffect(() => {
    let active = true
    void window.aerio.updates.status().then((status) => {
      if (active) setUpdateStatus(status)
    }).catch((error) => {
      if (active) setUpdateStatus({ phase: 'error', currentVersion: 'Unknown', message: error instanceof Error ? error.message : 'Update status is unavailable.' })
    })
    const unsubscribe = window.aerio.updates.onStatus((status) => {
      if (active) setUpdateStatus(status)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.aerio.appLock.status().then((status) => { if (active) setAppLockStatus(status) }).catch((error) => {
      if (active) { setAppLockMessageIsError(true); setAppLockMessage(error instanceof Error ? error.message : 'App-lock status is unavailable.') }
    })
    const unsubscribe = window.aerio.appLock.onStatus((status) => { if (active) setAppLockStatus(status) })
    return () => { active = false; unsubscribe() }
  }, [])

  const setSettings = (updates: Partial<AppPreferences['settings']>) => {
    onChange({ ...preferences, settings: { ...preferences.settings, ...updates } })
  }

  const runUpdateAction = async () => {
    if (!updateStatus) return
    try {
      if (updateStatus.phase === 'available') setUpdateStatus(await window.aerio.updates.download())
      else if (updateStatus.phase === 'ready') await window.aerio.updates.install()
      else setUpdateStatus(await window.aerio.updates.check())
    } catch (error) {
      setUpdateStatus((current) => ({
        phase: 'error',
        currentVersion: current?.currentVersion ?? 'Unknown',
        availableVersion: current?.availableVersion,
        message: error instanceof Error ? error.message : 'The update action failed.'
      }))
    }
  }

  const updateActionLabel = !updateStatus
    ? 'Loading update status…'
    : updateStatus.phase === 'checking'
      ? 'Checking…'
      : updateStatus.phase === 'available'
        ? 'Download update'
        : updateStatus.phase === 'downloading'
          ? `Downloading… ${Math.round(updateStatus.progress ?? 0)}%`
          : updateStatus.phase === 'ready'
            ? 'Restart and install'
            : 'Check for updates'
  const updateActionDisabled = !updateStatus || ['unsupported', 'checking', 'downloading'].includes(updateStatus.phase)

  const checkHealth = async () => {
    setDiagnosticStatus('checking')
    setDiagnosticMessage('')
    try {
      const result = await window.aerio.mail.diagnostics.health()
      setHealth(result)
      const problems = (result.integrity === 'ok' ? 0 : 1) + result.accounts.reduce((sum, account) => sum + account.failedDownloads + account.failedOperations + account.failedDrafts, 0) + result.orphanedMessages + result.orphanedAttachments + result.missingRawFiles
      setDiagnosticMessage(result.integrity === 'ok' && problems === 0 ? 'Mail storage is healthy.' : `${problems.toLocaleString()} item${problems === 1 ? '' : 's'} need attention.`)
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : 'The health check failed.')
    } finally {
      setDiagnosticStatus('idle')
    }
  }

  const exportDiagnostics = async () => {
    setDiagnosticStatus('exporting')
    setDiagnosticMessage('')
    try {
      const result = await window.aerio.mail.diagnostics.export()
      if (result.savedPath) setDiagnosticMessage('Diagnostics exported. Credentials and message contents were redacted.')
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : 'Diagnostics could not be exported.')
    } finally {
      setDiagnosticStatus('idle')
    }
  }

  const exportLocalData = async () => {
    setLocalDataStatus('exporting')
    setLocalDataMessage('')
    try {
      const result = await window.aerio.productivity.exportLocalData()
      if (result.savedPath) setLocalDataMessage('Tasks, Notes, and Contacts backup exported.')
    } catch (error) {
      setLocalDataMessage(error instanceof Error ? error.message : 'Local data could not be exported.')
    } finally {
      setLocalDataStatus('idle')
    }
  }

  const importLocalData = async () => {
    if (!window.confirm('Restore Tasks and Notes from a backup? This replaces the current local Tasks and Notes.')) return
    setLocalDataStatus('importing')
    setLocalDataMessage('')
    try {
      const snapshot = await window.aerio.productivity.importLocalData()
      if (snapshot) {
        onLocalDataRestored?.(snapshot)
        const contacts = snapshot.contacts?.length ?? 0
        setLocalDataMessage(`Restored ${snapshot.tasks.length.toLocaleString()} task${snapshot.tasks.length === 1 ? '' : 's'}, ${snapshot.notes.length.toLocaleString()} note${snapshot.notes.length === 1 ? '' : 's'}, and ${contacts.toLocaleString()} contact${contacts === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      setLocalDataMessage(error instanceof Error ? error.message : 'Local data could not be restored.')
    } finally {
      setLocalDataStatus('idle')
    }
  }

  const enableAppLock = async () => {
    if (appLockPassphrase !== appLockConfirmation) { setAppLockMessageIsError(true); return setAppLockMessage('Passphrases do not match.') }
    setAppLockAction(true)
    setAppLockMessage('')
    try {
      setAppLockStatus(await window.aerio.appLock.enable(appLockPassphrase))
      setAppLockPassphrase('')
      setAppLockConfirmation('')
      setAppLockMessageIsError(false)
      setAppLockMessage('App lock enabled. Aerio will lock at launch and when sent to the tray.')
    } catch (error) {
      setAppLockMessageIsError(true)
      setAppLockMessage(error instanceof Error ? error.message : 'App lock could not be enabled.')
    } finally {
      setAppLockAction(false)
    }
  }

  const disableAppLock = async () => {
    if (!window.confirm('Turn off the Aerio app lock?')) return
    setAppLockAction(true)
    setAppLockMessage('')
    try {
      setAppLockStatus(await window.aerio.appLock.disable(appLockPassphrase))
      setAppLockPassphrase('')
      setAppLockMessageIsError(false)
      setAppLockMessage('App lock disabled.')
    } catch (error) {
      setAppLockMessageIsError(true)
      setAppLockMessage(error instanceof Error ? error.message : 'App lock could not be disabled.')
    } finally {
      setAppLockAction(false)
    }
  }

  return (
    <Modal title="Aerio settings" subtitle="Make your workspace feel just right." width="medium" onClose={onClose}>
      <div className="settings-sections">
        <section className="settings-section">
          <div className="settings-icon"><LockKeyhole size={18} /></div>
          <div className="settings-content">
            <h3>App lock</h3>
            <p>Hide your workspace behind a local passphrase at launch and whenever Aerio is sent to the tray.</p>
            {!appLockStatus ? <small>Reading app-lock status…</small> : appLockStatus.enabled ? <>
              <label className="field-label">Current passphrase
                <input type="password" autoComplete="current-password" value={appLockPassphrase} onChange={(event) => setAppLockPassphrase(event.target.value)} />
              </label>
              <div className="settings-actions">
                <button className="button primary" disabled={appLockAction} onClick={() => void window.aerio.appLock.lock()}><LockKeyhole size={16} /> Lock Aerio now</button>
                <button className="button danger-subtle" disabled={appLockAction || !appLockPassphrase} onClick={() => void disableAppLock()}>Turn off app lock</button>
              </div>
            </> : <>
              <label className="field-label">New passphrase
                <input type="password" autoComplete="new-password" value={appLockPassphrase} onChange={(event) => setAppLockPassphrase(event.target.value)} />
              </label>
              <label className="field-label">Confirm passphrase
                <input type="password" autoComplete="new-password" value={appLockConfirmation} onChange={(event) => setAppLockConfirmation(event.target.value)} />
              </label>
              <button className="button ghost" disabled={appLockAction || !appLockPassphrase || !appLockConfirmation} onClick={() => void enableAppLock()}><LockKeyhole size={16} /> Enable app lock</button>
            </>}
            {appLockMessage && <small className={appLockMessageIsError ? 'diagnostic-error' : 'diagnostic-result'} role="status">{appLockMessage}</small>}
            <small>This is a privacy screen, not file encryption. A forgotten passphrase requires resetting Aerio’s local app settings.</small>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><DatabaseBackup size={18} /></div>
          <div className="settings-content">
            <h3>Local data backup</h3>
            <p>Export local Tasks, Notes, and Contacts to a portable JSON backup, or restore them on this PC.</p>
            <div className="settings-actions">
              <button className="button ghost" disabled={localDataStatus !== 'idle'} onClick={() => void exportLocalData()}><Download size={16} /> {localDataStatus === 'exporting' ? 'Exporting…' : 'Export backup'}</button>
              <button className="button ghost" disabled={localDataStatus !== 'idle'} onClick={() => void importLocalData()}><Upload size={16} /> {localDataStatus === 'importing' ? 'Restoring…' : 'Restore backup'}</button>
            </div>
            {localDataMessage && <small className="diagnostic-result" aria-live="polite">{localDataMessage}</small>}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><RefreshCw size={18} /></div>
          <div className="settings-content">
            <h3>Aerio updates</h3>
            <p>Installed Windows builds check GitHub Releases and let you choose when to download and restart.</p>
            <button className="button ghost" disabled={updateActionDisabled} onClick={() => void runUpdateAction()}>
              {updateStatus?.phase === 'available' ? <Download size={16} /> : <RefreshCw size={16} />}
              {updateActionLabel}
            </button>
            {updateStatus?.phase === 'downloading' && <progress className="update-progress" max="100" value={updateStatus.progress ?? 0} aria-label="Update download progress" />}
            <small className={updateStatus?.phase === 'error' ? 'diagnostic-error' : undefined} aria-live="polite">
              {updateStatus ? `Version ${updateStatus.currentVersion} · ${updateStatus.message ?? updateStatus.phase}` : 'Reading update status…'}
            </small>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><Palette size={18} /></div>
          <div className="settings-content">
            <h3>Appearance</h3>
            <p>Choose a theme and how much information appears at once.</p>
            <div className="segmented wide">
              {(['system', 'light', 'dark'] as ThemePreference[]).map((theme) => (
                <button key={theme} className={preferences.settings.theme === theme ? 'active' : ''} aria-pressed={preferences.settings.theme === theme} onClick={() => setSettings({ theme })}>{theme}</button>
              ))}
            </div>
            <div className="segmented wide">
              {(['comfortable', 'compact'] as DensityPreference[]).map((density) => (
                <button key={density} className={preferences.settings.density === density ? 'active' : ''} aria-pressed={preferences.settings.density === density} onClick={() => setSettings({ density })}>{density}</button>
              ))}
            </div>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><Stethoscope size={18} /></div>
          <div className="settings-content">
            <h3>Mail diagnostics</h3>
            <p>Check the local mail database or create a privacy-redacted report for troubleshooting.</p>
            <div className="settings-actions">
              <button className="button ghost" disabled={diagnosticStatus !== 'idle'} onClick={() => void checkHealth()}><Stethoscope size={16} /> {diagnosticStatus === 'checking' ? 'Checking…' : 'Check mail storage'}</button>
              <button className="button ghost" disabled={diagnosticStatus !== 'idle'} onClick={() => void exportDiagnostics()}><Download size={16} /> {diagnosticStatus === 'exporting' ? 'Exporting…' : 'Export diagnostics'}</button>
            </div>
            {diagnosticMessage && <small className={health?.integrity === 'error' ? 'diagnostic-error' : 'diagnostic-result'}>{diagnosticMessage}</small>}
            {health && <small>{health.accounts.reduce((sum, account) => sum + account.messages, 0).toLocaleString()} messages · {health.accounts.length} account{health.accounts.length === 1 ? '' : 's'} · checked {new Date(health.generatedAt).toLocaleTimeString()}</small>}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><Monitor size={18} /></div>
          <div className="settings-content">
            <h3>Desktop behaviour</h3>
            <label className="toggle-row">
              <span><strong>Keep scheduling active in the tray</strong><small>Required for scheduled sending, snooze, mail rules, and background synchronization while the window is closed.</small></span>
              <input type="checkbox" checked={preferences.settings.closeToTray} onChange={(event) => {
                setSettings({ closeToTray: event.target.checked })
              }} />
            </label>
            {!preferences.settings.closeToTray && <small className="diagnostic-error">Background actions pause whenever Aerio is fully closed.</small>}
            <label className="toggle-row">
              <span><strong>Start Aerio when you sign in</strong><small>Starts minimized to the normal app workspace so scheduled work can resume after a Windows restart.</small></span>
              <input type="checkbox" checked={Boolean(preferences.settings.launchAtLogin)} onChange={(event) => setSettings({ launchAtLogin: event.target.checked })} />
            </label>
            <label className="field-label">Open Aerio to
              <select value={preferences.settings.startModule} onChange={(event) => setSettings({ startModule: event.target.value as ModuleId })}>
                <option value="mail">Mail</option>
                <option value="calendar">Calendar</option>
                <option value="contacts">Contacts</option>
                <option value="tasks">Tasks</option>
                <option value="notes">Notes</option>
              </select>
            </label>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><Bell size={18} /></div>
          <div className="settings-content">
            <h3>Notifications</h3>
            <label className="toggle-row">
              <span><strong>Desktop notifications</strong><small>Use native desktop notifications for new mail, including while Aerio is open.</small></span>
              <input type="checkbox" checked={preferences.settings.notifications} onChange={(event) => setSettings({ notifications: event.target.checked })} />
            </label>
          </div>
        </section>
      </div>
    </Modal>
  )
}
