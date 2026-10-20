import { useEffect, useState } from 'react'
import { Network } from 'lucide-react'
import type { NetworkProxySettings, NetworkProxyStatus } from '../network-proxy-types'

export default function ProxySettings() {
  const [status, setStatus] = useState<NetworkProxyStatus>()
  const [form, setForm] = useState<NetworkProxySettings>()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearCredentials, setClearCredentials] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const api = window.aerio?.networkProxy
  useEffect(() => {
    let active = true
    void api?.status().then((value) => { if (active) { setStatus(value); setForm({ mode: value.mode, server: value.server, bypass: value.bypass }) } }).catch(() => { if (active) setError('Proxy settings could not be loaded') })
    return () => { active = false }
  }, [api])
  if (!api) return null
  const save = async () => {
    if (!form) return
    setBusy(true); setError(''); setMessage('')
    try {
      const value = await api.configure({ ...form, ...(form.mode === 'manual' && (username || password) ? { username, password } : {}), clearCredentials })
      setStatus(value); setForm({ mode: value.mode, server: value.server, bypass: value.bypass })
      setUsername(''); setPassword(''); setClearCredentials(false)
      setMessage(value.restartRequired ? 'Proxy settings saved. Quit and reopen Aerio to apply them to every connection.' : 'Proxy settings saved.')
    } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '') : 'Proxy settings could not be saved') }
    finally { setBusy(false) }
  }
  return <section className="settings-section" aria-label="Network proxy settings">
    <div className="settings-icon"><Network size={18} /></div>
    <div className="settings-content"><h3>Network proxy</h3>
      <p>Choose how Aerio connects. Changes apply after you quit and reopen the app. Localhost and loopback connections always bypass the proxy.</p>
      {form && <>
        <label className="field"><span>Connection</span><select aria-label="Proxy mode" value={form.mode} disabled={busy} onChange={(event) => setForm({ ...form, mode: event.target.value as NetworkProxySettings['mode'] })}><option value="system">System / environment settings</option><option value="direct">Direct connection</option><option value="manual">Manual HTTP(S) proxy</option></select></label>
        {form.mode === 'manual' && <>
          <label className="field"><span>Proxy server</span><input aria-label="Proxy server" value={form.server} disabled={busy} placeholder="http://proxy.example.com:8080" onChange={(event) => setForm({ ...form, server: event.target.value })} /></label>
          <label className="field"><span>Bypass hosts</span><input aria-label="Proxy bypass hosts" value={form.bypass} disabled={busy} placeholder="intranet.example.com, *.internal.example.com" onChange={(event) => setForm({ ...form, bypass: event.target.value })} /></label>
          <p>{status?.hasCredentials ? 'Credentials are saved with OS encryption. Leave both fields empty to keep them.' : 'Optional proxy credentials are stored with OS encryption and are never returned to the app window.'}</p>
          {!status?.secureStorage && <p>OS encryption is unavailable. You can save an unauthenticated proxy; credentials cannot be saved.</p>}
          <label className="field"><span>New proxy username</span><input aria-label="Proxy username" autoComplete="off" value={username} disabled={busy || !status?.secureStorage} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="field"><span>New proxy password</span><input aria-label="Proxy password" autoComplete="new-password" type="password" value={password} disabled={busy || !status?.secureStorage} onChange={(event) => setPassword(event.target.value)} /></label>
          {status?.hasCredentials && <label className="toggle-row"><span>Remove saved proxy credentials</span><input type="checkbox" checked={clearCredentials} disabled={busy} onChange={(event) => { setClearCredentials(event.target.checked); setUsername(''); setPassword('') }} /></label>}
        </>}
        <button className="button ghost" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save proxy settings'}</button>
      </>}
      {status?.restartRequired && <p role="status">A restart is required to apply the saved proxy settings.</p>}
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    </div>
  </section>
}
