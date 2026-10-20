import { useEffect, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import type { SpotlightApi, SpotlightSettings as Settings, SpotlightStatus } from '../spotlight-types'
export default function SpotlightSettings() {
  const api = (window.aerio as typeof window.aerio & { spotlight?: SpotlightApi }).spotlight
  const [status, setStatus] = useState<SpotlightStatus>()
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!api) return
    let live = true
    void api.status().then(async (next) => { if (live) setStatus(next); if (next.platformSupported) { const accounts = await window.aerio.mail.accounts.list(); if (live) setAccounts(accounts.filter((account) => !account.archived)) } }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Spotlight settings are unavailable') })
    const unsubscribe = api.onChanged((next) => { if (live) setStatus(next) })
    return () => { live = false; unsubscribe() }
  }, [api])
  if (!api || !status?.platformSupported) return null
  const save = async (updates: Partial<Settings>) => {
    setBusy(true); setError('')
    try { setStatus(await api.save({ ...status.settings, ...updates })) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Spotlight settings could not be saved') } finally { setBusy(false) }
  }
  return <section className="settings-section"><div className="settings-content">
    <h3>macOS Spotlight</h3>
    <p>Spotlight stores selected subjects and sender names outside Aerio. Previews are optional. Locking or disabling requests removal; macOS may take time to remove results. Results can remain while Aerio is closed.</p>
    <label className="check-label"><input type="checkbox" checked={status.settings.enabled} disabled={busy || !status.available} onChange={(event) => void save({ enabled: event.target.checked })} />Index selected mail in Spotlight</label>
    <fieldset disabled={busy || !status.available}><legend>Choose accounts to index</legend>
      {accounts.map((account) => <label className="check-label" key={account.id}><input type="checkbox" checked={status.settings.accountIds.includes(account.id)} onChange={(event) => void save({ accountIds: event.target.checked ? [...status.settings.accountIds, account.id] : status.settings.accountIds.filter((id) => id !== account.id) })} />{account.displayName || account.email} ({account.email})</label>)}
      {!accounts.length && <p>No connected accounts to index.</p>}
      <label className="check-label"><input type="checkbox" checked={status.settings.includePreview} onChange={(event) => void save({ includePreview: event.target.checked })} />Include message previews in the system index</label>
    </fieldset>
    <p>{status.indexed.toLocaleString()} conversations indexed · up to the newest {status.limit.toLocaleString()} locally cached conversations from selected accounts. Drafts, Spam and Trash are excluded.</p>
    <button type="button" className="button ghost" disabled={busy || status.syncing || !status.available || !status.settings.enabled} onClick={() => { setBusy(true); void api.refresh().then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : 'Spotlight refresh failed')).finally(() => setBusy(false)) }}>{status.syncing ? 'Indexing…' : 'Refresh Spotlight index'}</button>
    {(error || status.error) && <p role="alert">{error || status.error}</p>}
  </div></section>
}
