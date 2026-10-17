import { ShieldCheck, ShieldOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailSmimeOptions, SmimePreflight } from '../smime-types'
import { formatCertificateFingerprint, friendlySmimeError } from '../lib/smime-display'

interface MailComposeSmimeControlProps {
  accountId: string
  fromIdentityId?: string
  recipients: string[]
  value?: MailSmimeOptions
  disabled?: boolean
  onChange(next: MailSmimeOptions | undefined): void
}

const normalize = (value: MailSmimeOptions): MailSmimeOptions | undefined =>
  value.sign || value.encrypt ? { ...(value.sign ? { sign: true } : {}), ...(value.encrypt ? { encrypt: true } : {}), ...(value.recipientCerts && Object.keys(value.recipientCerts).length ? { recipientCerts: value.recipientCerts } : {}) } : undefined

// Compact S/MIME Sign/Encrypt picker for the composer footer. Turning it on
// turns OpenPGP off (the composer enforces one method), and the main process
// checks again before queuing and refuses to fall back to plaintext.
export default function MailComposeSmimeControl({ accountId, fromIdentityId, recipients, value, disabled, onChange }: MailComposeSmimeControlProps) {
  const api = window.aerio?.smime
  const [check, setCheck] = useState<SmimePreflight>()
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const active = Boolean(value?.sign || value?.encrypt)
  const recipientKey = recipients.join('\n')

  useEffect(() => {
    if (!api || !active || !accountId) { setCheck(undefined); return }
    let current = true
    const timer = setTimeout(() => {
      void api.preflight({ accountId, fromIdentityId, recipients: recipientKey ? recipientKey.split('\n') : [], options: value ?? {} })
        .then((next) => { if (current) { setCheck(next); setError('') } })
        .catch((failure) => { if (current) setError(friendlySmimeError(failure, 'S/MIME certificates could not be checked')) })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [accountId, active, api, fromIdentityId, recipientKey, revision, value])

  if (!api) return null
  const update = (changes: Partial<MailSmimeOptions>) => { setNotice(''); onChange(normalize({ ...value, ...changes })) }
  const unlock = async () => {
    if (!check?.signer) return
    setError('')
    try {
      await api.unlock(check.signer.fingerprint, passphrase)
      setPassphrase('')
      setRevision((item) => item + 1)
    } catch (failure) {
      setError(friendlySmimeError(failure, 'The certificate could not be unlocked'))
    }
  }
  const saveDefault = async () => {
    setError('')
    try {
      await api.setIdentityDefault({ accountId, fromIdentityId }, active ? { sign: Boolean(value?.sign), encrypt: Boolean(value?.encrypt) } : undefined)
      setNotice(active ? 'New messages from this sender will start with these S/MIME settings.' : 'New messages from this sender will start unprotected.')
    } catch (failure) {
      setError(friendlySmimeError(failure, 'The default could not be saved'))
    }
  }
  const summary = [value?.sign ? 'signed' : '', value?.encrypt ? 'encrypted' : ''].filter(Boolean).join(' and ')
  const Icon = active ? ShieldCheck : ShieldOff

  return (
    <details className={`mail-send-options mail-openpgp-options mail-smime-options ${active ? 'active' : ''} ${check && !check.ready ? 'attention' : ''}`}>
      <summary className="icon-button" title={summary ? `S/MIME: ${summary}${check && !check.ready ? ' — needs attention' : ''}` : 'S/MIME sign and encrypt'} aria-label="S/MIME sign and encrypt">
        <Icon size={16} aria-hidden="true" />
      </summary>
      <div className="mail-send-options-panel" role="group" aria-label="S/MIME sign and encrypt">
        <label className="mail-send-options-check">
          <input type="checkbox" checked={Boolean(value?.sign)} disabled={disabled} onChange={(event) => update({ sign: event.target.checked })} />
          <span>Sign with S/MIME</span>
        </label>
        <label className="mail-send-options-check">
          <input type="checkbox" checked={Boolean(value?.encrypt)} disabled={disabled} onChange={(event) => update({ encrypt: event.target.checked })} />
          <span>Encrypt with S/MIME</span>
        </label>
        {active && check && <div className="mail-openpgp-check" role="status">
          {check.signer && <p><small>Signing as {check.signer.subject} · {formatCertificateFingerprint(check.signer.fingerprint)}{check.signer.unlocked ? ' · unlocked' : ''}</small></p>}
          {check.signer && !check.signer.unlocked && <span className="mail-openpgp-unlock">
            <input type="password" aria-label="Certificate passphrase" placeholder="Certificate passphrase" autoComplete="off" value={passphrase} disabled={disabled} onChange={(event) => setPassphrase(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void unlock() } }} />
            <button type="button" className="button ghost small" disabled={disabled || !passphrase} onClick={() => void unlock()}>Unlock</button>
          </span>}
          {check.recipients.map((item) => <p key={item.address}><small>
            {item.address}: {item.status === 'ok' ? `certificate ${formatCertificateFingerprint(item.fingerprint!)}` : item.status === 'missing' ? 'no certificate' : `certificate ${item.status}`}
          </small>{item.candidates.length > 1 && <select aria-label={`Certificate for ${item.address}`} value={item.fingerprint} disabled={disabled} onChange={(event) => update({ recipientCerts: { ...value?.recipientCerts, [item.address]: event.target.value } })}>
            {item.candidates.map((candidate) => <option key={candidate.fingerprint} value={candidate.fingerprint}>{candidate.subject} · until {new Date(candidate.validTo).toLocaleDateString()} · {formatCertificateFingerprint(candidate.fingerprint)}</option>)}
          </select>}</p>)}
          {check.problems.map((problem) => <p key={problem}><small className="diagnostic-error">{problem}</small></p>)}
          {check.warnings.map((warning) => <p key={warning}><small>{warning}</small></p>)}
          {check.ready && <p><small className="diagnostic-result">Ready: the message will be {summary} with S/MIME. It will not be sent unprotected.</small></p>}
        </div>}
        <button type="button" className="button ghost small" disabled={disabled} onClick={() => void saveDefault()}>{active ? 'Use for new messages from this sender' : 'Clear this sender’s default'}</button>
        {notice && <small className="diagnostic-result">{notice}</small>}
        {error && <small className="diagnostic-error">{error}</small>}
        <small>{value?.encrypt ? 'Encrypted drafts stay on this device and are not saved to your provider. Subject lines and addresses are not encrypted.' : 'S/MIME certificates are managed in Settings. A message uses S/MIME or OpenPGP, not both.'}</small>
      </div>
    </details>
  )
}
