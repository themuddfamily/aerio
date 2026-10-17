import { CalendarClock, Cloud, Copy, Paperclip, Save, Send, Sparkles, Trash2, Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MailAccountSummary, MailDraftInput, MailDraftRecord, MailThreadDetail, MailRecipientSuggestion, MailSendOptions } from '../mail-types'
import { formatFileSize } from '../lib/domain'
import { isCompleteMailAddress } from '../lib/mail-address'
import { copyText, useContextMenu } from './ContextMenu'
import { ModalShell } from './Modal'
import MailTemplatePicker from './MailTemplatePicker'
import { primaryIdentityId, type MailSenderIdentity, type MailSignature } from '../mail-identity-types'
import { defaultIdentityId, identityLabel, LEGACY_SIGNATURE_ID, replaceSignatureBlock, replyIdentityId, signatureBlockHtml, signatureBlockUnchanged, signatureForIdentity, QUOTE_ATTRIBUTE, type ComposerSignature } from '../lib/mail-signature'
import MailSendOptionsControl from './MailSendOptionsControl'
import MailComposeOpenPgpControl from './MailComposeOpenPgpControl'
import MailComposeSmimeControl from './MailComposeSmimeControl'
import type { MailOpenPgpOptions } from '../openpgp-types'
import type { MailSmimeOptions } from '../smime-types'
import MailFormattingToolbar, { useRichEditorInput } from './MailFormattingToolbar'
import { useKeymapKeyDown } from '../lib/use-keymap'
import { ReplyWatchControl, armReplyWatch, replyWatchDeadline, type ReplyWatchSetting } from './MailReplyWatches'
import { describeExpansion, expandRecipientLists, recipientListLabel, recipientListPreview, suggestRecipientLists, type RecipientList } from '../lib/distribution-lists'
import { useRecipientLists } from './use-recipient-lists'
import { useRecipientDirectorySections } from './RecipientDirectory'
import { MailAiComposeAssist } from './MailAiComposeAssist'
import { aiFeatureAvailable, useAiAssistantStatus } from '../lib/use-ai-assistant'
import { cloudAttachmentsAvailable, confirmCloudLinks, MailCloudAttachments } from './MailCloudAttachments'
import MailMergeModal from './MailMerge'

