import {
  Archive, ChevronDown, Download, FileText, Image, Inbox, LoaderCircle, Mail, MailOpen,
  MoreHorizontal, Paperclip, Pause, Play, Plus, RefreshCw, Reply, Search, Send, Settings2,
  Star, Tag, Trash2, Undo2, UserPlus, WifiOff
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import GmailComposeModal from '../components/GmailComposeModal'
import type {
  GmailAccountSummary,
  GmailCredentialStatus,
  GmailLabel,
  GmailThreadDetail,
  MailActionKind,
  MailPage,
  MailQuery,
  PendingOperation,
  SyncProgress
} from '../gmail-types'
import { formatFileSize } from '../lib/domain'

interface GmailViewProps {
  onToast(message: string): void
}

const emptyPage: MailPage = { items: [], total: 0 }
const folderNames: Record<NonNullable<MailQuery['folder']>, string> = {
  inbox: 'Inbox', starred: 'Starred', important: 'Important', sent: 'Sent',
  drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash', all: 'All mail'
}

function shortDate(date: string) {
  const value = new Date(date)
  const today = new Date()
  return value.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(value)
    : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(value)
}

export default function GmailView({ onToast }: GmailViewProps) {
  const [credentials, setCredentials] = useState<GmailCredentialStatus>({ configured: false })
  const [accounts, setAccounts] = useState<GmailAccountSummary[]>([])
  const [labels, setLabels] = useState<GmailLabel[]>([])
  const [page, setPage] = useState<MailPage>(emptyPage)
  const [history, setHistory] = useState<(string | undefined)[]>([])
  const [folder, setFolder] = useState<NonNullable<MailQuery['folder']>>('inbox')
  const [labelId, setLabelId] = useState<string>()
  const [accountId, setAccountId] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [thread, setThread] = useState<GmailThreadDetail>()
  const [sync, setSync] = useState<SyncProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [compose, setCompose] = useState<{ reply?: GmailThreadDetail }>()
  const [pending, setPending] = useState<PendingOperation>()
  const [remoteImages, setRemoteImages] = useState(false)
  const selected = page.items.find((item) => `${item.accountId}:${item.id}` === selectedKey)
  const selectedAccount = accounts.find((item) => item.id === selected?.accountId)

  const refreshAccounts = useCallback(async () => {
    const next = await window.aerio.gmail.accounts.list()
    setAccounts(next)
    return next
  }, [])

  const loadPage = useCallback(async (cursor?: string) => {
    if (!accounts.length) {
      setPage(emptyPage)
      return
    }
    setLoading(true)
    try {
      const next = await window.aerio.gmail.mail.list({
        folder,
        accountIds: accountId === 'all' ? undefined : [accountId],
        labelId,
        search: search.trim() || undefined,
        cursor,
        pageSize: 50
      })
      setPage(next)
      setSelectedKey((current) => current && next.items.some((item) => `${item.accountId}:${item.id}` === current)
        ? current
        : next.items[0] ? `${next.items[0].accountId}:${next.items[0].id}` : '')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Mail could not be loaded')
    } finally {
      setLoading(false)
    }
  }, [accountId, accounts.length, folder, labelId, onToast, search])

  useEffect(() => {
    void Promise.all([
      window.aerio.gmail.credentials.status(),
      window.aerio.gmail.accounts.list(),
      window.aerio.gmail.sync.progress()
    ]).then(([credentialStatus, accountList, progress]) => {
      const visible = accountList
      setCredentials(credentialStatus)
      setAccounts(visible)
      setSync(progress)
      return window.aerio.gmail.mail.labels(visible.map((item) => item.id))
    }).then(setLabels).catch((error) => onToast(error instanceof Error ? error.message : 'Gmail could not start')).finally(() => setLoading(false))
  }, [onToast])

  useEffect(() => {
    const unsubscribe = window.aerio.gmail.onEvent((event) => {
      if (event.type === 'accounts-changed') setAccounts(event.payload)
      if (event.type === 'sync-progress') setSync((items) => [...items.filter((item) => item.accountId !== event.payload.accountId), event.payload])
      if (event.type === 'mail-changed') void loadPage()
      if (event.type === 'operation' && event.payload.status === 'failed') onToast(event.payload.error ?? 'Gmail rejected the change')
      if (event.type === 'operation' && event.payload.id === pending?.id && event.payload.status === 'succeeded') setPending(undefined)
      if (event.type === 'connectivity' && !event.payload.online) onToast('Offline — changes will be sent when you reconnect')
    })
    return unsubscribe
  }, [loadPage, onToast, pending?.id])

  useEffect(() => {
    if (!pending?.undoUntil) return
    const delay = Math.max(0, new Date(pending.undoUntil).getTime() - Date.now())
    const timer = setTimeout(() => setPending(undefined), delay)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    setHistory([])
    void loadPage()
  }, [loadPage])

  useEffect(() => {
    if (!selected) {
      setThread(undefined)
      return
    }
    setRemoteImages(false)
    void window.aerio.gmail.mail.thread(selected.accountId, selected.id).then(setThread).catch((error) => onToast(error instanceof Error ? error.message : 'Conversation could not be opened'))
    if (selected.unread) void applyAction('read', selected.accountId, [selected.id], false)
    // The action helper is intentionally excluded: selecting a row is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const importCredentials = async () => {
    try {
      setCredentials(await window.aerio.gmail.credentials.import())
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Credentials could not be imported')
    }
  }

  const connect = async () => {
    setConnecting(true)
    try {
      await window.aerio.gmail.accounts.connect()
      await refreshAccounts()
      onToast('Google account connected — offline sync has started')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Google account could not be connected')
    } finally {
      setConnecting(false)
    }
  }

  async function applyAction(action: MailActionKind, targetAccount = selected?.accountId, threadIds = selected ? [selected.id] : [], showUndo = true) {
    if (!targetAccount || !threadIds.length) return
    try {
      const operation = await window.aerio.gmail.mail.action({ accountId: targetAccount, threadIds, action })
      if (showUndo) setPending(operation)
      await loadPage()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The change could not be queued')
    }
  }

  const undo = async () => {
    if (!pending) return
    const restored = await window.aerio.gmail.mail.undo(pending.id)
    if (restored) {
      onToast('Change undone')
      setPending(undefined)
      await loadPage()
    }
  }

  const loadRemoteImages = async () => {
    if (!selected) return
    setRemoteImages(true)
    setThread(await window.aerio.gmail.mail.thread(selected.accountId, selected.id, true))
  }

  const addAccount = async () => {
    if (!credentials.configured) {
      onToast('Import your Google Desktop OAuth credentials first')
      return
    }
    await connect()
  }

  const disconnect = async (account: GmailAccountSummary) => {
    const keep = window.confirm(`Disconnect ${account.email}?\n\nOK keeps its downloaded mail as a read-only archive. Cancel lets you choose whether to delete it.`)
    if (keep) {
      await window.aerio.gmail.accounts.disconnect(account.id, 'archive')
    } else if (window.confirm(`Delete all downloaded mail for ${account.email}? Gmail itself will not be changed.`)) {
      await window.aerio.gmail.accounts.disconnect(account.id, 'delete')
    } else return
    await refreshAccounts()
    onToast('Account disconnected')
  }

  const showStorage = async () => {
    const stats = await window.aerio.gmail.storage()
    onToast(`${formatFileSize(stats.totalBytes)} stored offline · ${formatFileSize(stats.freeBytes)} free`)
  }

  if (!loading && accounts.length === 0) {
    return (
      <div className="gmail-onboarding">
        <section>
          <span className="gmail-mark"><Mail size={28} /></span>
          <p className="eyebrow">Aerio Gmail alpha</p>
          <h1>Your real inbox, stored locally.</h1>
          <p>Aerio downloads your Gmail messages and attachments for offline use. OAuth tokens are protected by Windows secure storage, and remote images stay blocked until you choose to load them.</p>
          <ol>
            <li className={credentials.configured ? 'done' : ''}><strong>Import Google Desktop OAuth JSON</strong><span>Create a Desktop app credential in Google Cloud, then select the downloaded JSON file.</span><button className="button ghost" onClick={() => void importCredentials()}>{credentials.configured ? 'Replace credentials' : 'Import JSON'}</button></li>
            <li className={accounts.length ? 'done' : ''}><strong>Connect a Google account</strong><span>Your browser handles sign-in. Aerio requests Gmail modify access and never sees your password.</span><button className="button primary" disabled={!credentials.configured || connecting} onClick={() => void connect()}>{connecting ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}{connecting ? 'Waiting for Google…' : 'Connect Gmail'}</button></li>
            <li><strong>Let the first sync run</strong><span>A 100,000-message mailbox can take seven hours or more because Aerio stays within Gmail’s per-user quota. You can pause and resume at any time.</span></li>
          </ol>
          <small>Use an OAuth consent screen set to “In production” for personal use; Google Testing-mode refresh tokens expire after seven days.</small>
        </section>
      </div>
    )
  }

  const activeProgress = sync.filter((item) => item.phase !== 'complete' && item.phase !== 'idle')
  const visibleLabels = labels.filter((label) => label.type === 'user' && (accountId === 'all' || label.accountId === accountId)).slice(0, 12)
  const folderButton = (value: typeof folder, icon: React.ReactNode) => (
    <button className={`sidebar-item ${folder === value && !labelId ? 'active' : ''}`} onClick={() => { setLabelId(undefined); setFolder(value) }}>{icon}<span>{folderNames[value]}</span></button>
  )

  return (
    <div className="workspace mail-workspace real-mail">
      <aside className="context-sidebar">
        <button className="compose-button" disabled={!accounts.some((account) => !account.archived)} onClick={() => setCompose({})}><Plus size={18} /> New Gmail message</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Mailboxes</span>
          {folderButton('inbox', <Inbox size={17} />)}
          {folderButton('starred', <Star size={17} />)}
          {folderButton('important', <Tag size={17} />)}
          {folderButton('drafts', <FileText size={17} />)}
          {folderButton('sent', <Send size={17} />)}
          {folderButton('archive', <Archive size={17} />)}
          {folderButton('spam', <WifiOff size={17} />)}
          {folderButton('trash', <Trash2 size={17} />)}
          {folderButton('all', <Mail size={17} />)}
        </div>
        <div className="sidebar-group">
          <span className="sidebar-label">Accounts</span>
          <button className={`sidebar-item ${accountId === 'all' ? 'active' : ''}`} onClick={() => setAccountId('all')}><span className="account-dot multi" /><span>All accounts</span></button>
          {accounts.map((account) => <button className={`sidebar-item gmail-account-row ${accountId === account.id ? 'active' : ''}`} key={account.id} onClick={() => setAccountId(account.id)} title={`${account.email}${account.archived ? ' · offline archive' : ''}`}><span className="account-dot" style={{ background: account.color }} /><span>{account.email}{account.archived ? ' · archive' : ''}</span><i className={`account-state ${account.status}`} /></button>)}
          <button className="sidebar-item" onClick={() => void addAccount()}><UserPlus size={16} /><span>Add Google account</span></button>
        </div>
          {visibleLabels.length > 0 && <div className="sidebar-group"><span className="sidebar-label">Labels</span>{visibleLabels.map((label) => <button className={`sidebar-item ${labelId === label.id && accountId === label.accountId ? 'active' : ''}`} key={`${label.accountId}:${label.id}`} onClick={() => { setAccountId(label.accountId); setLabelId(label.id); setFolder('all') }}><Tag size={15} /><span>{label.name}</span></button>)}</div>}
        <div className="gmail-sidebar-footer">
          <button onClick={() => void showStorage()}><Download size={14} /> Offline storage</button>
          {accounts.filter((account) => !account.archived).map((account) => <button key={account.id} title={`Disconnect ${account.email}`} onClick={() => void disconnect(account)}><Settings2 size={14} /> {account.email.split('@')[0]}</button>)}
        </div>
      </aside>

      <section className="mail-list-panel">
        <header className="panel-heading">
          <div><h1>{labels.find((label) => label.id === labelId && label.accountId === accountId)?.name ?? folderNames[folder]}</h1><p>{page.total.toLocaleString()} conversations</p></div>
          <button className="icon-button" title="Check for mail" onClick={() => void window.aerio.gmail.sync.start(accountId === 'all' ? undefined : accountId)}><RefreshCw size={17} /></button>
        </header>
        <div className="gmail-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search offline mail…" /><span>FTS</span></div>
        {activeProgress.map((item) => {
          const account = accounts.find((entry) => entry.id === item.accountId)
          const percent = item.total ? Math.round(item.completed / item.total * 100) : 0
          return <div className="sync-strip" key={item.accountId}><span><strong>{account?.email ?? 'Gmail'}</strong><small>{item.message ?? item.phase} · {item.completed.toLocaleString()}/{item.total.toLocaleString()}</small></span><progress max={Math.max(item.total, 1)} value={item.completed} /><button className="icon-button" onClick={() => void (item.phase === 'paused' ? window.aerio.gmail.sync.resume(item.accountId) : window.aerio.gmail.sync.pause(item.accountId))}>{item.phase === 'paused' ? <Play size={14} /> : <Pause size={14} />}</button><em>{percent}%</em></div>
        })}
        <div className="message-list">
          {page.items.map((item) => (
            <button key={`${item.accountId}:${item.id}`} className={`message-row ${selectedKey === `${item.accountId}:${item.id}` ? 'selected' : ''} ${item.unread ? 'unread' : ''}`} onClick={() => setSelectedKey(`${item.accountId}:${item.id}`)}>
              <span className="avatar" style={{ background: accounts.find((account) => account.id === item.accountId)?.color }}>{item.participants[0]?.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || '?'}</span>
              <span className="message-copy">
                <span className="message-meta"><strong>{item.participants.join(', ') || 'Unknown sender'}</strong><time>{shortDate(item.lastDate)}</time></span>
                <span className="message-subject">{item.subject}</span>
                <span className="message-preview">{item.snippet}</span>
                <span className="message-tags">{item.messageCount > 1 && <em>{item.messageCount} messages</em>}{item.hasAttachments && <Paperclip size={13} />}</span>
              </span>
              <span className="row-flags">{item.starred && <Star size={13} fill="currentColor" />}</span>
            </button>
          ))}
          {!loading && !page.items.length && <div className="empty-state"><Search size={28} /><h3>No conversations here</h3><p>Try another mailbox or search.</p></div>}
          {loading && <div className="empty-state"><LoaderCircle className="spin" size={28} /><p>Loading local mail…</p></div>}
        </div>
        <footer className="gmail-pagination"><button className="button ghost small" disabled={!history.length} onClick={() => { const prior = history.slice(0, -1); setHistory(prior); void loadPage(prior.at(-1)) }}>Previous</button><button className="button ghost small" disabled={!page.nextCursor} onClick={() => { setHistory((items) => [...items, page.nextCursor]); void loadPage(page.nextCursor) }}>Next</button></footer>
      </section>

      <section className="reader-panel">
        {selected && thread ? <>
          <div className="reader-toolbar">
            <button className="icon-button" disabled={selectedAccount?.archived} title={selected.unread ? 'Mark read' : 'Mark unread'} onClick={() => void applyAction(selected.unread ? 'read' : 'unread')}>{selected.unread ? <MailOpen size={18} /> : <Mail size={18} />}</button>
            <button className="icon-button" disabled={selectedAccount?.archived} title="Archive" onClick={() => void applyAction('archive')}><Archive size={18} /></button>
            <button className="icon-button" disabled={selectedAccount?.archived} title="Move to Trash" onClick={() => void applyAction('trash')}><Trash2 size={18} /></button>
            <span className="toolbar-divider" />
            <button className={`icon-button ${selected.starred ? 'active' : ''}`} disabled={selectedAccount?.archived} title="Star" onClick={() => void applyAction(selected.starred ? 'unstar' : 'star')}><Star size={18} fill={selected.starred ? 'currentColor' : 'none'} /></button>
            <span className="spacer" />
            {!remoteImages && <button className="button ghost small" onClick={() => void loadRemoteImages()}><Image size={15} /> Load remote images</button>}
            <button className="icon-button" title="More"><MoreHorizontal size={19} /></button>
          </div>
          <article className="message-reader gmail-thread">
            <header><div className="reader-labels">{selected.labelIds.filter((label) => !['INBOX', 'UNREAD'].includes(label)).slice(0, 5).map((label) => <span key={label}>{label}</span>)}</div><h2>{thread.subject}</h2></header>
            {thread.messages.map((message) => <section className="gmail-message" key={message.id}>
              <header className="sender-card"><span className="avatar large">{(message.fromName || message.fromEmail).split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span><span><strong>{message.fromName || message.fromEmail}</strong><small>{message.fromEmail} · {new Date(message.date).toLocaleString()}</small></span><span className="spacer" />{!selectedAccount?.archived && <button className="button ghost small" onClick={() => setCompose({ reply: thread })}><Reply size={15} /> Reply</button>}</header>
              {message.sanitizedHtml ? <div className="message-body gmail-html" dangerouslySetInnerHTML={{ __html: message.sanitizedHtml }} /> : <div className="message-body gmail-text">{message.text}</div>}
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small></span><button className="icon-button" title="Open" onClick={() => void window.aerio.gmail.attachments.open(message.accountId, message.id, attachment.id, attachment.filename)}><Download size={16} /></button><button className="button ghost small" onClick={() => void window.aerio.gmail.attachments.save(message.accountId, message.id, attachment.id, attachment.filename)}>Save as</button></div>)}</div>}
            </section>)}
            {!selectedAccount?.archived && <div className="quick-actions"><button className="button ghost" onClick={() => setCompose({ reply: thread })}><Reply size={16} /> Reply</button></div>}
          </article>
        </> : <div className="empty-state grow">{accounts.some((item) => item.status === 'syncing') ? <><LoaderCircle className="spin" size={34} /><h3>Downloading your mailbox</h3><p>Conversations appear here as soon as they are available.</p></> : <><Inbox size={34} /><h3>Select a conversation</h3><p>Choose a conversation to read it here.</p></>}</div>}
      </section>

      {pending && <div className="undo-toast"><span>Change queued for Gmail</span><button onClick={() => void undo()}><Undo2 size={15} /> Undo</button><button onClick={() => setPending(undefined)}>Dismiss</button></div>}
      {compose && <GmailComposeModal accounts={accounts.filter((account) => !account.archived)} replyTo={compose.reply} onClose={() => setCompose(undefined)} onSent={() => void loadPage()} onToast={onToast} />}
    </div>
  )
}
