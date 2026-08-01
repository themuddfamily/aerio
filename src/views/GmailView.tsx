import {
  Archive, ChevronDown, Download, FileText, Image, Inbox, LoaderCircle, Mail, MailOpen,
  Paperclip, Pause, Play, Plus, RefreshCw, Reply, Search, Send, Settings2,
  Star, Tag, Trash2, Undo2, UserPlus, WifiOff
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GmailComposeModal from '../components/GmailComposeModal'
import MailAccountSetupModal from '../components/MailAccountSetupModal'
import type {
  GmailAccountSummary,
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
  composeRequest?: number
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

export default function GmailView({ onToast, composeRequest = 0 }: GmailViewProps) {
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
  const [compose, setCompose] = useState<{ reply?: GmailThreadDetail }>()
  const [pending, setPending] = useState<PendingOperation>()
  const [remoteImages, setRemoteImages] = useState(false)
  const [accountSetup, setAccountSetup] = useState(false)
  const handledComposeRequest = useRef(0)
  const selected = page.items.find((item) => `${item.accountId}:${item.id}` === selectedKey)
  const selectedAccount = accounts.find((item) => item.id === selected?.accountId)

  const refreshAccounts = useCallback(async () => {
    const next = await window.aerio.mail.accounts.list()
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
      const next = await window.aerio.mail.mail.list({
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
      window.aerio.mail.accounts.list(),
      window.aerio.mail.sync.progress()
    ]).then(([accountList, progress]) => {
      const visible = accountList
      setAccounts(visible)
      setSync(progress)
      return window.aerio.mail.mail.labels(visible.map((item) => item.id))
    }).then(setLabels).catch((error) => onToast(error instanceof Error ? error.message : 'Gmail could not start')).finally(() => setLoading(false))
  }, [onToast])

  useEffect(() => {
    const unsubscribe = window.aerio.mail.onEvent((event) => {
      if (event.type === 'accounts-changed') setAccounts(event.payload)
      if (event.type === 'sync-progress') setSync((items) => [...items.filter((item) => item.accountId !== event.payload.accountId), event.payload])
      if (event.type === 'mail-changed') void loadPage()
      if (event.type === 'operation' && event.payload.status === 'failed') onToast(event.payload.error ?? 'The mail provider rejected the change')
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
    void window.aerio.mail.mail.thread(selected.accountId, selected.id).then(setThread).catch((error) => onToast(error instanceof Error ? error.message : 'Conversation could not be opened'))
    if (selected.unread) void applyAction('read', selected.accountId, [selected.id], false)
    // The action helper is intentionally excluded: selecting a row is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  useEffect(() => {
    if (!composeRequest || handledComposeRequest.current === composeRequest) return
    handledComposeRequest.current = composeRequest
    if (accounts.some((account) => !account.archived)) setCompose({})
    else setAccountSetup(true)
  }, [accounts, composeRequest])

  async function applyAction(action: MailActionKind, targetAccount = selected?.accountId, threadIds = selected ? [selected.id] : [], showUndo = true) {
    if (!targetAccount || !threadIds.length) return
    try {
      const operation = await window.aerio.mail.mail.action({ accountId: targetAccount, threadIds, action })
      if (showUndo) setPending(operation)
      await loadPage()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The change could not be queued')
    }
  }

  const undo = async () => {
    if (!pending) return
    try {
      const restored = await window.aerio.mail.mail.undo(pending.id)
      if (restored) {
        onToast('Change undone')
        setPending(undefined)
        await loadPage()
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The change could not be undone')
    }
  }

  const loadRemoteImages = async () => {
    if (!selected) return
    try {
      setRemoteImages(true)
      setThread(await window.aerio.mail.mail.thread(selected.accountId, selected.id, true))
    } catch (error) {
      setRemoteImages(false)
      onToast(error instanceof Error ? error.message : 'Remote images could not be loaded')
    }
  }

  const addAccount = () => setAccountSetup(true)

  const toggleSync = async (account: GmailAccountSummary, paused: boolean) => {
    try {
      if (paused) await window.aerio.mail.sync.resume(account.id)
      else await window.aerio.mail.sync.pause(account.id)
    } catch (error) {
      onToast(error instanceof Error ? error.message : `Sync could not be ${paused ? 'resumed' : 'paused'}`)
    }
  }

  const accountConnected = async () => {
    const next = await refreshAccounts()
    setLabels(await window.aerio.mail.mail.labels(next.map((account) => account.id)))
  }

  const disconnect = async (account: GmailAccountSummary) => {
    const keep = window.confirm(`Disconnect ${account.email}?\n\nOK keeps its downloaded mail as a read-only archive. Cancel lets you choose whether to delete it.`)
    try {
      if (keep) {
        await window.aerio.mail.accounts.disconnect(account.id, 'archive')
      } else if (window.confirm(`Delete all downloaded mail for ${account.email}? The provider mailbox itself will not be changed.`)) {
        await window.aerio.mail.accounts.disconnect(account.id, 'delete')
      } else return
      await refreshAccounts()
      onToast('Account disconnected')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The account could not be disconnected')
    }
  }

  const showStorage = async () => {
    try {
      const stats = await window.aerio.mail.storage()
      onToast(`${formatFileSize(stats.totalBytes)} stored offline · ${formatFileSize(stats.freeBytes)} free`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Storage information is unavailable')
    }
  }

  if (!loading && accounts.length === 0) {
    return (
      <div className="gmail-onboarding">
        <section>
          <span className="gmail-mark"><Mail size={28} /></span>
          <p className="eyebrow">Aerio mail</p>
          <h1>Your inboxes, together and available offline.</h1>
          <p>Connect Gmail, Outlook, iCloud, Yahoo, Fastmail, Proton Bridge, or another IMAP/SMTP provider. Aerio protects credentials with Windows secure storage and blocks remote images until you load them.</p>
          <button className="button primary onboarding-connect" onClick={() => setAccountSetup(true)}><UserPlus size={16} /> Add your first account</button>
          <small>OAuth providers open sign-in in your browser. iCloud, Yahoo, and Fastmail use provider-issued app passwords.</small>
        </section>
        {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
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
        <button className="compose-button" disabled={!accounts.some((account) => !account.archived)} onClick={() => setCompose({})}><Plus size={18} /> New message</button>
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
          {accounts.map((account) => <button className={`sidebar-item gmail-account-row ${accountId === account.id ? 'active' : ''}`} key={account.id} onClick={() => setAccountId(account.id)} title={`${account.email} · ${account.provider}${account.archived ? ' · offline archive' : ''}`}><span className="account-dot" style={{ background: account.color }} /><span>{account.email}{account.archived ? ' · archive' : ''}<small className="provider-name">{account.provider}</small></span><i className={`account-state ${account.status}`} /></button>)}
          <button className="sidebar-item" onClick={addAccount}><UserPlus size={16} /><span>Add mail account</span></button>
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
          <button className="icon-button" title="Check for mail" onClick={() => void window.aerio.mail.sync.start(accountId === 'all' ? undefined : accountId).catch((error) => onToast(error instanceof Error ? error.message : 'Sync could not start'))}><RefreshCw size={17} /></button>
        </header>
        <div className="gmail-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search offline mail…" /><span>FTS</span></div>
        {activeProgress.map((item) => {
          const account = accounts.find((entry) => entry.id === item.accountId)
          const percent = item.total ? Math.round(item.completed / item.total * 100) : 0
          return <div className="sync-strip" key={item.accountId}><span><strong>{account?.email ?? 'Mail'}</strong><small>{item.message ?? item.phase} · {item.completed.toLocaleString()}/{item.total.toLocaleString()}</small></span><progress max={Math.max(item.total, 1)} value={item.completed} /><button className="icon-button" disabled={!account} aria-label={item.phase === 'paused' ? 'Resume sync' : 'Pause sync'} onClick={() => account && void toggleSync(account, item.phase === 'paused')}>{item.phase === 'paused' ? <Play size={14} /> : <Pause size={14} />}</button><em>{percent}%</em></div>
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
          </div>
          <article className="message-reader gmail-thread">
            <header><div className="reader-labels">{selected.labelIds.filter((label) => !['INBOX', 'UNREAD'].includes(label)).slice(0, 5).map((label) => <span key={label}>{label}</span>)}</div><h2>{thread.subject}</h2></header>
            {thread.messages.map((message) => <section className="gmail-message" key={message.id}>
              <header className="sender-card"><span className="avatar large">{(message.fromName || message.fromEmail).split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span><span><strong>{message.fromName || message.fromEmail}</strong><small>{message.fromEmail} · {new Date(message.date).toLocaleString()}</small></span><span className="spacer" />{!selectedAccount?.archived && <button className="button ghost small" onClick={() => setCompose({ reply: thread })}><Reply size={15} /> Reply</button>}</header>
              {message.sanitizedHtml ? <div className="message-body gmail-html" dangerouslySetInnerHTML={{ __html: message.sanitizedHtml }} /> : <div className="message-body gmail-text">{message.text}</div>}
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small></span><button className="icon-button" title="Open" onClick={() => void window.aerio.mail.attachments.open(message.accountId, message.id, attachment.id, attachment.filename).then((result) => { if (result.error) onToast(result.error) }).catch((error) => onToast(error instanceof Error ? error.message : 'Attachment could not be opened'))}><Download size={16} /></button><button className="button ghost small" onClick={() => void window.aerio.mail.attachments.save(message.accountId, message.id, attachment.id, attachment.filename).then((result) => { if (result.savedPath) onToast(`Saved ${attachment.filename}`) }).catch((error) => onToast(error instanceof Error ? error.message : 'Attachment could not be saved'))}>Save as</button></div>)}</div>}
            </section>)}
            {!selectedAccount?.archived && <div className="quick-actions"><button className="button ghost" onClick={() => setCompose({ reply: thread })}><Reply size={16} /> Reply</button></div>}
          </article>
        </> : <div className="empty-state grow">{accounts.some((item) => item.status === 'syncing') ? <><LoaderCircle className="spin" size={34} /><h3>Downloading your mailbox</h3><p>Conversations appear here as soon as they are available.</p></> : <><Inbox size={34} /><h3>Select a conversation</h3><p>Choose a conversation to read it here.</p></>}</div>}
      </section>

      {pending && <div className="undo-toast"><span>Mail change queued</span><button onClick={() => void undo()}><Undo2 size={15} /> Undo</button><button onClick={() => setPending(undefined)}>Dismiss</button></div>}
      {compose && <GmailComposeModal accounts={accounts.filter((account) => !account.archived)} replyTo={compose.reply} onClose={() => setCompose(undefined)} onSent={() => void loadPage()} onToast={onToast} />}
      {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
    </div>
  )
}
