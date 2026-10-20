import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProviderChatAccount, ProviderChatApi, ProviderChatId, ProviderChatPage, ProviderChatSnapshot } from '../provider-chat-types'
import './ProviderChatWorkspace.css'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export default function ProviderChatWorkspace({ api, snapshot, openRequest, matrix, matrixDetail, matrixOpenId, onToast }: {
  api: ProviderChatApi; snapshot: ProviderChatSnapshot; openRequest?: { accountId: string; roomId: string }
  matrix?: ReactNode; matrixDetail?: string; matrixOpenId?: number; onToast(message: string): void
}) {
  const [matrixActive, setMatrixActive] = useState(false)
  const [selected, setSelected] = useState<{ accountId: string; roomId: string }>()
  const [provider, setProvider] = useState<ProviderChatId>('teams')
  const [fields, setFields] = useState<Record<string, string | boolean>>({})
  const [reconnect, setReconnect] = useState<ProviderChatAccount>()
  const [connecting, setConnecting] = useState(false)
  const [body, setBody] = useState('')
  const [threadId, setThreadId] = useState<string>()
  const [page, setPage] = useState<ProviderChatPage>({ items: [] })
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const route = JSON.stringify([selected?.accountId, selected?.roomId, threadId])
  const currentRoute = useRef(route)
  currentRoute.current = route
  useEffect(() => { if (matrixOpenId) setMatrixActive(true) }, [matrixOpenId])
  useEffect(() => { if (openRequest) { setSelected(openRequest); setMatrixActive(false) } }, [openRequest])
  const room = selected && snapshot.rooms.find((item) => item.accountId === selected.accountId && item.id === selected.roomId)
  const account = selected && snapshot.accounts.find((item) => item.id === selected.accountId)
  const descriptor = snapshot.providers.find((item) => item.id === provider) ?? snapshot.providers[0]
  useEffect(() => { setPage({ items: [] }); setBody(''); setThreadId(undefined); setError(''); setBusy(false) }, [selected?.accountId, selected?.roomId])
  useEffect(() => api.onEvent((event) => { if (event.type === 'messages' && selected?.accountId === event.accountId && selected?.roomId === event.roomId) setRevision((value) => value + 1) }), [api, selected?.accountId, selected?.roomId])
  useEffect(() => {
    if (!room || matrixActive) return
    let live = true
    void api.messages(room.accountId, room.id, { threadId }).then((next) => { if (live) { setPage(next); if (next.error) setError(next.error) } }).catch((reason) => { if (live) setError(errorText(reason)) })
    const timer = setInterval(() => setRevision((value) => value + 1), 30_000)
    return () => { live = false; clearInterval(timer) }
  }, [api, room?.accountId, room?.id, threadId, revision, matrixActive])
  const run = async (action: () => Promise<unknown>) => { try { await action() } catch (reason) { onToast(errorText(reason)) } }
  return <div className="provider-chat-shell">
    <nav className="provider-chat-tabs" aria-label="Chat workspaces"><button className="button ghost" aria-pressed={!matrixActive} onClick={() => setMatrixActive(false)}>Connected chat providers</button>{matrix && <button className="button ghost" aria-pressed={matrixActive} onClick={() => setMatrixActive(true)}>Matrix</button>}</nav>
    {matrixActive && matrix ? matrix : <div className="workspace provider-chat-workspace">
      <aside className="context-sidebar">
        <h2>Chat accounts</h2>
        {!snapshot.available && <p role="alert">{snapshot.detail}</p>}
        {snapshot.accounts.map((item) => <section className="sidebar-group" key={item.id}>
          <strong>{item.name}</strong><small>{snapshot.providers.find((candidate) => candidate.id === item.provider)?.name} · {item.status}</small>
          {item.error && <p role="status">{item.error}</p>}
          <div className="provider-chat-account-actions"><button className="text-button" onClick={() => void run(() => api.refresh(item.id))}>Refresh</button><button className="text-button" onClick={() => { setProvider(item.provider); setReconnect(item); setFields({}) }}>Reconnect</button><button className="text-button" onClick={() => { if (window.confirm('Remove this chat connection and its local history?')) void run(() => api.remove(item.id)) }}>Remove</button></div>
          <label className="check-label"><input type="checkbox" checked={item.notificationPreviews} onChange={(event) => void run(() => api.preferences(item.id, event.target.checked))} />Notification room names</label>
          {snapshot.rooms.filter((candidate) => candidate.accountId === item.id).map((candidate) => <button className={`sidebar-item ${room?.id === candidate.id && room.accountId === item.id ? 'active' : ''}`} key={candidate.id} onClick={() => setSelected({ accountId: item.id, roomId: candidate.id })}><span>{candidate.name}</span>{candidate.unread > 0 && <em aria-label="Unread activity">●</em>}</button>)}
        </section>)}
        <form className="form-stack provider-chat-connect" onSubmit={(event) => {
          event.preventDefault(); if (!descriptor) return
          setConnecting(true); setError('')
          void api.connect(descriptor.id, fields, reconnect?.id).then(() => { setReconnect(undefined); setFields({}); onToast('Chat account connected') }).catch((reason) => setError(errorText(reason))).finally(() => setConnecting(false))
        }}>
          <h3>{reconnect ? `Reconnect ${reconnect.name}` : 'Connect chat'}</h3>
          <label className="field-label">Provider<select value={descriptor?.id ?? ''} disabled={connecting || Boolean(reconnect)} onChange={(event) => { setProvider(event.target.value as ProviderChatId); setFields({}) }}>{snapshot.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {descriptor && <p className="provider-source-note">{descriptor.detail}</p>}
          {descriptor?.fields.map((field) => field.type === 'checkbox' ? <label className="check-label" key={field.key}><input type="checkbox" checked={fields[field.key] === true} disabled={connecting} onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.checked }))} />{field.label}</label> : <label className="field-label" key={field.key}>{field.label}<input type={field.type} required={field.required} value={String(fields[field.key] ?? '')} disabled={connecting} autoComplete="off" onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}
          <button className="button primary" disabled={!snapshot.available || !descriptor?.available || connecting}>{connecting ? 'Connecting…' : reconnect ? 'Reconnect account' : 'Connect account'}</button>
          {reconnect && <button type="button" className="button ghost" onClick={() => { setReconnect(undefined); setFields({}) }}>Cancel reconnect</button>}
        </form>
        {!matrix && matrixDetail && <p className="provider-source-note">Matrix: {matrixDetail}</p>}
      </aside>
      <section className="module-panel provider-chat-conversation">
        {room && account ? <>
          <header className="module-header"><div><h1>{room.name}</h1><p>{account.name} · {room.kind} · provider-managed encryption</p></div><div><button className="button ghost" onClick={() => setRevision((value) => value + 1)}>Refresh messages</button>{room.canReadReceipt && <button className="button ghost" onClick={() => void run(() => api.markRead(account.id, room.id))}>Mark read on server</button>}</div></header>
          {threadId && <p><button className="text-button" onClick={() => { setThreadId(undefined); setPage({ items: [] }) }}>Back to channel posts</button> · Channel replies</p>}
          <div className="provider-chat-messages" aria-label="Chat messages">
            {page.cursor && <button className="button ghost" disabled={busy} onClick={() => { const requestRoute = route; setBusy(true); void api.messages(account.id, room.id, { cursor: page.cursor, threadId }).then((older) => { if (currentRoute.current === requestRoute) setPage((current) => ({ ...older, items: [...new Map([...older.items, ...current.items].map((item) => [item.id, item])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) })) }).catch((reason) => { if (currentRoute.current === requestRoute) setError(errorText(reason)) }).finally(() => { if (currentRoute.current === requestRoute) setBusy(false) }) }}>Load more messages</button>}
            {page.stale && <p role="status">Cached messages — update unavailable.</p>}
            {page.items.map((message) => <article className={message.own ? 'provider-chat-message own' : 'provider-chat-message'} key={message.id}><header><strong>{message.sender}</strong><time>{new Date(message.timestamp).toLocaleString()}</time></header><p>{message.body}</p>{message.delivery && <small>{message.delivery === 'review' ? 'Delivery uncertain — check the provider before sending again' : message.delivery}</small>}{message.error && <p role="alert">{message.error}</p>}{room.threaded && !threadId && !message.delivery && <button className="text-button" onClick={() => { setThreadId(message.id); setPage({ items: [] }) }}>Open replies</button>}</article>)}
            {!page.items.length && <p>No messages loaded.</p>}
          </div>
          <form className="provider-chat-composer" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(''); const currentBody = body, requestRoute = route; void api.send(account.id, room.id, currentBody, threadId).then(() => { if (currentRoute.current === requestRoute) { setBody(''); setRevision((value) => value + 1) } }).catch((reason) => { if (currentRoute.current === requestRoute) { setError(errorText(reason)); setRevision((value) => value + 1) } }).finally(() => { if (currentRoute.current === requestRoute) setBusy(false) }) }}><label className="field-label">{threadId ? 'Reply' : 'Message'}<textarea value={body} maxLength={28_000} disabled={busy || !room.canSend} onChange={(event) => setBody(event.target.value)} /></label><button className="button primary" disabled={busy || !room.canSend || !body.trim()}>{busy ? 'Sending…' : 'Send'}</button></form>
        </> : <div className="empty-state"><h1>Connected chat providers</h1><p>Connect an account and choose a conversation. Provider permissions and encryption are separate from Matrix.</p>{snapshot.detail && <p>{snapshot.detail}</p>}</div>}
        {error && <p className="provider-chat-error" role="alert">{error}</p>}
      </section>
    </div>}
  </div>
}
