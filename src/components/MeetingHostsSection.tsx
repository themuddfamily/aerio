import { useEffect, useState } from 'react'
import { KeyRound, LogIn, Unplug, Video } from 'lucide-react'
import type { MeetingAccount, MeetingHostAccount, MeetingHostProvider, MeetingHostSnapshot } from '../meeting-host-types'
import MeetnRoomSettings from './MeetnRoomSettings'
import IceWarpMeetingSettings from './IceWarpMeetingSettings'
import { CONFERENCE_LABELS } from '../lib/online-meetings'

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

function statusText(account: MeetingHostAccount) {
  const label = CONFERENCE_LABELS[account.provider]
  if (!account.configured) return 'No app registration'
  if (account.needsReconnect) return 'Access revoked or expired · reconnect to keep adding meetings'
  if (account.connected) return `Connected${account.email ? ` as ${account.email}` : account.displayName ? ` as ${account.displayName}` : ''}`
  return `Not connected · sign in to add ${label} meetings`
}

/** Settings section for the Zoom and Webex accounts that host online meetings (E47). */
export default function MeetingHostsSection() {
  const api = window.aerio.meetingHosts
  const [accounts, setAccounts] = useState<MeetingAccount[]>([])
  const [busy, setBusy] = useState<string>()
  const [confirmDisconnect, setConfirmDisconnect] = useState<MeetingHostProvider>()
  const [editing, setEditing] = useState<MeetingHostProvider>()
  const [forms, setForms] = useState<Partial<Record<MeetingHostProvider, { clientId: string; clientSecret: string }>>>({})
  const [message, setMessage] = useState({ text: '', error: false })

  useEffect(() => {
    if (!api) return
    let active = true
    void api.status().then((snapshot) => { if (active) setAccounts(snapshot.accounts) }).catch(() => undefined)
    const unsubscribe = api.onChanged((snapshot) => { if (active) setAccounts(snapshot.accounts) })
    return () => { active = false; unsubscribe() }
  }, [api])

  if (!api) return null

  const run = async (key: string, work: () => Promise<MeetingHostSnapshot>, success: string, failure: string) => {
    setBusy(key)
    setMessage({ text: '', error: false })
    try {
      setAccounts((await work()).accounts)
      setMessage({ text: success, error: false })
      return true
    } catch (error) {
      setMessage({ text: errorText(error, failure), error: true })
      return false
    } finally { setBusy(undefined) }
  }

  const formFor = (provider: MeetingHostProvider) => forms[provider] ?? { clientId: '', clientSecret: '' }
  const setForm = (provider: MeetingHostProvider, value: { clientId: string; clientSecret: string }) => setForms((current) => ({ ...current, [provider]: value }))

  const saveRegistration = async (provider: MeetingHostProvider) => {
    const form = formFor(provider)
    const saved = await run(`configure:${provider}`, () => api.configure(provider, form.clientId, form.clientSecret), `${CONFERENCE_LABELS[provider]} app registration saved. Connect your account next.`, 'The registration could not be saved')
    if (saved) { setEditing(undefined); setForm(provider, { clientId: '', clientSecret: '' }) }
  }

  return (
    <section className="settings-section">
      <div className="settings-icon"><Video size={18} /></div>
      <div className="settings-content">
        <h3>Online meetings</h3>
        <p>Connect Zoom, Webex or GoToMeeting to add their meetings to Google and Microsoft calendar events. Aerio schedules the meeting with your account and writes the available join details into the event, so invitations include them. Changing the event’s title or time updates the meeting; deleting the event cancels it unless you choose to keep it.</p>
        <ul className="dav-account-list" aria-label="Online meeting accounts">
          {accounts.map((account) => {
            if (account.provider === 'meetn') return <MeetnRoomSettings key="meetn" account={account} api={api} changed={(snapshot) => setAccounts(snapshot.accounts)} />
            if (account.provider === 'icewarp') return <IceWarpMeetingSettings key="icewarp" account={account} api={api} changed={(snapshot) => setAccounts(snapshot.accounts)} />
            const label = CONFERENCE_LABELS[account.provider]
            const showForm = editing === account.provider || !account.configured
            const form = formFor(account.provider)
            return <li key={account.provider}>
              <div className="dav-account-heading">
                <span><strong>{label}</strong><small>{statusText(account)}{account.configured && account.clientIdHint ? ` · app ${account.clientIdHint}${account.configSource === 'built-in' ? ' (built in)' : ''}` : ''}</small></span>
                <div className="settings-actions">
                  {account.configured && (!account.connected || account.needsReconnect) && (
                    <button className="button primary" disabled={Boolean(busy)} onClick={() => void run(`connect:${account.provider}`, () => api.connect(account.provider), `${label} connected.`, `${label} could not be connected`)}>
                      <LogIn size={15} /> {busy === `connect:${account.provider}` ? 'Waiting for the browser…' : account.needsReconnect ? `Reconnect ${label}` : `Connect ${label}`}
                    </button>
                  )}
                  {account.connected && (confirmDisconnect === account.provider
                    ? <>
                      <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => { setConfirmDisconnect(undefined); void run(`disconnect:${account.provider}`, () => api.disconnect(account.provider), `${label} disconnected. Existing meetings were not cancelled.`, `${label} could not be disconnected`) }}>Disconnect</button>
                      <button className="button ghost" onClick={() => setConfirmDisconnect(undefined)}>Cancel</button>
                    </>
                    : <button className="button ghost" aria-label={`Disconnect ${label}`} disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(account.provider)}><Unplug size={15} /> Disconnect</button>)}
                  {account.configSource !== 'built-in' && account.configured && editing !== account.provider && (
                    <button className="button ghost" disabled={Boolean(busy)} onClick={() => { setEditing(account.provider); setForm(account.provider, { clientId: '', clientSecret: '' }) }}><KeyRound size={15} /> Change app</button>
                  )}
                </div>
              </div>
              {account.needsReconnect && account.error && <small className="diagnostic-error">{account.error}</small>}
              {showForm && account.configSource !== 'built-in' && <div className="meeting-host-registration" role="group" aria-label={`${label} app registration`}>
                <small>
                  {account.provider === 'zoom' ? 'Create a user-managed OAuth app in the Zoom App Marketplace' : account.provider === 'goto' ? 'Create an OAuth client on developer.goto.com with GoTo Meeting product access' : 'Create an integration on developer.webex.com'} with the redirect URL <code>{account.redirectUri}</code>{account.scopes.length ? ` and the scopes ${account.scopes.join(', ')}` : ''}.
                </small>
                <div className="profile-backup-fields">
                  <label className="field-label">Client ID
                    <input value={form.clientId} autoComplete="off" disabled={Boolean(busy)} onChange={(event) => setForm(account.provider, { ...form, clientId: event.target.value })} />
                  </label>
                  <label className="field-label">Client secret
                    <input type="password" autoComplete="off" value={form.clientSecret} disabled={Boolean(busy)} onChange={(event) => setForm(account.provider, { ...form, clientSecret: event.target.value })} />
                  </label>
                </div>
                <div className="settings-actions">
                  <button className="button ghost" disabled={Boolean(busy) || !form.clientId.trim() || !form.clientSecret.trim()} onClick={() => void saveRegistration(account.provider)}><KeyRound size={15} /> Save registration</button>
                  {account.configured && <button className="button ghost" onClick={() => setEditing(undefined)}>Cancel</button>}
                </div>
              </div>}
            </li>
          })}
        </ul>
        {message.text && <small className={message.error ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message.text}</small>}
      </div>
    </section>
  )
}
