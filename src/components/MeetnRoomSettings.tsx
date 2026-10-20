import { useState } from 'react'
import type { MeetnRoomAccount, MeetingHostApi, MeetingHostSnapshot } from '../meeting-host-types'
export default function MeetnRoomSettings({ account, api, changed }: { account: MeetnRoomAccount; api: MeetingHostApi; changed(snapshot: MeetingHostSnapshot): void }) {
  const [room, setRoom] = useState(account.room ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (value: string) => {
    setBusy(true); setError('')
    try { changed(await api.setMeetnRoom(value)); if (!value) setRoom('') }
    catch (error) { setError(error instanceof Error ? error.message : 'The Meetn room could not be saved') }
    finally { setBusy(false) }
  }
  return <li>
    <div className="dav-account-heading"><span><strong>Meetn</strong><small>{account.connected ? `Room: ${account.room}` : 'Connect your existing Meetn room'}</small></span></div>
    <p>Meetn uses a permanent room link. Create the room in Meetn first, then enter its name or public link. All events using this room share the same link; removing an event leaves the room available.</p>
    <label className="field-label">Meetn room name or link<input value={room} disabled={busy} onChange={(event) => setRoom(event.target.value)} placeholder="https://meetn.com/your-room" autoComplete="off" /></label>
    <div className="settings-actions"><button className="button ghost" disabled={busy || !room.trim()} onClick={() => void save(room)}>Save Meetn room</button>{account.connected && <button className="button ghost" disabled={busy} onClick={() => void save('')}>Disconnect Meetn room</button>}</div>
    {error && <small role="alert" className="diagnostic-error">{error}</small>}
  </li>
}
