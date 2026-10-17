import {
  AlertTriangle, BellOff, Bell, Check, CornerUpLeft, Download, Eye, EyeOff, KeyRound, Lock, LockOpen, LogOut, MessageSquare,
  Paperclip, Pencil, Plus, RefreshCw, Search, Send, Settings, ShieldCheck, ShieldAlert, SmilePlus, Trash2, X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  ChatAccountPreferences, ChatAccountSummary, ChatDesktopApi, ChatDeviceSummary, ChatLoginFlows, ChatRoomSummary, ChatSearchResult,
  ChatSnapshot, ChatTimelineItem, ChatTimelinePage, ChatVerificationState
} from '../chat-types'
import { copyText } from '../components/ContextMenu'

/**
 * The Matrix Chat workspace (E30). It only ever sees display snapshots and
 * timeline projections from the main process: no access tokens, keys or SDK
 * objects. App.tsx mounts it only while the Chat gate passes.
 */
export interface ChatOpenRequest { id: number; accountId: string; roomId: string }

interface ChatViewProps {
  chat: ChatDesktopApi
  snapshot: ChatSnapshot
  openRequest?: ChatOpenRequest
  onToast(message: string): void
}

type Panel = { kind: 'room'; accountId: string; roomId: string } | { kind: 'security'; accountId: string } | { kind: 'settings'; accountId: string } | { kind: 'add' }