interface MailComposeModalProps {
  accounts: MailAccountSummary[]
  draft?: MailDraftRecord
  replyTo?: MailThreadDetail
  replyAll?: boolean
  forward?: boolean
  initialTo?: string
  /** Plain text placed above the signature of a new message, e.g. an AI reply the user chose. */
  initialBody?: string
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

export default function MailComposeModal({ accounts, draft, replyTo, replyAll, forward, initialTo, initialBody, onClose, onSent, onToast }: MailComposeModalProps) {
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
  const signatureContext = replyTo ? 'reply' : 'new'
  const initialSignature = draft ? undefined : signatureForIdentity(undefined, accounts.find((account) => account.id === initialAccountId), [], signatureContext)
  const signature = draft ? '' : accounts.find((account) => account.id === initialAccountId)?.signature.trim() ?? ''
  const body = draft ? '' : initialBody?.trim() ?? ''
  const initialText = draft?.text ?? `${body}${signature ? `

-- 
${signature}` : ''}${forwardedText}`
  const initialHtml = draft?.html ?? `${body ? `<div>${escapeHtml(body)}</div>` : ''}${initialSignature ? `<div data-aerio-signature-spacer=""><br></div>${signatureBlockHtml(initialSignature)}` : ''}${forwardedText ? `<div ${QUOTE_ATTRIBUTE}="forward">${escapeHtml(forwardedText)}</div>` : ''}`
  const [accountId, setAccountId] = useState(initialAccountId)
  const [identityId, setIdentityId] = useState(draft?.fromIdentityId ?? primaryIdentityId(initialAccountId))
  const [identities, setIdentities] = useState<MailSenderIdentity[]>([])
  const [signatures, setSignatures] = useState<MailSignature[]>([])
  const [signatureChoice, setSignatureChoice] = useState(initialSignature?.id ?? '')
  const [replyToField, setReplyToField] = useState(draft?.replyTo?.join(', ') ?? '')
  const [replyToVisible, setReplyToVisible] = useState(Boolean(draft?.replyTo?.length))
  const insertedSignature = useRef<ComposerSignature | undefined>(initialSignature)
  const fromTouched = useRef(Boolean(draft))
  const [draftId, setDraftId] = useState(() => draft?.id ?? crypto.randomUUID())
  const [to, setTo] = useState(draft?.to.join(', ') ?? (forward ? '' : replyRecipients.join(', ') || initialTo || ''))
  const [cc, setCc] = useState(draft?.cc.join(', ') ?? replyCc.join(', '))
  const [bcc, setBcc] = useState(draft?.bcc.join(', ') ?? '')
  const [bccVisible, setBccVisible] = useState(Boolean(draft?.bcc.length))
  const [subject, setSubject] = useState(draft?.subject ?? (replyTo ? forward ? (/^fwd:/i.test(replyTo.subject) ? replyTo.subject : `Fwd: ${replyTo.subject}`) : (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : ''))
  const [text, setText] = useState(initialText)
  const [html, setHtml] = useState(initialHtml)
  const [attachments, setAttachments] = useState<{ name: string; size: number; path: string }[]>(() => (draft?.attachmentPaths ?? []).map((path) => ({ name: fileName(path), size: 0, path })))
  const [sendOptions, setSendOptions] = useState<MailSendOptions | undefined>(draft?.sendOptions)
  const [openPgp, setOpenPgp] = useState<MailOpenPgpOptions | undefined>(draft?.openPgp)
  const [smime, setSmime] = useState<MailSmimeOptions | undefined>(draft?.openPgp ? undefined : draft?.smime)
  // One protection method per message: choosing one turns the other off.
  const protectionTouched = useRef(Boolean(draft))
  const chooseOpenPgp = (next: MailOpenPgpOptions | undefined) => { protectionTouched.current = true; setOpenPgp(next); if (next) setSmime(undefined) }
  const chooseSmime = (next: MailSmimeOptions | undefined) => { protectionTouched.current = true; setSmime(next); if (next) setOpenPgp(undefined) }
  const protectedMessage = Boolean(openPgp?.sign || openPgp?.encrypt || smime?.sign || smime?.encrypt)
  const [replyWatch, setReplyWatch] = useState<ReplyWatchSetting>({ enabled: false, deadline: '' })
  const [scheduledFor, setScheduledFor] = useState(() => localDateTimeValue(draft?.status === 'scheduled' ? draft.deliveryAt : undefined))
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'sending' | 'closing' | 'failed'>(draft?.status === 'failed' ? 'failed' : draft ? 'saved' : 'idle')
  const [saveError, setSaveError] = useState(draft?.error)
  const [conflict, setConflict] = useState(false)
  const [recipientField, setRecipientField] = useState<'to' | 'cc' | 'bcc'>()
  const [recipientSuggestions, setRecipientSuggestions] = useState<MailRecipientSuggestion[]>([])
  // Distribution lists typed or picked in To/Cc/Bcc expand to their member addresses.
  const recipientLists = useRecipientLists()
  const fieldValue = (field: 'to' | 'cc' | 'bcc') => field === 'to' ? to : field === 'cc' ? cc : bcc
  const expandLists = (field: 'to' | 'cc' | 'bcc', pick?: RecipientList, suffix = '') => {
    const expansion = expandRecipientLists(fieldValue(field), recipientLists, pick)
    if (!expansion.expanded.length) return false
    ;(field === 'to' ? setTo : field === 'cc' ? setCc : setBcc)(expansion.value)
    setRecipientSuggestions([])
    onToast(`${describeExpansion(expansion)}${suffix}`)
    return true
  }
  const listSuggestions = recipientField ? suggestRecipientLists(fieldValue(recipientField).split(/[;,]/).at(-1) ?? '', recipientLists) : []
  // Personal contacts and the read-only organization directory follow the cached-mail suggestions (E41).
  const extraRecipients = useRecipientDirectorySections({
    accountId, query: recipientField ? fieldValue(recipientField).split(/[;,]/).at(-1)?.trim() ?? '' : '', enabled: Boolean(recipientField),
    exclude: recipientSuggestions, onChoose: (suggestion) => chooseRecipient(suggestion), onChooseMany: (suggestions, note) => { chooseRecipient(...suggestions); onToast(note) }, onToast
  })
  const ai = useAiAssistantStatus()
  const [aiOpen, setAiOpen] = useState(false)
  const [cloudOpen, setCloudOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
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
    attachmentPaths: attachments.map((item) => item.path),
    fromIdentityId: identityId !== primaryIdentityId(accountId) ? identityId : undefined,
    replyTo: replyToField.trim() ? splitAddresses(replyToField) : undefined,
    ...(sendOptions ? { sendOptions } : {}),
    ...(openPgp ? { openPgp } : {}),
    ...(smime ? { smime } : {})
  }), [accountId, attachments, bcc, cc, draft?.inReplyTo, draft?.references, draft?.threadId, draftId, forward, html, identityId, openPgp, replyMessage, replyTo?.id, replyToField, sendOptions, smime, subject, text, to])
  const fingerprint = useMemo(() => JSON.stringify(input), [input])
  const initialFingerprint = useRef(fingerprint)
  const latestFingerprint = useRef(fingerprint)
  const rebaseline = useRef(false)
  // Applying the default identity to an untouched composer is not a user edit, so it must not autosave a draft.
  if (rebaseline.current) {
    initialFingerprint.current = fingerprint
    rebaseline.current = false
  }
  latestFingerprint.current = fingerprint
  const hasContent = Boolean(to || cc || bcc || subject || text.trim() || attachments.length || /<(?:img|table)\b/i.test(html))
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

