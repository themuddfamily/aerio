import { useState } from 'react'
import { Bell, Database, Download, Monitor, Palette, RotateCcw, Stethoscope } from 'lucide-react'
import type { AppState, DensityPreference, ModuleId, ThemePreference } from '../types'
import type { MailDiagnosticHealth } from '../gmail-types'
import Modal from './Modal'

interface SettingsModalProps {
  state: AppState
  onChange(next: AppState): void
  onReset(): Promise<void>
  onClose(): void
}

export default function SettingsModal({ state, onChange, onReset, onClose }: SettingsModalProps) {
  const [health, setHealth] = useState<MailDiagnosticHealth>()
  const [diagnosticStatus, setDiagnosticStatus] = useState<'idle' | 'checking' | 'exporting'>('idle')
  const [diagnosticMessage, setDiagnosticMessage] = useState('')
  const setSettings = (updates: Partial<AppState['settings']>) => {
    onChange({ ...state, settings: { ...state.settings, ...updates } })
  }

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
          <div className="settings-icon"><Palette size={18} /></div>
          <div className="settings-content">
            <h3>Appearance</h3>
            <p>Choose a theme and how much information appears at once.</p>
            <div className="segmented wide">
              {(['system', 'light', 'dark'] as ThemePreference[]).map((theme) => (
                <button key={theme} className={state.settings.theme === theme ? 'active' : ''} onClick={() => setSettings({ theme })}>{theme}</button>
              ))}
            </div>
            <div className="segmented wide">
              {(['comfortable', 'compact'] as DensityPreference[]).map((density) => (
                <button key={density} className={state.settings.density === density ? 'active' : ''} onClick={() => setSettings({ density })}>{density}</button>
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
              <input type="checkbox" checked={state.settings.closeToTray} onChange={(event) => setSettings({ closeToTray: event.target.checked })} />
            </label>
            <label className="field-label">Open Aerio to
              <select value={state.settings.startModule} onChange={(event) => setSettings({ startModule: event.target.value as ModuleId })}>
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
              <span><strong>Desktop notifications</strong><small>Show new mail, reminders, and sending confirmations.</small></span>
              <input type="checkbox" checked={state.settings.notifications} onChange={(event) => setSettings({ notifications: event.target.checked })} />
            </label>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-icon"><Database size={18} /></div>
          <div className="settings-content">
            <h3>Local demo data</h3>
            <p>Aerio keeps this release entirely on your computer in a local SQLite database.</p>
            <button className="button danger-subtle" onClick={() => { if (window.confirm('Reset all demo mail, calendar, contacts, tasks, notes, chats, and settings? Real mail is not affected.')) void onReset() }}><RotateCcw size={16} /> Reset demo data</button>
          </div>
        </section>
        <section className="settings-section signature-section">
          <div className="settings-icon"><Database size={18} /></div>
          <div className="settings-content">
            <h3>Demo workspace signature</h3>
            <textarea value={state.settings.signature} onChange={(event) => setSettings({ signature: event.target.value })} />
          </div>
        </section>
      </div>
    </Modal>
  )
}