const ATTACHMENT_LIMIT_MIB = 25
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`
const STATUS_LABELS: Record<ChatAccountSummary['status'], string> = {
  connecting: 'Connecting…', ready: 'Connected', offline: 'Offline — messages wait in the outbox', 'needs-auth': 'Sign in again', paused: 'Paused', error: 'Needs attention'
}
const DELIVERY_LABELS: Record<NonNullable<ChatTimelineItem['delivery']>, string> = {
  pending: 'Waiting to send', running: 'Sending…', sent: 'Accepted by server', failed: 'Not sent', review: 'Needs review — may already have been delivered'
}

export default function ChatView({ chat, snapshot, openRequest, onToast }: ChatViewProps) {
  const [panel, setPanel] = useState<Panel>()
  const run = useCallback(async <T,>(action: () => Promise<T>, success?: string) => {
    try {
      const result = await action()
      if (success) onToast(success)
      return result
    } catch (error) {
      onToast(errorText(error))
      return undefined
    }
  }, [onToast])

  useEffect(() => {
    if (openRequest) setPanel({ kind: 'room', accountId: openRequest.accountId, roomId: openRequest.roomId })
  }, [openRequest])

  const accounts = snapshot.accounts
  const current: Panel = panel && (panel.kind === 'add' || accounts.some((account) => account.id === panel.accountId))
    ? panel
    : accounts.length ? { kind: 'security', accountId: accounts[0].id } : { kind: 'add' }
  const firstRoom = accounts.length ? snapshot.rooms.find((room) => room.accountId === accounts[0].id && room.membership === 'join') : undefined
  const active: Panel = !panel && firstRoom ? { kind: 'room', accountId: firstRoom.accountId, roomId: firstRoom.roomId } : current
  const room = active.kind === 'room' ? snapshot.rooms.find((item) => item.accountId === active.accountId && item.roomId === active.roomId) : undefined
  const verifications = snapshot.verifications

  return (
    <div className="workspace chat-workspace">
      <aside className="context-sidebar chat-sidebar" aria-label="Chat rooms">
        <button className="compose-button" onClick={() => setPanel({ kind: 'add' })}><Plus size={18} /> Add Matrix account</button>
        {snapshot.gate.preview && <p className="chat-preview-note" role="note"><AlertTriangle size={13} /> Chat preview: hosted two-device interoperability is unverified for this version.</p>}
        {accounts.map((account) => (
          <div className="sidebar-group" key={account.id}>
            <span className="sidebar-label chat-account-label" title={`${account.userId} on ${account.homeserver}`}>{account.userId}</span>
            <small className={`chat-account-status ${account.status}`}>{STATUS_LABELS[account.status]}</small>
            {account.securityPause && <small className="chat-account-status error">{account.securityPause}</small>}
            {snapshot.rooms.filter((item) => item.accountId === account.id && item.membership !== 'leave' && item.membership !== 'ban').map((item) => (
              <button key={item.roomId} className={`sidebar-item ${active.kind === 'room' && active.roomId === item.roomId && active.accountId === account.id ? 'active' : ''}`}
                aria-label={`${item.name}${item.unread ? `, ${item.unread} unread` : ''}${item.membership === 'invite' ? ', invitation' : ''}`}
                onClick={() => setPanel({ kind: 'room', accountId: account.id, roomId: item.roomId })}>
                {item.encrypted ? <Lock size={15} /> : <LockOpen size={15} />}
                <span>{item.name}</span>
                {item.membership === 'invite' ? <em>Invite</em> : item.unread > 0 && <em className="mail-unread-count">{item.unread > 99 ? '99+' : item.unread}</em>}
              </button>
            ))}
            <button className={`sidebar-item ${active.kind === 'security' && active.accountId === account.id ? 'active' : ''}`} onClick={() => setPanel({ kind: 'security', accountId: account.id })}>
              {account.trust === 'verified' ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}<span>Security and devices</span>
              {verifications.some((state) => state.accountId === account.id) && <em>1</em>}
            </button>
            <button className={`sidebar-item ${active.kind === 'settings' && active.accountId === account.id ? 'active' : ''}`} onClick={() => setPanel({ kind: 'settings', accountId: account.id })}>
              <Settings size={15} /><span>Account settings</span>
            </button>
          </div>
        ))}
      </aside>
      <section className="chat-main">
        {verifications.map((state) => <VerificationCard key={`${state.accountId}|${state.requestId}`} state={state} chat={chat} run={run} />)}
        {active.kind === 'add' && <ChatSignIn chat={chat} run={run} onConnected={(account) => setPanel({ kind: 'security', accountId: account.id })} />}
        {active.kind === 'security' && <ChatSecurity key={active.accountId} account={accounts.find((item) => item.id === active.accountId)!} chat={chat} run={run} onToast={onToast} />}
        {active.kind === 'settings' && <ChatAccountSettings key={active.accountId} account={accounts.find((item) => item.id === active.accountId)!} chat={chat} run={run} onToast={onToast} onRemoved={() => setPanel(undefined)} />}
        {active.kind === 'room' && room && <ChatRoom key={`${room.accountId}|${room.roomId}`} room={room} chat={chat} run={run} onToast={onToast} />}
        {active.kind === 'room' && !room && <div className="empty-state grow"><MessageSquare size={30} /><h3>Room unavailable</h3><p>This room is no longer in your local Chat history.</p></div>}
      </section>
    </div>
  )
}

type Run = <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>

function ChatSignIn({ chat, run, onConnected }: { chat: ChatDesktopApi; run: Run; onConnected(account: ChatAccountSummary): void }) {
  const [server, setServer] = useState('')
  const [flows, setFlows] = useState<ChatLoginFlows>()
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    setFlows(await run(() => chat.discover(server.trim())))
    setBusy(false)
  }
  const signIn = async () => {
    if (!flows) return
    setBusy(true)
    const account = await run(() => chat.login({ homeserver: flows.homeserver, user: user.trim(), password }), 'Matrix account connected')
    // The password is never kept after the attempt.
    setPassword('')
    setBusy(false)
    if (account) onConnected(account)
  }
  return (
    <form className="chat-card chat-sign-in" aria-label="Add Matrix account" onSubmit={(event) => { event.preventDefault(); void (flows ? signIn() : check()) }}>
      <h2>Add a Matrix account</h2>
      <p>Chat uses your own Matrix homeserver account. It is separate from your mail accounts: an email address never establishes a chat identity.</p>
      <label className="field-label">Homeserver or Matrix ID
        <input value={server} placeholder="matrix.example.org or @you:example.org" autoComplete="off" spellCheck={false} onChange={(event) => { setServer(event.target.value); setFlows(undefined) }} />
      </label>
      {!flows && <div className="settings-actions"><button className="button primary" type="submit" disabled={busy || !server.trim()}>Check server</button></div>}
      {flows && (
        <>
          <p className="chat-origin" role="status">You will sign in to <strong>{flows.homeserver}</strong>{flows.versions.length ? ` (Matrix ${flows.versions.slice(-1)[0]})` : ''}.</p>
          {!flows.password && <p className="diagnostic-error">This homeserver does not offer password sign-in{flows.sso ? '; single sign-on is not supported in Aerio yet' : ''}.</p>}
          {flows.password && (
            <>
              <label className="field-label">User name<input value={user} autoComplete="username" spellCheck={false} onChange={(event) => setUser(event.target.value)} /></label>
              <label className="field-label">Password<input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></label>
              <p className="chat-hint">Your password goes only to this homeserver and is not stored. Signing in creates a new device for this Aerio installation.</p>
              <div className="settings-actions">
                <button className="button ghost" type="button" onClick={() => setFlows(undefined)}>Change server</button>
                <button className="button primary" type="submit" disabled={busy || !user.trim() || !password}>Sign in</button>
              </div>
            </>
          )}
        </>
      )}
    </form>
  )
}

function VerificationCard({ state, chat, run }: { state: ChatVerificationState; chat: ChatDesktopApi; run: Run }) {
  const act = (action: 'accept' | 'start-sas' | 'confirm' | 'mismatch' | 'cancel', success?: string) => void run(() => chat.verificationAction(state.accountId, state.requestId, action), success)
  const who = state.selfVerification ? `your other session${state.otherDeviceId ? ` (${state.otherDeviceId})` : ''}` : state.otherUserId
  return (
    <section className="chat-card chat-verification" aria-label="Device verification">
      <h3><ShieldCheck size={15} /> Verify {who}</h3>
      {state.phase === 'requested' && !state.initiatedByMe && (
        <>
          <p>{state.otherUserId} asked to verify{state.selfVerification ? ' this device' : ''}. Accept only if you started this on your other device.</p>
          <div className="settings-actions"><button className="button ghost small" onClick={() => act('cancel')}>Decline</button><button className="button primary small" onClick={() => act('accept')}>Accept</button></div>
        </>
      )}
      {state.phase === 'requested' && state.initiatedByMe && <><p>Waiting for {who} to accept…</p><div className="settings-actions"><button className="button ghost small" onClick={() => act('cancel')}>Cancel</button></div></>}
      {state.phase === 'ready' && <><p>Both sides are ready. Compare emoji to finish.</p><div className="settings-actions"><button className="button ghost small" onClick={() => act('cancel')}>Cancel</button><button className="button primary small" onClick={() => act('start-sas')}>Compare emoji</button></div></>}
      {state.phase === 'started' && <p>Waiting for the emoji…</p>}
      {state.phase === 'show-sas' && (
        <>
          <p>Confirm that these emoji appear in the same order on the other device.</p>
          {state.emoji ? <ol className="chat-emoji" aria-label="Verification emoji">{state.emoji.map((item, index) => <li key={index}><span aria-hidden="true">{item.symbol}</span><small>{item.name}</small></li>)}</ol>
            : <p className="chat-hint">The emoji were cleared when Aerio locked. Cancel and start again.</p>}
          <div className="settings-actions">
            <button className="button danger-subtle small" onClick={() => act('mismatch')}>They don’t match</button>
            <button className="button primary small" disabled={!state.emoji} onClick={() => act('confirm', 'Verification confirmed')}>They match</button>
          </div>
        </>
      )}
    </section>
  )
}

function ChatSecurity({ account, chat, run, onToast }: { account: ChatAccountSummary; chat: ChatDesktopApi; run: Run; onToast(message: string): void }) {
  const [devices, setDevices] = useState<ChatDeviceSummary[]>()
  const [recoveryKey, setRecoveryKey] = useState('')
  const [created, setCreated] = useState<{ recoveryKey?: string; backupComplete?: boolean }>()
  const [busy, setBusy] = useState(false)
  const loadDevices = useCallback(() => { void run(() => chat.devices(account.id)).then((list) => setDevices(list)) }, [account.id, chat, run])
  useEffect(() => { if (account.status === 'ready') loadDevices() }, [account.status, loadDevices])
  const restore = async () => {
    setBusy(true)
    const result = await run(() => chat.restoreFromRecoveryKey(account.id, recoveryKey))
    setBusy(false)
    if (!result) return
    setRecoveryKey('')
    onToast(result.total ? `Restored ${result.imported} of ${result.total} backed-up message keys` : 'Recovery key accepted; the backup holds no message keys yet')
  }
  const setup = async () => {
    setBusy(true)
    setCreated(await run(() => chat.setupRecovery(account.id)))
    setBusy(false)
  }
  return (
    <div className="chat-scroll">
      <header className="panel-heading"><div><h1>Security and devices</h1><p>{account.userId} · device {account.deviceId}</p></div></header>
      {account.securityPause && <p className="chat-banner danger" role="alert"><AlertTriangle size={14} /> {account.securityPause}</p>}
      <section className="chat-card">
        <h3>{account.trust === 'verified' ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />} This device is {account.trust === 'verified' ? 'verified' : account.trust === 'unverified' ? 'not verified' : 'in an unknown trust state'}</h3>
        <p>Verify it from another of your Matrix sessions by comparing emoji, or restore with your recovery key. Aerio never trusts a device because it shares an email address or user name.</p>
        <div className="settings-actions"><button className="button primary small" disabled={account.status !== 'ready'} onClick={() => void run(() => chat.verifyOwnDevice(account.id))}>Verify with another session</button></div>
      </section>
      <section className="chat-card" aria-label="Recovery">
        <h3><KeyRound size={15} /> Recovery and key backup</h3>
        <p>{account.recovery === 'available' || account.recovery === 'restored' ? 'Encrypted key backup is active for this device.'
          : account.recovery === 'needs-key' ? 'A key backup exists. Enter your recovery key to read earlier encrypted messages on this device.'
            : account.recovery === 'not-set-up' ? 'No key backup is set up. Without one, a lost device means its encrypted history cannot be read elsewhere.'
              : 'Recovery status is not known yet.'}</p>
        {created?.recoveryKey ? (
          <div className="chat-recovery-key">
            <p><strong>Save this recovery key now.</strong> Aerio does not store it and cannot show it again.</p>
            <code aria-label="Recovery key">{created.recoveryKey}</code>
            {created.backupComplete === false && <p className="chat-hint">Earlier message keys are still uploading to the backup.</p>}
            <div className="settings-actions"><button className="button ghost small" onClick={() => void copyText(created.recoveryKey!)}>Copy</button><button className="button primary small" onClick={() => setCreated(undefined)}>I have saved it</button></div>
          </div>
        ) : account.recovery === 'not-set-up' && <div className="settings-actions"><button className="button primary small" disabled={busy || account.status !== 'ready'} onClick={() => void setup()}>Set up recovery</button></div>}
        {account.recovery !== 'not-set-up' && (
          <form className="chat-inline-form" onSubmit={(event) => { event.preventDefault(); void restore() }}>
            <label className="field-label">Recovery key<input value={recoveryKey} autoComplete="off" spellCheck={false} onChange={(event) => setRecoveryKey(event.target.value)} /></label>
            <button className="button ghost small" type="submit" disabled={busy || !recoveryKey.trim() || account.status !== 'ready'}>Restore</button>
          </form>
        )}
      </section>
      <section className="chat-card" aria-label="Devices">
        <h3>Your devices <button className="text-button" aria-label="Refresh devices" onClick={loadDevices}><RefreshCw size={12} /></button></h3>
        {!devices ? <p className="chat-hint">{account.status === 'ready' ? 'Loading devices…' : 'Devices load once Chat is connected.'}</p> : (
          <ul className="chat-device-list">
            {devices.map((device) => (
              <li key={device.deviceId}>
                <span><strong>{device.displayName || device.deviceId}</strong><small>{device.deviceId}{device.current ? ' · this device' : ''}</small></span>
                <em className={device.verified ? 'verified' : 'unverified'}>{device.verified ? 'Verified' : 'Not verified'}</em>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ChatAccountSettings({ account, chat, run, onToast, onRemoved }: { account: ChatAccountSummary; chat: ChatDesktopApi; run: Run; onToast(message: string): void; onRemoved(): void }) {
  const preferences = account.preferences
  const [historyDays, setHistoryDays] = useState(String(preferences.retention.historyDays))
  const [mediaCacheMiB, setMediaCacheMiB] = useState(String(preferences.retention.mediaCacheMiB))
  const update = (patch: Partial<ChatAccountPreferences>) => void run(() => chat.updatePreferences(account.id, patch))
  const toggle = (key: 'notificationPreviews' | 'sendWhileLocked' | 'typingNotifications' | 'readReceipts', label: string, detail: string) => (
    <label className="toggle-row"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={preferences[key]} onChange={(event) => update({ [key]: event.target.checked })} /></label>
  )
  return (
    <div className="chat-scroll">
      <header className="panel-heading"><div><h1>Account settings</h1><p>{account.userId} on {account.homeserver}</p></div></header>
      <section className="chat-card chat-settings">
        {toggle('notificationPreviews', 'Message previews in notifications', 'Off by default. Previews still need an unlocked app and a room that allows them.')}
        {toggle('sendWhileLocked', 'Send queued messages while locked', 'Otherwise the outbox waits until Aerio is unlocked.')}
        {toggle('typingNotifications', 'Send typing notifications', 'Off by default.')}
        {toggle('readReceipts', 'Send read receipts', 'Off by default; Aerio only moves your private read marker.')}
      </section>
      <form className="chat-card chat-settings" aria-label="Local retention" onSubmit={(event) => { event.preventDefault(); update({ retention: { historyDays: Number(historyDays), mediaCacheMiB: Number(mediaCacheMiB) } }) }}>
        <h3>Local retention</h3>
        <p>How much decrypted history and encrypted media this PC keeps. Server retention is separate; pending messages and keys are never pruned.</p>
        <div className="chat-retention">
          <label className="field-label">Days of history<input type="number" min={1} max={3650} value={historyDays} onChange={(event) => setHistoryDays(event.target.value)} /></label>
          <label className="field-label">Media cache (MiB)<input type="number" min={16} max={10240} value={mediaCacheMiB} onChange={(event) => setMediaCacheMiB(event.target.value)} /></label>
          <button className="button ghost small" type="submit">Save</button>
        </div>
      </form>
      <section className="chat-card">
        <h3>Local data</h3>
        <p>Clearing history removes decrypted messages and cached media from this PC. Your device keys stay, and history can sync again from the server if it still has it.</p>
        <p>Removing the account stops Chat for it, signs this device out when the server can be reached, and deletes its local keys and cache. It does not delete messages for other participants.</p>
        <div className="settings-actions">
          <button className="button ghost small" onClick={() => { if (window.confirm('Clear local Chat history for this account?')) void run(() => chat.clearHistory(account.id), 'Local Chat history cleared') }}><Trash2 size={13} /> Clear local history</button>
          <button className="button danger-subtle small" onClick={() => {
            if (!window.confirm(`Remove ${account.userId} from Aerio?`)) return
            void run(() => chat.removeAccount(account.id)).then((result) => {
              if (!result) return
              onToast(result.remoteLogout === 'done' ? 'Account removed and signed out' : `Account removed from this PC. ${result.message ?? 'The server sign-out could not be confirmed.'}`)
              onRemoved()
            })
          }}><LogOut size={13} /> Remove account</button>
        </div>
      </section>
    </div>
  )
}

function ChatRoom({ room, chat, run, onToast }: { room: ChatRoomSummary; chat: ChatDesktopApi; run: Run; onToast(message: string): void }) {
  const [page, setPage] = useState<ChatTimelinePage>()
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<ChatTimelineItem>()
  const [editing, setEditing] = useState<ChatTimelineItem>()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatSearchResult[]>()
  const joined = room.membership === 'join'
  const reload = useCallback(() => {
    if (room.membership !== 'join') { setPage(undefined); return }
    void chat.timeline(room.accountId, room.roomId).then(setPage).catch(() => undefined)
  }, [chat, room.accountId, room.membership, room.roomId])
  useEffect(() => {
    reload()
    if (room.membership === 'join') void chat.markRead(room.accountId, room.roomId).catch(() => undefined)
    return chat.onEvent((event) => {
      if (event.type === 'timeline' && event.accountId === room.accountId && event.roomId === room.roomId) {
        reload()
        if (document.hasFocus()) void chat.markRead(room.accountId, room.roomId).catch(() => undefined)
      }
    })
  }, [chat, reload, room.accountId, room.membership, room.roomId])

  const submit = async () => {
    const body = draft.trim()
    if (!body) return
    const done = editing?.eventId
      ? await run(async () => { await chat.edit(room.accountId, room.roomId, editing.eventId!, body); return true })
      : await run(() => chat.send(room.accountId, room.roomId, body, replyTo?.eventId))
    if (!done) return
    setDraft('')
    setReplyTo(undefined)
    setEditing(undefined)
    reload()
  }
  const older = async () => {
    setLoadingOlder(true)
    const next = await run(() => chat.loadOlder(room.accountId, room.roomId))
    if (next) setPage(next)
    setLoadingOlder(false)
  }
  const roomAction = (action: Parameters<ChatDesktopApi['roomAction']>[2], success?: string) => void run(() => chat.roomAction(room.accountId, room.roomId, action), success)
  const items = page?.items ?? []
  const searchable = query.trim()

  return (
    <div className="chat-room">
      <header className="panel-heading chat-room-header">
        <div>
          <h1>{room.name}</h1>
          <p className={room.encrypted ? 'chat-encrypted' : 'chat-unencrypted'}>
            {room.encrypted ? <><Lock size={11} /> End-to-end encrypted</> : <><LockOpen size={11} /> Not encrypted — the server can read these messages</>}
            {room.isDirect ? ' · direct conversation' : ''}
          </p>
        </div>
        {joined && (
          <div className="chat-room-actions">
            <form role="search" onSubmit={(event) => { event.preventDefault(); if (searchable) void run(() => chat.search(room.accountId, searchable)).then((found) => setResults(found?.filter((item) => item.roomId === room.roomId))) }}>
              <input aria-label="Search this room" placeholder="Search kept history" value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setResults(undefined) }} />
              <button className="text-button" type="submit" aria-label="Search"><Search size={13} /></button>
            </form>
            <button className="text-button" aria-label={room.muted ? 'Unmute room' : 'Mute room'} title={room.muted ? 'Unmute' : 'Mute'} onClick={() => roomAction(room.muted ? 'unmute' : 'mute')}>{room.muted ? <BellOff size={14} /> : <Bell size={14} />}</button>
            <button className="text-button" aria-label={room.previews ? 'Hide notification previews' : 'Allow notification previews'} title={room.previews ? 'Previews allowed' : 'Previews hidden'} onClick={() => roomAction(room.previews ? 'block-previews' : 'allow-previews')}>{room.previews ? <Eye size={14} /> : <EyeOff size={14} />}</button>
            <button className="text-button" aria-label="Leave room" onClick={() => { if (window.confirm(`Leave ${room.name}?`)) roomAction('leave', 'You left the room') }}><LogOut size={14} /></button>
          </div>
        )}
      </header>
      {room.membership === 'invite' && (
        <section className="chat-card" aria-label="Invitation">
          <h3>Invitation</h3>
          <p>{room.inviter ? <>Invited by <strong>{room.inviter}</strong>.</> : 'You were invited to this room.'} Media and history load only after you accept.</p>
          <div className="settings-actions"><button className="button ghost small" onClick={() => roomAction('decline', 'Invitation declined')}>Decline</button><button className="button primary small" onClick={() => roomAction('accept', 'Invitation accepted')}>Accept</button></div>
        </section>
      )}
      {room.held && <p className="chat-banner danger" role="alert"><AlertTriangle size={14} /> Sending is paused: {room.held} <button className="button ghost small" onClick={() => roomAction('release-hold')}>Resume sending</button></p>}
      {results && (
        <section className="chat-card" aria-label="Search results">
          <h3>{results.length ? `${results.length} matches in locally kept history` : 'No matches in locally kept history'} <button className="text-button" aria-label="Close search" onClick={() => { setResults(undefined); setQuery('') }}><X size={12} /></button></h3>
          <p className="chat-hint">Search covers decrypted messages kept on this PC only.</p>
          <ul className="chat-search-results">{results.map((item) => <li key={item.eventId}><strong>{item.sender}</strong> <time>{new Date(item.timestamp).toLocaleString()}</time><p>{item.snippet}</p></li>)}</ul>
        </section>
      )}
      {joined && (
        <ol className="chat-timeline" aria-label={`Messages in ${room.name}`}>
          {page?.gapBefore && <li className="chat-gap"><button className="button ghost small" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? 'Loading…' : 'Load older messages'}</button></li>}
          {page && !items.length && <li className="chat-gap"><p className="chat-hint">No messages kept locally yet.</p></li>}
          {items.map((item) => <ChatMessage key={item.id} item={item} room={room} chat={chat} run={run} onToast={onToast} onReply={() => { setReplyTo(item); setEditing(undefined) }} onEdit={() => { setEditing(item); setReplyTo(undefined); setDraft(item.body ?? '') }} reload={reload} />)}
        </ol>
      )}
      {joined && (
        <form className="chat-composer" aria-label="Message composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          {(replyTo || editing) && (
            <p className="chat-composer-context">{editing ? 'Editing your message' : <>Replying to <strong>{replyTo!.sender}</strong>: {replyTo!.body?.slice(0, 80) ?? ''}</>}
              <button className="text-button" type="button" aria-label="Cancel reply or edit" onClick={() => { setReplyTo(undefined); if (editing) setDraft(''); setEditing(undefined) }}><X size={12} /></button></p>
          )}
          <div className="chat-composer-row">
            <button className="text-button" type="button" aria-label={`Attach a file (up to ${ATTACHMENT_LIMIT_MIB} MiB)`} title={`Attach a file (up to ${ATTACHMENT_LIMIT_MIB} MiB, or less if the server allows less)`} disabled={Boolean(editing)}
              onClick={() => void run(() => chat.attach(room.accountId, room.roomId)).then((item) => { if (item) reload() })}><Paperclip size={16} /></button>
            <textarea aria-label="Message" rows={2} value={draft} placeholder={room.encrypted ? 'Encrypted message' : 'Message (not encrypted)'} onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} />
            <button className="button primary small" type="submit" aria-label={editing ? 'Save edit' : 'Send'} disabled={!draft.trim()}>{editing ? <Check size={14} /> : <Send size={14} />}</button>
          </div>
        </form>
      )}
    </div>
  )
}

function ChatMessage({ item, room, chat, run, onToast, onReply, onEdit, reload }: {
  item: ChatTimelineItem; room: ChatRoomSummary; chat: ChatDesktopApi; run: Run; onToast(message: string): void; onReply(): void; onEdit(): void; reload(): void
}) {
  if (item.kind === 'membership') return <li className="chat-membership"><small>{item.body ?? `${item.sender} changed their membership`}</small></li>
  const confirmed = Boolean(item.eventId)
  return (
    <li className={`chat-message ${item.own ? 'own' : ''}`}>
      <header><strong title={item.sender}>{item.own ? 'You' : item.sender}</strong><time dateTime={item.timestamp}>{time(item.timestamp)}</time>{item.edited && <small>(edited)</small>}{!item.encrypted && room.encrypted && <small className="chat-unencrypted">not encrypted</small>}</header>
      {item.replyTo && <blockquote>{item.replyTo.missing ? 'Replying to a message that is not loaded yet' : <><strong>{item.replyTo.sender}</strong> {item.replyTo.body}</>}</blockquote>}
      {item.kind === 'undecryptable' && <p className="chat-undecryptable"><Lock size={12} /> This message could not be decrypted: {item.decryptionError ?? 'the key is not available'}. Verify this device or restore from your recovery key; no text is guessed.</p>}
      {item.kind === 'redacted' && <p className="chat-hint">Message deleted</p>}
      {item.kind === 'unsupported' && <p className="chat-hint">This message type is not supported in Aerio.</p>}
      {(item.kind === 'text' || item.kind === 'notice' || item.kind === 'emote') && <p className={`chat-body ${item.kind}`}>{item.kind === 'emote' ? `* ${item.sender} ` : ''}{item.body}</p>}
      {item.kind === 'media' && item.media && (
        <p className="chat-media"><Paperclip size={13} /> <span>{item.media.name}</span> <small>{size(item.media.size)}{item.media.encrypted ? ' · encrypted' : ''}</small>
          {confirmed && <button className="button ghost small" onClick={() => void run(() => chat.saveMedia(room.accountId, item.media!.mediaId)).then((saved) => { if (saved) onToast('Attachment saved') })}><Download size={12} /> Save…</button>}</p>
      )}
      {item.reactions.length > 0 && <p className="chat-reactions">{item.reactions.map((reaction) => <span key={reaction.key} className={reaction.mine ? 'mine' : ''}>{reaction.key} {reaction.count}</span>)}</p>}
      {item.delivery && item.delivery !== 'sent' && (
        <p className={`chat-delivery ${item.delivery}`}>{DELIVERY_LABELS[item.delivery]}{item.deliveryError ? `: ${item.deliveryError}` : ''}
          {item.outboxId && (item.delivery === 'failed' || item.delivery === 'review') && <button className="text-button" onClick={() => void run(() => chat.retryOutgoing(item.outboxId!)).then(reload)}>{item.delivery === 'review' ? 'Send anyway' : 'Retry'}</button>}
          {item.outboxId && item.delivery !== 'running' && <button className="text-button" onClick={() => void run(() => chat.cancelOutgoing(item.outboxId!)).then(reload)}>Cancel</button>}
        </p>
      )}
      {confirmed && item.kind !== 'redacted' && (
        <div className="chat-message-actions">
          <button className="text-button" aria-label="Reply" onClick={onReply}><CornerUpLeft size={12} /></button>
          <button className="text-button" aria-label="React with thumbs up" onClick={() => void run(() => chat.react(room.accountId, room.roomId, item.eventId!, '👍')).then(reload)}><SmilePlus size={12} /></button>
          {item.own && item.kind === 'text' && <button className="text-button" aria-label="Edit" onClick={onEdit}><Pencil size={12} /></button>}
          {item.own && <button className="text-button" aria-label="Delete message" onClick={() => { if (window.confirm('Delete this message for everyone? Other devices may already have a copy.')) void run(() => chat.redact(room.accountId, room.roomId, item.eventId!)).then(reload) }}><Trash2 size={12} /></button>}
        </div>
      )}
    </li>
  )
}