  const chooseRecipient = (...suggestions: MailRecipientSuggestion[]) => {
    if (!recipientField || !suggestions.length) return
    const value = recipientField === 'to' ? to : recipientField === 'cc' ? cc : bcc
    const parts = splitAddresses(value)
    const formatted = suggestions.map((suggestion) => {
      const displayName = suggestion.name && /[,;]/.test(suggestion.name) ? `"${suggestion.name.replaceAll('"', '')}"` : suggestion.name
      return displayName ? `${displayName} <${suggestion.email}>` : suggestion.email
    })
    if (/[,;]\s*$/.test(value) || !parts.length) parts.push(...formatted)
    else parts.splice(parts.length - 1, 1, ...formatted)
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
    setText((editor.innerText ?? editor.textContent ?? '').replaceAll('\u00a0', ' '))
  }

  const applySignature = (next: ComposerSignature | undefined, onlyIfUntouched = false) => {
    const editor = editorRef.current
    if (!editor || (onlyIfUntouched && !signatureBlockUnchanged(editor, insertedSignature.current))) return
    setSignatureChoice(next?.id ?? '')
    insertedSignature.current = next
    if (replaceSignatureBlock(editor, next)) updateEditor()
  }

  /** Switches the From identity, swapping only its signature block and default Reply-To. */
  const applyIdentity = (nextAccountId: string, nextIdentityId: string, available = identities, availableSignatures = signatures, onlyIfUntouched = false) => {
    const previous = available.find((item) => item.id === identityId)
    const next = available.find((item) => item.id === nextIdentityId)
    setAccountId(nextAccountId)
    setIdentityId(nextIdentityId)
    // Keep a Reply-To the user typed; replace one that came from the previous identity.
    if (splitAddresses(replyToField).join(', ') === (previous?.replyTo ?? []).join(', ')) {
      setReplyToField((next?.replyTo ?? []).join(', '))
      if (next?.replyTo.length) setReplyToVisible(true)
    }
    applySignature(signatureForIdentity(next, accounts.find((account) => account.id === nextAccountId), availableSignatures, signatureContext), onlyIfUntouched)
  }

