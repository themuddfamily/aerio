import { UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppProfileSnapshot } from '../app-profile-types'
import Modal from './Modal'

export default function AppProfileSwitcher({ onPrepareSwitch }: { onPrepareSwitch(): Promise<void> }) {
  const [snapshot, setSnapshot] = useState<AppProfileSnapshot>()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [renameId, setRenameId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.aerio.appProfiles
  useEffect(() => { if (!api) return; let active = true; void api.list().then((value) => { if (active) setSnapshot(value) }).catch(() => {}); return () => { active = false } }, [])
  if (!api) return null
  const current = snapshot?.profiles.find((profile) => profile.id === snapshot.currentId)
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : 'The application profile action failed.') }
    finally { setBusy(false) }
  }
  const reload = async () => { setSnapshot(await api.list()) }
  return <>
    <button aria-label="Switch application profile" title={`Application profile: ${current?.name ?? 'Loading…'}`} onClick={() => { setOpen(true); setError(''); void reload().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Profiles could not be loaded.')) }}><UsersRound size={19} /><span>Profiles</span></button>
    {open && <Modal title="Application profiles" subtitle="Keep personal and work accounts, settings and data separate." width="medium" onClose={() => setOpen(false)} closeEnabled={!busy}>
      <p>Switching restarts Aerio. Save and close open drafts and other Aerio windows first. Each profile has its own accounts, credentials, messages, calendars and local workspace.</p>
      <ul className="application-profile-list">{snapshot?.profiles.map((profile) => <li key={profile.id}><span><strong>{profile.name}</strong>{profile.id === snapshot.currentId && <small>Current profile</small>}</span><button className="button ghost small" disabled={busy} onClick={() => { setRenameId(profile.id); setName(profile.name) }} aria-label={`Rename ${profile.name}`}>Rename</button><button className="button ghost small" disabled={busy || profile.id === snapshot.currentId} onClick={() => void perform(async () => { await onPrepareSwitch(); await api.switch(profile.id) })} aria-label={`Switch to ${profile.name}`}>Switch</button></li>)}</ul>
      <form onSubmit={(event) => { event.preventDefault(); void perform(async () => { setSnapshot(renameId ? await api.rename(renameId, name) : await api.create(name)); setName(''); setRenameId(undefined) }) }}>
        <label className="field-label">{renameId ? 'Rename profile' : 'New profile name'}<input maxLength={80} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="Work, Personal…" /></label>
        <div className="settings-actions"><button className="button primary" disabled={busy || !name.trim()} type="submit">{renameId ? 'Save profile name' : 'Create separate profile'}</button>{renameId && <button className="button ghost" disabled={busy} type="button" onClick={() => { setRenameId(undefined); setName('') }}>Cancel rename</button>}</div>
      </form>
      {error && <p role="alert">{error}</p>}
      <small>New profiles start empty. Aerio remembers the last selected profile at startup. Existing profile data is never copied or deleted here.</small>
    </Modal>}
  </>
}
