import { ArrowLeft, Check, KeyRound, LoaderCircle, Mail, Server, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { GmailCredentialStatus, ImapAccountInput, MailProviderId, MailProviderPreset } from '../gmail-types'

interface Props {
  onClose(): void
  onConnected(): Promise<void> | void
  onToast(message: string): void
}

const emptyStatus: GmailCredentialStatus = { configured: false }

export default function MailAccountSetupModal({ onClose, onConnected, onToast }: Props) {
  const [presets, setPresets] = useState<MailProviderPreset[]>([])
  const [selected, setSelected] = useState<MailProviderId>()
  const [google, setGoogle] = useState(emptyStatus)
  const [microsoft, setMicrosoft] = useState(emptyStatus)
  const [microsoftClientId, setMicrosoftClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const preset = useMemo(() => presets.find((item) => item.id === selected), [presets, selected])
  const [imap, setImap] = useState<ImapAccountInput>({
    provider: 'imap', email: '', displayName: '', username: '', password: '',
    imapHost: '', imapPort: 993, imapSecurity: 'tls', smtpHost: '', smtpPort: 465, smtpSecurity: 'tls'
  })

  useEffect(() => {
    void Promise.all([
      window.aerio.mail.presets(),
      window.aerio.mail.credentials.status(),
      window.aerio.mail.credentials.microsoftStatus()
    ]).then(([providerPresets, googleStatus, microsoftStatus]) => {
      setPresets(providerPresets)
      setGoogle(googleStatus)
      setMicrosoft(microsoftStatus)
    }).catch((error) => onToast(error instanceof Error ? error.message : 'Account setup could not start'))
  }, [onToast])

  const choose = (value: MailProviderPreset) => {
    setSelected(value.id)
    if (value.id !== 'gmail' && value.id !== 'microsoft') {
      setImap({
        provider: value.id,
        email: '', displayName: '', username: '', password: '',
        imapHost: value.imapHost ?? '', imapPort: value.imapPort ?? 993, imapSecurity: value.imapSecurity ?? 'tls',
        smtpHost: value.smtpHost ?? '', smtpPort: value.smtpPort ?? 465, smtpSecurity: value.smtpSecurity ?? 'tls',
        allowInvalidCertificates: value.id === 'proton-bridge'
      })
    }
  }

  const finish = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await task()
      await onConnected()
      onToast(success)
      onClose()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The account could not be connected')
    } finally {
      setBusy(false)
    }
  }

  const importGoogle = async () => {
    try { setGoogle(await window.aerio.mail.credentials.import()) }
    catch (error) { onToast(error instanceof Error ? error.message : 'Google credentials could not be imported') }
  }

  const connectMicrosoft = async () => {
    if (!microsoft.configured || microsoftClientId.trim()) {
      if (!microsoftClientId.trim()) {
        onToast('Enter the Application (client) ID from your Microsoft Entra app')
        return
      }
      try { setMicrosoft(await window.aerio.mail.credentials.configureMicrosoft(microsoftClientId)) }
      catch (error) {
        onToast(error instanceof Error ? error.message : 'Microsoft app configuration could not be saved')
        return
      }
    }
    await finish(() => window.aerio.mail.accounts.connectMicrosoft(), 'Microsoft account connected — sync has started')
  }

  const update = <K extends keyof ImapAccountInput>(key: K, value: ImapAccountInput[K]) => setImap((current) => ({ ...current, [key]: value }))

  return (
    <div className="modal-backdrop mail-account-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal mail-account-setup" role="dialog" aria-modal="true" aria-label="Add mail account">
        <header className="modal-header">
          <div className="setup-heading">
            {selected && <button className="icon-button" onClick={() => setSelected(undefined)} aria-label="Back to providers"><ArrowLeft size={18} /></button>}
            <span className="setup-mark"><Mail size={20} /></span>
            <div><h2>{preset ? preset.name : 'Add a mail account'}</h2><p>{preset?.description ?? 'Choose your provider. Aerio keeps tokens and passwords in Windows secure storage.'}</p></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        </header>

        {!preset && <div className="provider-grid">
          {presets.map((provider) => <button key={provider.id} onClick={() => choose(provider)}>
            <span>{provider.auth.includes('oauth') ? <ShieldCheck size={21} /> : provider.auth === 'bridge' ? <Server size={21} /> : <KeyRound size={21} />}</span>
            <strong>{provider.name}</strong><small>{provider.description}</small>
          </button>)}
        </div>}

        {preset?.id === 'gmail' && <div className="provider-setup-body">
          <div className={`setup-step ${google.configured ? 'complete' : ''}`}><span>{google.configured ? <Check size={17} /> : '1'}</span><div><strong>Google Desktop OAuth app</strong><p>Import the JSON downloaded from Google Cloud. This identifies Aerio to Google; it is not your email password.</p></div><button className="button ghost" onClick={() => void importGoogle()}>{google.configured ? 'Replace JSON' : 'Import JSON'}</button></div>
          <div className="setup-step"><span>2</span><div><strong>Sign in with Google</strong><p>Your browser asks for Gmail access. Aerio receives a revocable OAuth token.</p></div><button className="button primary" disabled={!google.configured || busy} onClick={() => void finish(() => window.aerio.mail.accounts.connect(), 'Google account connected — sync has started')}>{busy && <LoaderCircle className="spin" size={15} />}Connect Gmail</button></div>
          <p className="setup-note">Google requires each distributed desktop client to have an OAuth registration. During private development, use your own Desktop app credentials.</p>
        </div>}

        {preset?.id === 'microsoft' && <div className="provider-setup-body">
          <label className="field"><span>Microsoft Application (client) ID</span><input value={microsoftClientId} onChange={(event) => setMicrosoftClientId(event.target.value)} placeholder={microsoft.clientIdHint ?? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'} /></label>
          <p className="setup-note">Register Aerio as a public desktop client in Microsoft Entra and allow the localhost redirect. Aerio requests Mail.ReadWrite and Mail.Send through Microsoft Graph.</p>
          <footer className="setup-actions"><button className="button primary" disabled={busy || (!microsoft.configured && !microsoftClientId.trim())} onClick={() => void connectMicrosoft()}>{busy && <LoaderCircle className="spin" size={15} />}Connect Microsoft</button></footer>
        </div>}

        {preset && preset.id !== 'gmail' && preset.id !== 'microsoft' && <form className="provider-setup-body imap-form" onSubmit={(event) => { event.preventDefault(); void finish(() => window.aerio.mail.accounts.connectImap(imap), `${preset.name} account connected — sync has started`) }}>
          <div className="field-grid"><label className="field"><span>Email address</span><input type="email" required value={imap.email} onChange={(event) => { const value = event.target.value; if (!imap.username || imap.username === imap.email) update('username', value); update('email', value) }} /></label><label className="field"><span>Display name</span><input value={imap.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="Optional" /></label></div>
          <div className="field-grid"><label className="field"><span>Username</span><input required value={imap.username} onChange={(event) => update('username', event.target.value)} placeholder={preset.usernameHint ?? 'Usually your full email address'} /></label><label className="field"><span>{preset.passwordHint ?? 'Password'}</span><input type="password" required value={imap.password} onChange={(event) => update('password', event.target.value)} /></label></div>
          <div className="server-fields"><strong>Incoming mail (IMAP)</strong><label className="field grow"><span>Server</span><input required value={imap.imapHost} onChange={(event) => update('imapHost', event.target.value)} /></label><label className="field port"><span>Port</span><input type="number" required value={imap.imapPort} onChange={(event) => update('imapPort', Number(event.target.value))} /></label><label className="field security"><span>Security</span><select value={imap.imapSecurity} onChange={(event) => update('imapSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label></div>
          <div className="server-fields"><strong>Outgoing mail (SMTP)</strong><label className="field grow"><span>Server</span><input required value={imap.smtpHost} onChange={(event) => update('smtpHost', event.target.value)} /></label><label className="field port"><span>Port</span><input type="number" required value={imap.smtpPort} onChange={(event) => update('smtpPort', Number(event.target.value))} /></label><label className="field security"><span>Security</span><select value={imap.smtpSecurity} onChange={(event) => update('smtpSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label></div>
          {preset.auth === 'app-password' && <p className="setup-note">Use an app-specific password from your provider’s security settings. Your normal account password may be rejected.</p>}
          {preset.auth === 'bridge' && <p className="setup-note">Keep Proton Mail Bridge running. Use the IMAP/SMTP username and password shown inside Bridge, not your Proton account password.</p>}
          <footer className="setup-actions"><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Test and connect</button></footer>
        </form>}
      </section>
    </div>
  )
}
