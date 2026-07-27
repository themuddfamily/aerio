import { Paperclip, Send, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GmailAccountSummary, GmailDraftInput, GmailThreadDetail } from '../gmail-types'
import { formatFileSize } from '../lib/domain'

interface GmailComposeModalProps {
  accounts: GmailAccountSummary[]
  replyTo?: GmailThreadDetail
  onClose(): void
  onSent(): void
  onToast(message: string): void
}

export default function GmailComposeModal({ accounts, replyTo, onClose, onSent, onToast }: GmailComposeModalProps) {
  const replyMessage = replyTo?.messages.at(-1)
  const [accountId, setAccountId] = useState(replyTo?.accountId ?? accounts[0]?.id ?? '')
  const [draftId, setDraftId] = useState<string>()
  const [to, setTo] = useState(replyMessage?.fromEmail ?? '')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState(replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : '')
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<{ name: string; size: number; path: string }[]>([])
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'sending' | 'failed'>('idle')
  const firstRender = useRef(true)

  const input = useMemo<GmailDraftInput>(() => ({
    id: draftId,
    accountId,
    threadId: replyTo?.id,
    inReplyTo: replyMessage?.messageIdHeader,
    references: [...(replyMessage?.references ?? []), ...(replyMessage?.messageIdHeader ? [replyMessage.messageIdHeader] : [])],
    to: to.split(',').map((item) => item.trim()).filter(Boolean),
    cc: cc.split(',').map((item) => item.trim()).filter(Boolean),
    bcc: bcc.split(',').map((item) => item.trim()).filter(Boolean),
    subject,
    text,
    attachmentPaths: attachments.map((item) => item.path)
  }), [accountId, attachments, bcc, cc, draftId, replyMessage, replyTo?.id, subject, text, to])

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!accountId || (!to && !subject && !text && !attachments.length)) return
    setStatus('saving')
    const timer = setTimeout(() => {
      void window.aerio.gmail.drafts.save(input).then((result) => {
        setDraftId(result.id)
        setStatus(result.status === 'failed' ? 'failed' : 'saved')
      }).catch(() => setStatus('failed'))
    }, 2_000)
    return () => clearTimeout(timer)
  }, [accountId, attachments.length, input, subject, text, to])

  const chooseAttachments = async () => {
    const selected = await window.aerio.chooseAttachments()
    setAttachments((current) => [
      ...current,
      ...selected.filter((item) => item.path).map((item) => ({ name: item.name, size: item.size, path: item.path! }))
    ])
  }

  const send = async () => {
    if (!input.to.length) {
      onToast('Add at least one recipient')
      return
    }
    setStatus('sending')
    const result = await window.aerio.gmail.drafts.send(input)
    if (result.status === 'sent') {
      onToast('Message sent')
      onSent()
      onClose()
    } else if (result.status === 'queued') {
      onToast('Offline — message added to Outbox')
      onClose()
    } else {
      setStatus('failed')
      onToast(result.error ?? 'Message could not be sent')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal gmail-compose" role="dialog" aria-label="Compose Gmail message">
        <header className="modal-header">
          <div><h2>{replyTo ? 'Reply' : 'New Gmail message'}</h2><p>{status === 'saving' ? 'Saving to Gmail…' : status === 'saved' ? 'Draft saved' : status === 'failed' ? 'Draft not saved' : 'Real Gmail'}</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="compose">
          <div className="compose-row"><label>From</label><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.email}</option>)}</select></div>
          <div className="compose-row"><label>To</label><input autoFocus value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" /></div>
          <div className="compose-row"><label>Cc</label><input value={cc} onChange={(event) => setCc(event.target.value)} /><button className="text-button" onClick={() => setBcc((value) => value || ' ')}>Bcc</button></div>
          {bcc !== '' && <div className="compose-row"><label>Bcc</label><input value={bcc} onChange={(event) => setBcc(event.target.value)} /></div>}
          <div className="compose-row"><label>Subject</label><input value={subject} onChange={(event) => setSubject(event.target.value)} /></div>
          <textarea className="compose-body" value={text} onChange={(event) => setText(event.target.value)} placeholder="Write your message…" />
          {attachments.length > 0 && <div className="gmail-compose-files">{attachments.map((file, index) => <span key={`${file.path}-${index}`}><Paperclip size={14} /><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small><button onClick={() => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex))}><X size={13} /></button></span>)}</div>}
        </div>
        <footer className="compose-footer">
          <button className="icon-button" title="Attach files" onClick={() => void chooseAttachments()}><Paperclip size={18} /></button>
          <span className="spacer" />
          <button className="button primary" disabled={status === 'sending'} onClick={() => void send()}><Send size={16} /> {status === 'sending' ? 'Sending…' : 'Send'}</button>
        </footer>
      </section>
    </div>
  )
}
