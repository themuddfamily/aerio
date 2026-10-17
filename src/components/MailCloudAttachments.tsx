import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Cloud, RotateCw, Trash2, X } from 'lucide-react'
import type { CloudAttachmentStatus, CloudPendingUpload, CloudShareAudience, CloudShareRole, CloudUploadProgress, CloudUploadResult } from '../cloud-attachment-types'
import type { MailProviderId } from '../mail-types'
import { formatFileSize } from '../lib/domain'
import { attachmentBytes, CLOUD_AUDIENCE_LABELS, cloudLinkHtml, cloudLinkUrls, cloudProviderName, shareScopeLabel } from '../lib/cloud-attachments'
import { SIGNATURE_ATTRIBUTE } from '../lib/mail-signature'
import { insertHtmlAtRange } from './MailTemplatePicker'

interface ComposerFile { name: string; size: number; path: string }

const friendlyError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback : fallback
const bareAddress = (value: string) => value.trim().match(/<([^<>]+)>$/)?.[1].trim() ?? value.trim()

export const cloudAttachmentsAvailable = (provider?: MailProviderId) => (provider === 'gmail' || provider === 'microsoft') && Boolean(window.aerio?.mail?.cloudAttachments)

/**
 * Re-checks the cloud links in the message before it is sent. Returns false when
 * the user chose not to send a message whose links no longer open.
 */
export async function confirmCloudLinks(accountId: string, editor: HTMLElement | null) {
  const api = window.aerio?.mail?.cloudAttachments
  const urls = cloudLinkUrls(editor)
  if (!api || !urls.length) return true
  const issues = await api.verify(accountId, urls).catch(() => [])
  if (!issues.length) return true
  return window.confirm(`${issues.map((issue) => issue.message).join('\n')}\n\nSend anyway?`)
}

/**
 * Uploads a file to the account's Google Drive or OneDrive and inserts a sharing
 * link. The sharing scope is shown before upload; nothing is shared until the
 * user confirms, and ordinary attachments stay available.
 */
