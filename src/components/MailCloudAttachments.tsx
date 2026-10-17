import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Cloud, RotateCw, Trash2, X } from 'lucide-react'
import type { CloudAttachmentStatus, CloudPendingUpload, CloudShareAudience, CloudShareOptions, CloudShareRole, CloudStorageAccount, CloudUploadProgress, CloudUploadResult } from '../cloud-attachment-types'
import type { MailProviderId } from '../mail-types'
import { formatFileSize } from '../lib/domain'
import { attachmentBytes, cloudAudienceLabel, cloudLinkHtml, cloudLinkUrls, cloudProviderName, shareScopeLabel } from '../lib/cloud-attachments'
import { SIGNATURE_ATTRIBUTE } from '../lib/mail-signature'
import { insertHtmlAtRange } from './MailTemplatePicker'
import { CloudCapabilityList } from './CloudStorageAccountsSection'

interface ComposerFile { name: string; size: number; path: string }

const friendlyError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback : fallback
const bareAddress = (value: string) => value.trim().match(/<([^<>]+)>$/)?.[1].trim() ?? value.trim()

/** Gmail and Microsoft accounts have their own storage; any account can use a connected Dropbox, ownCloud or Nextcloud. */
export const cloudAttachmentsAvailable = (provider?: MailProviderId) => Boolean(provider && provider !== 'local' && window.aerio?.mail?.cloudAttachments)

