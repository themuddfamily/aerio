import { Bell, Database, Monitor, Palette, RotateCcw } from 'lucide-react'
import type { AppState, DensityPreference, ModuleId, ThemePreference } from '../types'
import Modal from './Modal'

interface SettingsModalProps {
  state: AppState
  onChange(next: AppState): void
  onReset(): Promise<void>
  onClose(): void
}

export default function SettingsModal({ state, onChange, onReset, onClose }: SettingsModalProps) {
  const setSettings = (updates: Partial<AppState['settings']>) => {
    onChange({ ...state, settings: { ...state.settings, ...updates } })
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
              <span><strong>Desktop notifications</strong><small>Show reminders and sending confirmations.</small></span>
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
            <h3>Signature</h3>
            <textarea value={state.settings.signature} onChange={(event) => setSettings({ signature: event.target.value })} />
          </div>
        </section>
      </div>
    </Modal>
  )
}