export function MailCloudAttachments({ open, accountId, provider, attachments, recipients, editorRef, onOpenChange, onEditorChange, onRemoveAttachment, onToast }: {
  open: boolean
  accountId: string
  provider?: MailProviderId
  attachments: ComposerFile[]
  recipients: string[]
  editorRef: RefObject<HTMLDivElement | null>
  onOpenChange(open: boolean): void
  onEditorChange(): void
  /** Called after a composer attachment was replaced by its cloud link. */
  onRemoveAttachment(path: string): void
  onToast(message: string): void
}) {
  const api = cloudAttachmentsAvailable(provider) ? window.aerio.mail.cloudAttachments : undefined
  const [status, setStatus] = useState<CloudAttachmentStatus>()
  const [pending, setPending] = useState<CloudPendingUpload[]>([])
  const [file, setFile] = useState<ComposerFile & { fromAttachments?: boolean }>()
  const [audience, setAudience] = useState<CloudShareAudience>('anyone')
  const [role, setRole] = useState<CloudShareRole>('view')
  const [busy, setBusy] = useState<'connect' | 'upload'>()
  const [progress, setProgress] = useState<CloudUploadProgress>()
  const [error, setError] = useState<string>()
  const uploadId = useRef<string>(undefined)
  const savedRange = useRef<Range | undefined>(undefined)
  const totalBytes = attachmentBytes(attachments)

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const [next, interrupted] = await Promise.all([api.status(accountId), api.pending(accountId)])
      setStatus(next)
      setPending(interrupted)
    } catch {
      setStatus(undefined)
    }
  }, [accountId, api])

  // Status is only needed once a file might be too large, or the panel is open.
  useEffect(() => { if (open || totalBytes > 0) void refresh() }, [open, refresh, totalBytes > 0])

  useEffect(() => {
    if (!api) return
    return api.onProgress((value) => { if (value.uploadId === uploadId.current) setProgress(value) })
  }, [api])

  useEffect(() => {
    if (!open) return
    const editor = editorRef.current
    const selection = editor?.ownerDocument.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined
    savedRange.current = editor && range && editor.contains(range.commonAncestorContainer) ? range.cloneRange() : undefined
    setError(undefined)
  }, [editorRef, open])

  useEffect(() => {
    if (status?.audiences.length && !status.audiences.includes(audience)) setAudience(status.audiences[0])
  }, [audience, status])

  if (!api) return null
  const storage = status?.provider ? cloudProviderName(status.provider) : provider === 'gmail' ? 'Google Drive' : 'OneDrive'
  const mailName = provider === 'gmail' ? 'Gmail' : 'Outlook'
  const oversized = Boolean(status?.supported && totalBytes > status.attachmentLimitBytes)
  const shareRecipients = Array.from(new Set(recipients.map((item) => bareAddress(item).toLowerCase()).filter(Boolean)))
  const share = { audience, role, ...(audience === 'recipients' ? { recipients: shareRecipients } : {}) }

  const startFor = (item: ComposerFile) => {
    setFile({ ...item, fromAttachments: true })
    onOpenChange(true)
  }

  const chooseFile = async () => {
    try {
      const [selected] = await window.aerio.chooseAttachments()
      if (selected?.path) setFile({ name: selected.name, size: selected.size, path: selected.path })
    } catch (reason) {
      onToast(friendlyError(reason, 'The file could not be selected'))
    }
  }

  const insertLink = (html: string) => {
    const editor = editorRef.current
    if (!editor) return
    let range = savedRange.current
    const signature = editor.querySelector(`[${SIGNATURE_ATTRIBUTE}]`)
    if (!range && signature) {
      // Without a caret, links go above the signature rather than after quoted text.
      range = editor.ownerDocument.createRange()
      range.setStartBefore(signature)
      range.collapse(true)
    }
    savedRange.current = insertHtmlAtRange(editor, html, range)
    onEditorChange()
  }

  const finish = (result: CloudUploadResult, source?: ComposerFile & { fromAttachments?: boolean }) => {
    if (result.status === 'cancelled') {
      onToast('Upload cancelled; nothing was shared')
      return
    }
    insertLink(cloudLinkHtml(result.link))
    if (source?.fromAttachments) onRemoveAttachment(source.path)
    onToast(`Link to ${result.link.name} inserted · ${result.link.scopeLabel}`)
    setFile(undefined)
    onOpenChange(false)
  }

  const run = async (start: () => Promise<CloudUploadResult>, id: string, source?: ComposerFile & { fromAttachments?: boolean }) => {
    uploadId.current = id
    setBusy('upload')
    setError(undefined)
    setProgress(undefined)
    try {
      finish(await start(), source)
    } catch (reason) {
      setError(friendlyError(reason, 'The file could not be shared'))
    } finally {
      uploadId.current = undefined
      setBusy(undefined)
      setProgress(undefined)
      void refresh()
    }
  }

  const upload = () => {
    if (!file) return
    const id = crypto.randomUUID()
    void run(() => api.upload(id, accountId, file.path, share), id, file)
  }

  const connect = async () => {
    setBusy('connect')
    setError(undefined)
    try {
      const next = await api.connect(accountId)
      setStatus(next)
      if (!next.connected) setError(next.message)
    } catch (reason) {
      setError(friendlyError(reason, `${storage} could not be connected`))
    } finally {
      setBusy(undefined)
    }
  }

  const discard = async (item: CloudPendingUpload) => {
    await api.discard(item.uploadId).catch(() => undefined)
    void refresh()
  }

  const percent = progress?.totalBytes ? Math.min(100, Math.round(progress.sentBytes / progress.totalBytes * 100)) : 0

  return <>
    {oversized && !open && <div className="cloud-attach-notice" role="status">
      <span>These attachments total {formatFileSize(totalBytes)}, more than {mailName} usually accepts ({formatFileSize(status!.attachmentLimitBytes)}). Share large files as {storage} links instead:</span>
      {[...attachments].filter((item) => item.size > 0).sort((a, b) => b.size - a.size).slice(0, 3).map((item) => <button key={item.path} className="text-button" onClick={() => startFor(item)}><Cloud size={13} /> {item.name}</button>)}
    </div>}
    {open && <section className="cloud-attach-panel" aria-label="Cloud attachment">
      <header>
        <strong><Cloud size={15} /> Share from {storage}</strong>
        <button className="icon-button" aria-label="Close cloud attachment" disabled={busy === 'upload'} onClick={() => onOpenChange(false)}><X size={14} /></button>
      </header>
      {!status && <p>Checking {storage}…</p>}
      {status && !status.supported && <p>{status.message}</p>}
      {status?.supported && !status.connected && <div className="cloud-attach-consent">
        <p>{status.message}</p>
        <p className="muted">This opens a {provider === 'gmail' ? 'Google' : 'Microsoft'} sign-in for this account and adds only this permission; your mail access is unchanged.</p>
        <button className="button small" disabled={busy === 'connect'} onClick={() => void connect()}>{busy === 'connect' ? 'Waiting for sign-in…' : `Connect ${storage}`}</button>
      </div>}
      {status?.supported && status.connected && <>
        {pending.length > 0 && !busy && <ul className="cloud-attach-pending" aria-label="Interrupted uploads">{pending.map((item) => <li key={item.uploadId}>
          <span>Interrupted upload of <strong>{item.name}</strong> ({formatFileSize(item.totalBytes)}) · {shareScopeLabel(item.provider, item.share)}</span>
          <button className="text-button" onClick={() => void run(() => api.resume(item.uploadId), item.uploadId)}><RotateCw size={13} /> Resume</button>
          <button className="text-button danger-subtle" onClick={() => void discard(item)}><Trash2 size={13} /> Discard</button>
        </li>)}</ul>}
        <div className="cloud-attach-file">
          {file ? <span><strong>{file.name}</strong>{file.size > 0 && <small> {formatFileSize(file.size)}</small>}</span> : <span className="muted">No file selected</span>}
          <button className="text-button" disabled={Boolean(busy)} onClick={() => void chooseFile()}>{file ? 'Choose another…' : 'Choose file…'}</button>
        </div>
        <fieldset className="cloud-attach-scope" disabled={Boolean(busy)}>
          <legend>Who can open it</legend>
          {status.audiences.map((value) => <label key={value}><input type="radio" name={`cloud-audience-${accountId}`} checked={audience === value} onChange={() => setAudience(value)} /> {CLOUD_AUDIENCE_LABELS[value]}</label>)}
          <label className="cloud-attach-role">Access <select aria-label="Access level" value={role} onChange={(event) => setRole(event.target.value as CloudShareRole)}><option value="view">Can view</option><option value="edit">Can edit</option></select></label>
        </fieldset>
        <p className="cloud-attach-summary" aria-live="polite">{audience === 'recipients' && !shareRecipients.length ? 'Add recipients to the message first.' : `${shareScopeLabel(status.provider!, share)}. ${audience === 'anyone' ? 'Anyone the link is forwarded to can open it.' : ''}`}</p>
        {busy === 'upload' && <div className="cloud-attach-progress">
          <progress max={100} value={percent} aria-label="Upload progress" />
          <span>{progress ? `${formatFileSize(progress.sentBytes)} of ${formatFileSize(progress.totalBytes)}` : 'Starting…'}</span>
          <button className="button ghost small" onClick={() => uploadId.current && void api.cancel(uploadId.current)}>Cancel upload</button>
        </div>}
        {!busy && <div className="cloud-attach-actions">
          <button className="button primary small" disabled={!file || (audience === 'recipients' && !shareRecipients.length)} onClick={upload}>Upload and insert link</button>
          {file?.fromAttachments && <span className="muted">The file stays attached until the link is inserted.</span>}
        </div>}
      </>}
      {error && <p className="cloud-attach-error" role="alert">{error}</p>}
    </section>}
  </>
}
