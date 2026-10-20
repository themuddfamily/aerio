import { useState } from 'react'
import type { IceWarpMeetingAccount, MeetingHostApi, MeetingHostSnapshot } from '../meeting-host-types'
export default function IceWarpMeetingSettings({ account, api, changed }: { account: IceWarpMeetingAccount; api: MeetingHostApi; changed(snapshot: MeetingHostSnapshot): void }) {
  const [server, setServer] = useState(account.server ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (disconnect = false) => {
    setBusy(true); setError('')
    try { changed(await (disconnect ? api.disconnectIceWarp() : api.connectIceWarp({ server, token }))); setToken('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'IceWarp could not be connected') }
    finally { setBusy(false) }
  }
  return <li>
    <div className="dav-account-heading"><span><strong>IceWarp</strong><small>{account.connected ? `Connected as ${account.email} · ${account.server}` : 'Connect your IceWarp conference account'}</small></span></div>
    <p>Uses your server's TeamChat conference API. Aerio provisions a private conference, then sets its requested title and time before saving your calendar invitation. It does not join, record or invite conference participants. Google or Microsoft calendar invitations carry the public join link. Existing conferences require their original IceWarp server and user for updates or cancellation.</p>
    <label className="field-label">IceWarp meetings server HTTPS URL<input value={server} disabled={busy} onChange={(event) => setServer(event.target.value)} autoComplete="off" /></label>
    <label className="field-label">IceWarp conference API token<input type="password" value={token} disabled={busy || !account.secureStorage} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" /></label>
    <small>Use a TeamChat user API token with conference permissions. It is encrypted with OS credential storage and never returned to this window. This is separate from your Chat connection. Disconnecting keeps existing conferences and recovery records.</small>
    {!account.secureStorage && <small role="alert">Secure credential storage is unavailable; IceWarp cannot be connected.</small>}
    {account.error && <small role="alert" className="diagnostic-error">{account.error}</small>}
    <div className="settings-actions"><button className="button ghost" disabled={busy || !server.trim() || !token.trim() || !account.secureStorage} onClick={() => void run()}>Connect IceWarp meetings</button>{account.connected && <button className="button ghost" disabled={busy} onClick={() => void run(true)}>Disconnect IceWarp meetings</button>}</div>
    {error && <small role="alert" className="diagnostic-error">{error}</small>}
  </li>
}
