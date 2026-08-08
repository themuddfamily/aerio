import { Bold, CalendarClock, Copy, Italic, Link, List, Paperclip, Save, Send, Trash2, Underline, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MailAccountSummary, MailDraftInput, MailDraftRecord, MailThreadDetail, MailRecipientSuggestion } from '../mail-types'
import { formatFileSize } from '../lib/domain'
import { isCompleteMailAddress } from '../lib/mail-address'
import { copyText, useContextMenu } from './ContextMenu'
import { ModalShell } from './Modal'

interface MailComposeModalProps {
  accounts: MailAccountSummary[]
  draft?: MailDraftRecord
  replyTo?: MailThreadDetail
  replyAll?: boolean
  forward?: boolean
  initialTo?: string
  onClose(): void
  onSent(result: import('../mail-types').MailDraftResult): void
  onToast(message: string): void
}

const splitAddresses = (value: string) => {
  const addresses: string[] = []
  let current = ''
  let angleDepth = 0
  let quoted = false
  for (const character of value) {
    if (character === '"') quoted = !quoted
    if (!quoted && character === '<') angleDepth += 1
    if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1)
    if (!quoted && angleDepth === 0 && (character === ',' || character === ';')) {
      if (current.trim()) addresses.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) addresses.push(current.trim())
  return addresses
}
const fileName = (path: string) => (path.split(/[\\/]/).at(-1) || 'attachment').replace(/^\d+(?:-[a-f0-9]{10})?-/, '')
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>')
const addressEmail = (value: string) => value.trim().match(/<([^<>]+)>$/)?.[1].trim().toLowerCase() ?? value.trim().toLowerCase()
const friendlyError = (error: unknown, fallback: string) => {
  if (!(error instanceof Error)) return fallback
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback
}
const localDateTimeValue = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function MailComposeModal({ accounts, draft, replyTo, replyAll, forward, initialTo, onClose, onSent, onToast }: MailComposeModalProps) {
  const { showContextMenu } = useContextMenu()
  const replyMessage = replyTo?.messages.at(-1)
  const forwardedText = replyTo && forward && replyMessage ? `\n\n---------- Forwarded message ----------\nFrom: ${replyMessage.fromName || replyMessage.fromEmail} <${replyMessage.fromEmail}>\nDate: ${new Date(replyMessage.date).toLocaleString()}\nSubject: ${replyMessage.subject}\n\n${replyMessage.text}` : ''
  const initialAccountId = draft?.accountId ?? replyTo?.accountId ?? accounts[0]?.id ?? ''
  const ownEmail = accounts.find((account) => account.id === initialAccountId)?.email.toLowerCase()
  const uniqueRecipients = (values: string[]) => Array.from(new Map(values
    .filter((value) => value && addressEmail(value) !== ownEmail)
    .map((value) => [addressEmail(value), value])).values())
  const replyRecipients = replyAll && replyMessage
    ? uniqueRecipients([replyMessage.fromEmail, ...replyMessage.to])
    : replyMessage ? uniqueRecipients(addressEmail(replyMessage.fromEmail) === ownEmail ? replyMessage.to : [replyMessage.fromEmail]) : []
  const replyCc = replyAll && replyMessage
    ? uniqueRecipients(replyMessage.cc).filter((value) => !replyRecipients.some((recipient) => addressEmail(recipient) === addressEmail(value)))
    : []
  const signature = draft ? '' : accounts.find((account) => account.id === initialAccountId)?.signature.trim() ?? ''
  const initialText = draft?.text ?? `${signature ? `\n\n-- \n${signature}` : ''}${forwardedText}`
  const initialHtml = draft?.html ?? `${signature ? `<div><br></div><div>-- <br>${escapeHtml(signature)}</div>` : ''}${forwardedText ? `<div>${escapeHtml(forwardedText)}</div>` : ''}`
  const [accountId, setAccountId] = useState(initialAccountId)
  const [draftId, setDraftId] = useState(() => draft?.id ?? crypto.randomUUID())
  const [to, setTo] = useState(draft?.to.join(', ') ?? (forward ? '' : replyRecipients.join(', ') || initialTo || ''))
  const [cc, setCc] = useState(draft?.cc.join(', ') ?? replyCc.join(', '))
  const [bcc, setBcc] = useState(draft?.bcc.join(', ') ?? '')
  const [bccVisible, setBccVisible] = useState(Boolean(draft?.bcc.length))
  const [subject, setSubject] = useState(draft?.subject ?? (replyTo ? forward ? (/^fwd:/i.test(replyTo.subject) ? replyTo.subject : `Fwd: ${replyTo.subject}`) : (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : ''))
  const [text, setText] = useState(initialText)
  const [html, setHtml] = useState(initialHtml)
  const [attachments, setAttachments] = useState<{ name: string; size: number; path: string }[]>(() => (draft?.attachmentPaths ?? []).map((path) => ({ name: fileName(path), size: 0, path })))
  const [scheduledFor, setScheduledFor] = useState(() => localDateTimeValue(draft?.status === 'scheduled' ? draft.deliveryAt : undefined))
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'sending' | 'closing' | 'failed'>(draft?.status === 'failed' ? 'failed' : draft ? 'saved' : 'idle')
  const [saveError, setSaveError] = useState(draft?.error)
  const [conflict, setConflict] = useState(false)
  const [recipientField, setRecipientField] = useState<'to' | 'cc' | 'bcc'>()
  const [recipientSuggestions, setRecipientSuggestions] = useState<MailRecipientSuggestion[]>([])
  const editorRef = useRef<HTMLDivElement>(null)
  const editorHtmlRef = useRef(initialHtml)
  const firstRender = useRef(true)
  const lastSaved = useRef('')
  const revision = useRef(draft?.updatedAt)
  const remoteRevision = useRef(draft?.remoteRevision)
  const stagedForwardAttachments = useRef(false)

  const input = useMemo<MailDraftInput>(() => ({
    id: draftId,
    accountId,
    threadId: draft?.threadId ?? (forward ? undefined : replyTo?.id),
    inReplyTo: draft?.inReplyTo ?? (forward ? undefined : replyMessage?.messageIdHeader),
    references: draft?.references ?? (forward ? [] : [...(replyMessage?.references ?? []), ...(replyMessage?.messageIdHeader ? [replyMessage.messageIdHeader] : [])]),
    to: splitAddresses(to),
    cc: splitAddresses(cc),
    bcc: splitAddresses(bcc),
    subject,
    text,
    html: html && html !== '<br>' ? html : undefined,
    attachmentPaths: attachments.map((item) => item.path)
  }), [accountId, attachments, bcc, cc, draft?.inReplyTo, draft?.references, draft?.threadId, draftId, forward, html, replyMessage, replyTo?.id, subject, text, to])
  const fingerprint = useMemo(() => JSON.stringify(input), [input])
  const initialFingerprint = useRef(fingerprint)
  const hasContent = Boolean(to || cc || bcc || subject || text.trim() || attachments.length)
  const hasChanges = fingerprint !== initialFingerprint.current

  useEffect(() => {
    if (!recipientField || !accountId) {
      setRecipientSuggestions([])
      return
    }
    const value = recipientField === 'to' ? to : recipientField === 'cc' ? cc : bcc
    const query = value.split(/[;,]/).at(-1)?.trim() ?? ''
    const timer = setTimeout(() => {
      void window.aerio.mail.mail.suggestRecipients(query, [accountId]).then(setRecipientSuggestions).catch(() => setRecipientSuggestions([]))
    }, 180)
    return () => clearTimeout(timer)
  }, [accountId, bcc, cc, recipientField, to])

  useEffect(() => {
    if (draft) lastSaved.current = JSON.stringify({ ...input, attachmentPaths: draft.attachmentPaths })
    // Only the initial persisted snapshot is recorded here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (stagedForwardAttachments.current || draft || !forward || !replyMessage?.attachments.length) return
    stagedForwardAttachments.current = true
    void window.aerio.mail.drafts.stageMessageAttachments(draftId, replyMessage.accountId, replyMessage.id).then((files) => {
      setAttachments(files)
    }).catch((error) => onToast(error instanceof Error ? error.message : 'Forwarded attachments could not be prepared'))
  }, [draft, draftId, forward, onToast, replyMessage])

  const saveNow = async (value = input, notify = false, preserveRevision = true) => {
    const valueFingerprint = JSON.stringify(value)
    if (!value.accountId || !hasContent || valueFingerprint === lastSaved.current) return true
    setStatus('saving')
    try {
      const result = await window.aerio.mail.drafts.save({
        ...value,
        expectedUpdatedAt: preserveRevision ? revision.current : undefined,
        expectedRemoteRevision: preserveRevision ? remoteRevision.current : undefined
      })
      revision.current = result.updatedAt
      remoteRevision.current = result.remoteRevision
      if (result.status === 'failed') {
        const message = result.error ?? 'Draft could not be saved'
        setStatus('failed')
        setSaveError(message)
        if (notify) onToast(message)
        return false
      }
      lastSaved.current = valueFingerprint
      setConflict(false)
      setSaveError(undefined)
      setStatus('saved')
      return true
    } catch (error) {
      const message = friendlyError(error, 'Draft could not be saved')
      setStatus('failed')
      setSaveError(message)
      setConflict(/draft changed after it was opened/i.test(message))
      if (notify) onToast(message)
      return false
    }
  }

  const saveAsCopy = async () => {
    const nextId = crypto.randomUUID()
    revision.current = undefined
    remoteRevision.current = undefined
    const saved = await saveNow({ ...input, id: nextId }, true, false)
    if (saved) {
      setDraftId(nextId)
      onToast('Draft saved as a separate copy')
    }
  }

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!accountId || !hasContent || !hasChanges || fingerprint === lastSaved.current || status === 'sending' || status === 'closing') return
    const timer = setTimeout(() => void saveNow(input), 1_200)
    return () => clearTimeout(timer)
  }, [accountId, fingerprint, hasChanges, hasContent, input, status])

  const closeComposer = async () => {
    if (status === 'sending' || status === 'closing') return
    setStatus('closing')
    if (hasChanges && hasContent && fingerprint !== lastSaved.current) await saveNow(input, true)
    onClose()
  }
  const chooseAttachments = async () => {
    try {
      const selected = await window.aerio.chooseAttachments()
      setAttachments((current) => {
        const known = new Set(current.map((item) => item.path.toLowerCase()))
        return [...current, ...selected.filter((item) => item.path && !known.has(item.path.toLowerCase())).map((item) => ({ name: item.name, size: item.size, path: item.path! }))]
      })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachments could not be selected')
    }
  }

  const chooseRecipient = (suggestion: MailRecipientSuggestion) => {
    if (!recipientField) return
    const value = recipientField === 'to' ? to : recipientField === 'cc' ? cc : bcc
    const parts = splitAddresses(value)
    const displayName = suggestion.name && /[,;]/.test(suggestion.name) ? `"${suggestion.name.replaceAll('"', '')}"` : suggestion.name
    const formatted = displayName ? `${displayName} <${suggestion.email}>` : suggestion.email
    if (/[,;]\s*$/.test(value) || !parts.length) parts.push(formatted)
    else parts[parts.length - 1] = formatted
    const next = `${parts.map((part) => part.trim()).filter(Boolean).join(', ')}, `
    if (recipientField === 'to') setTo(next)
    else if (recipientField === 'cc') setCc(next)
    else setBcc(next)
    setRecipientSuggestions([])
  }

  const bindEditor = useCallback((editor: HTMLDivElement | null) => {
    editorRef.current = editor
    if (editor) editor.innerHTML = editorHtmlRef.current
  }, [])

  const updateEditor = () => {
    const editor = editorRef.current
    if (!editor) return
    editorHtmlRef.current = editor.innerHTML
    setHtml(editorHtmlRef.current)
    setText(editor.innerText.replaceAll('\u00a0', ' '))
  }

  const format = (command: string, value?: string) => {
    const editor = editorRef.current
    editor?.focus()
    editor?.ownerDocument.execCommand(command, false, value)
    updateEditor()
  }

  const addLink = () => {
    const value = editorRef.current?.ownerDocument.defaultView?.prompt('Link address (https:// or mailto:)')?.trim()
    if (!value) return
    if (!/^(https?:|mailto:)/i.test(value)) {
      onToast('Use an https://, http://, or mailto: link')
      return
    }
    format('createLink', value)
  }

  const discard = async () => {
    if (!window.confirm('Discard this draft? It will also be removed from the mail provider.')) return
    try {
      const result = await window.aerio.mail.drafts.delete(draftId)
      onToast(result.status === 'discard-queued' ? 'Offline — draft will be discarded after reconnecting' : 'Draft discarded')
      onClose()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Draft could not be discarded')
    }
  }

  const send = async () => {
    const recipients = [...input.to, ...input.cc, ...input.bcc]
    if (!recipients.length) {
      onToast('Add at least one recipient')
      return
    }
    if (recipients.some((recipient) => !isCompleteMailAddress(recipient))) {
      onToast('Finish or correct the recipient email addresses before sending')
      return
    }
    const deliveryAt = scheduledFor ? new Date(scheduledFor) : undefined
    if (deliveryAt && (!Number.isFinite(deliveryAt.getTime()) || deliveryAt.getTime() <= Date.now())) {
      onToast('Choose a scheduled time in the future')
      return
    }
    setStatus('sending')
    try {
      const result = deliveryAt
        ? await window.aerio.mail.drafts.schedule({ ...input, expectedUpdatedAt: revision.current, expectedRemoteRevision: remoteRevision.current }, deliveryAt.toISOString())
        : await window.aerio.mail.drafts.send({ ...input, expectedUpdatedAt: revision.current, expectedRemoteRevision: remoteRevision.current })
      if (result.status === 'scheduled') {
        onToast(`Message scheduled for ${deliveryAt!.toLocaleString()}`)
        onSent(result)
        onClose()
      } else if (result.status === 'send-pending') {
        onToast('Message ready to send — use Undo if you need it back')
        onSent(result)
        onClose()
      } else {
        setStatus('failed')
        onToast(result.error ?? 'Message could not be sent')
      }
    } catch (error) {
      setStatus('failed')
      onToast(friendlyError(error, 'Message could not be sent'))
    }
  }

  const statusText = status === 'saving' ? 'Saving draft…'
    : status === 'saved' ? 'Draft saved'
      : status === 'sending' ? 'Sending…'
        : status === 'closing' ? 'Saving before closing…'
          : status === 'failed' ? saveError ?? 'Draft not saved — retry available' : 'Real mail'
  const composeTitle = draft ? 'Edit draft' : forward ? 'Forward' : replyTo ? replyAll ? 'Reply all' : 'Reply' : 'New message'

  return (
    <ModalShell
      title={composeTitle}
      subtitle={statusText}
      className="mail-compose"
      closeEnabled={status !== 'sending' && status !== 'closing'}
      closeTitle="Save draft and close"
      popoutSize={{ width: 800, height: 820 }}
      onClose={() => void closeComposer()}
    >
        <div className="compose">
          <div className="compose-row"><label>From</label><select value={accountId} disabled={Boolean(draft)} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.displayName} · {account.email}</option>)}</select></div>
          <div className="compose-row"><label>To</label><input autoFocus value={to} onFocus={() => setRecipientField('to')} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" /></div>
          <div className="compose-row"><label>Cc</label><input value={cc} onFocus={() => setRecipientField('cc')} onChange={(event) => setCc(event.target.value)} /><button className="text-button" onClick={() => setBccVisible((value) => !value)}>Bcc</button></div>
          {bccVisible && <div className="compose-row"><label>Bcc</label><input value={bcc} onFocus={() => setRecipientField('bcc')} onChange={(event) => setBcc(event.target.value)} /></div>}
          {recipientField && recipientSuggestions.length > 0 && <div className="recipient-suggestions">{recipientSuggestions.map((suggestion) => <button key={`${suggestion.accountId}:${suggestion.email}`} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseRecipient(suggestion)}><span className="avatar">{(suggestion.name || suggestion.email).slice(0, 2).toUpperCase()}</span><span><strong>{suggestion.name || suggestion.email}</strong><small>{suggestion.email}</small></span></button>)}</div>}
          <div className="compose-row"><label>Subject</label><input value={subject} onFocus={() => setRecipientField(undefined)} onChange={(event) => setSubject(event.target.value)} /></div>
          <div className="compose-formatting" role="toolbar" aria-label="Message formatting">
            <button className="icon-button" title="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => format('bold')}><Bold size={15} /></button>
            <button className="icon-button" title="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => format('italic')}><Italic size={15} /></button>
            <button className="icon-button" title="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => format('underline')}><Underline size={15} /></button>
            <button className="icon-button" title="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => format('insertUnorderedList')}><List size={15} /></button>
            <button className="icon-button" title="Add link" onMouseDown={(event) => event.preventDefault()} onClick={addLink}><Link size={15} /></button>
          </div>
          <div
            ref={bindEditor}
            className="compose-body compose-rich-body"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            data-placeholder="Write your message…"
            onInput={updateEditor}
            onFocus={() => setRecipientField(undefined)}
            onPaste={(event) => {
              event.preventDefault()
              event.currentTarget.ownerDocument.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
              updateEditor()
            }}
          />
          {attachments.length > 0 && <div className="mail-compose-files">{attachments.map((file, index) => <span key={`${file.path}-${index}`} onContextMenu={(event) => showContextMenu(event, [
            { label: 'Copy filename', icon: Copy, action: () => copyText(file.name) },
            { label: 'Remove attachment', icon: Trash2, separatorBefore: true, danger: true, action: () => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex)) }
          ], file.name)}><Paperclip size={14} /><strong>{file.name}</strong>{file.size > 0 && <small>{formatFileSize(file.size)}</small>}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex))}><X size={13} /></button></span>)}</div>}
        </div>
        <footer className="compose-footer">
          <button className="icon-button" title="Attach files" onClick={() => void chooseAttachments()}><Paperclip size={18} /></button>
          <button className="button ghost small" disabled={status === 'saving' || status === 'sending'} onClick={() => void saveNow(input, true)}><Save size={15} /> Save draft</button>
          {conflict && <button className="button ghost small" disabled={status === 'saving' || status === 'sending'} onClick={() => void saveAsCopy()}><Copy size={15} /> Save as copy</button>}
          <button className="button ghost small danger-subtle" disabled={status === 'sending'} onClick={() => void discard()}><Trash2 size={15} /> Discard</button>
          <span className="spacer" />
          <label className="mail-schedule-field" title="Schedule delivery"><CalendarClock size={15} /><input aria-label="Scheduled delivery time" type="datetime-local" min={localDateTimeValue(new Date(Date.now() + 60_000).toISOString())} value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />{scheduledFor && <button type="button" aria-label="Clear scheduled delivery" onClick={() => setScheduledFor('')}><X size={13} /></button>}</label>
          <button className="button primary" disabled={status === 'sending' || status === 'closing'} onClick={() => void send()}><Send size={16} /> {status === 'sending' ? scheduledFor ? 'Scheduling…' : 'Queuing…' : scheduledFor ? 'Schedule' : 'Send'}</button>
        </footer>
    </ModalShell>
  )
}
