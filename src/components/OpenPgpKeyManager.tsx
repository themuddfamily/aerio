import { Download, KeyRound, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OpenPgpImportResult, OpenPgpKeySummary, OpenPgpStatus } from '../openpgp-types'
import { formatFingerprint, friendlyOpenPgpError, keyStatusLabel } from '../lib/openpgp-display'

type Panel = 'generate' | 'paste' | 'import-passphrase' | undefined

/** Settings section for OpenPGP keys: generate, import, export, verify, delete. */
export default function OpenPgpKeyManager() {
  const api = window.aerio?.openPgp
  const [status, setStatus] = useState<OpenPgpStatus>()
  const [panel, setPanel] = useState<Panel>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', passphrase: '', confirm: '', expiresInDays: '0' })
  const [pasted, setPasted] = useState('')
  const [importPassphrase, setImportPassphrase] = useState('')
  const [pendingImport, setPendingImport] = useState<{ kind: 'text'; armored: string } | { kind: 'file' }>()
  const [exporting, setExporting] = useState<string>()
  const [exportPassphrase, setExportPassphrase] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string>()

  const refresh = async () => { if (api) setStatus(await api.status()) }
  useEffect(() => {
    let active = true
    void api?.status().then((next) => { if (active) setStatus(next) }).catch((error) => { if (active) { setMessageIsError(true); setMessage(friendlyOpenPgpError(error, 'OpenPGP keys could not be read')) } })
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
      setMessage(friendlyOpenPgpError(error, 'The OpenPGP action failed'))
    } finally { setBusy(false) }
  }
  const imported = (result: OpenPgpImportResult | undefined, retry: NonNullable<typeof pendingImport>) => {
    if (!result) return undefined
    if (result.needsPassphrase) {
      setPendingImport(retry); setPanel('import-passphrase')
      return 'This private key is not protected. Choose a passphrase so Aerio can store it encrypted.'
    }
    setPanel(undefined); setPasted(''); setImportPassphrase(''); setPendingImport(undefined)
    return `Imported ${result.imported.length} key${result.imported.length === 1 ? '' : 's'}. Compare fingerprints with their owners before marking them verified.`
  }
  const generate = () => run(async () => {
    if (form.passphrase !== form.confirm) throw new Error('The passphrases do not match')
    const key = await api.generate({ name: form.name, email: form.email, passphrase: form.passphrase, expiresInDays: Number(form.expiresInDays) || 0 })
    setForm({ name: '', email: '', passphrase: '', confirm: '', expiresInDays: '0' }); setPanel(undefined)
    return `Created a key for ${key.emails[0]}. Export your public key to share it, and keep a private-key export somewhere safe: profile backups do not include keys.`
  })
  const retryImport = () => run(async () => {
    if (!pendingImport) return undefined
    const result = pendingImport.kind === 'text' ? await api.importText(pendingImport.armored, importPassphrase) : await api.importFile(importPassphrase)
    return imported(result, pendingImport)
  })
  const exportPrivate = (fingerprint: string) => run(async () => {
    const saved = await api.exportPrivate(fingerprint, exportPassphrase)
    setExporting(undefined); setExportPassphrase('')
    return saved.savedPath ? `Private key saved to ${saved.savedPath}. It is still protected by its passphrase.` : undefined
  })

  const describeExpiry = (key: OpenPgpKeySummary) => key.expiresAt ? `${key.expired ? 'expired' : 'expires'} ${new Date(key.expiresAt).toLocaleDateString()}` : 'never expires'

  return (
    <section className="settings-section openpgp-settings">
      <div className="settings-icon"><KeyRound size={18} /></div>
      <div className="settings-content">
        <h3>OpenPGP keys</h3>
        <p>Sign and encrypt mail with OpenPGP (PGP/MIME). Private keys stay protected by their passphrase and are additionally encrypted with your operating system’s secure storage. Keys are not included in profile backups; export them to move them to another device. Locking Aerio forgets every unlocked key.</p>
        {status && !status.secureStorage && <small className="diagnostic-error">Secure credential storage is unavailable, so OpenPGP keys cannot be saved on this device.</small>}
        <div className="settings-actions">
          <button className="button ghost" disabled={busy} onClick={() => setPanel(panel === 'generate' ? undefined : 'generate')}><Plus size={16} /> New key</button>
          <button className="button ghost" disabled={busy} onClick={() => void run(async () => imported(await api.importFile(), { kind: 'file' }))}><Upload size={16} /> Import key file…</button>
          <button className="button ghost" disabled={busy} onClick={() => setPanel(panel === 'paste' ? undefined : 'paste')}>Paste key</button>
          {status?.keys.some((key) => key.unlocked) && <button className="button ghost" disabled={busy} onClick={() => void run(async () => { await api.forgetPassphrases(); return 'Unlocked keys were locked again.' })}>Forget passphrases</button>}
        </div>
        {panel === 'generate' && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void generate() }}>
          <label className="field-label">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="field-label">Email<input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <label className="field-label">Passphrase<input type="password" autoComplete="new-password" required minLength={8} value={form.passphrase} onChange={(event) => setForm({ ...form, passphrase: event.target.value })} /></label>
          <label className="field-label">Confirm passphrase<input type="password" autoComplete="new-password" required value={form.confirm} onChange={(event) => setForm({ ...form, confirm: event.target.value })} /></label>
          <label className="field-label">Expires
            <select value={form.expiresInDays} onChange={(event) => setForm({ ...form, expiresInDays: event.target.value })}>
              <option value="0">Never</option><option value="365">In 1 year</option><option value="730">In 2 years</option><option value="1825">In 5 years</option>
            </select>
          </label>
          <div className="settings-actions"><button type="submit" className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create key'}</button></div>
        </form>}
        {panel === 'paste' && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void run(async () => imported(await api.importText(pasted), { kind: 'text', armored: pasted })) }}>
          <label className="field-label">Armored key<textarea rows={5} value={pasted} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" onChange={(event) => setPasted(event.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="button primary" disabled={busy || !pasted.trim()}>Import</button></div>
        </form>}
        {panel === 'import-passphrase' && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void retryImport() }}>
          <label className="field-label">New passphrase for the imported private key<input type="password" autoComplete="new-password" minLength={8} value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="button primary" disabled={busy || importPassphrase.length < 8}>Protect and import</button></div>
        </form>}
        {status && (status.keys.length ? <ul className="openpgp-key-list">{status.keys.map((key) => <li key={key.fingerprint} className={key.revoked || key.expired ? 'inactive' : ''}>
          <div>
            <strong>{key.userIds.join(', ') || key.keyId}</strong>
            <small>{keyStatusLabel(key)} · {key.algorithm} · created {new Date(key.createdAt).toLocaleDateString()} · {describeExpiry(key)}{key.unlocked ? ' · unlocked' : ''}</small>
            <code aria-label="Fingerprint">{formatFingerprint(key.fingerprint)}</code>
            <small>{key.verification === 'verified' ? <><ShieldCheck size={13} aria-hidden="true" /> Fingerprint verified</> : 'Fingerprint not verified'}</small>
          </div>
          <div className="settings-actions">
            <button className="button ghost small" disabled={busy} onClick={() => void run(async () => { await api.setVerification(key.fingerprint, key.verification === 'verified' ? 'unverified' : 'verified'); return undefined })}>{key.verification === 'verified' ? 'Mark unverified' : 'Mark verified'}</button>
            <button className="button ghost small" disabled={busy} onClick={() => void run(async () => { const saved = await api.exportPublic(key.fingerprint); return saved.savedPath ? `Public key saved to ${saved.savedPath}` : undefined })}><Download size={14} /> Public key</button>
            {key.hasPrivateKey && <button className="button ghost small" disabled={busy} onClick={() => { setExporting(exporting === key.fingerprint ? undefined : key.fingerprint); setExportPassphrase('') }}><Download size={14} /> Private key</button>}
            <button className="button ghost small danger-subtle" disabled={busy} onClick={() => setConfirmDelete(confirmDelete === key.fingerprint ? undefined : key.fingerprint)}><Trash2 size={14} /> Delete</button>
          </div>
          {exporting === key.fingerprint && <form className="openpgp-form" onSubmit={(event) => { event.preventDefault(); void exportPrivate(key.fingerprint) }}>
            <label className="field-label">Confirm this key’s passphrase to export it<input type="password" autoComplete="off" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} /></label>
            <div className="settings-actions"><button type="submit" className="button primary small" disabled={busy || !exportPassphrase}>Export private key…</button></div>
          </form>}
          {confirmDelete === key.fingerprint && <div className="settings-actions" role="alert">
            <small>{key.hasPrivateKey ? 'Deleting your private key means mail encrypted to it can no longer be read here.' : 'Delete this public key?'}</small>
            <button className="button ghost small danger-subtle" disabled={busy} onClick={() => void run(async () => { await api.delete(key.fingerprint); setConfirmDelete(undefined); return 'Key deleted.' })}>Delete key</button>
          </div>}
        </li>)}</ul> : <small>No OpenPGP keys yet. Create one or import your existing key.</small>)}
        {message && <small className={messageIsError ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message}</small>}
      </div>
    </section>
  )
}
