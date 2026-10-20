import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SettingsSyncStatus } from '../settings-sync-types'
export default function SettingsSyncSection({ beforeSync }: { beforeSync(): Promise<void> }) {
  const api = window.aerio.settingsSync
  const [status, setStatus] = useState<SettingsSyncStatus>()
  const [url, setUrl] = useState(''), [username, setUsername] = useState(''), [password, setPassword] = useState(''), [passphrase, setPassphrase] = useState('')
  const [deviceName, setDeviceName] = useState('This device'), [interval, setIntervalMinutes] = useState(15), [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const update = (next: SettingsSyncStatus, fields = false) => {
    setStatus(next)
    if (fields) { setUrl(next.url); setUsername(next.username); setDeviceName(next.deviceName); setIntervalMinutes(next.intervalMinutes); setEnabled(next.enabled) }
  }
  useEffect(() => {
    if (!api) return
    let active = true
    void api.status().then((next) => { if (active) update(next, true) }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Settings sync is unavailable.') })
    const timer = window.setInterval(() => { void api.status().then((next) => { if (active) update(next) }).catch(() => {}) }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  if (!api) return null
  const perform = async (action: () => Promise<SettingsSyncStatus>, fields = false) => {
    setBusy(true); setError('')
    try { update(await action(), fields) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Settings synchronization failed.'); void api.status().then((next) => update(next)).catch(() => {}) }
    finally { setBusy(false) }
  }
  const running = busy || status?.phase === 'syncing'
  return <section className="settings-section"><div className="settings-icon"><RefreshCw size={18} /></div><div className="settings-content">
    <h3>Settings synchronization</h3>
    <p>Synchronize appearance and portable preferences, signatures, message templates with attachments, and QuickText across your devices using an encrypted WebDAV file. Account credentials, mail, app locks and device startup settings stay local.</p>
    <label className="field-label">WebDAV file URL<input type="url" value={url} disabled={running} onChange={(event) => setUrl(event.target.value)} placeholder="https://cloud.example.com/aerio-settings.enc.json" /></label>
    <label className="field-label">WebDAV user name<input value={username} disabled={running} autoComplete="off" onChange={(event) => setUsername(event.target.value)} /></label>
    <label className="field-label">WebDAV app password<input type="password" value={password} disabled={running} autoComplete="new-password" placeholder={status?.configured ? 'Saved; leave blank to keep' : ''} onChange={(event) => setPassword(event.target.value)} /></label>
    <label className="field-label">Sync encryption passphrase<input type="password" value={passphrase} disabled={running} autoComplete="new-password" placeholder={status?.configured ? 'Saved; leave blank to keep' : 'At least 12 characters; use the same on every device'} onChange={(event) => setPassphrase(event.target.value)} /></label>
    <small>Passwords and the passphrase are stored using OS secure storage. The server receives encrypted data. Keep a copy of the passphrase; Aerio cannot recover it.</small>
    <label className="field-label">Sync device name<input value={deviceName} maxLength={80} disabled={running} onChange={(event) => setDeviceName(event.target.value)} /></label>
    <label className="field-label">Sync interval<select value={interval} disabled={running} onChange={(event) => setIntervalMinutes(Number(event.target.value))}>{[5, 15, 30, 60, 360, 1440].map((value) => <option key={value} value={value}>{value < 60 ? `${value} minutes` : `${value / 60} hours`}</option>)}</select></label>
    <label className="settings-check"><input type="checkbox" checked={enabled} disabled={running} onChange={(event) => setEnabled(event.target.checked)} /> Enable scheduled settings synchronization</label>
    <div className="settings-actions"><button className="button ghost" disabled={running || !url || !username} onClick={() => void perform(async () => { const next = await api.configure({ enabled, url, username, password: password || undefined, passphrase: passphrase || undefined, deviceName, intervalMinutes: interval }); setPassword(''); setPassphrase(''); return next }, true)}>Save sync connection</button><button className="button ghost" disabled={running || !status?.configured || !status.enabled && !status.recoveryPending} onClick={() => void perform(async () => { await beforeSync(); return api.sync() })}>Sync settings now</button><button className="button danger-subtle" disabled={running || !status?.configured} onClick={() => { if (window.confirm('Disconnect this device and forget its saved WebDAV password and sync passphrase? The shared encrypted file and other devices will remain.')) void perform(() => api.disconnect(), true) }}>Disconnect settings sync</button></div>
    {status?.review && <div className="settings-sync-review"><h4>Review settings versions</h4><p>{status.message}</p><p>Shared version: {status.review.remoteDevice}, {new Date(status.review.updatedAt).toLocaleString()}.</p><table><thead><tr><th>Contents</th><th>This device</th><th>Shared</th></tr></thead><tbody>{(['signatures', 'templates', 'snippets'] as const).map((kind) => <tr key={kind}><th>{kind === 'snippets' ? 'QuickText' : kind}</th><td>{status.review!.local[kind]}</td><td>{status.review!.remote[kind]}</td></tr>)}</tbody></table><ul>{status.review.differences.map((item, index) => <li key={index}>{item}</li>)}</ul><p>Your choice replaces the complete synchronized scope on one side, including deletions. Local account sign-ins and security settings are preserved.</p><div className="settings-actions"><button className="button ghost" disabled={running} onClick={() => void perform(async () => { await beforeSync(); return api.resolve('local') })}>Use this device's settings</button><button className="button primary" disabled={running || status.review.remoteDigest === 'missing'} onClick={() => void perform(async () => { await beforeSync(); return api.resolve('remote') })}>Use shared settings</button></div></div>}
    {status?.lastSyncedAt && <small>Last synchronized {new Date(status.lastSyncedAt).toLocaleString()}.</small>}
    {status?.message && !status.review && <small aria-live="polite">{status.message}</small>}
    {error && <p role="alert">{error}</p>}
  </div></section>
}
