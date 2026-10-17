import { Lock, LockOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailOpenPgpOptions, OpenPgpPreflight } from '../openpgp-types'
import { formatFingerprint, friendlyOpenPgpError } from '../lib/openpgp-display'

interface MailComposeOpenPgpControlProps {
  accountId: string
  fromIdentityId?: string
  recipients: string[]
  value?: MailOpenPgpOptions
  disabled?: boolean
  onChange(next: MailOpenPgpOptions | undefined): void
}

const normalize = (value: MailOpenPgpOptions): MailOpenPgpOptions | undefined =>
  value.sign || value.encrypt ? { ...(value.sign ? { sign: true } : {}), ...(value.encrypt ? { encrypt: true } : {}), ...(value.recipientKeys && Object.keys(value.recipientKeys).length ? { recipientKeys: value.recipientKeys } : {}) } : undefined

// Compact OpenPGP Sign/Encrypt picker for the composer footer. Sending is
// checked again in the main process, which refuses to fall back to plaintext.
export default function MailComposeOpenPgpControl({ accountId, fromIdentityId, recipients, value, disabled, onChange }: MailComposeOpenPgpControlProps) {
  const api = window.aerio?.openPgp
  const [check, setCheck] = useState<OpenPgpPreflight>()
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const active = Boolean(value?.sign || value?.encrypt)
  const recipientKey = recipients.join('\n')

  useEffect(() => {
    if (!api || !active || !accountId) { setCheck(undefined); return }
    let current = true
    const timer = setTimeout(() => {
      void api.preflight({ accountId, fromIdentityId, recipients: recipientKey ? recipientKey.split('\n') : [], options: value ?? {} })
        .then((next) => { if (current) { setCheck(next); setError('') } })
        .catch((failure) => { if (current) setError(friendlyOpenPgpError(failure, 'OpenPGP keys could not be checked')) })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [accountId, active, api, fromIdentityId, recipientKey, revision, value])

  if (!api) return null
  const update = (changes: Partial<MailOpenPgpOptions>) => onChange(normalize({ ...value, ...changes }))
  const unlock = async () => {
    if (!check?.signer) return
    setError('')
    try {
      await api.unlock(check.signer.fingerprint, passphrase)
      setPassphrase('')
      setRevision((item) => item + 1)
    } catch (failure) {
      setError(friendlyOpenPgpError(failure, 'The key could not be unlocked'))
    }
  }
  const summary = [value?.sign ? 'signed' : '', value?.encrypt ? 'encrypted' : ''].filter(Boolean).join(' and ')
  const Icon = value?.encrypt ? Lock : LockOpen

  return (
    <details className={`mail-send-options mail-openpgp-options ${active ? 'active' : ''} ${check && !check.ready ? 'attention' : ''}`}>
      <summary className="icon-button" title={summary ? `OpenPGP: ${summary}${check && !check.ready ? ' — needs attention' : ''}` : 'OpenPGP sign and encrypt'} aria-label="OpenPGP sign and encrypt">
        <Icon size={16} aria-hidden="true" />
      </summary>
      <div className="mail-send-options-panel" role="group" aria-label="OpenPGP sign and encrypt">
        <label className="mail-send-options-check">
          <input type="checkbox" checked={Boolean(value?.sign)} disabled={disabled} onChange={(event) => update({ sign: event.target.checked })} />
          <span>Sign with OpenPGP</span>
        </label>
        <label className="mail-send-options-check">
          <input type="checkbox" checked={Boolean(value?.encrypt)} disabled={disabled} onChange={(event) => update({ encrypt: event.target.checked })} />
          <span>Encrypt with OpenPGP</span>
        </label>
        {active && check && <div className="mail-openpgp-check" role="status">
          {check.signer && <p><small>Signing as {check.signer.userId} · {formatFingerprint(check.signer.fingerprint).slice(-19)}{check.signer.unlocked ? ' · unlocked' : ''}</small></p>}
          {check.signer && !check.signer.unlocked && <span className="mail-openpgp-unlock">
            <input type="password" aria-label="Signing key passphrase" placeholder="Key passphrase" autoComplete="off" value={passphrase} disabled={disabled} onChange={(event) => setPassphrase(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void unlock() } }} />
            <button type="button" className="button ghost small" disabled={disabled || !passphrase} onClick={() => void unlock()}>Unlock</button>
          </span>}
          {check.recipients.map((item) => <p key={item.address}><small>
            {item.address}: {item.status === 'ok' ? `${item.verification === 'verified' ? 'verified key' : 'unverified key'} ${formatFingerprint(item.fingerprint!).slice(-19)}` : item.status === 'missing' ? 'no public key' : `key ${item.status}`}
          </small>{item.candidates.length > 1 && <select aria-label={`Key for ${item.address}`} value={item.fingerprint} disabled={disabled} onChange={(event) => update({ recipientKeys: { ...value?.recipientKeys, [item.address]: event.target.value } })}>
            {item.candidates.map((candidate) => <option key={candidate.fingerprint} value={candidate.fingerprint}>{candidate.userId} · {formatFingerprint(candidate.fingerprint).slice(-19)}{candidate.verification === 'verified' ? ' · verified' : ''}</option>)}
          </select>}</p>)}
          {check.problems.map((problem) => <p key={problem}><small className="diagnostic-error">{problem}</small></p>)}
          {check.ready && <p><small className="diagnostic-result">Ready: the message will be {summary}. It will not be sent unprotected.</small></p>}
        </div>}
        {error && <small className="diagnostic-error">{error}</small>}
        <small>{value?.encrypt ? 'Encrypted drafts stay on this device and are not saved to your provider. Subject lines and addresses are not encrypted.' : 'OpenPGP keys are managed in Settings.'}</small>
      </div>
    </details>
  )
}
