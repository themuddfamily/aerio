import { Bold, Copy, Italic, Link, List, Paperclip, Save, Send, Trash2, Underline, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GmailAccountSummary, GmailDraftInput, GmailDraftRecord, GmailThreadDetail, MailRecipientSuggestion } from '../gmail-types'
import { formatFileSize } from '../lib/domain'
import { copyText, useContextMenu } from './ContextMenu'

interface GmailComposeModalProps {
  accounts: GmailAccountSummary[]
  draft?: GmailDraftRecord
  replyTo?: GmailThreadDetail
  forward?: boolean
  onClose(): void
  onSent(): void
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

export default function GmailComposeModal({ accounts, draft, replyTo, forward, onClose, onSent, onToast }: GmailComposeModalProps) {
  const { showContextMenu } = useContextMenu()
  const replyMessage = replyTo?.messages.at(-1)
  const forwardedText = replyTo && forward && replyMessage ? `\n\n---------- Forwarded message ----------\nFrom: ${replyMessage.fromName || replyMessage.fromEmail} <${replyMessage.fromEmail}>\nDate: ${new Date(replyMessage.date).toLocaleString()}\nSubject: ${replyMessage.subject}\n\n${replyMessage.text}` : ''
  const initialAccountId = draft?.accountId ?? replyTo?.accountId ?? accounts[0]?.id ?? ''
  const signature = draft ? '' : accounts.find((account) => account.id === initialAccountId)?.signature.trim() ?? ''
  const initialText = draft?.text ?? `${signature ? `\n\n-- \n${signature}` : ''}${forwardedText}`
  const initialHtml = draft?.html ?? `${signature ? `<div><br></div><div>-- <br>${escapeHtml(signature)}</div>` : ''}${forwardedText ? `<div>${escapeHtml(forwardedText)}</div>` : ''}`
  const [accountId, setAccountId] = useState(initialAccountId)
  const [draftId] = useState(() => draft?.id ?? crypto.randomUUID())
  const [to, setTo] = useState(draft?.to.join(', ') ?? (forward ? '' : replyMessage?.fromEmail ?? ''))
  const [cc, setCc] = useState(draft?.cc.join(', ') ?? '')
  const [bcc, setBcc] = useState(draft?.bcc.join(', ') ?? '')
  const [bccVisible, setBccVisible] = useState(Boolean(draft?.bcc.length))
  const [subject, setSubject] = useState(draft?.subject ?? (replyTo ? forward ? (/^fwd:/i.test(replyTo.subject) ? replyTo.subject : `Fwd: ${replyTo.subject}`) : (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : ''))
  const [text, setText] = useState(initialText)
  const [html, setHtml] = useState(initialHtml)
  const [attachments, setAttachments] = useState<{ name: string; size: number; path: string }[]>(() => (draft?.attachmentPaths ?? []).map((path) => ({ name: fileName(path), size: 0, path })))
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'sending' | 'closing' | 'failed'>(draft?.status === 'failed' ? 'failed' : draft ? 'saved' : 'idle')
  const [recipientField, setRecipientField] = useState<'to' | 'cc' | 'bcc'>()
  const [recipientSuggestions, setRecipientSuggestions] = useState<MailRecipientSuggestion[]>([])
  const editorRef = useRef<HTMLDivElement>(null)
  const firstRender = useRef(true)
  const lastSaved = useRef('')
  const stagedForwardAttachments = useRef(false)

  const input = useMemo<GmailDraftInput>(() => ({
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

  const saveNow = async (value = input) => {
    const valueFingerprint = JSON.stringify(value)
    if (!value.accountId || !hasContent || valueFingerprint === lastSaved.current) return true
    setStatus('saving')
    try {
      const result = await window.aerio.mail.drafts.save(value)
      if (result.status === 'failed') {
        setStatus('failed')
        onToast(result.error ?? 'Draft could not be saved')
        return false
      }
      lastSaved.current = valueFingerprint
      setStatus('saved')
      return true
    } catch (error) {
      setStatus('failed')
      onToast(error instanceof Error ? error.message : 'Draft could not be saved')
      return false
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
    if (hasChanges && hasContent && fingerprint !== lastSaved.current) await saveNow(input)
    onClose()
  }

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && status !== 'sending') {
        event.preventDefault()
        void closeComposer()
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  })

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

  const updateEditor = () => {
    const editor = editorRef.current
    if (!editor) return
    setHtml(editor.innerHTML)
    setText(editor.innerText.replaceAll('\u00a0', ' '))
  }

  const format = (command: string, value?: string) => {
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    updateEditor()
  }

  const addLink = () => {
    const value = window.prompt('Link address (https:// or mailto:)')?.trim()
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
    if (![...input.to, ...input.cc, ...input.bcc].length) {
      onToast('Add at least one recipient')
      return
    }
    setStatus('sending')
    try {
      const result = await window.aerio.mail.drafts.send(input)
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
    } catch (error) {
      setStatus('failed')
      onToast(error instanceof Error ? error.message : 'Message could not be sent')
    }
  }

  const statusText = status === 'saving' ? 'Saving draft…'
    : status === 'saved' ? 'Draft saved'
      : status === 'sending' ? 'Sending…'
        : status === 'closing' ? 'Saving before closing…'
          : status === 'failed' ? draft?.error ?? 'Draft not saved — retry available' : 'Real mail'

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) void closeComposer() }}>
      <section className="modal gmail-compose" role="dialog" aria-modal="true" aria-label="Compose mail message">
        <header className="modal-header">
          <div><h2>{draft ? 'Edit draft' : forward ? 'Forward' : replyTo ? 'Reply' : 'New message'}</h2><p>{statusText}</p></div>
          <button className="icon-button" onClick={() => void closeComposer()} aria-label="Close" title="Save draft and close"><X size={18} /></button>
        </header>
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
            ref={editorRef}
            className="compose-body compose-rich-body"
            contentEditable
            role="textbox"
            aria-multiline="true"
            data-placeholder="Write your message…"
            dangerouslySetInnerHTML={{ __html: html }}
            onInput={updateEditor}
            onFocus={() => setRecipientField(undefined)}
            onPaste={(event) => {
              event.preventDefault()
              document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
              updateEditor()
            }}
          />
          {attachments.length > 0 && <div className="gmail-compose-files">{attachments.map((file, index) => <span key={`${file.path}-${index}`} onContextMenu={(event) => showContextMenu(event, [
            { label: 'Copy filename', icon: Copy, action: () => copyText(file.name) },
            { label: 'Remove attachment', icon: Trash2, separatorBefore: true, danger: true, action: () => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex)) }
          ], file.name)}><Paperclip size={14} /><strong>{file.name}</strong>{file.size > 0 && <small>{formatFileSize(file.size)}</small>}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex))}><X size={13} /></button></span>)}</div>}
        </div>
        <footer className="compose-footer">
          <button className="icon-button" title="Attach files" onClick={() => void chooseAttachments()}><Paperclip size={18} /></button>
          <button className="button ghost small" disabled={status === 'saving' || status === 'sending'} onClick={() => void saveNow()}><Save size={15} /> Save draft</button>
          <button className="button ghost small danger-subtle" disabled={status === 'sending'} onClick={() => void discard()}><Trash2 size={15} /> Discard</button>
          <span className="spacer" />
          <button className="button primary" disabled={status === 'sending' || status === 'closing'} onClick={() => void send()}><Send size={16} /> {status === 'sending' ? 'Sending…' : 'Send'}</button>
        </footer>
      </section>
    </div>
  )
}
