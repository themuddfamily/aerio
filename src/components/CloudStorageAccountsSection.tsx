import { useEffect, useState } from 'react'
import { Cloud, Link2Off, LogIn, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudStorageAccount, CloudStorageCapabilities, CloudStorageLink, CloudStorageSnapshot } from '../cloud-attachment-types'
import { cloudCapabilityRows } from '../lib/cloud-attachments'

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || fallback : fallback
const empty: CloudStorageSnapshot = { accounts: [], dropboxConfigured: false, dropboxBuiltIn: false }
const statusLabel: Record<CloudStorageAccount['status'], string> = { ready: 'Connected', 'needs-auth': 'Sign-in needed', error: 'Needs attention' }

/** What the account's server or plan allows for links: shown in Settings and in the composer. */
export function CloudCapabilityList({ capabilities, label }: { capabilities: CloudStorageCapabilities; label: string }) {
  return <div className="cloud-capabilities">
    <dl aria-label={label}>
      {cloudCapabilityRows(capabilities).map((row) => <div key={row.label} data-state={row.state}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
    </dl>
    {capabilities.notes.length > 0 && <ul>{capabilities.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
  </div>
}

/**
 * Settings section for Dropbox, ownCloud and Nextcloud storage accounts used for cloud
 * attachments. Each account connects on its own; secrets stay in the main process.
 */
export default function CloudStorageAccountsSection() {
  const api = window.aerio?.mail?.cloudAttachments?.storage
  const [snapshot, setSnapshot] = useState<CloudStorageSnapshot>(empty)
  const [appKey, setAppKey] = useState('')
  const [form, setForm] = useState({ provider: 'nextcloud' as 'nextcloud' | 'owncloud', serverUrl: '', username: '', password: '', name: '' })
  const [links, setLinks] = useState<Record<string, CloudStorageLink[]>>({})
  const [confirmRemove, setConfirmRemove] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState({ text: '', error: false })

  useEffect(() => {
    if (!api) return
    let active = true
    void api.snapshot().then((next) => { if (active) setSnapshot(next) }).catch(() => undefined)
    return () => { active = false }
  }, [api])

  if (!api) return null

  const run = async (key: string, work: () => Promise<CloudStorageSnapshot>, success: string, failure: string) => {
    setBusy(key)
    setMessage({ text: '', error: false })
    try {
      setSnapshot(await work())
      setMessage({ text: success, error: false })
      return true
    } catch (error) {
      setMessage({ text: errorText(error, failure), error: true })
      setSnapshot(await api.snapshot().catch(() => snapshot))
      return false
    } finally { setBusy(undefined) }
  }

  const showLinks = async (account: CloudStorageAccount) => {
    if (links[account.id]) {
      setLinks(({ [account.id]: _hidden, ...rest }) => rest)
      return
    }
    try { setLinks({ ...links, [account.id]: await api.links(account.id) }) }
    catch (error) { setMessage({ text: errorText(error, 'The links could not be listed'), error: true }) }
  }

  const revoke = async (account: CloudStorageAccount, link: CloudStorageLink) => {
    setBusy(`revoke:${link.url}`)
    try {
      setLinks({ ...links, [account.id]: await api.revoke(link.url) })
      setMessage({ text: `The link to ${link.name} no longer opens.`, error: false })
    } catch (error) {
      setMessage({ text: errorText(error, 'The link could not be turned off'), error: true })
    } finally { setBusy(undefined) }
  }

  const connectServer = async () => {
    const added = await run('server', () => api.connectServer({ provider: form.provider, serverUrl: form.serverUrl, username: form.username, password: form.password, ...(form.name.trim() ? { name: form.name } : {}) }),
      'Account connected. Choose it in the composer’s cloud panel to share files from it.', 'The account could not be connected')
    setForm((current) => added ? { ...current, serverUrl: '', username: '', password: '', name: '' } : { ...current, password: '' })
  }

  const serverLabel = form.provider === 'nextcloud' ? 'Nextcloud' : 'ownCloud'

  return (
    <section className="settings-section">
      <div className="settings-icon"><Cloud size={18} /></div>
      <div className="settings-content">
        <h3>Cloud storage accounts</h3>
        <p>Connect Dropbox, ownCloud or Nextcloud to share files as links from any mail account. Google Drive and OneDrive links use the Gmail or Microsoft account itself. Aerio only uploads into an “Aerio attachments” folder and never lists your other files.</p>
        {snapshot.accounts.length > 0 && <ul className="dav-account-list" aria-label="Cloud storage accounts">
          {snapshot.accounts.map((account) => <li key={account.id}>
            <div className="dav-account-heading">
              <span><strong>{account.name}</strong><small>{account.serverUrl ? `${account.serverUrl} · ` : ''}{account.username} · {statusLabel[account.status]}</small></span>
              <div className="settings-actions">
                {account.provider === 'dropbox' && account.status === 'needs-auth' && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`dropbox:${account.id}`, () => api.connectDropbox(), 'Dropbox connected again.', 'Dropbox could not be connected')}><LogIn size={15} /> Sign in again</button>}
                <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`refresh:${account.id}`, () => api.refresh(account.id), 'Sharing settings checked.', 'The sharing settings could not be checked')}><RefreshCw size={15} /> {busy === `refresh:${account.id}` ? 'Checking…' : 'Check again'}</button>
                <button className="button ghost" disabled={Boolean(busy)} aria-expanded={Boolean(links[account.id])} onClick={() => void showLinks(account)}>Links</button>
                {confirmRemove === account.id
                  ? <>
                    <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => { setConfirmRemove(undefined); void run(`remove:${account.id}`, () => api.disconnect(account.id), 'Disconnected. Aerio forgot the credentials and interrupted uploads; links already sent keep working.', 'The account could not be disconnected') }}>Disconnect</button>
                    <button className="button ghost" onClick={() => setConfirmRemove(undefined)}>Cancel</button>
                  </>
                  : <button className="button ghost" aria-label={`Disconnect ${account.name}`} disabled={Boolean(busy)} onClick={() => setConfirmRemove(account.id)}><Trash2 size={15} /> Disconnect</button>}
              </div>
            </div>
            {account.error && <small className="diagnostic-error">{account.error}</small>}
            <CloudCapabilityList capabilities={account.capabilities} label={`${account.name} sharing capabilities`} />
            {links[account.id] && (links[account.id].length
              ? <ul className="cloud-storage-links" aria-label={`Links shared from ${account.name}`}>
                {links[account.id].map((link) => <li key={link.url}>
                  <span><strong>{link.name}</strong><small>{link.scopeLabel}{link.expiresAt ? ` · expires ${new Date(link.expiresAt).toLocaleDateString()}` : ''}</small></span>
                  <button className="button ghost" disabled={Boolean(busy)} onClick={() => void revoke(account, link)}><Link2Off size={15} /> Turn off link</button>
                </li>)}
              </ul>
              : <small>No links shared from this account yet.</small>)}
          </li>)}
        </ul>}
        <div className="dav-add" role="group" aria-label="Connect Dropbox">
          <strong>Dropbox</strong>
          {!snapshot.dropboxConfigured && <>
            <label className="field-label">Dropbox app key
              <input value={appKey} autoComplete="off" disabled={Boolean(busy)} onChange={(event) => setAppKey(event.target.value)} />
            </label>
            <small>Create a scoped app in the Dropbox App Console with the redirect URI http://localhost:53134/dropbox, then paste its app key. The key is not a secret; no app secret is needed.</small>
          </>}
          <div className="settings-actions">
            {!snapshot.dropboxConfigured && <button className="button ghost" disabled={Boolean(busy) || !appKey.trim()} onClick={() => void run('app-key', () => api.configureDropbox(appKey), 'Dropbox app key saved.', 'The app key could not be saved').then((saved) => { if (saved) setAppKey('') })}>Save app key</button>}
            <button className="button primary" disabled={Boolean(busy) || !snapshot.dropboxConfigured} onClick={() => void run('dropbox', () => api.connectDropbox(), 'Dropbox connected.', 'Dropbox could not be connected')}>
              <LogIn size={16} /> {busy === 'dropbox' ? 'Waiting for Dropbox sign-in…' : 'Connect Dropbox'}
            </button>
          </div>
        </div>
        <div className="dav-add" role="group" aria-label="Connect ownCloud or Nextcloud">
          <div className="profile-backup-fields">
            <label className="field-label">Service
              <select value={form.provider} disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, provider: event.target.value as 'nextcloud' | 'owncloud' })}>
                <option value="nextcloud">Nextcloud</option>
                <option value="owncloud">ownCloud</option>
              </select>
            </label>
            <label className="field-label">Server address
              <input value={form.serverUrl} placeholder="https://cloud.example.com" disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, serverUrl: event.target.value })} />
            </label>
            <label className="field-label">{serverLabel} user name
              <input value={form.username} autoComplete="username" disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, username: event.target.value })} />
            </label>
            <label className="field-label">App password
              <input type="password" autoComplete="off" value={form.password} disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </label>
            <label className="field-label">Name (optional)
              <input value={form.name} placeholder={`${serverLabel} · ${form.username || 'you'}`} disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
          </div>
          <small>Create an app password under Personal settings → Security. Use https://; plain http is only accepted for a server on this computer. To renew a password, connect the same server and user again.</small>
          <div className="settings-actions">
            <button className="button primary" disabled={Boolean(busy) || !form.serverUrl.trim() || !form.username.trim() || !form.password} onClick={() => void connectServer()}>
              <Cloud size={16} /> {busy === 'server' ? 'Checking the server…' : `Connect ${serverLabel}`}
            </button>
          </div>
        </div>
        {message.text && <small className={message.error ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message.text}</small>}
      </div>
    </section>
  )
}
