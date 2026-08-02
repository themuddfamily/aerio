import { Copy, Download, Image, Inbox, LoaderCircle, Paperclip } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import TitleBar from '../components/TitleBar'
import SenderAvatar from '../components/SenderAvatar'
import { copyText, useContextMenu } from '../components/ContextMenu'
import { formatFileSize } from '../lib/domain'
import type { GmailAttachment, GmailMessageDetail, GmailThreadDetail } from '../gmail-types'
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
  const [thread, setThread] = useState<GmailThreadDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [remoteImages, setRemoteImages] = useState(false)
  const [toast, setToast] = useState('')

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
      setThread(await window.aerio.mail.mail.thread(source.accountId, source.threadId))
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'The message could not be opened')).finally(() => setLoading(false))
  }, [source])

  const title = demoMessage?.subject ?? thread?.subject ?? 'Message'
  useEffect(() => { document.title = `${title} — Aerio` }, [title])

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
      setThread(await window.aerio.mail.mail.thread(source.accountId, source.threadId, true))
      setRemoteImages(true)
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Remote images could not be loaded')
    }
  }

  return (
    <div className="message-window-shell">
      <TitleBar title={title} />
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
            {thread.messages.map((message) => <section className="gmail-message" key={message.id}>
              <header className="sender-card"><SenderAvatar email={message.fromEmail} name={message.fromName} large /><span><strong>{message.fromName || message.fromEmail}</strong><small>{message.fromEmail} · {messageDate(message.date)}</small></span></header>
              {message.sanitizedHtml ? <div className="message-body gmail-html" dangerouslySetInnerHTML={{ __html: message.sanitizedHtml }} /> : <div className="message-body gmail-text">{message.text}</div>}
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id} onContextMenu={(event) => showContextMenu(event, [
                { label: 'Open attachment', icon: Download, action: () => openAttachment(message, attachment) },
                { label: 'Save as…', icon: Download, action: () => saveAttachment(message, attachment) },
                { label: 'Copy filename', icon: Copy, separatorBefore: true, action: () => copyText(attachment.filename) }
              ], attachment.filename)}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small></span><button className="icon-button" title="Open" onClick={() => void openAttachment(message, attachment)}><Download size={16} /></button><button className="button ghost small" onClick={() => void saveAttachment(message, attachment)}>Save as</button></div>)}</div>}
            </section>)}
          </article>
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
