import { KeyRound, RefreshCw, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import type { ExchangeAccountState, ExchangeAuthPreference, ExchangeReviewItem, ExchangeSnapshot } from '../exchange-types'

interface Props {
  account: MailAccountSummary
  onToast(message: string): void
}

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
const authLabel: Record<ExchangeAccountState['auth'], string> = { ntlm: 'NTLM', basic: 'Basic over HTTPS', bearer: 'OAuth access token' }
const statusLabel: Record<ExchangeAccountState['status'], string> = { ready: 'Connected', syncing: 'Synchronizing…', 'needs-auth': 'Sign-in needed', error: 'Needs attention' }

function reviewSummary(item: ExchangeReviewItem) {
  const what = item.kind === 'event' ? 'event' : 'contact'
  if (item.status === 'held') return `Your ${item.action === 'delete' ? 'deletion of this' : 'change to this'} ${what} was restored from a backup and has not been sent.`
  if (item.status === 'failed') return item.error
  if (item.serverDeleted) return `${item.action === 'delete' ? 'Also deleted' : 'Deleted'} on the server after you ${item.action === 'delete' ? 'deleted' : 'edited'} it.`
  return `${item.error}${item.serverTitle && item.serverTitle !== item.title ? ` The server now has “${item.serverTitle}”.` : ''}`
}

/** Exchange server details, capabilities, re-authentication, and Calendar/Contacts conflict review. */
export default function ExchangeAccountSection({ account, onToast }: Props) {
  const api = window.aerio.exchange
  const [snapshot, setSnapshot] = useState<ExchangeSnapshot>({ accounts: [], review: [] })
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [auth, setAuth] = useState<ExchangeAuthPreference>()
  const [busy, setBusy] = useState<string>()

  useEffect(() => {
    if (!api) return
    let active = true
    void api.snapshot().then((next) => { if (active) setSnapshot(next) }).catch(() => undefined)
    const unsubscribe = api.onChanged((next) => { if (active) setSnapshot(next) })
    return () => { active = false; unsubscribe() }
  }, [api])

  if (!api) return null
  const state = snapshot.accounts.find((item) => item.accountId === account.id)
  const review = snapshot.review.filter((item) => item.accountId === account.id)
  const needsAuth = account.status === 'needs-auth' || state?.status === 'needs-auth'
  const method = auth ?? state?.auth ?? 'auto'

  const run = async (key: string, work: () => Promise<ExchangeSnapshot>, success: string, failure: string) => {
    setBusy(key)
    try {
      setSnapshot(await work())
      onToast(success)
      return true
    } catch (error) {
      onToast(errorText(error, failure))
      setSnapshot(await api.snapshot().catch(() => snapshot))
      return false
    } finally { setBusy(undefined) }
  }

  const saveCredentials = async () => {
    const saved = await run('credentials', () => api.updateCredentials(account.id, { ...(password ? { password } : {}), ...(token.trim() ? { bearerToken: token.trim() } : {}), ...(auth ? { auth } : {}) }), 'Exchange sign-in verified and saved', 'The Exchange server rejected the new sign-in')
    if (saved) { setPassword(''); setToken('') }
  }

  return <section className="exchange-account-section" aria-label="Exchange server">
    <h3><Server size={16} /> Exchange server</h3>
    {state ? <>
      <p>
        <strong>{statusLabel[state.status]}</strong>
        {state.serverVersion ? ` · ${state.serverVersion}` : ''} · {authLabel[state.auth]}
        {state.lastSyncedAt ? ` · Calendar and Contacts synchronized ${new Date(state.lastSyncedAt).toLocaleString()}` : ''}
        {state.pendingWrites ? ` · ${state.pendingWrites} change${state.pendingWrites === 1 ? '' : 's'} waiting to send` : ''}
      </p>
      <p className="exchange-url"><code>{state.ewsUrl}</code> · {state.username}</p>
      {state.error && <p className="account-error">{state.error}</p>}
      <ul className="exchange-capabilities" aria-label="Exchange capabilities">
        <li><strong>Mail</strong> <small>{state.capabilities.mail.detail}</small></li>
        <li><strong>Calendar</strong> <small>{state.capabilities.calendar.write ? '' : 'Read-only. '}{state.capabilities.calendar.detail}</small></li>
        <li><strong>Contacts</strong> <small>{state.capabilities.contacts.write ? '' : 'Read-only. '}{state.capabilities.contacts.detail}</small></li>
        {state.capabilities.notes.map((note) => <li key={note}><small>{note}</small></li>)}
      </ul>
    </> : <p>Calendar and Contacts for this account have not been set up yet.</p>}

    {review.length > 0 && <div className="dav-review" role="region" aria-label="Exchange changes to review">
      <strong>{review.length === 1 ? '1 change needs your decision' : `${review.length} changes need your decision`}</strong>
      <small>Exchange reported a newer version (ChangeKey) or refused the change. Aerio never overwrites a server change on its own.</small>
      <ul>
        {review.map((item) => <li key={item.id}>
          <span><strong>{item.title}</strong><small>{reviewSummary(item)}</small></span>
          <div className="settings-actions">
            <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`review:${item.id}`, () => api.resolve(item.id, 'keep-local'), item.status === 'conflict' ? 'Your version will be sent to Exchange.' : 'The change will be sent again.', 'The change could not be resolved')}>
              {item.status === 'conflict' ? (item.serverDeleted && item.action !== 'delete' ? 'Restore my version' : item.action === 'delete' ? 'Delete anyway' : 'Keep my version') : 'Send again'}
            </button>
            <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`review:${item.id}`, () => api.resolve(item.id, 'keep-server'), 'The server version was kept.', 'The change could not be resolved')}>
              {item.status === 'conflict' ? 'Keep server version' : 'Discard my change'}
            </button>
          </div>
        </li>)}
      </ul>
    </div>}

    <div className={`exchange-credentials ${needsAuth ? 'attention' : ''}`}>
      <p>{needsAuth ? 'Exchange rejected the saved sign-in (the session expired or the password changed). Enter it again to resume synchronization; nothing local was deleted.' : 'Update the saved password or token. It is verified with the server before it replaces the old one.'}</p>
      <div className="dav-password-row">
        <label className="field-label">Authentication
          <select value={method} onChange={(event) => setAuth(event.target.value as ExchangeAuthPreference)}>
            <option value="auto">Automatic</option>
            <option value="ntlm">NTLM</option>
            <option value="basic">Basic over HTTPS</option>
            <option value="bearer">OAuth access token</option>
          </select>
        </label>
        {method === 'bearer'
          ? <label className="field-label">New access token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
          : <label className="field-label">New password<input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
        <button className="button ghost" disabled={Boolean(busy) || (method === 'bearer' ? !token.trim() : !password)} onClick={() => void saveCredentials()}><KeyRound size={15} /> {busy === 'credentials' ? 'Verifying…' : 'Verify and save'}</button>
        {state && <button className="button ghost" disabled={Boolean(busy) || needsAuth} onClick={() => void run('sync', () => api.sync(account.id), 'Exchange Calendar and Contacts synchronized', 'Synchronization failed')}><RefreshCw size={15} /> {busy === 'sync' ? 'Syncing…' : 'Sync Calendar and Contacts'}</button>}
      </div>
    </div>
  </section>
}
