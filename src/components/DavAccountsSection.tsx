import { useEffect, useState } from 'react'
import { CalendarSync, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import type { DavAccountSummary, DavPresetId, DavReviewItem, DavSnapshot } from '../dav-types'
import { DAV_PRESETS, davPreset } from '../lib/dav-presets'
import { confirmServerNotesRemoval } from '../lib/server-notes-removal'

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
const formatTime = (value?: string) => value ? new Date(value).toLocaleString() : ''
const statusLabel: Record<DavAccountSummary['status'], string> = { ready: 'Connected', syncing: 'Synchronizing…', 'needs-auth': 'Password needed', error: 'Needs attention' }
const empty: DavSnapshot = { accounts: [], collections: [], review: [] }

function reviewSummary(item: DavReviewItem) {
  const what = item.kind === 'event' ? 'event' : 'contact'
  if (item.status === 'held') return `Your ${item.action === 'delete' ? 'deletion of this' : 'change to this'} ${what} was restored from a backup and has not been sent.`
  if (item.status === 'failed') return item.error
  if (item.serverDeleted) return `${item.action === 'delete' ? 'Also deleted' : 'Deleted'} on the server after you ${item.action === 'delete' ? 'deleted' : 'edited'} it.`
  return `${item.error}${item.serverTitle && item.serverTitle !== item.title ? ` The server now has “${item.serverTitle}”.` : ''}`
}

/** Settings section for CalDAV/CardDAV calendar and contact accounts and their conflict review. */
export default function DavAccountsSection() {
  const api = window.aerio.dav
  const [snapshot, setSnapshot] = useState<DavSnapshot>(empty)
  const [preset, setPreset] = useState<DavPresetId>('icloud')
  const [form, setForm] = useState({ serverUrl: '', username: '', password: '', name: '' })
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [confirmRemove, setConfirmRemove] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState({ text: '', error: false })

  useEffect(() => {
    if (!api) return
    let active = true
    void api.snapshot().then((next) => { if (active) setSnapshot(next) }).catch(() => undefined)
    const unsubscribe = api.onChanged((next) => { if (active) setSnapshot(next) })
    return () => { active = false; unsubscribe() }
  }, [api])

  if (!api) return null
  const definition = davPreset(preset)

  const run = async (key: string, work: () => Promise<DavSnapshot>, success: string, failure: string) => {
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

  const connect = async () => {
    const added = await run('add', () => api.addAccount({ preset, username: form.username, password: form.password, ...(form.name.trim() ? { name: form.name } : {}), ...(definition.needsServerUrl ? { serverUrl: form.serverUrl } : {}) }),
      'Account connected. Its calendars and address books now appear in Calendar and Contacts.', 'The account could not be connected')
    if (added) setForm({ serverUrl: '', username: '', password: '', name: '' })
    else setForm((current) => ({ ...current, password: '' }))
  }

  return (
    <section className="settings-section">
      <div className="settings-icon"><CalendarSync size={18} /></div>
      <div className="settings-content">
        <h3>Calendar and contacts accounts</h3>
        <p>Connect iCloud, Fastmail, Nextcloud, or any CalDAV/CardDAV server. Mail presets only provide mail; add the same provider here for its calendars and contacts. Changes made offline are queued and sent when the server is reachable.</p>
        {snapshot.review.length > 0 && <div className="dav-review" role="region" aria-label="Calendar and contact changes to review">
          <strong>{snapshot.review.length === 1 ? '1 change needs your decision' : `${snapshot.review.length} changes need your decision`}</strong>
          <small>Aerio never overwrites a server change on its own.</small>
          <ul>
            {snapshot.review.map((item) => <li key={item.id}>
              <span><strong>{item.title}</strong><small>{reviewSummary(item)}</small></span>
              <div className="settings-actions">
                <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`review:${item.id}`, () => api.resolve(item.id, 'keep-local'), item.status === 'conflict' ? 'Your version will be sent to the server.' : 'The change will be sent again.', 'The change could not be resolved')}>
                  {item.status === 'conflict' ? (item.serverDeleted && item.action !== 'delete' ? 'Restore my version' : item.action === 'delete' ? 'Delete anyway' : 'Keep my version') : 'Send again'}
                </button>
                <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`review:${item.id}`, () => api.resolve(item.id, 'keep-server'), 'The server version was kept.', 'The change could not be resolved')}>
                  {item.status === 'conflict' ? 'Keep server version' : 'Discard my change'}
                </button>
              </div>
            </li>)}
          </ul>
        </div>}
        {snapshot.accounts.length > 0 && <ul className="dav-account-list" aria-label="Calendar and contacts accounts">
          {snapshot.accounts.map((account) => {
            const collections = snapshot.collections.filter((collection) => collection.accountId === account.id)
            return <li key={account.id}>
              <div className="dav-account-heading">
                <span><strong>{account.name}</strong><small>{account.username} · {statusLabel[account.status]}{account.lastSyncedAt ? ` · synchronized ${formatTime(account.lastSyncedAt)}` : ''}{account.pendingWrites ? ` · ${account.pendingWrites} change${account.pendingWrites === 1 ? '' : 's'} waiting to send` : ''}</small></span>
                <div className="settings-actions">
                  <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`sync:${account.id}`, () => api.sync(account.id), 'Synchronized.', 'Synchronization failed')}><RefreshCw size={15} /> {busy === `sync:${account.id}` ? 'Syncing…' : 'Sync now'}</button>
                  {confirmRemove === account.id
                    ? <>
                      <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => { setConfirmRemove(undefined); void (async () => { if (await confirmServerNotesRemoval(account.id, account.name)) await run(`remove:${account.id}`, () => api.removeAccount(account.id), 'Account removed from Aerio. Nothing was deleted on the server.', 'The account could not be removed') })() }}>Remove{account.pendingWrites ? ` and discard ${account.pendingWrites} unsent change${account.pendingWrites === 1 ? '' : 's'}` : ''}</button>
                      <button className="button ghost" onClick={() => setConfirmRemove(undefined)}>Cancel</button>
                    </>
                    : <button className="button ghost" aria-label={`Remove ${account.name}`} disabled={Boolean(busy)} onClick={() => setConfirmRemove(account.id)}><Trash2 size={15} /> Remove</button>}
                </div>
              </div>
              {account.error && <small className="diagnostic-error">{account.error}</small>}
              {account.status === 'needs-auth' && <div className="dav-password-row">
                <label className="field-label">App password
                  <input type="password" autoComplete="off" value={passwords[account.id] ?? ''} onChange={(event) => setPasswords((current) => ({ ...current, [account.id]: event.target.value }))} />
                </label>
                <button className="button ghost" disabled={Boolean(busy) || !passwords[account.id]} onClick={() => void run(`password:${account.id}`, () => api.updatePassword(account.id, passwords[account.id]), 'Password saved.', 'The password could not be saved').then((saved) => { if (saved) setPasswords((current) => ({ ...current, [account.id]: '' })) })}><KeyRound size={15} /> Save password</button>
              </div>}
              {collections.length > 0 && <ul className="dav-collection-list" aria-label={`${account.name} calendars and address books`}>
                {collections.map((collection) => {
                  const tasksOnly = collection.kind === 'calendar' && !collection.components.includes('VEVENT')
                  return <li key={collection.id}>
                    <label className="toggle-row">
                      <span>
                        <strong><i className="dav-color" style={{ background: collection.color }} /> {collection.name}</strong>
                        <small>
                          {collection.kind === 'calendar' ? 'Calendar' : 'Address book'}
                          {collection.readOnly ? ' · Read-only' : ''}{collection.shared ? ' · Shared' : ''}
                          {tasksOnly ? ' · Tasks only (not shown in Calendar)' : ''}
                          {collection.error ? ` · ${collection.error}` : ''}
                        </small>
                      </span>
                      <input type="checkbox" aria-label={`Show ${collection.name}`} disabled={Boolean(busy) || tasksOnly} checked={collection.enabled && !tasksOnly} onChange={(event) => void run(`collection:${collection.id}`, () => api.setCollectionEnabled(collection.id, event.target.checked), '', 'The collection could not be updated')} />
                    </label>
                  </li>
                })}
              </ul>}
            </li>
          })}
        </ul>}
        <div className="dav-add" role="group" aria-label="Add a calendar and contacts account">
          <div className="profile-backup-fields">
            <label className="field-label">Service
              <select value={preset} disabled={Boolean(busy)} onChange={(event) => setPreset(event.target.value as DavPresetId)}>
                {DAV_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            {definition.needsServerUrl && <label className="field-label">Server address
              <input value={form.serverUrl} placeholder={definition.serverPlaceholder} disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, serverUrl: event.target.value })} />
            </label>}
            <label className="field-label">{definition.usernameLabel}
              <input value={form.username} autoComplete="username" disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, username: event.target.value })} />
            </label>
            <label className="field-label">App password
              <input type="password" autoComplete="off" value={form.password} disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </label>
            <label className="field-label">Name (optional)
              <input value={form.name} placeholder={`${definition.label} · ${form.username || 'you'}`} disabled={Boolean(busy)} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
          </div>
          <small>{definition.passwordHelp} {definition.needsServerUrl ? 'Use https://; plain http is only accepted for a server on this computer.' : ''}</small>
          <div className="settings-actions">
            <button className="button primary" disabled={Boolean(busy) || !form.username.trim() || !form.password || (definition.needsServerUrl && !form.serverUrl.trim())} onClick={() => void connect()}>
              <CalendarSync size={16} /> {busy === 'add' ? 'Discovering calendars and contacts…' : 'Connect account'}
            </button>
          </div>
        </div>
        {message.text && <small className={message.error ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message.text}</small>}
      </div>
    </section>
  )
}
