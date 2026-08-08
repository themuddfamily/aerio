import { useEffect, useState } from 'react'
import { Bell, Download, Monitor, Palette, RefreshCw, Stethoscope } from 'lucide-react'
import type { AppPreferences, AppUpdateStatus, DensityPreference, ModuleId, ThemePreference } from '../types'
import type { MailDiagnosticHealth } from '../mail-types'
import Modal from './Modal'

interface SettingsModalProps {
  preferences: AppPreferences
  onChange(next: AppPreferences): void
  onClose(): void
}

export default function SettingsModal({ preferences, onChange, onClose }: SettingsModalProps) {
  const [health, setHealth] = useState<MailDiagnosticHealth>()
  const [diagnosticStatus, setDiagnosticStatus] = useState<'idle' | 'checking' | 'exporting'>('idle')
  const [diagnosticMessage, setDiagnosticMessage] = useState('')
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>()

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

  return (
    <Modal title="Aerio settings" subtitle="Make your workspace feel just right." width="medium" onClose={onClose}>
      <div className="settings-sections">
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
              <span><strong>Keep Aerio in the tray</strong><small>Closing the window keeps your workspace ready.</small></span>
              <input type="checkbox" checked={preferences.settings.closeToTray} onChange={(event) => setSettings({ closeToTray: event.target.checked })} />
            </label>
            <label className="field-label">Open Aerio to
              <select value={preferences.settings.startModule} onChange={(event) => setSettings({ startModule: event.target.value as ModuleId })}>
                <option value="mail">Mail</option>
                <option value="calendar">Calendar</option>
                <option value="contacts">Contacts</option>
                <option value="tasks">Tasks</option>
                <option value="notes">Notes</option>
                <option value="chat">Chat</option>
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
