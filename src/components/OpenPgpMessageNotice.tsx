import { Lock, Paperclip, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailMessageDetail } from '../mail-types'
import { messageLooksOpenPgp, type OpenPgpDecryptResult, type OpenPgpMessageStatus, type OpenPgpSignatureResult } from '../openpgp-types'
import { formatFileSize } from '../lib/domain'
import { formatFingerprint, friendlyOpenPgpError, signatureSummary, type SignatureTone } from '../lib/openpgp-display'
import MessageHtml from './MessageHtml'

interface OpenPgpMessageNoticeProps {
  message: Pick<MailMessageDetail, 'accountId' | 'threadId' | 'id' | 'text' | 'attachments'>
}

const toneIcon: Record<SignatureTone, typeof ShieldCheck> = { good: ShieldCheck, warning: ShieldQuestion, bad: ShieldAlert }
const worstTone = (results: OpenPgpSignatureResult[]): SignatureTone => {
  const tones = results.map((result) => signatureSummary(result).tone)
  return tones.includes('bad') ? 'bad' : tones.includes('warning') ? 'warning' : 'good'
}

function Signatures({ results }: { results: OpenPgpSignatureResult[] }) {
  return <ul className="openpgp-signatures">{results.map((result, index) => {
    const summary = signatureSummary(result)
    return <li key={`${result.keyId}-${index}`} className={`openpgp-${summary.tone}`}>
      {summary.text}
      {result.fingerprint && <small> Fingerprint {formatFingerprint(result.fingerprint)}{result.signedAt ? ` · signed ${new Date(result.signedAt).toLocaleString()}` : ''}</small>}
    </li>
  })}</ul>
}

// Verification and decryption banner for OpenPGP mail. Decrypted content is
// held only in this component's state; it is never written to the mail cache.
export default function OpenPgpMessageNotice({ message }: OpenPgpMessageNoticeProps) {
  const api = window.aerio?.openPgp
  const candidate = Boolean(api) && messageLooksOpenPgp(message)
  const ref = { accountId: message.accountId, threadId: message.threadId, messageId: message.id }
  const [status, setStatus] = useState<OpenPgpMessageStatus>()
  const [decrypted, setDecrypted] = useState<Extract<OpenPgpDecryptResult, { status: 'decrypted' }>>()
  const [prompt, setPrompt] = useState<Extract<OpenPgpDecryptResult, { status: 'passphrase-required' }>>()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setStatus(undefined); setDecrypted(undefined); setPrompt(undefined); setError('')
    if (!candidate || !api) return
    let active = true
    void api.inspect({ accountId: message.accountId, threadId: message.threadId, messageId: message.id })
      .then((next) => { if (active) setStatus(next) })
      .catch((failure) => { if (active) setError(friendlyOpenPgpError(failure, 'OpenPGP details could not be read')) })
    return () => { active = false }
  }, [api, candidate, message.accountId, message.id, message.threadId])

  if (!candidate || !api || (!status && !error) || status?.kind === 'none') return null

  const decrypt = async (withPassphrase?: string) => {
    setBusy(true); setError('')
    try {
      const result = await api.decrypt(ref, withPassphrase)
      if (result.status === 'passphrase-required') setPrompt(result)
      else { setDecrypted(result); setPrompt(undefined); setPassphrase('') }
    } catch (failure) {
      setError(friendlyOpenPgpError(failure, 'This message could not be decrypted'))
    } finally { setBusy(false) }
  }
  const saveAttachment = async (index: number) => {
    setError('')
    try { await api.saveAttachment(ref, index) } catch (failure) { setError(friendlyOpenPgpError(failure, 'The attachment could not be saved')) }
  }

  const encrypted = status?.kind === 'encrypted' || status?.kind === 'inline-encrypted'
  const signatures = decrypted?.signatures ?? status?.signatures ?? []
  const tone: SignatureTone = status?.error ? 'bad' : signatures.length ? worstTone(signatures) : 'good'
  const Icon = encrypted ? Lock : toneIcon[tone]
  const decryptable = status?.encryptedTo?.some((item) => item.available)

  return (
    <div className={`openpgp-notice openpgp-${tone}`} role="status">
      <Icon size={15} aria-hidden="true" />
      <div>
        {encrypted && <p><strong>{decrypted ? 'Decrypted OpenPGP message.' : 'This message is encrypted with OpenPGP.'}</strong>
          {!decrypted && !decryptable && status && !status.error && <small> It was not encrypted to any private key in your keyring.</small>}
          {!decrypted && decryptable && !prompt && <span className="mail-receipt-actions"><button type="button" disabled={busy} onClick={() => void decrypt()}>{busy ? 'Decrypting…' : 'Decrypt'}</button></span>}
        </p>}
        {!encrypted && status && !status.error && <p><strong>{status.kind === 'inline-signed' ? 'Inline OpenPGP signature.' : 'OpenPGP signed message.'}</strong></p>}
        {prompt && <form className="mail-openpgp-unlock" onSubmit={(event) => { event.preventDefault(); void decrypt(passphrase) }}>
          <small>Enter the passphrase for {prompt.userId} ({formatFingerprint(prompt.fingerprint).slice(-19)}).</small>
          <input type="password" aria-label="Key passphrase" autoComplete="off" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} />
          <button type="submit" className="button ghost small" disabled={busy || !passphrase}>Unlock and decrypt</button>
          {prompt.error && <small className="diagnostic-error">{prompt.error}</small>}
        </form>}
        {signatures.length > 0 && <Signatures results={signatures} />}
        {encrypted && decrypted && signatures.length === 0 && <p><small>The decrypted message is not signed, so its sender cannot be confirmed.</small></p>}
        {status?.error && <p><small className="diagnostic-error">{status.error}</small></p>}
        {error && <p><small className="diagnostic-error">{error}</small></p>}
        {decrypted && <div className="openpgp-decrypted">
          {decrypted.sanitizedHtml ? <MessageHtml className="message-body mail-html" html={decrypted.sanitizedHtml} /> : <div className="message-body mail-text">{decrypted.text}</div>}
          {decrypted.attachments.length > 0 && <ul className="openpgp-attachments">{decrypted.attachments.map((item) => <li key={item.index}>
            <Paperclip size={13} aria-hidden="true" /> {item.filename} <small>{formatFileSize(item.size)}</small>
            <button type="button" className="button ghost small" onClick={() => void saveAttachment(item.index)}>Save…</button>
          </li>)}</ul>}
        </div>}
      </div>
    </div>
  )
}