const MAIL_STORAGE = 'mail'
const dateInput = (time: number) => new Date(time).toISOString().slice(0, 10)

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
  const [linked, setLinked] = useState<CloudStorageAccount[]>([])
  const [target, setTarget] = useState<string>()
  const [password, setPassword] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
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
      const [next, interrupted, storage] = await Promise.all([api.status(accountId), api.pending(accountId), api.storage?.snapshot().catch(() => undefined)])
      setStatus(next)
      setPending(interrupted)
      setLinked((storage?.accounts ?? []).filter((item) => item.status !== 'error'))
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

  // The mail account's own storage comes first; otherwise the first connected storage account.
  const selected = target ?? (status?.supported ? MAIL_STORAGE : linked[0]?.id ?? MAIL_STORAGE)
  const account = selected === MAIL_STORAGE ? undefined : linked.find((item) => item.id === selected)
  const audiences = account ? account.capabilities.audiences : status?.audiences ?? []

  useEffect(() => {
    if (audiences.length && !audiences.includes(audience)) setAudience(audiences[0])
    if (account?.capabilities.edit === 'unavailable' && role === 'edit') setRole('view')
  }, [account, audience, audiences, role])

  if (!api) return null
  const storageProvider = account?.provider ?? status?.provider
  const storage = account ? account.name : status?.provider ? cloudProviderName(status.provider) : provider === 'gmail' ? 'Google Drive' : provider === 'microsoft' ? 'OneDrive' : 'cloud storage'
  const mailName = provider === 'gmail' ? 'Gmail' : provider === 'microsoft' ? 'Outlook' : 'your mail server'
  const usable = Boolean(account || (status?.supported && selected === MAIL_STORAGE))
  const oversized = Boolean(status && (status.supported || linked.length > 0) && totalBytes > status.attachmentLimitBytes)
  const shareRecipients = Array.from(new Set(recipients.map((item) => bareAddress(item).toLowerCase()).filter(Boolean)))
  const capabilities = account?.capabilities
  const share: CloudShareOptions = {
    audience, role,
    ...(audience === 'recipients' ? { recipients: shareRecipients } : {}),
    ...(capabilities && capabilities.password !== 'unavailable' && password ? { password } : {}),
    ...(capabilities && capabilities.expiry !== 'unavailable' && expiresOn ? { expiresOn } : {})
  }
  const missing = audience === 'recipients' && !shareRecipients.length ? 'Add recipients to the message first.'
    : capabilities?.password === 'enforced' && !password ? `${storage} requires a link password.`
      : capabilities?.expiry === 'enforced' && !expiresOn ? `${storage} requires an expiry date.` : undefined

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
    void run(() => account ? api.upload(id, accountId, file.path, share, account.id) : api.upload(id, accountId, file.path, share), id, file)
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
      {status && (linked.length > 0 && (status.supported || linked.length > 1)) && <label className="cloud-attach-target">Store in
        <select aria-label="Store in" value={selected} disabled={Boolean(busy)} onChange={(event) => setTarget(event.target.value)}>
          {status.supported && <option value={MAIL_STORAGE}>{status.provider ? cloudProviderName(status.provider) : 'This account'} (this mail account)</option>}
          {linked.map((item) => <option key={item.id} value={item.id}>{item.name}{item.status === 'needs-auth' ? ' (sign-in needed)' : ''}</option>)}
        </select>
      </label>}
      {status && !status.supported && !linked.length && <p>{status.message} Connect one in Settings → Cloud storage accounts.</p>}
      {status?.supported && !status.connected && selected === MAIL_STORAGE && <div className="cloud-attach-consent">
        <p>{status.message}</p>
        <p className="muted">This opens a {provider === 'gmail' ? 'Google' : 'Microsoft'} sign-in for this account and adds only this permission; your mail access is unchanged.</p>
        <button className="button small" disabled={busy === 'connect'} onClick={() => void connect()}>{busy === 'connect' ? 'Waiting for sign-in…' : `Connect ${storage}`}</button>
      </div>}
      {account?.status === 'needs-auth' && <p className="cloud-attach-error" role="alert">{account.error ?? `Sign in to ${account.name} again in Settings → Cloud storage accounts.`}</p>}
      {status && usable && (account ? account.status === 'ready' : status.connected) && <>
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
          {audiences.map((value) => <label key={value}><input type="radio" name={`cloud-audience-${accountId}`} checked={audience === value} onChange={() => setAudience(value)} /> {cloudAudienceLabel(storageProvider!, value)}</label>)}
          {!audiences.length && <p className="muted">This account does not allow sharing links.</p>}
          <label className="cloud-attach-role">Access <select aria-label="Access level" value={role} onChange={(event) => setRole(event.target.value as CloudShareRole)}><option value="view">Can view</option>{capabilities?.edit !== 'unavailable' && <option value="edit">Can edit</option>}</select></label>
          {capabilities && capabilities.password !== 'unavailable' && <label className="cloud-attach-role">Link password{capabilities.password === 'enforced' ? ' (required)' : ' (optional)'} <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
          {capabilities && capabilities.expiry !== 'unavailable' && <label className="cloud-attach-role">Expires on{capabilities.expiry === 'enforced' ? ' (required)' : ' (optional)'} <input type="date" value={expiresOn} min={dateInput(Date.now() + 86_400_000)} {...(capabilities.maxExpiryDays ? { max: dateInput(Date.now() + capabilities.maxExpiryDays * 86_400_000) } : {})} onChange={(event) => setExpiresOn(event.target.value)} /></label>}
        </fieldset>
        {capabilities && <CloudCapabilityList capabilities={capabilities} label={`${storage} sharing capabilities`} />}
        <p className="cloud-attach-summary" aria-live="polite">{missing ?? `${shareScopeLabel(storageProvider!, share)}. ${audience === 'anyone' ? `Anyone the link is forwarded to can open it${share.password ? ' with the password' : ''}.` : ''}`}</p>
        {busy === 'upload' && <div className="cloud-attach-progress">
          <progress max={100} value={percent} aria-label="Upload progress" />
          <span>{progress ? `${formatFileSize(progress.sentBytes)} of ${formatFileSize(progress.totalBytes)}` : 'Starting…'}</span>
          <button className="button ghost small" onClick={() => uploadId.current && void api.cancel(uploadId.current)}>Cancel upload</button>
        </div>}
        {!busy && <div className="cloud-attach-actions">
          <button className="button primary small" disabled={!file || Boolean(missing) || !audiences.length} onClick={upload}>Upload and insert link</button>
          {file?.fromAttachments && <span className="muted">The file stays attached until the link is inserted.</span>}
        </div>}
      </>}
      {error && <p className="cloud-attach-error" role="alert">{error}</p>}
    </section>}
  </>
}
