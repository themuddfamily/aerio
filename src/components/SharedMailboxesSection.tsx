import { ChevronDown, ChevronRight, FolderTree, Plus, RefreshCw, Search, Trash2, UserCog, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import {
  DELEGATE_FOLDERS,
  type DelegateFolder,
  type DelegateFolderPermission,
  type HeldMailboxOperation,
  type MailboxAccess,
  type MailboxDelegate,
  type MailboxDelegation,
  type MailboxDiscoveryResult,
  type MailboxOwnerSummary,
  type MailboxSendMode,
  type MeetingRequestDelivery,
  type PublicFolderNode
} from '../mailbox-owner-types'

// Settings › Mail account › Shared mailboxes & public folders (E40): attach shared or delegated
// mailboxes (by address or from Autodiscover), see effective permissions, choose send as / send on
// behalf, review actions held after access was removed, browse and subscribe public folders, and
// manage the delegates of the account's own mailbox (Exchange).

interface Props {
  account: MailAccountSummary
  onToast(message: string): void
}

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
export const accessLabel: Record<MailboxAccess, string> = { write: 'Can edit', read: 'Read-only', none: 'No access' }
const statusLabel: Record<MailboxOwnerSummary['status'], string> = { active: 'Synchronized', syncing: 'Synchronizing…', 'access-removed': 'Access removed', error: 'Needs attention' }
const kindLabel: Record<MailboxOwnerSummary['kind'], string> = { shared: 'Shared mailbox', delegated: 'Delegated mailbox', 'public-folders': 'Public folders' }
const sendModeLabel: Record<MailboxSendMode, string> = { none: 'Do not send from this mailbox', 'send-as': 'Send as (From: the mailbox)', 'send-on-behalf': 'Send on behalf (From: the mailbox, Sender: you)' }
const LEVELS: DelegateFolderPermission[] = ['None', 'Reviewer', 'Author', 'Editor']
const FOLDER_NAMES: Record<DelegateFolder, string> = { calendar: 'Calendar', tasks: 'Tasks', inbox: 'Inbox', contacts: 'Contacts', notes: 'Notes' }
const DELIVERY_LABEL: Record<MeetingRequestDelivery, string> = {
  DelegatesAndSendInformationToMe: 'My delegates only, but send me a copy for information',
  DelegatesAndMe: 'My delegates and me',
  DelegatesOnly: 'My delegates only',
  NoForward: 'Only me'
}
const newDelegate = (): MailboxDelegate => ({ address: '', permissions: { calendar: 'Editor', tasks: 'None', inbox: 'None', contacts: 'None', notes: 'None' }, receiveCopiesOfMeetingMessages: true, viewPrivateItems: false })

export function AccessBadge({ access }: { access: MailboxAccess }) {
  return <span className={`mailbox-access-badge access-${access}`}>{accessLabel[access]}</span>
}

export default function SharedMailboxesSection({ account, onToast }: Props) {
  const api = window.aerio.mailboxOwners
  const exchange = account.provider === 'exchange'
  const [owners, setOwners] = useState<MailboxOwnerSummary[]>([])
  const [held, setHeld] = useState<HeldMailboxOperation[]>([])
  const [busy, setBusy] = useState<string>()
  const [address, setAddress] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [kind, setKind] = useState<'shared' | 'delegated'>('shared')
  const [sendMode, setSendMode] = useState<MailboxSendMode>('none')
  const [discovery, setDiscovery] = useState<MailboxDiscoveryResult>()
  const [expanded, setExpanded] = useState<string>()

  const load = useCallback(async () => {
    if (!api) return
    const [nextOwners, nextHeld] = await Promise.all([api.list(account.id), api.held.list(account.id)])
    setOwners(nextOwners)
    setHeld(nextHeld)
  }, [account.id, api])

  useEffect(() => {
    void load().catch(() => undefined)
    return window.aerio.mail.onEvent((event) => {
      if (event.type === 'mail-changed' && (!event.payload.accountId || event.payload.accountId === account.id)) void load().catch(() => undefined)
    })
  }, [account.id, load])

  if (!api) return null

  const run = async (key: string, work: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(key)
    try {
      await work()
      if (success) onToast(success)
      await load()
      return true
    } catch (error) {
      onToast(errorText(error, failure))
      await load().catch(() => undefined)
      return false
    } finally { setBusy(undefined) }
  }

  const attach = async (target = address, name = displayName, targetKind = kind, discoveredBy?: 'autodiscover') => {
    const ok = await run(`attach:${target}`, () => api.attach({ accountId: account.id, address: target.trim(), ...(name.trim() ? { displayName: name.trim() } : {}), kind: targetKind, sendMode, ...(discoveredBy ? { discoveredBy } : {}) }), `${target.trim()} was added; its folders appear in the sidebar`, 'The mailbox could not be added')
    if (ok) { setAddress(''); setDisplayName(''); setSendMode('none') }
  }

  const mailboxes = owners.filter((owner) => owner.kind !== 'public-folders')
  const publicOwner = owners.find((owner) => owner.kind === 'public-folders')

  return <section className="shared-mailboxes-section" aria-label="Shared mailboxes and public folders">
    <h3><Users size={16} /> Shared mailboxes &amp; public folders</h3>
    <p>Open mailboxes that were shared with you or that you are a delegate for. Their folders appear in the sidebar under the mailbox name. Aerio follows the permissions the server reports: read-only folders can be read but not changed.</p>

    {mailboxes.length > 0 && <ul className="shared-mailbox-list" aria-label="Attached mailboxes">
      {mailboxes.map((owner) => <li key={owner.id} className={`shared-mailbox-row status-${owner.status}`}>
        <div className="shared-mailbox-head">
          <span><strong>{owner.displayName}</strong><small>{owner.address} · {kindLabel[owner.kind]} · {statusLabel[owner.status]}{owner.lastSyncAt ? ` · ${new Date(owner.lastSyncAt).toLocaleString()}` : ''}</small></span>
          <AccessBadge access={owner.access} />
        </div>
        {owner.error && <p className={owner.status === 'access-removed' ? 'account-error' : 'shared-mailbox-note'}>{owner.error}</p>}
        <div className="settings-actions">
          <label className="field-label">From address
            <select aria-label={`Send from ${owner.address}`} value={owner.sendMode} disabled={Boolean(busy) || owner.status === 'access-removed'} onChange={(event) => void run(`send:${owner.id}`, () => api.update({ accountId: account.id, ownerId: owner.id, sendMode: event.target.value as MailboxSendMode }), 'Sender option saved', 'The sender option could not be saved')}>
              {(Object.keys(sendModeLabel) as MailboxSendMode[]).map((mode) => <option key={mode} value={mode}>{sendModeLabel[mode]}</option>)}
            </select>
          </label>
          <button className="button ghost" disabled={Boolean(busy)} onClick={() => setExpanded(expanded === owner.id ? undefined : owner.id)} aria-expanded={expanded === owner.id}>{expanded === owner.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Permissions</button>
          <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`sync:${owner.id}`, () => api.sync(account.id, owner.id), owner.status === 'access-removed' ? 'Access was checked again' : 'Mailbox synchronized', 'The mailbox could not be synchronized')}><RefreshCw size={15} /> {owner.status === 'access-removed' ? 'Check access again' : 'Sync'}</button>
          <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Remove ${owner.displayName} from Aerio? Its cached mail and held changes are deleted from this computer; nothing changes on the server.`)) void run(`remove:${owner.id}`, () => api.remove(account.id, owner.id), `${owner.displayName} was removed`, 'The mailbox could not be removed') }}><Trash2 size={15} /> Remove</button>
        </div>
        {expanded === owner.id && <table className="shared-mailbox-folders" aria-label={`Permissions in ${owner.displayName}`}>
          <thead><tr><th>Folder</th><th>Type</th><th>Your access</th></tr></thead>
          <tbody>{owner.folders.map((folder) => <tr key={folder.folderId}><td>{folder.name}{folder.error ? <small> {folder.error}</small> : null}</td><td>{folder.kind}</td><td><AccessBadge access={folder.access} /></td></tr>)}</tbody>
        </table>}
      </li>)}
    </ul>}

    <div className="shared-mailbox-attach">
      <label className="field-label">Mailbox address<input type="email" value={address} placeholder="team@example.com" onChange={(event) => setAddress(event.target.value)} /></label>
      <label className="field-label">Name in the sidebar<input value={displayName} placeholder="Optional" onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label className="field-label">Type
        <select value={kind} onChange={(event) => setKind(event.target.value as 'shared' | 'delegated')}><option value="shared">Shared mailbox</option><option value="delegated">Another person’s mailbox (delegate)</option></select>
      </label>
      <label className="field-label">From address
        <select aria-label="Send from the new mailbox" value={sendMode} onChange={(event) => setSendMode(event.target.value as MailboxSendMode)}>{(Object.keys(sendModeLabel) as MailboxSendMode[]).map((mode) => <option key={mode} value={mode}>{sendModeLabel[mode]}</option>)}</select>
      </label>
      <button className="button ghost" disabled={Boolean(busy) || !address.includes('@')} onClick={() => void attach()}><Plus size={15} /> {busy?.startsWith('attach:') ? 'Checking access…' : 'Add mailbox'}</button>
      {exchange && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run('discover', async () => setDiscovery(await api.discover(account.id)), '', 'Autodiscover could not list your mailboxes')}><Search size={15} /> {busy === 'discover' ? 'Asking the server…' : 'Find my mailboxes'}</button>}
    </div>
    {discovery && <div className="shared-mailbox-discovery" role="region" aria-label="Mailboxes found by Autodiscover">
      {discovery.note && <p className="shared-mailbox-note">{discovery.note}</p>}
      <ul>{discovery.mailboxes.map((mailbox) => <li key={mailbox.address}>
        <span><strong>{mailbox.displayName}</strong><small>{mailbox.address} · {mailbox.kind === 'delegated' ? 'Delegate access' : 'Shared mailbox'}</small></span>
        <button className="button ghost" disabled={Boolean(busy) || mailbox.attached} onClick={() => void attach(mailbox.address, mailbox.displayName, mailbox.kind, 'autodiscover')}>{mailbox.attached ? 'Added' : 'Add'}</button>
      </li>)}</ul>
    </div>}
    {!exchange && <p className="shared-mailbox-note">Microsoft 365 needs the Mail.ReadWrite.Shared and Calendars.ReadWrite.Shared permissions. Microsoft Graph does not report folder permissions, so Aerio treats folders as editable until the server refuses a change.</p>}

    {held.length > 0 && <div className="dav-review" role="region" aria-label="Held mailbox changes">
      <strong>{held.length === 1 ? '1 change is on hold' : `${held.length} changes are on hold`}</strong>
      <small>Access to the mailbox was removed before these changes were sent. Send them again once access is restored, or discard them to restore the messages as they were.</small>
      <ul>{held.map((item) => <li key={item.id}>
        <span><strong>{item.kind} · {item.threadCount} conversation{item.threadCount === 1 ? '' : 's'}</strong><small>{item.ownerName}{item.error ? ` — ${item.error}` : ''}</small></span>
        <div className="settings-actions">
          <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`held:${item.id}`, () => api.held.resolve(item.id, 'retry'), 'The change will be sent again', 'The change could not be sent again')}>Send again</button>
          <button className="button ghost" disabled={Boolean(busy)} onClick={() => void run(`held:${item.id}`, () => api.held.resolve(item.id, 'discard'), 'The change was discarded', 'The change could not be discarded')}>Discard</button>
        </div>
      </li>)}</ul>
    </div>}

    {exchange && <PublicFolderBrowser account={account} owner={publicOwner} onToast={onToast} onChanged={() => void load().catch(() => undefined)} />}
    {exchange && <DelegationEditor account={account} onToast={onToast} />}
  </section>
}

function PublicFolderBrowser({ account, owner, onToast, onChanged }: Props & { owner?: MailboxOwnerSummary; onChanged(): void }) {
  const api = window.aerio.mailboxOwners!
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<Record<string, PublicFolderNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const loadLevel = async (parent?: string) => {
    setBusy(`load:${parent ?? ''}`)
    try {
      const nodes = await api.publicFolders.browse(account.id, parent)
      setChildren((current) => ({ ...current, [parent ?? '']: nodes }))
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure, 'Public folders could not be listed'))
    } finally { setBusy(undefined) }
  }

  const toggle = async (node: PublicFolderNode) => {
    const next = new Set(expanded)
    if (next.has(node.folderId)) next.delete(node.folderId)
    else {
      next.add(node.folderId)
      if (!children[node.folderId]) await loadLevel(node.folderId)
    }
    setExpanded(next)
  }

  const subscribe = async (node: PublicFolderNode, subscribed: boolean) => {
    setBusy(`subscribe:${node.folderId}`)
    try {
      await api.publicFolders.subscribe(account.id, node.folderId, subscribed)
      setChildren((current) => Object.fromEntries(Object.entries(current).map(([key, nodes]) => [key, nodes.map((item) => item.folderId === node.folderId ? { ...item, subscribed } : item)])))
      onToast(subscribed ? `${node.name} was added to the sidebar` : `${node.name} was removed from the sidebar`)
      onChanged()
    } catch (failure) {
      onToast(errorText(failure, 'The public folder could not be changed'))
    } finally { setBusy(undefined) }
  }

  const render = (parent: string, depth: number): React.ReactNode => (children[parent] ?? []).map((node) => <li key={node.folderId} style={{ paddingInlineStart: depth * 14 }}>
    <div className="public-folder-row">
      {node.childCount > 0
        ? <button className="mail-folder-twisty" aria-label={`${expanded.has(node.folderId) ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => void toggle(node)}>{expanded.has(node.folderId) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        : <span className="mail-folder-twisty" aria-hidden="true" />}
      <span className="public-folder-name">{node.name}<small> {node.kind === 'mail' ? 'Mail' : node.kind === 'calendar' ? 'Calendar' : node.kind === 'contacts' ? 'Contacts' : node.kind}</small></span>
      <AccessBadge access={node.access} />
      {(node.kind === 'mail' || node.kind === 'calendar' || node.kind === 'contacts') && <label className="public-folder-subscribe">
        <input type="checkbox" aria-label={`Show ${node.name} in Aerio`} checked={node.subscribed} disabled={Boolean(busy) || node.access === 'none'} onChange={(event) => void subscribe(node, event.target.checked)} /> Show in Aerio
      </label>}
    </div>
    {expanded.has(node.folderId) && <ul>{render(node.folderId, depth + 1)}</ul>}
  </li>)

  return <div className="public-folder-browser">
    <div className="settings-actions">
      <button className="button ghost" aria-expanded={open} disabled={Boolean(busy)} onClick={() => { const next = !open; setOpen(next); if (next && !children['']) void loadLevel() }}><FolderTree size={15} /> {open ? 'Hide public folders' : 'Browse public folders'}</button>
      {owner && <small>{owner.folders.filter((folder) => folder.subscribed).length} public folder{owner.folders.filter((folder) => folder.subscribed).length === 1 ? '' : 's'} shown in Aerio{owner.error ? ` · ${owner.error}` : ''}</small>}
    </div>
    {open && <>
      {error && <p className="account-error">{error}</p>}
      {busy === 'load:' && <p className="shared-mailbox-note">Loading public folders…</p>}
      {children[''] && !children[''].length && <p className="shared-mailbox-note">No public folders are available to this account.</p>}
      <ul className="public-folder-tree" aria-label="Public folders">{render('', 0)}</ul>
      <p className="shared-mailbox-note">Mail public folders appear in the sidebar; calendar and contacts public folders appear read-only in Calendar and Contacts.</p>
    </>}
  </div>
}

function DelegationEditor({ account, onToast }: Props) {
  const api = window.aerio.mailboxOwners!
  const [delegation, setDelegation] = useState<MailboxDelegation>()
  const [draft, setDraft] = useState<MailboxDelegate>(newDelegate())
  const [edits, setEdits] = useState<Record<string, MailboxDelegate>>({})
  const [busy, setBusy] = useState<string>()

  const run = async (key: string, work: () => Promise<MailboxDelegation>, success: string, failure: string) => {
    setBusy(key)
    try {
      setDelegation(await work())
      setEdits({})
      if (success) onToast(success)
      return true
    } catch (error) {
      onToast(errorText(error, failure))
      return false
    } finally { setBusy(undefined) }
  }

  const editor = (delegate: MailboxDelegate, change: (next: MailboxDelegate) => void) => <div className="delegate-permissions">
    {DELEGATE_FOLDERS.map((folder) => <label key={folder} className="field-label">{FOLDER_NAMES[folder]}
      <select aria-label={`${FOLDER_NAMES[folder]} permission for ${delegate.address || 'the new delegate'}`} value={delegate.permissions[folder]} onChange={(event) => change({ ...delegate, permissions: { ...delegate.permissions, [folder]: event.target.value as DelegateFolderPermission } })}>
        {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
    </label>)}
    <label className="rule-enabled"><input type="checkbox" checked={delegate.receiveCopiesOfMeetingMessages} onChange={(event) => change({ ...delegate, receiveCopiesOfMeetingMessages: event.target.checked })} /> Receives copies of meeting-related messages</label>
    <label className="rule-enabled"><input type="checkbox" checked={delegate.viewPrivateItems} onChange={(event) => change({ ...delegate, viewPrivateItems: event.target.checked })} /> Can see my private items</label>
  </div>

  if (!delegation) {
    return <div className="delegation-editor"><div className="settings-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={() => void run('load', () => api.delegates.get(account.id), '', 'Delegates could not be loaded')}><UserCog size={15} /> {busy === 'load' ? 'Loading delegates…' : 'Manage delegates of my mailbox'}</button></div></div>
  }
  if (!delegation.supported) return <div className="delegation-editor"><p className="shared-mailbox-note">{delegation.note}</p></div>

  return <div className="delegation-editor" role="region" aria-label="Delegates">
    <h4>Delegates of {account.email}</h4>
    <p className="shared-mailbox-note">Delegates can work in your folders with the permission you choose. Reviewer can read, Author can create and change their own items, Editor can change everything.</p>
    {delegation.delegates.length === 0 && <p className="shared-mailbox-note">You have no delegates.</p>}
    <ul className="delegate-list">{delegation.delegates.map((delegate) => {
      const current = edits[delegate.address] ?? delegate
      return <li key={delegate.address}>
        <strong>{delegate.displayName ?? delegate.address}</strong> <small>{delegate.address}</small>
        {editor(current, (next) => setEdits((value) => ({ ...value, [delegate.address]: next })))}
        <div className="settings-actions">
          <button className="button ghost" disabled={Boolean(busy) || !edits[delegate.address]} onClick={() => void run(`save:${delegate.address}`, () => api.delegates.save({ accountId: account.id, mode: 'update', delegate: current }), 'Delegate permissions saved', 'The delegate could not be saved')}>Save</button>
          <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => void run(`remove:${delegate.address}`, () => api.delegates.remove(account.id, delegate.address), `${delegate.address} is no longer a delegate`, 'The delegate could not be removed')}><Trash2 size={15} /> Remove</button>
        </div>
      </li>
    })}</ul>
    <div className="delegate-add">
      <label className="field-label">New delegate<input type="email" value={draft.address} placeholder="colleague@example.com" onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></label>
      {editor(draft, setDraft)}
      <button className="button ghost" disabled={Boolean(busy) || !draft.address.includes('@')} onClick={() => void run('add', () => api.delegates.save({ accountId: account.id, mode: 'add', delegate: { ...draft, address: draft.address.trim() } }), 'Delegate added', 'The delegate could not be added').then((ok) => { if (ok) setDraft(newDelegate()) })}><Plus size={15} /> Add delegate</button>
    </div>
    <label className="field-label">Deliver meeting requests to
      <select value={delegation.deliverMeetingRequests} disabled={Boolean(busy)} onChange={(event) => void run('delivery', () => api.delegates.setMeetingDelivery(account.id, event.target.value as MeetingRequestDelivery), 'Meeting request delivery saved', 'Meeting request delivery could not be saved')}>
        {(Object.keys(DELIVERY_LABEL) as MeetingRequestDelivery[]).map((value) => <option key={value} value={value}>{DELIVERY_LABEL[value]}</option>)}
      </select>
    </label>
  </div>
}
