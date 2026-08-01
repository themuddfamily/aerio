import { ArrowLeft, Check, ChevronRight, LoaderCircle, Mail, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { GmailCredentialStatus, ImapAccountInput, MailProviderId, MailProviderPreset } from '../gmail-types'
import { useDialogFocus } from '../lib/dialog-focus'
import ProviderLogo from './ProviderLogo'

interface Props {
  onClose(): void
  onConnected(): Promise<void> | void
  onToast(message: string): void
}

const emptyStatus: GmailCredentialStatus = { configured: false }

const providerPresentation: Record<MailProviderId, { action: string; detail: string }> = {
  gmail: { action: 'Continue with Google', detail: 'Gmail, Calendar and Contacts' },
  microsoft: { action: 'Continue with Microsoft', detail: 'Outlook.com, Hotmail and Microsoft 365' },
  icloud: { action: 'Continue with iCloud', detail: 'Use an Apple app-specific password' },
  yahoo: { action: 'Continue with Yahoo', detail: 'Yahoo Mail and AOL accounts' },
  fastmail: { action: 'Continue with Fastmail', detail: 'Use a Fastmail app password' },
  'proton-bridge': { action: 'Continue with Proton Mail', detail: 'Requires Proton Mail Bridge' },
  imap: { action: 'Set up another provider', detail: 'Connect with IMAP and SMTP' }
}

const featuredProviders = new Set<MailProviderId>(['gmail', 'microsoft'])

export default function MailAccountSetupModal({ onClose, onConnected, onToast }: Props) {
  const [presets, setPresets] = useState<MailProviderPreset[]>([])
  const [selected, setSelected] = useState<MailProviderId>()
  const [google, setGoogle] = useState(emptyStatus)
  const [microsoft, setMicrosoft] = useState(emptyStatus)
  const [microsoftClientId, setMicrosoftClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useDialogFocus<HTMLElement>(onClose, true, !busy)
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
      <section ref={dialogRef} className="modal mail-account-setup" role="dialog" aria-modal="true" aria-label="Add mail account" tabIndex={-1}>
        <header className="modal-header">
          <div className="setup-heading">
            {selected && <button className="icon-button" onClick={() => setSelected(undefined)} aria-label="Back to providers"><ArrowLeft size={18} /></button>}
            <span className={`setup-mark ${preset ? 'provider-brand-mark' : ''}`}>{preset ? <ProviderLogo provider={preset.id} size={22} /> : <Mail size={20} />}</span>
            <div><h2>{preset ? providerPresentation[preset.id].action : 'Connect an email account'}</h2><p>{preset?.description ?? 'Choose your provider to bring mail, calendar, and contacts into Aerio.'}</p></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        </header>

        {!preset && <div className="provider-chooser">
          <div className="provider-featured-grid">
            {presets.filter((provider) => featuredProviders.has(provider.id)).map((provider) => {
              const presentation = providerPresentation[provider.id]
              return <button className={`provider-choice featured provider-${provider.id}`} key={provider.id} aria-label={`${presentation.action}. ${provider.name}. ${presentation.detail}`} onClick={() => choose(provider)}>
                <span className="provider-logo-frame"><ProviderLogo provider={provider.id} size={25} /></span>
                <span className="provider-choice-copy"><strong>{presentation.action}</strong><small>{presentation.detail}</small></span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            })}
          </div>
          <div className="provider-section-label"><span>Other email providers</span></div>
          <div className="provider-secondary-grid">
            {presets.filter((provider) => !featuredProviders.has(provider.id)).map((provider) => {
              const presentation = providerPresentation[provider.id]
              return <button className={`provider-choice compact provider-${provider.id}`} key={provider.id} aria-label={`${presentation.action}. ${provider.name}. ${presentation.detail}`} onClick={() => choose(provider)}>
                <span className="provider-logo-frame"><ProviderLogo provider={provider.id} size={21} /></span>
                <span className="provider-choice-copy"><strong>{presentation.action}</strong><small>{presentation.detail}</small></span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            })}
          </div>
          <p className="provider-security-note"><ShieldCheck size={15} /> Secure sign-in opens in your browser. App passwords and tokens are encrypted with Windows secure storage.</p>
        </div>}

        {preset?.id === 'gmail' && <div className="provider-setup-body">
          <div className={`setup-step ${google.configured ? 'complete' : ''}`}>
            <span>{google.configured ? <Check size={17} /> : '1'}</span>
            <div>
              <strong>{google.source === 'built-in' ? 'Aerio Google registration' : 'Google Desktop OAuth app'}</strong>
              <p>{google.source === 'built-in'
                ? `Included in this Aerio build${google.clientIdHint ? ` (${google.clientIdHint})` : ''}. No credential file is required.`
                : 'Import the Desktop app JSON downloaded from Google Cloud. This development fallback is not your email password.'}</p>
            </div>
            {google.source !== 'built-in' && <button className="button ghost" onClick={() => void importGoogle()}>{google.configured ? 'Replace JSON' : 'Import JSON'}</button>}
          </div>
          <div className="setup-step"><span>2</span><div><strong>Sign in with Google</strong><p>Your browser asks for Gmail access. Aerio receives a revocable OAuth token.</p></div><button className="button brand-auth-action" disabled={!google.configured || busy} onClick={() => void finish(() => window.aerio.mail.accounts.connect(), 'Google account connected — sync has started')}><ProviderLogo provider="gmail" size={16} />{busy && <LoaderCircle className="spin" size={15} />}Continue with Google</button></div>
          <p className="setup-note">Aerio uses a desktop OAuth registration and a local PKCE callback. Your Google password is never shared with Aerio.</p>
        </div>}

        {preset?.id === 'microsoft' && <div className="provider-setup-body">
          {microsoft.source === 'built-in'
            ? <div className="setup-step complete"><span><Check size={17} /></span><div><strong>Aerio Microsoft registration</strong><p>Included in this Aerio build{microsoft.clientIdHint ? ` (${microsoft.clientIdHint})` : ''}. No application ID is required.</p></div></div>
            : <label className="field"><span>Microsoft Application (client) ID</span><input value={microsoftClientId} onChange={(event) => setMicrosoftClientId(event.target.value)} placeholder={microsoft.clientIdHint ?? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'} /></label>}
          <p className="setup-note">{microsoft.source === 'built-in' ? 'Sign in with a personal Outlook or Microsoft 365 account. Aerio requests mail access plus read-only Calendar and Contacts access through Microsoft Graph.' : 'Register Aerio as a public desktop client in Microsoft Entra and allow the localhost redirect.'}</p>
          <footer className="setup-actions"><button className="button brand-auth-action" disabled={busy || (!microsoft.configured && !microsoftClientId.trim())} onClick={() => void connectMicrosoft()}><ProviderLogo provider="microsoft" size={15} />{busy && <LoaderCircle className="spin" size={15} />}Continue with Microsoft</button></footer>
        </div>}

        {preset && preset.id !== 'gmail' && preset.id !== 'microsoft' && <form className="provider-setup-body imap-form" onSubmit={(event) => { event.preventDefault(); void finish(() => window.aerio.mail.accounts.connectImap(imap), `${preset.name} account connected — sync has started`) }}>
          <div className="field-grid"><label className="field"><span>Email address</span><input type="email" required value={imap.email} onChange={(event) => { const value = event.target.value; if (!imap.username || imap.username === imap.email) update('username', value); update('email', value) }} /></label><label className="field"><span>Display name</span><input value={imap.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="Optional" /></label></div>
          <div className="field-grid"><label className="field"><span>Username</span><input required value={imap.username} onChange={(event) => update('username', event.target.value)} placeholder={preset.usernameHint ?? 'Usually your full email address'} /></label><label className="field"><span>{preset.passwordHint ?? 'Password'}</span><input type="password" required value={imap.password} onChange={(event) => update('password', event.target.value)} /></label></div>
          <div className="server-fields"><strong>Incoming mail (IMAP)</strong><label className="field grow"><span>Server</span><input required value={imap.imapHost} onChange={(event) => update('imapHost', event.target.value)} /></label><label className="field port"><span>Port</span><input type="number" required value={imap.imapPort} onChange={(event) => update('imapPort', Number(event.target.value))} /></label><label className="field security"><span>Security</span><select value={imap.imapSecurity} onChange={(event) => update('imapSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label></div>
          <div className="server-fields"><strong>Outgoing mail (SMTP)</strong><label className="field grow"><span>Server</span><input required value={imap.smtpHost} onChange={(event) => update('smtpHost', event.target.value)} /></label><label className="field port"><span>Port</span><input type="number" required value={imap.smtpPort} onChange={(event) => update('smtpPort', Number(event.target.value))} /></label><label className="field security"><span>Security</span><select value={imap.smtpSecurity} onChange={(event) => update('smtpSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label></div>
          {preset.auth === 'app-password' && <p className="setup-note">Use an app-specific password from your provider’s security settings. Your normal account password may be rejected.</p>}
          {preset.auth === 'bridge' && <p className="setup-note">Keep Proton Mail Bridge running. Use the IMAP/SMTP username and password shown inside Bridge, not your Proton account password.</p>}
          <footer className="setup-actions"><button type="submit" className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}{providerPresentation[preset.id].action}</button></footer>
        </form>}
      </section>
    </div>
  )
}
