import { Building2, Lock, Mail, Phone, RefreshCw, Search, ShieldAlert, UserPlus, Users, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DirectoryAccountState, DirectoryEntry, DirectoryGroupMembers, DirectorySnapshot } from '../directory-types'
import { DIRECTORY_KIND_LABELS, DirectoryKindIcon, directoryEntryDetail, useDirectoryLookup } from './RecipientDirectory'

// The read-only organization directory inside Contacts (E41): search, entry details, group
// members, offline address book freshness and refresh, and directory consent. Entries are never
// edited; "Add to my contacts" copies one into personal contacts.

const backendLabel = (account: DirectoryAccountState) => account.backend === 'microsoft-graph' ? 'Microsoft 365 directory'
  : account.backend === 'google-workspace' ? 'Google Workspace directory' : account.backend === 'exchange-ews' ? 'Exchange global address list' : 'No directory'

export function formatAge(iso: string | undefined, now = Date.now()) {
  if (!iso) return 'never'
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

export function DirectoryAccountStatus({ account, onChanged, onToast }: { account: DirectoryAccountState; onChanged(snapshot: DirectorySnapshot): void; onToast(message: string): void }) {
  const [busy, setBusy] = useState<'refresh' | 'grant' | 'resources'>()
  const api = window.aerio?.directory
  const run = async (kind: 'refresh' | 'grant' | 'resources') => {
    if (!api) return
    setBusy(kind)
    try {
      onChanged(kind === 'refresh' ? await api.refresh(account.accountId) : await api.grantAccess(account.accountId, kind === 'resources' ? 'resources' : 'directory'))
      onToast(kind === 'refresh' ? 'Offline address book refreshed' : 'Directory permission updated')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The directory could not be updated')
    } finally {
      setBusy(undefined)
    }
  }
  if (!account.supported) return <li className="directory-account unsupported"><strong>{account.email}</strong><small>{account.message}</small></li>
  const cache = account.cache
  return (
    <li className="directory-account">
      <strong>{account.email}</strong>
      <small>{backendLabel(account)}</small>
      {account.message && <p className={account.consent === 'denied' ? 'directory-warning' : 'provider-source-note'}>{account.consent === 'denied' && <ShieldAlert size={13} />} {account.message}</p>}
      {account.capabilities.offline && <small className="directory-freshness">
        Offline address book: {cache.entries.toLocaleString()} entr{cache.entries === 1 ? 'y' : 'ies'}{cache.mode === 'incremental' ? ' (rooms and people you looked up)' : ''} · updated {formatAge(cache.lastSuccessAt)}
        {cache.error && <span className="directory-warning"> · last refresh failed {formatAge(cache.lastAttemptAt)}: {cache.error}</span>}
      </small>}
      <div className="directory-account-actions">
        {account.backend !== 'exchange-ews' && (account.consent === 'denied' || ((account.consent === 'missing' || account.consent === 'unknown') && account.missingScopes.length > 0)) &&
          <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void run('grant')}><Lock size={13} /> {busy === 'grant' ? 'Waiting for sign-in…' : 'Allow directory access'}</button>}
        {account.backend === 'microsoft-graph' && account.consent === 'granted' && account.missingResourceScopes.length > 0 &&
          <button className="button ghost small" title={`Requests ${account.missingResourceScopes.join(', ')}; work or school organizations usually need an administrator to approve`} disabled={Boolean(busy)} onClick={() => void run('resources')}><Lock size={13} /> {busy === 'resources' ? 'Waiting for sign-in…' : 'Allow rooms and groups'}</button>}
        {account.capabilities.offline && <button className="button ghost small" disabled={Boolean(busy) || cache.refreshing} onClick={() => void run('refresh')}><RefreshCw size={13} className={busy === 'refresh' || cache.refreshing ? 'spin' : undefined} /> {busy === 'refresh' || cache.refreshing ? 'Refreshing…' : 'Refresh now'}</button>}
      </div>
    </li>
  )
}

interface DirectoryPanelProps {
  initialQuery?: string
  onCompose(address: string): void
  onAddToContacts(entry: DirectoryEntry): void
  onToast(message: string): void
}

