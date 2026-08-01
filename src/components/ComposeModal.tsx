import { Clock3, Copy, FileText, Paperclip, Send, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { uid, formatFileSize } from '../lib/domain'
import type { AppState, Attachment, Message } from '../types'
import Modal from './Modal'
import { copyText, useContextMenu } from './ContextMenu'

interface ComposeModalProps {
  state: AppState
  replyTo?: Message
  replyAll?: boolean
  forward?: boolean
  draft?: Message
  initialTo?: string
  onChange(next: AppState): void
  onClose(): void
  onToast(message: string): void
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const bodyText = (html: string) => new DOMParser().parseFromString(html.replaceAll('</p>', '</p>\n').replaceAll('<br/>', '\n'), 'text/html').body.textContent?.trim() ?? ''

export default function ComposeModal({ state, replyTo, replyAll, forward, draft, initialTo, onChange, onClose, onToast }: ComposeModalProps) {
  const { showContextMenu } = useContextMenu()
  const defaultAccount = draft?.accountId ?? replyTo?.accountId ?? state.accounts[0].id
  const [accountId, setAccountId] = useState(defaultAccount)
  const ownEmail = state.accounts.find((item) => item.id === defaultAccount)?.email
  const replyRecipients = replyTo && replyAll
    ? Array.from(new Set([replyTo.fromEmail, ...replyTo.to].filter((email) => email !== ownEmail)))
    : replyTo ? [replyTo.fromEmail] : []
  const replyCc = replyTo && replyAll ? Array.from(new Set((replyTo.cc ?? []).filter((email) => email !== ownEmail && !replyRecipients.includes(email)))) : []
  const [to, setTo] = useState(draft ? draft.to.join(', ') : replyTo && !forward ? replyRecipients.join(', ') : initialTo ?? '')
  const [ccVisible, setCcVisible] = useState(Boolean(draft?.cc?.length) || (!forward && Boolean(replyCc.length)))
  const [cc, setCc] = useState(draft ? (draft.cc ?? []).join(', ') : forward ? '' : replyCc.join(', '))
  const [subject, setSubject] = useState(draft?.subject ?? (replyTo ? forward ? `Fwd: ${replyTo.subject.replace(/^Fwd:\s*/i, '')}` : `Re: ${replyTo.subject.replace(/^Re:\s*/i, '')}` : ''))
  const [body, setBody] = useState(draft ? bodyText(draft.body) : replyTo ? forward
    ? `\n\n---------- Forwarded message ----------\nFrom: ${replyTo.from} <${replyTo.fromEmail}>\nDate: ${new Date(replyTo.date).toLocaleString()}\nSubject: ${replyTo.subject}\n\n${replyTo.preview}`
    : `\n\n\nOn ${new Date(replyTo.date).toLocaleDateString()}, ${replyTo.from} wrote:\n${replyTo.preview}` : '')
  const [attachments, setAttachments] = useState<Attachment[]>(draft?.attachments ?? (forward ? replyTo?.attachments ?? [] : []))
  const [scheduledFor, setScheduledFor] = useState('')
  const account = useMemo(() => state.accounts.find((item) => item.id === accountId) ?? state.accounts[0], [accountId, state.accounts])

  const buildMessage = (isDraft: boolean): Message => {
    const folder = state.folders.find((item) => item.accountId === accountId && item.system === (isDraft ? 'drafts' : 'sent'))
    const timestamp = scheduledFor ? new Date(scheduledFor).toISOString() : new Date().toISOString()
    return {
      id: draft?.id ?? uid('message'),
      threadId: draft?.threadId ?? (replyTo && !forward ? replyTo.threadId : uid('thread')),
      accountId,
      folderId: folder?.id ?? '',
      from: account.name,
      fromEmail: account.email,
      to: to.split(',').map((value) => value.trim()).filter(Boolean),
      cc: cc.split(',').map((value) => value.trim()).filter(Boolean),
      subject: subject.trim() || '(No subject)',
      preview: body.trim().slice(0, 110) || 'Empty message',
      body: body.split('\n').map((line) => `<p>${line ? escapeHtml(line) : '<br/>'}</p>`).join(''),
      date: timestamp,
      unread: false,
      starred: false,
      flagged: false,
      labels: scheduledFor ? ['Scheduled'] : [],
      attachments,
      draft: isDraft,
      sent: !isDraft
    }
  }

  const saveDraft = () => {
    onChange({ ...state, messages: [buildMessage(true), ...state.messages.filter((message) => message.id !== draft?.id)] })
    onToast('Draft saved')
    onClose()
  }

  const send = () => {
    if (!to.trim()) {
      onToast('Add at least one recipient')
      return
    }
    if (scheduledFor && new Date(scheduledFor).getTime() <= Date.now()) {
      onToast('Choose a future delivery time')
      return
    }
    onChange({ ...state, messages: [buildMessage(false), ...state.messages.filter((message) => message.id !== draft?.id)] })
    const scheduled = Boolean(scheduledFor)
    onToast(scheduled ? `Message scheduled for ${new Date(scheduledFor).toLocaleString()}` : 'Message sent')
    if (!scheduled && state.settings.notifications) void window.aerio.notify('Message sent', `Your message to ${to} is on its way.`)
    onClose()
  }

  const chooseFiles = async () => {
    try {
      const chosen = await window.aerio.chooseAttachments()
      setAttachments((current) => [...current, ...chosen])
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachments could not be selected')
    }
  }

  return (
    <Modal title={draft ? 'Edit draft' : forward ? 'Forward' : replyTo ? 'Reply' : 'New message'} subtitle={`From ${account.email}`} width="large" onClose={onClose}>
      <div className="compose">
        <div className="compose-row">
          <label>From</label>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {state.accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.email}</option>)}
          </select>
        </div>
        <div className="compose-row">
          <label>To</label>
          <input autoFocus value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" />
          <button className="text-button" onClick={() => setCcVisible((value) => !value)}>Cc</button>
        </div>
        {ccVisible && (
          <div className="compose-row">
            <label>Cc</label>
            <input value={cc} onChange={(event) => setCc(event.target.value)} placeholder="Optional recipients" />
          </div>
        )}
        <div className="compose-row">
          <label>Subject</label>
          <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="What’s this about?" />
        </div>
        <textarea className="compose-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write a message…" />
        {state.settings.signature && <div className="compose-signature">{state.settings.signature.split('\n').map((line) => <div key={line}>{line}</div>)}</div>}
        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id} onContextMenu={(event) => showContextMenu(event, [
                { label: 'Copy filename', icon: Copy, action: () => copyText(attachment.name) },
                { label: 'Remove attachment', icon: Trash2, separatorBefore: true, danger: true, action: () => setAttachments((items) => items.filter((item) => item.id !== attachment.id)) }
              ], attachment.name)}>
                <Paperclip size={14} />
                <span>{attachment.name}</span>
                <small>{formatFileSize(attachment.size)}</small>
                <button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}><X size={13} /></button>
              </div>
            ))}
          </div>
        )}
        <footer className="compose-footer">
          <button className="icon-button" title="Attach files" onClick={() => void chooseFiles()}><Paperclip size={18} /></button>
          <label className="schedule-field" title="Schedule delivery">
            <Clock3 size={16} />
            <input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
          </label>
          <span className="spacer" />
          <button className="button ghost" onClick={saveDraft}><FileText size={16} /> Save draft</button>
          <button className="button primary" onClick={send}><Send size={16} /> {scheduledFor ? 'Schedule' : 'Send'}</button>
        </footer>
      </div>
    </Modal>
  )
}
