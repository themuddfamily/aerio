import { Archive, Copy, Download, Forward, Image, Inbox, LoaderCircle, Mail, MailOpen, Paperclip, Reply, ReplyAll, Star, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import ComposeModal from '../components/ComposeModal'
import GmailComposeModal from '../components/GmailComposeModal'
import TitleBar from '../components/TitleBar'
import ThreadMessageAccordion from '../components/ThreadMessageAccordion'
import { copyText, useContextMenu } from '../components/ContextMenu'
import { formatFileSize } from '../lib/domain'
import type { GmailAccountSummary, GmailAttachment, GmailMessageDetail, GmailThreadDetail, MailActionKind, PendingOperation } from '../gmail-types'
import type { AppState, Message } from '../types'

type MessageWindowSource =
  | { type: 'demo'; messageId: string }
  | { type: 'gmail'; accountId: string; threadId: string }

function windowSource(): MessageWindowSource | undefined {
  const params = new URLSearchParams(window.location.search)
  if (params.get('view') !== 'message') return
  if (params.get('source') === 'demo' && params.get('messageId')) return { type: 'demo', messageId: params.get('messageId')! }
  if (params.get('source') === 'gmail' && params.get('accountId') && params.get('threadId')) {
    return { type: 'gmail', accountId: params.get('accountId')!, threadId: params.get('threadId')! }
  }
}

function messageDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function MessageWindow() {
  const { showContextMenu } = useContextMenu()
  const source = useMemo(windowSource, [])
  const [state, setState] = useState<AppState>()
  const [demoMessage, setDemoMessage] = useState<Message>()
  const [accounts, setAccounts] = useState<GmailAccountSummary[]>([])
  const [thread, setThread] = useState<GmailThreadDetail>()
  const [expandedMessageId, setExpandedMessageId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [remoteImages, setRemoteImages] = useState(false)
  const [toast, setToast] = useState('')
  const [actionBusy, setActionBusy] = useState<MailActionKind>()
  const [pendingOperation, setPendingOperation] = useState<PendingOperation>()
  const [gmailCompose, setGmailCompose] = useState<{ reply: GmailThreadDetail; replyAll?: boolean; forward?: boolean }>()
  const [demoCompose, setDemoCompose] = useState<{ replyAll?: boolean; forward?: boolean }>()

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2_600)
  }

  useEffect(() => {
    if (!source) {
      setError('This message window request is invalid.')
      setLoading(false)
      return
    }
    void window.aerio.loadState().then(async (nextState) => {
      setState(nextState)
      document.documentElement.dataset.theme = nextState.settings.theme
      document.documentElement.dataset.density = nextState.settings.density
      if (source.type === 'demo') {
        const message = nextState.messages.find((item) => item.id === source.messageId)
        if (!message) throw new Error('This demo message no longer exists.')
        setDemoMessage(message)
        return
      }
      const [accountList, detail] = await Promise.all([
        window.aerio.mail.accounts.list(),
        window.aerio.mail.mail.thread(source.accountId, source.threadId)
      ])
      setAccounts(accountList)
      setThread(detail)
      setExpandedMessageId(detail.messages.at(-1)?.id)
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'The message could not be opened')).finally(() => setLoading(false))
  }, [source])

  const title = demoMessage?.subject ?? thread?.subject ?? 'Message'
  useEffect(() => { document.title = `${title} — Aerio` }, [title])

  const reloadGmailThread = useCallback(async (allowRemoteImages = remoteImages) => {
    if (source?.type !== 'gmail') return
    const detail = await window.aerio.mail.mail.thread(source.accountId, source.threadId, allowRemoteImages)
    setThread(detail)
    setExpandedMessageId((current) => current && detail.messages.some((message) => message.id === current) ? current : detail.messages.at(-1)?.id)
    return detail
  }, [remoteImages, source])

  useEffect(() => {
    if (source?.type !== 'gmail') return
    return window.aerio.mail.onEvent((event) => {
      if (event.type === 'accounts-changed') setAccounts(event.payload)
      if (event.type === 'mail-changed') void reloadGmailThread()
      if (event.type === 'operation' && pendingOperation?.id === event.payload.id) {
        if (event.payload.status === 'failed') showToast(event.payload.error ?? 'The mail provider rejected the change')
        if (event.payload.status === 'failed' || event.payload.status === 'succeeded') setPendingOperation(undefined)
      }
    })
  }, [pendingOperation?.id, reloadGmailThread, source])

  useEffect(() => {
    if (!pendingOperation?.undoUntil) return
    const delay = Math.max(0, new Date(pendingOperation.undoUntil).getTime() - Date.now())
    const timer = window.setTimeout(() => setPendingOperation(undefined), delay)
    return () => window.clearTimeout(timer)
  }, [pendingOperation])

  const gmailLabels = new Set(thread?.messages.flatMap((message) => message.labelIds) ?? [])
  const gmailAccount = source?.type === 'gmail' ? accounts.find((account) => account.id === source.accountId) : undefined
  const gmailReadOnly = Boolean(gmailAccount?.archived)
  const gmailUnread = gmailLabels.has('UNREAD')
  const gmailStarred = gmailLabels.has('STARRED')
  const gmailInInbox = gmailLabels.has('INBOX')
  const gmailTrashed = gmailLabels.has('TRASH')

  const applyGmailAction = async (action: MailActionKind) => {
    if (source?.type !== 'gmail' || gmailReadOnly || actionBusy) return
    setActionBusy(action)
    try {
      const operation = await window.aerio.mail.mail.action({ accountId: source.accountId, threadIds: [source.threadId], action })
      setPendingOperation(operation)
      await reloadGmailThread()
      const labels: Partial<Record<MailActionKind, string>> = {
        read: 'Conversation marked as read', unread: 'Conversation marked as unread',
        star: 'Star added', unstar: 'Star removed', archive: 'Conversation archived',
        unarchive: 'Conversation moved to Inbox', trash: 'Conversation moved to Trash',
        untrash: 'Conversation restored from Trash'
      }
      showToast(labels[action] ?? 'Conversation updated')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'The conversation could not be updated')
    } finally {
      setActionBusy(undefined)
    }
  }

  const undoGmailAction = async () => {
    if (!pendingOperation) return
    try {
      await window.aerio.mail.mail.undo(pendingOperation.id)
      setPendingOperation(undefined)
      await reloadGmailThread()
      showToast('Mail change undone')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'The mail change could not be undone')
    }
  }

  const replyThreadFor = (message: GmailMessageDetail) => {
    const index = thread?.messages.findIndex((item) => item.id === message.id) ?? -1
    return thread && index >= 0 ? { ...thread, messages: thread.messages.slice(0, index + 1) } : thread
  }

  const updateDemoState = (next: AppState) => {
    setState(next)
    if (source?.type === 'demo') setDemoMessage(next.messages.find((message) => message.id === source.messageId))
    void window.aerio.saveState(next).catch((reason) => showToast(reason instanceof Error ? reason.message : 'The message change could not be saved'))
  }

  const updateDemoMessage = (updates: Partial<Message>, confirmation: string) => {
    if (!state || !demoMessage) return
    const nextMessage = { ...demoMessage, ...updates }
    updateDemoState({ ...state, messages: state.messages.map((message) => message.id === demoMessage.id ? nextMessage : message) })
    showToast(confirmation)
  }

  const openAttachment = async (message: GmailMessageDetail, attachment: GmailAttachment) => {
    try {
      const result = await window.aerio.mail.attachments.open(message.accountId, message.id, attachment.id, attachment.filename)
      if (result.error) showToast(result.error)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'The attachment could not be opened')
    }
  }

  const saveAttachment = async (message: GmailMessageDetail, attachment: GmailAttachment) => {
    try {
      const result = await window.aerio.mail.attachments.save(message.accountId, message.id, attachment.id, attachment.filename)
      if (result.error) showToast(result.error)
      else if (result.savedPath) showToast(`Saved ${attachment.filename}`)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'The attachment could not be saved')
    }
  }

  const loadRemoteImages = async () => {
    if (source?.type !== 'gmail') return
    try {
      await reloadGmailThread(true)
      setRemoteImages(true)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Remote images could not be loaded')
    }
  }

  return (
    <div className="message-window-shell">
      <TitleBar title={title} />
      {!loading && demoMessage && state && <div className="message-window-toolbar" role="toolbar" aria-label="Message actions">
        <button className="button ghost small" onClick={() => setDemoCompose({})}><Reply size={15} /> Reply</button>
        <button className="button ghost small" onClick={() => setDemoCompose({ replyAll: true })}><ReplyAll size={15} /> Reply all</button>
        <button className="button ghost small" onClick={() => setDemoCompose({ forward: true })}><Forward size={15} /> Forward</button>
        <span className="toolbar-divider" />
        <button className="icon-button" aria-label={demoMessage.unread ? 'Mark as read' : 'Mark as unread'} title={demoMessage.unread ? 'Mark as read' : 'Mark as unread'} onClick={() => updateDemoMessage({ unread: !demoMessage.unread }, demoMessage.unread ? 'Message marked as read' : 'Message marked as unread')}>{demoMessage.unread ? <MailOpen size={17} /> : <Mail size={17} />}</button>
        <button className={`icon-button ${demoMessage.starred ? 'active' : ''}`} aria-label={demoMessage.starred ? 'Remove star' : 'Add star'} title={demoMessage.starred ? 'Remove star' : 'Add star'} onClick={() => updateDemoMessage({ starred: !demoMessage.starred }, demoMessage.starred ? 'Star removed' : 'Star added')}><Star size={17} fill={demoMessage.starred ? 'currentColor' : 'none'} /></button>
        <span className="spacer" />
        <button className="icon-button" aria-label={demoMessage.archived || demoMessage.trashed ? 'Move to inbox' : 'Archive'} title={demoMessage.archived || demoMessage.trashed ? 'Move to inbox' : 'Archive'} onClick={() => {
          const inboxId = state.folders.find((folder) => folder.accountId === demoMessage.accountId && folder.system === 'inbox')?.id ?? `${demoMessage.accountId}-inbox`
          updateDemoMessage(demoMessage.archived || demoMessage.trashed
            ? { archived: false, trashed: false, folderId: inboxId }
            : { archived: true, folderId: `${demoMessage.accountId}-archive` }, demoMessage.archived || demoMessage.trashed ? 'Message moved to Inbox' : 'Message archived')
        }}>{demoMessage.archived || demoMessage.trashed ? <Inbox size={17} /> : <Archive size={17} />}</button>
        <button className="icon-button danger" aria-label={demoMessage.trashed ? 'Restore from trash' : 'Move to trash'} title={demoMessage.trashed ? 'Restore from trash' : 'Move to trash'} onClick={() => updateDemoMessage(demoMessage.trashed
          ? { trashed: false, folderId: state.folders.find((folder) => folder.accountId === demoMessage.accountId && folder.system === 'inbox')?.id ?? `${demoMessage.accountId}-inbox` }
          : { trashed: true, folderId: `${demoMessage.accountId}-trash` }, demoMessage.trashed ? 'Message restored from Trash' : 'Message moved to Trash')}>{demoMessage.trashed ? <Undo2 size={17} /> : <Trash2 size={17} />}</button>
      </div>}
      {!loading && thread && source?.type === 'gmail' && <div className="message-window-toolbar" role="toolbar" aria-label="Conversation actions">
        <button className="button ghost small" disabled={gmailReadOnly} onClick={() => setGmailCompose({ reply: thread })}><Reply size={15} /> Reply</button>
        <button className="button ghost small" disabled={gmailReadOnly} onClick={() => setGmailCompose({ reply: thread, replyAll: true })}><ReplyAll size={15} /> Reply all</button>
        <button className="button ghost small" disabled={gmailReadOnly} onClick={() => setGmailCompose({ reply: thread, forward: true })}><Forward size={15} /> Forward</button>
        <span className="toolbar-divider" />
        <button className="icon-button" disabled={gmailReadOnly || Boolean(actionBusy)} aria-label={gmailUnread ? 'Mark as read' : 'Mark as unread'} title={gmailUnread ? 'Mark as read' : 'Mark as unread'} onClick={() => void applyGmailAction(gmailUnread ? 'read' : 'unread')}>{gmailUnread ? <MailOpen size={17} /> : <Mail size={17} />}</button>
        <button className={`icon-button ${gmailStarred ? 'active' : ''}`} disabled={gmailReadOnly || Boolean(actionBusy)} aria-label={gmailStarred ? 'Remove star' : 'Add star'} title={gmailStarred ? 'Remove star' : 'Add star'} onClick={() => void applyGmailAction(gmailStarred ? 'unstar' : 'star')}><Star size={17} fill={gmailStarred ? 'currentColor' : 'none'} /></button>
        <span className="spacer" />
        <button className="icon-button" disabled={gmailReadOnly || gmailTrashed || Boolean(actionBusy)} aria-label={gmailInInbox ? 'Archive' : 'Move to inbox'} title={gmailInInbox ? 'Archive' : 'Move to inbox'} onClick={() => void applyGmailAction(gmailInInbox ? 'archive' : 'unarchive')}>{gmailInInbox ? <Archive size={17} /> : <Inbox size={17} />}</button>
        <button className="icon-button danger" disabled={gmailReadOnly || Boolean(actionBusy)} aria-label={gmailTrashed ? 'Restore from trash' : 'Move to trash'} title={gmailTrashed ? 'Restore from trash' : 'Move to trash'} onClick={() => void applyGmailAction(gmailTrashed ? 'untrash' : 'trash')}>{gmailTrashed ? <Undo2 size={17} /> : <Trash2 size={17} />}</button>
      </div>}
      <main className="message-window-content">
        {loading && <div className="empty-state grow"><LoaderCircle className="spin" size={32} /><h3>Opening message…</h3></div>}
        {!loading && error && <div className="empty-state grow"><Inbox size={34} /><h3>Message unavailable</h3><p>{error}</p></div>}
        {!loading && demoMessage && state && (
          <article className="message-reader message-window-reader">
            <header>
              <div className="reader-labels">{demoMessage.labels.map((label) => <span key={label}>{label}</span>)}</div>
              <h2>{demoMessage.subject}</h2>
              <div className="sender-card">
                <span className="avatar large" style={{ background: state.contacts.find((contact) => contact.email === demoMessage.fromEmail)?.color ?? '#8892a6' }}>{demoMessage.from.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                <span><strong>{demoMessage.from}</strong><small>{demoMessage.fromEmail} · {messageDate(demoMessage.date)}</small></span>
              </div>
            </header>
            <div className="message-body" dangerouslySetInnerHTML={{ __html: demoMessage.body }} />
            {demoMessage.attachments.length > 0 && <div className="reader-attachments"><h3>{demoMessage.attachments.length} attachment{demoMessage.attachments.length === 1 ? '' : 's'}</h3>{demoMessage.attachments.map((attachment) => (
              <button className="attachment-card" key={attachment.id} onClick={() => showToast(`${attachment.name} is sample metadata; no local file is attached`)} onContextMenu={(event) => showContextMenu(event, [
                { label: 'Show attachment details', icon: Paperclip, action: () => showToast(`${attachment.name} · ${formatFileSize(attachment.size)}`) },
                { label: 'Copy filename', icon: Copy, action: () => copyText(attachment.name) }
              ], attachment.name)}><span className="file-icon">{attachment.name.split('.').pop()?.toUpperCase()}</span><span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span></button>
            ))}</div>}
          </article>
        )}
        {!loading && thread && (
          <article className="message-reader gmail-thread message-window-reader">
            <header><div className="message-window-heading"><h2>{thread.subject}</h2>{!remoteImages && <button className="button ghost small" onClick={() => void loadRemoteImages()}><Image size={15} /> Load remote images</button>}</div></header>
            {thread.messages.map((message) => <ThreadMessageAccordion key={message.id} message={message} expanded={expandedMessageId === message.id} dateLabel={messageDate(message.date)} onToggle={() => setExpandedMessageId((current) => current === message.id ? undefined : message.id)} onReply={gmailReadOnly ? undefined : () => { const reply = replyThreadFor(message); if (reply) setGmailCompose({ reply }) }}>
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id} onContextMenu={(event) => showContextMenu(event, [
                { label: 'Open attachment', icon: Download, action: () => openAttachment(message, attachment) },
                { label: 'Save as…', icon: Download, action: () => saveAttachment(message, attachment) },
                { label: 'Copy filename', icon: Copy, separatorBefore: true, action: () => copyText(attachment.filename) }
              ], attachment.filename)}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small></span><button className="icon-button" title="Open" onClick={() => void openAttachment(message, attachment)}><Download size={16} /></button><button className="button ghost small" onClick={() => void saveAttachment(message, attachment)}>Save as</button></div>)}</div>}
            </ThreadMessageAccordion>)}
          </article>
        )}
      </main>
      {pendingOperation && <div className="undo-toast"><span>Mail change queued</span><button onClick={() => void undoGmailAction()}><Undo2 size={15} /> Undo</button><button onClick={() => setPendingOperation(undefined)}>Dismiss</button></div>}
      {demoCompose && state && demoMessage && <ComposeModal state={state} replyTo={demoMessage} replyAll={demoCompose.replyAll} forward={demoCompose.forward} onChange={updateDemoState} onClose={() => setDemoCompose(undefined)} onToast={showToast} />}
      {gmailCompose && <GmailComposeModal accounts={accounts.filter((account) => !account.archived)} replyTo={gmailCompose.reply} replyAll={gmailCompose.replyAll} forward={gmailCompose.forward} onClose={() => setGmailCompose(undefined)} onSent={() => void reloadGmailThread()} onToast={showToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