export default function DirectoryPanel({ initialQuery = '', onCompose, onAddToContacts, onToast }: DirectoryPanelProps) {
  const [query, setQuery] = useState(initialQuery)
  const [snapshot, setSnapshot] = useState<DirectorySnapshot>()
  const [selectedId, setSelectedId] = useState<string>()
  const [members, setMembers] = useState<DirectoryGroupMembers>()
  const [membersError, setMembersError] = useState<string>()
  const { result, loading } = useDirectoryLookup(query, { limit: 100 })
  const api = window.aerio?.directory

  useEffect(() => {
    if (!api) return
    let active = true
    void api.snapshot().then((value) => { if (active) setSnapshot(value) }).catch(() => undefined)
    const stop = api.onChanged((value) => setSnapshot(value))
    return () => { active = false; stop() }
  }, [api])

  const entries = result?.entries ?? []
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0]
  useEffect(() => { setMembers(undefined); setMembersError(undefined) }, [selected?.id])

  const showMembers = async (entry: DirectoryEntry) => {
    if (!api) return
    setMembersError(undefined)
    try { setMembers(await api.expandGroup(entry.accountId, entry.email)) } catch (error) { setMembersError(error instanceof Error ? error.message : 'The group members could not be listed') }
  }

  const supported = snapshot?.accounts.filter((account) => account.supported) ?? []
  const problems = result?.accounts.filter((account) => account.error) ?? []
  return (
    <>
      <section className="contact-list-panel directory-panel">
        <header className="panel-heading"><div><h1>Directory</h1><p>Read-only · people, groups, and rooms from your organization</p></div></header>
        <label className="inline-search directory-search"><Search size={16} /><input aria-label="Search the directory" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, address, title, or department" /></label>
        {result?.source === 'offline' && <p className="provider-source-note"><WifiOff size={13} /> Showing the saved offline address book.</p>}
        {problems.map((problem) => <p key={problem.accountId} className={problem.needsConsent ? 'directory-warning' : 'provider-source-note'}>{problem.error}</p>)}
        <div className="contact-list">
          {query.trim().length < 2 && <p className="provider-source-note">Type at least two characters to search.</p>}
          {query.trim().length >= 2 && !loading && result && !entries.length && <p className="provider-source-note">No directory entries match “{query.trim()}”.</p>}
          {entries.map((entry) => (
            <button key={entry.id} className={`contact-row directory-row ${selected?.id === entry.id ? 'selected' : ''}`} onClick={() => setSelectedId(entry.id)}>
              <span className={`avatar large directory-kind kind-${entry.kind}`}><DirectoryKindIcon kind={entry.kind} size={18} /></span>
              <span><strong>{entry.name}</strong><small>{DIRECTORY_KIND_LABELS[entry.kind]} · {directoryEntryDetail(entry)}</small></span>
            </button>
          ))}
        </div>
        <ul className="directory-accounts" aria-label="Directory sources">
          {!api && <li className="directory-account unsupported"><small>The directory is unavailable in this window.</small></li>}
          {snapshot && !supported.length && <li className="directory-account unsupported"><small>None of your accounts publishes an organization directory. Microsoft 365, Google Workspace, and Exchange Server accounts do.</small></li>}
          {snapshot?.accounts.map((account) => <DirectoryAccountStatus key={account.accountId} account={account} onChanged={setSnapshot} onToast={onToast} />)}
        </ul>
      </section>
      <section className="contact-detail-panel">
        {selected ? <>
          <header className="contact-hero">
            <span className={`avatar hero-avatar directory-kind kind-${selected.kind}`}><DirectoryKindIcon kind={selected.kind} size={30} /></span>
            <div><h1>{selected.name}</h1><p>{[selected.title, selected.department].filter(Boolean).join(', ') || DIRECTORY_KIND_LABELS[selected.kind]}</p></div>
          </header>
          <div className="contact-actions">
            <button onClick={() => onCompose(selected.email)}><span><Mail size={19} /></span>Email</button>
            {selected.kind === 'person' && <button onClick={() => onAddToContacts(selected)}><span><UserPlus size={19} /></span>Add to my contacts</button>}
            {selected.kind === 'group' && selected.expandable && <button onClick={() => void showMembers(selected)}><span><Users size={19} /></span>Show members</button>}
          </div>
          <p className="provider-source-note">Read-only directory entry. Your organization manages it; adding it to your contacts makes an editable copy.</p>
          <div className="contact-detail-grid">
            <section className="detail-card">
              <h3>Details</h3>
              <dl>
                <div><dt><Mail size={15} /> Email</dt><dd>{selected.email}</dd></div>
                {selected.phone && <div><dt><Phone size={15} /> Phone</dt><dd>{selected.phone}</dd></div>}
                {selected.mobile && <div><dt><Phone size={15} /> Mobile</dt><dd>{selected.mobile}</dd></div>}
                {selected.company && <div><dt><Building2 size={15} /> Company</dt><dd>{selected.company}</dd></div>}
                {selected.office && <div><dt><Building2 size={15} /> Office</dt><dd>{selected.office}</dd></div>}
                {selected.building && <div><dt><Building2 size={15} /> Building</dt><dd>{selected.building}</dd></div>}
                {selected.capacity !== undefined && <div><dt><Users size={15} /> Capacity</dt><dd>{selected.capacity}</dd></div>}
              </dl>
            </section>
            {(members || membersError) && <section className="detail-card">
              <h3>Members</h3>
              {membersError && <p className="directory-warning">{membersError}</p>}
              {members && <ul className="directory-members">
                {members.members.map((member) => <li key={member.id}><DirectoryKindIcon kind={member.kind} /> {member.name} <small>{member.email}</small></li>)}
                {!members.members.length && <li>No members are listed.</li>}
                {members.truncated && <li><small>Only the first 500 members are shown.</small></li>}
              </ul>}
            </section>}
          </div>
        </> : <div className="empty-state grow"><Users size={32} /><h3>Search the directory</h3><p>Results are read-only. Use Add to my contacts to keep an editable copy.</p></div>}
      </section>
    </>
  )
}
