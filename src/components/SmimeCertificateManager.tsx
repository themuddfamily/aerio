import { Download, FileBadge, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SmimeImportResult, SmimeStatus } from '../smime-types'
import { certificateName, certificateStatusLabel, chainStatusLabel, friendlySmimeError } from '../lib/smime-display'
import SmimeCertificateDetails from './SmimeCertificateDetails'

type Panel = 'paste' | 'password' | 'passphrase' | undefined

/** Settings section for S/MIME: import PKCS#12 and certificates, trust, export, delete. */
export default function SmimeCertificateManager() {
  const api = window.aerio?.smime
  const [status, setStatus] = useState<SmimeStatus>()
  const [panel, setPanel] = useState<Panel>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const [pasted, setPasted] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [exporting, setExporting] = useState<string>()
  const [exportForm, setExportForm] = useState({ passphrase: '', password: '', confirm: '' })
  const [confirmDelete, setConfirmDelete] = useState<string>()

  const refresh = async () => { if (api) setStatus(await api.status()) }
  useEffect(() => {
    let active = true
    void api?.status().then((next) => { if (active) setStatus(next) }).catch((error) => { if (active) { setMessageIsError(true); setMessage(friendlySmimeError(error, 'S/MIME certificates could not be read')) } })
    return () => { active = false }
  }, [api])

  if (!api) return null
  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true); setMessage('')
    try {
      const done = await action()
      await refresh()
      setMessageIsError(false)
      if (done) setMessage(done)
    } catch (error) {
      setMessageIsError(true)
      setMessage(friendlySmimeError(error, 'The S/MIME action failed'))
    } finally { setBusy(false) }
  }
  const imported = (result: SmimeImportResult | undefined) => {
    if (!result) return undefined
    if (result.needsPassword) {
      setPanel('password')
      if (result.error) throw new Error(result.error)
      return 'Enter the password for this PKCS#12 file.'
    }
    if (result.needsPassphrase) {
      setPanel('passphrase')
      return 'The file password is too short to protect the key here. Choose a passphrase of at least 8 characters.'
    }
    setPanel(undefined); setPasted(''); setPassword(''); setPassphrase('')
    const own = result.imported.some((item) => item.hasPrivateKey)
    return `Imported ${result.imported.length} certificate${result.imported.length === 1 ? '' : 's'}.${own ? ' Keep a PKCS#12 export somewhere safe: profile backups do not include private keys.' : ' Mark a root certificate trusted only after checking its fingerprint.'}`
  }
  const exportPkcs12 = (fingerprint: string) => run(async () => {
    if (exportForm.password !== exportForm.confirm) throw new Error('The export passwords do not match')
    const saved = await api.exportPkcs12(fingerprint, exportForm.passphrase, exportForm.password)
    setExporting(undefined); setExportForm({ passphrase: '', password: '', confirm: '' })
    return saved.savedPath ? `Certificate and private key saved to ${saved.savedPath}, protected by the export password.` : undefined
  })

  return (
    <section className="settings-section smime-settings">
      <div className="settings-icon"><FileBadge size={18} /></div>
      <div className="settings-content">
        <h3>S/MIME certificates</h3>
        <p>Sign and encrypt mail with S/MIME. Import your own certificate as a PKCS#12 file (.p12 or .pfx) and recipients’ certificates as .cer, .crt or .pem files; certificates from valid signed mail are saved automatically. Private keys stay protected by a passphrase and your operating system’s secure storage, and are not included in profile backups. Revocation (CRL/OCSP) is not checked.</p>
        {status && !status.secureStorage && <small className="diagnostic-error">Secure credential storage is unavailable, so S/MIME certificates cannot be saved on this device.</small>}
        <div className="settings-actions">
          <button className="button ghost" disabled={busy} onClick={() => void run(async () => imported(await api.importFile()))}><Upload size={16} /> Import certificate file…</button>
          <button className="button ghost" disabled={busy} onClick={() => setPanel(panel === 'paste' ? undefined : 'paste')}>Paste certificate</button>
          {status?.certificates.some((cert) => cert.unlocked) && <button className="button ghost" disabled={busy} onClick={() => void run(async () => { await api.forgetPassphrases(); return 'Unlocked certificates were locked again.' })}>Forget passphrases</button>}
        </div>
        {panel === 'paste' && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => imported(await api.importText(pasted))) }}>
          <label className="field-label">PEM certificate<textarea rows={5} value={pasted} placeholder="-----BEGIN CERTIFICATE-----" onChange={(event) => setPasted(event.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="button primary" disabled={busy || !pasted.trim()}>Import</button></div>
        </form>}
        {panel === 'password' && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => imported(await api.retryImport(password))) }}>
          <label className="field-label">PKCS#12 file password<input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="button primary" disabled={busy}>Open file</button></div>
        </form>}
        {panel === 'passphrase' && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => imported(await api.retryImport(password, passphrase))) }}>
          <label className="field-label">New passphrase for this private key<input type="password" autoComplete="new-password" minLength={8} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="button primary" disabled={busy || passphrase.length < 8}>Protect and import</button></div>
        </form>}
        {status && (status.certificates.length ? <ul className="openpgp-key-list">{status.certificates.map((cert) => <li key={cert.fingerprint} className={cert.expired || cert.notYetValid ? 'inactive' : ''}>
          <div>
            <strong>{certificateName(cert)}</strong>
            <small>{certificateStatusLabel(cert)} · {cert.emails.join(', ') || 'no email'} · until {new Date(cert.validTo).toLocaleDateString()}{cert.source === 'harvested' ? ' · from signed mail' : ''}{cert.unlocked ? ' · unlocked' : ''}</small>
            <small>{cert.chainStatus === 'trusted' || cert.trusted ? <><ShieldCheck size={13} aria-hidden="true" /> {chainStatusLabel(cert.chainStatus, cert.trusted)}</> : chainStatusLabel(cert.chainStatus, cert.trusted)}</small>
            <SmimeCertificateDetails cert={cert} />
          </div>
          <div className="settings-actions">
            <button className="button ghost small" disabled={busy} title={cert.isCa ? 'Trust certificates issued by this authority' : 'Accept this certificate even though its issuer is not trusted'} onClick={() => void run(async () => { await api.setTrusted(cert.fingerprint, !cert.trusted); return undefined })}>{cert.trusted ? 'Stop trusting' : 'Trust'}</button>
            <button className="button ghost small" disabled={busy} onClick={() => void run(async () => { const saved = await api.exportCertificate(cert.fingerprint); return saved.savedPath ? `Certificate saved to ${saved.savedPath}` : undefined })}><Download size={14} /> Certificate</button>
            {cert.hasPrivateKey && <button className="button ghost small" disabled={busy} onClick={() => { setExporting(exporting === cert.fingerprint ? undefined : cert.fingerprint); setExportForm({ passphrase: '', password: '', confirm: '' }) }}><Download size={14} /> PKCS#12</button>}
            <button className="button ghost small danger-subtle" disabled={busy} onClick={() => setConfirmDelete(confirmDelete === cert.fingerprint ? undefined : cert.fingerprint)}><Trash2 size={14} /> Delete</button>
          </div>
          {exporting === cert.fingerprint && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void exportPkcs12(cert.fingerprint) }}>
            <label className="field-label">This certificate’s passphrase<input type="password" autoComplete="off" value={exportForm.passphrase} onChange={(event) => setExportForm({ ...exportForm, passphrase: event.target.value })} /></label>
            <label className="field-label">Export password<input type="password" autoComplete="new-password" minLength={8} value={exportForm.password} onChange={(event) => setExportForm({ ...exportForm, password: event.target.value })} /></label>
            <label className="field-label">Confirm export password<input type="password" autoComplete="new-password" value={exportForm.confirm} onChange={(event) => setExportForm({ ...exportForm, confirm: event.target.value })} /></label>
            <div className="settings-actions"><button type="submit" className="button primary small" disabled={busy || !exportForm.passphrase || exportForm.password.length < 8}>Export PKCS#12…</button></div>
          </form>}
          {confirmDelete === cert.fingerprint && <div className="settings-actions" role="alert">
            <small>{cert.hasPrivateKey ? 'Deleting your certificate and private key means mail encrypted to it can no longer be read here.' : 'Delete this certificate?'}</small>
            <button className="button ghost small danger-subtle" disabled={busy} onClick={() => void run(async () => { await api.delete(cert.fingerprint); setConfirmDelete(undefined); return 'Certificate deleted.' })}>Delete certificate</button>
          </div>}
        </li>)}</ul> : <small>No S/MIME certificates yet. Import your PKCS#12 file to sign and decrypt.</small>)}
        {message && <small className={messageIsError ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message}</small>}
      </div>
    </section>
  )
}
