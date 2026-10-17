import { Lock, Paperclip, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailMessageDetail } from '../mail-types'
import { messageLooksSmime, type SmimeDecryptResult, type SmimeMessageStatus, type SmimeSignatureResult } from '../smime-types'
import { formatFileSize } from '../lib/domain'
import type { SignatureTone } from '../lib/openpgp-display'
import { friendlySmimeError, smimeSignatureSummary } from '../lib/smime-display'
import MessageHtml from './MessageHtml'
import SmimeCertificateDetails from './SmimeCertificateDetails'

interface SmimeMessageNoticeProps {
  message: Pick<MailMessageDetail, 'accountId' | 'threadId' | 'id' | 'attachments'>
}

const toneIcon: Record<SignatureTone, typeof ShieldCheck> = { good: ShieldCheck, warning: ShieldQuestion, bad: ShieldAlert }
const worstTone = (results: SmimeSignatureResult[]): SignatureTone => {
  const tones = results.map((result) => smimeSignatureSummary(result).tone)
  return tones.includes('bad') ? 'bad' : tones.includes('warning') ? 'warning' : 'good'
}

function Signatures({ results }: { results: SmimeSignatureResult[] }) {
  return <ul className="openpgp-signatures">{results.map((result, index) => {
    const summary = smimeSignatureSummary(result)
    return <li key={`${result.signer?.fingerprint ?? 'unknown'}-${index}`} className={`openpgp-${summary.tone}`}>
      {summary.text}
      {result.signedAt && <small> Signed {new Date(result.signedAt).toLocaleString()}.</small>}
      {result.signer && <SmimeCertificateDetails cert={result.signer} summaryLabel="Signer certificate" />}
    </li>
  })}</ul>
}

// Verification and decryption banner for S/MIME mail. Decrypted content is
// held only in this component's state; it is never written to the mail cache.
export default function SmimeMessageNotice({ message }: SmimeMessageNoticeProps) {
  const api = window.aerio?.smime
  const candidate = Boolean(api) && messageLooksSmime(message)
  const ref = { accountId: message.accountId, threadId: message.threadId, messageId: message.id }
  const [status, setStatus] = useState<SmimeMessageStatus>()
  const [opened, setOpened] = useState<Extract<SmimeDecryptResult, { status: 'decrypted' }>>()
  const [prompt, setPrompt] = useState<Extract<SmimeDecryptResult, { status: 'passphrase-required' }>>()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setStatus(undefined); setOpened(undefined); setPrompt(undefined); setError('')
    if (!candidate || !api) return
    let active = true
    void api.inspect({ accountId: message.accountId, threadId: message.threadId, messageId: message.id })
      .then((next) => { if (active) setStatus(next) })
      .catch((failure) => { if (active) setError(friendlySmimeError(failure, 'S/MIME details could not be read')) })
    return () => { active = false }
  }, [api, candidate, message.accountId, message.id, message.threadId])

  if (!candidate || !api || (!status && !error) || status?.kind === 'none') return null

  const open = async (withPassphrase?: string) => {
    setBusy(true); setError('')
    try {
      const result = await api.decrypt(ref, withPassphrase)
      if (result.status === 'passphrase-required') setPrompt(result)
      else { setOpened(result); setPrompt(undefined); setPassphrase('') }
    } catch (failure) {
      setError(friendlySmimeError(failure, 'This message could not be opened'))
    } finally { setBusy(false) }
  }
  const saveAttachment = async (index: number) => {
    setError('')
    try { await api.saveAttachment(ref, index) } catch (failure) { setError(friendlySmimeError(failure, 'The attachment could not be saved')) }
  }

  const encrypted = status?.kind === 'encrypted'
  const signatures = opened?.signatures ?? status?.signatures ?? []
  const tone: SignatureTone = status?.error ? 'bad' : signatures.length ? worstTone(signatures) : 'good'
  const Icon = encrypted ? Lock : toneIcon[tone]
  const decryptable = status?.encryptedTo?.some((item) => item.available)

  return (
    <div className={`openpgp-notice smime-notice openpgp-${tone}`} role="status">
      <Icon size={15} aria-hidden="true" />
      <div>
        {encrypted && <p><strong>{opened ? 'Decrypted S/MIME message.' : 'This message is encrypted with S/MIME.'}</strong>
          {status?.algorithm && <small> {status.algorithm}.</small>}
          {!opened && !decryptable && status && !status.error && <small> It was not encrypted to any of your certificates.</small>}
          {!opened && decryptable && !prompt && <span className="mail-receipt-actions"><button type="button" disabled={busy} onClick={() => void open()}>{busy ? 'Decrypting…' : 'Decrypt'}</button></span>}
        </p>}
        {status?.kind === 'signed' && !status.error && <p><strong>S/MIME signed message.</strong></p>}
        {status?.kind === 'signed-opaque' && !status.error && <p><strong>S/MIME signed message.</strong>
          {!opened && <span className="mail-receipt-actions"><button type="button" disabled={busy} onClick={() => void open()}>Show signed content</button></span>}
        </p>}
        {prompt && <form className="mail-openpgp-unlock" onSubmit={(event) => { event.preventDefault(); void open(passphrase) }}>
          <small>Enter the passphrase for your certificate {prompt.subject}.</small>
          <input type="password" aria-label="Certificate passphrase" autoComplete="off" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} />
          <button type="submit" className="button ghost small" disabled={busy || !passphrase}>Unlock and decrypt</button>
          {prompt.error && <small className="diagnostic-error">{prompt.error}</small>}
        </form>}
        {signatures.length > 0 && <Signatures results={signatures} />}
        {encrypted && opened && signatures.length === 0 && <p><small>The decrypted message is not signed, so its sender cannot be confirmed.</small></p>}
        {status?.error && <p><small className="diagnostic-error">{status.error}</small></p>}
        {error && <p><small className="diagnostic-error">{error}</small></p>}
        {opened && <div className="openpgp-decrypted">
          {opened.sanitizedHtml ? <MessageHtml className="message-body mail-html" html={opened.sanitizedHtml} /> : <div className="message-body mail-text">{opened.text}</div>}
          {opened.attachments.length > 0 && <ul className="openpgp-attachments">{opened.attachments.map((item) => <li key={item.index}>
            <Paperclip size={13} aria-hidden="true" /> {item.filename} <small>{formatFileSize(item.size)}</small>
            <button type="button" className="button ghost small" onClick={() => void saveAttachment(item.index)}>Save…</button>
          </li>)}</ul>}
        </div>}
      </div>
    </div>
  )
}