  // A sender's S/MIME default applies to new messages until the user picks a protection choice.
  const senderIdentity = input.fromIdentityId
  useEffect(() => {
    const api = window.aerio?.smime
    if (!api || protectionTouched.current || !accountId) return
    let cancelled = false
    void api.identityDefault({ accountId, fromIdentityId: senderIdentity }).then((value) => {
      if (cancelled || protectionTouched.current || !value || !(value.sign || value.encrypt)) return
      // Not a user edit, so it must not autosave an otherwise untouched draft.
      rebaseline.current = latestFingerprint.current === initialFingerprint.current
      setSmime({ ...(value.sign ? { sign: true } : {}), ...(value.encrypt ? { encrypt: true } : {}) })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [accountId, senderIdentity])

  useEffect(() => {
    const api = window.aerio.mail.identities
    if (!api) return
    let cancelled = false
    void Promise.all([api.list(accounts.map((account) => account.id)), api.signatures.list()]).then(([loaded, loadedSignatures]) => {
      if (cancelled) return
      setIdentities(loaded)
      setSignatures(loadedSignatures)
      if (fromTouched.current) return
      const received = replyMessage ? [...replyMessage.to, ...replyMessage.cc] : []
      const chosen = replyTo ? replyIdentityId(loaded, accountId, received) : defaultIdentityId(loaded, accountId)
      rebaseline.current = latestFingerprint.current === initialFingerprint.current
      applyIdentity(accountId, chosen, loaded, loadedSignatures, true)
    }).catch(() => undefined)
    return () => { cancelled = true }
    // Identities load once per composer; later settings changes apply to the next composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const senderOptions = accounts.filter((account) => !draft || account.id === draft.accountId).flatMap((account) => {
    const own = identities.filter((identity) => identity.accountId === account.id)
    return own.length
      ? own.map((identity) => ({ accountId: account.id, id: identity.id, label: identityLabel(identity) }))
      : [{ accountId: account.id, id: primaryIdentityId(account.id), label: `${account.displayName} \u00b7 ${account.email}` }]
  })
  const currentAccount = accounts.find((account) => account.id === accountId)

  const editorInput = useRichEditorInput({ editorRef, onEditorChange: updateEditor, onToast })

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
    if ((['to', 'cc', 'bcc'] as const).filter((field) => expandLists(field, undefined, '. Review the recipients, then send again.')).length) return
    const recipients = [...input.to, ...input.cc, ...input.bcc]
    if (!recipients.length) {
      onToast('Add at least one recipient')
      return
    }
    if (recipients.some((recipient) => !isCompleteMailAddress(recipient))) {
      onToast('Finish or correct the recipient email addresses before sending')
      return
    }
    if (input.replyTo?.some((address) => !isCompleteMailAddress(address))) {
      onToast('Finish or correct the Reply-To email addresses before sending')
      return
    }
    const deliveryAt = scheduledFor ? new Date(scheduledFor) : undefined
    if (deliveryAt && (!Number.isFinite(deliveryAt.getTime()) || deliveryAt.getTime() <= Date.now())) {
      onToast('Choose a scheduled time in the future')
      return
    }
    if (!replyWatchDeadline(replyWatch).ok) {
      onToast('Choose a reply deadline in the future')
      return
    }
    if (!(await confirmCloudLinks(accountId, editorRef.current))) return
    setStatus('sending')
    try {
      const result = deliveryAt
        ? await window.aerio.mail.drafts.schedule({ ...input, expectedUpdatedAt: revision.current, expectedRemoteRevision: remoteRevision.current }, deliveryAt.toISOString())
        : await window.aerio.mail.drafts.send({ ...input, expectedUpdatedAt: revision.current, expectedRemoteRevision: remoteRevision.current })
      if (result.status === 'scheduled' || result.status === 'send-pending') await armReplyWatch(accountId, result.id, replyWatch, onToast)
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
  // Editor shortcuts from the keymap registry; scoped to the composer so they also work when it is popped out.
  const composeKeyDown = useKeymapKeyDown('compose', {
    'compose.send': () => { if (status !== 'sending' && status !== 'closing') void send() },
    'compose.saveDraft': () => { if (status !== 'saving' && status !== 'sending') void saveNow(input, true) }
  })
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
        <div className="compose" onKeyDown={composeKeyDown}>
          <div className="compose-row"><label>From</label><select value={identityId} disabled={senderOptions.length < 2} onChange={(event) => {
            const option = senderOptions.find((item) => item.id === event.target.value)
            if (!option) return
            fromTouched.current = true
            applyIdentity(option.accountId, option.id)
          }}>{senderOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></div>
          <div className="compose-row"><label>To</label><input autoFocus value={to} onFocus={() => setRecipientField('to')} onBlur={() => expandLists('to')} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" /></div>
          <div className="compose-row"><label>Cc</label><input value={cc} onFocus={() => setRecipientField('cc')} onBlur={() => expandLists('cc')} onChange={(event) => setCc(event.target.value)} /><button className="text-button" onClick={() => setBccVisible((value) => !value)}>Bcc</button><button className="text-button" onClick={() => setReplyToVisible((value) => !value)}>Reply-To</button></div>
          {bccVisible && <div className="compose-row"><label>Bcc</label><input value={bcc} onFocus={() => setRecipientField('bcc')} onBlur={() => expandLists('bcc')} onChange={(event) => setBcc(event.target.value)} /></div>}
          {(replyToVisible || replyToField) && <div className="compose-row"><label>Reply-To</label><input value={replyToField} onFocus={() => setRecipientField(undefined)} onChange={(event) => setReplyToField(event.target.value)} placeholder="replies@example.com" /></div>}
          {recipientField && (recipientSuggestions.length > 0 || listSuggestions.length > 0 || extraRecipients.count > 0) && <div className="recipient-suggestions">{listSuggestions.map((list) => <button key={list.id} className="recipient-list-suggestion" title={list.members.map((member) => member.email).join(', ')} onMouseDown={(event) => event.preventDefault()} onClick={() => expandLists(recipientField, list)}><span className="avatar">{list.members.length}</span><span><strong>{list.name} · {recipientListLabel(list)}</strong><small>{recipientListPreview(list)}</small></span></button>)}{recipientSuggestions.map((suggestion) => <button key={`${suggestion.accountId}:${suggestion.email}`} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseRecipient(suggestion)}><span className="avatar">{(suggestion.name || suggestion.email).slice(0, 2).toUpperCase()}</span><span><strong>{suggestion.name || suggestion.email}</strong><small>{suggestion.email}</small></span></button>)}{extraRecipients.nodes}</div>}
          <div className="compose-row"><label>Subject</label><input value={subject} onFocus={() => setRecipientField(undefined)} onChange={(event) => setSubject(event.target.value)} /></div>
          <MailFormattingToolbar editorRef={editorRef} onEditorChange={updateEditor} onToast={onToast}>
            {(signatures.length > 0 || Boolean(currentAccount?.signature.trim())) && <select className="compose-signature-select" aria-label="Signature" value={signatureChoice} onChange={(event) => {
              const stored = signatures.find((item) => item.id === event.target.value)
              applySignature(stored ? { id: stored.id, html: stored.html } : event.target.value === LEGACY_SIGNATURE_ID ? signatureForIdentity(undefined, currentAccount, [], signatureContext) : undefined)
            }}>
              <option value="">No signature</option>
              {currentAccount?.signature.trim() && <option value={LEGACY_SIGNATURE_ID}>Account signature</option>}
              {signatures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>}
            <MailTemplatePicker editorRef={editorRef} subject={subject} attachments={attachments} onEditorChange={updateEditor} onToast={onToast} onApplyTemplate={(changes) => {
              if (changes.subject) setSubject(changes.subject)
              setAttachments((current) => [...current, ...changes.attachments.filter((item) => !current.some((existing) => existing.path.toLowerCase() === item.path.toLowerCase()))])
            }} />
            {aiFeatureAvailable(ai, 'compose') && <button className={`icon-button ${aiOpen ? 'active' : ''}`} title="Draft or rephrase with AI" aria-pressed={aiOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setAiOpen((open) => !open)}><Sparkles size={15} /></button>}
          </MailFormattingToolbar>
          {aiOpen && ai && <MailAiComposeAssist status={ai} editorRef={editorRef} text={text} replyTo={!forward && replyMessage ? { accountId: replyMessage.accountId, threadId: replyMessage.threadId, messageId: replyMessage.id } : undefined} onEditorChange={updateEditor} onClose={() => setAiOpen(false)} />}
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
            {...editorInput}
          />
          {attachments.length > 0 && <div className="mail-compose-files">{attachments.map((file, index) => <span key={`${file.path}-${index}`} onContextMenu={(event) => showContextMenu(event, [
            { label: 'Copy filename', icon: Copy, action: () => copyText(file.name) },
            { label: 'Remove attachment', icon: Trash2, separatorBefore: true, danger: true, action: () => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex)) }
          ], file.name)}><Paperclip size={14} /><strong>{file.name}</strong>{file.size > 0 && <small>{formatFileSize(file.size)}</small>}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments((items) => items.filter((_, itemIndex) => index !== itemIndex))}><X size={13} /></button></span>)}</div>}
          <MailCloudAttachments open={cloudOpen} accountId={accountId} provider={currentAccount?.provider} attachments={attachments} recipients={[...input.to, ...input.cc, ...input.bcc]} editorRef={editorRef} onOpenChange={setCloudOpen} onEditorChange={updateEditor} onRemoveAttachment={(path) => setAttachments((items) => items.filter((item) => item.path !== path))} onToast={onToast} />
        </div>
        <footer className="compose-footer" onKeyDown={composeKeyDown}>
          <button className="icon-button" title="Attach files" onClick={() => void chooseAttachments()}><Paperclip size={18} /></button>
          {cloudAttachmentsAvailable(currentAccount?.provider) && <button className={`icon-button ${cloudOpen ? 'active' : ''}`} title="Share a file as a cloud link" aria-pressed={cloudOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setCloudOpen((value) => !value)}><Cloud size={18} /></button>}
          <button className="button ghost small" disabled={status === 'saving' || status === 'sending'} onClick={() => void saveNow(input, true)}><Save size={15} /> Save draft</button>
          {conflict && <button className="button ghost small" disabled={status === 'saving' || status === 'sending'} onClick={() => void saveAsCopy()}><Copy size={15} /> Save as copy</button>}
          <button className="button ghost small danger-subtle" disabled={status === 'sending'} onClick={() => void discard()}><Trash2 size={15} /> Discard</button>
          <MailSendOptionsControl provider={accounts.find((account) => account.id === accountId)?.provider} value={sendOptions} disabled={status === 'sending'} onChange={setSendOptions} />
          <MailComposeOpenPgpControl accountId={accountId} fromIdentityId={input.fromIdentityId} recipients={[...input.to, ...input.cc, ...input.bcc]} value={openPgp} disabled={status === 'sending'} onChange={chooseOpenPgp} />
          <MailComposeSmimeControl accountId={accountId} fromIdentityId={input.fromIdentityId} recipients={[...input.to, ...input.cc, ...input.bcc]} value={smime} disabled={status === 'sending'} onChange={chooseSmime} />
          {window.aerio.mail.merge && !replyTo && <button className="button ghost small" title={protectedMessage ? 'Mail merge does not sign or encrypt; turn off OpenPGP and S/MIME first' : 'Send a personalized copy to each recipient'} disabled={status === 'sending' || protectedMessage} onClick={() => setMergeOpen(true)}><Users size={15} /> Mail merge</button>}
          <span className="spacer" />
          <ReplyWatchControl value={replyWatch} onChange={setReplyWatch} />
          <label className="mail-schedule-field" title="Schedule delivery"><CalendarClock size={15} /><input aria-label="Scheduled delivery time" type="datetime-local" min={localDateTimeValue(new Date(Date.now() + 60_000).toISOString())} value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />{scheduledFor && <button type="button" aria-label="Clear scheduled delivery" onClick={() => setScheduledFor('')}><X size={13} /></button>}</label>
          <button className="button primary" disabled={status === 'sending' || status === 'closing'} onClick={() => void send()}><Send size={16} /> {status === 'sending' ? scheduledFor ? 'Scheduling…' : 'Queuing…' : scheduledFor ? 'Schedule' : 'Send'}</button>
        </footer>
        {mergeOpen && <MailMergeModal accounts={accounts} message={{ accountId, fromIdentityId: input.fromIdentityId, replyTo: input.replyTo, subject, text, html: input.html, attachmentPaths: input.attachmentPaths, sendOptions }} initialList={to} ignoredCopies={input.cc.length + input.bcc.length} onToast={onToast} onClose={() => setMergeOpen(false)} />}
    </ModalShell>
  )
}
