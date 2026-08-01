import { RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GmailAccountSummary, ImapServerSettings } from '../gmail-types'
import Modal from './Modal'

interface MailAccountSettingsModalProps {
  account: GmailAccountSummary
  onSaved(account: GmailAccountSummary): void
  onClose(): void
  onToast(message: string): void
}

const colors = ['#1d7a62', '#3b6fd8', '#8a5dc7', '#c2673d', '#b04d73', '#5d7589', '#c18a24', '#d14d57']

export default function MailAccountSettingsModal({ account, onSaved, onClose, onToast }: MailAccountSettingsModalProps) {
  const [displayName, setDisplayName] = useState(account.displayName)
  const [color, setColor] = useState(account.color)
  const [signature, setSignature] = useState(account.signature)
  const [notifications, setNotifications] = useState(account.notifications)
  const [syncEnabled, setSyncEnabled] = useState(account.syncEnabled)
  const [busy, setBusy] = useState<'save' | 'verify' | 'reconnect' | 'server' | 'rebuild'>()
  const [server, setServer] = useState<ImapServerSettings>()
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (account.provider === 'gmail' || account.provider === 'microsoft') return
    void window.aerio.mail.accounts.imapSettings(account.id).then(setServer).catch((error) => onToast(error instanceof Error ? error.message : 'Server settings could not be loaded'))
  }, [account.id, account.provider, onToast])

  const updateServer = <K extends keyof ImapServerSettings>(key: K, value: ImapServerSettings[K]) => setServer((current) => current ? { ...current, [key]: value } : current)

  const save = async () => {
    setBusy('save')
    try {
      const updated = await window.aerio.mail.accounts.update({ accountId: account.id, displayName, color, signature, notifications, syncEnabled })
      onSaved(updated)
      onToast('Account settings saved')
      onClose()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Account settings could not be saved')
    } finally {
      setBusy(undefined)
    }
  }

  const verify = async () => {
    setBusy('verify')
    try {
      await window.aerio.mail.accounts.verify(account.id)
      onToast('Connection succeeded')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Connection test failed')
    } finally {
      setBusy(undefined)
    }
  }

  const reconnect = async () => {
    setBusy('reconnect')
    try {
      await window.aerio.mail.accounts.reconnect(account.id)
      onToast('Account reconnected')
      onSaved({ ...account, status: 'syncing', error: undefined })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Account could not be reconnected')
    } finally {
      setBusy(undefined)
    }
  }

  const saveServer = async () => {
    if (!server) return
    setBusy('server')
    try {
      const updated = await window.aerio.mail.accounts.updateImap(account.id, {
        username: server.username,
        imapHost: server.imapHost,
        imapPort: server.imapPort,
        imapSecurity: server.imapSecurity,
        smtpHost: server.smtpHost,
        smtpPort: server.smtpPort,
        smtpSecurity: server.smtpSecurity,
        allowInvalidCertificates: server.allowInvalidCertificates,
        password: password || undefined
      })
      setServer(updated)
      setPassword('')
      onToast('Server settings verified and saved')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Server settings could not be verified')
    } finally {
      setBusy(undefined)
    }
  }

  const rebuild = async () => {
    if (!window.confirm(`Rebuild the local copy of ${account.email}? Provider mail will not be deleted, but downloading can take a while.`)) return
    setBusy('rebuild')
    try {
      await window.aerio.mail.sync.rebuild(account.id)
      onToast('Local mailbox rebuild started')
      onSaved({ ...account, status: 'syncing', error: undefined })
      onClose()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Mailbox rebuild could not start')
    } finally {
      setBusy(undefined)
    }
  }

  return <Modal title="Mail account settings" subtitle={`${account.email} · ${account.provider}`} width="medium" onClose={onClose}>
    <div className="account-settings-form">
      <section>
        <h3>Sender identity</h3>
        <label className="field"><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label className="field"><span>Email address</span><input value={account.email} readOnly /></label>
        <div className="account-color-field"><span>Account colour</span><div>{colors.map((value) => <button key={value} className={color === value ? 'selected' : ''} style={{ background: value }} aria-label={`Use ${value}`} onClick={() => setColor(value)} />)}<input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="Custom account colour" /></div></div>
      </section>
      <section>
        <h3>Signature</h3>
        <p>Inserted into new messages, replies and forwards sent from this account.</p>
        <textarea value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="Your name and contact details" />
      </section>
      <section>
        <h3>Synchronization and alerts</h3>
        <label className="toggle-row"><span><strong>Synchronize this account</strong><small>Check for new mail in the background.</small></span><input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} /></label>
        <label className="toggle-row"><span><strong>New-mail notifications</strong><small>Requires desktop notifications in Aerio settings.</small></span><input type="checkbox" checked={notifications} onChange={(event) => setNotifications(event.target.checked)} /></label>
      </section>
      <section>
        <h3>Connection and local data</h3>
        <p>Status: <strong>{account.status}</strong>{account.lastSyncAt ? ` · Last synchronized ${new Date(account.lastSyncAt).toLocaleString()}` : ''}</p>
        {account.error && <p className="account-error">{account.error}</p>}
        <div className="settings-actions">
          <button className="button ghost" disabled={Boolean(busy)} onClick={() => void verify()}><ShieldCheck size={15} /> {busy === 'verify' ? 'Testing…' : 'Test connection'}</button>
          {(account.provider === 'gmail' || account.provider === 'microsoft') && <button className="button ghost" disabled={Boolean(busy)} onClick={() => void reconnect()}><RefreshCw size={15} /> {busy === 'reconnect' ? 'Waiting for sign-in…' : 'Reconnect'}</button>}
          <button className="button danger-subtle" disabled={Boolean(busy) || !syncEnabled} onClick={() => void rebuild()}><RotateCcw size={15} /> {busy === 'rebuild' ? 'Starting…' : 'Rebuild local mailbox'}</button>
        </div>
      </section>
      {server && <section>
        <h3>IMAP and SMTP servers</h3>
        <p>The saved password remains encrypted and is never displayed. Leave the password blank to keep it.</p>
        <label className="field"><span>Username</span><input value={server.username} onChange={(event) => updateServer('username', event.target.value)} /></label>
        <div className="server-fields"><strong>Incoming</strong><label className="field grow"><span>IMAP server</span><input value={server.imapHost} onChange={(event) => updateServer('imapHost', event.target.value)} /></label><label className="field port"><span>Port</span><input type="number" value={server.imapPort} onChange={(event) => updateServer('imapPort', Number(event.target.value))} /></label><label className="field security"><span>Security</span><select value={server.imapSecurity} onChange={(event) => updateServer('imapSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label></div>
        <div className="server-fields"><strong>Outgoing</strong><label className="field grow"><span>SMTP server</span><input value={server.smtpHost} onChange={(event) => updateServer('smtpHost', event.target.value)} /></label><label className="field port"><span>Port</span><input type="number" value={server.smtpPort} onChange={(event) => updateServer('smtpPort', Number(event.target.value))} /></label><label className="field security"><span>Security</span><select value={server.smtpSecurity} onChange={(event) => updateServer('smtpSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label></div>
        <label className="field"><span>New password or app password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={server.passwordConfigured ? 'Leave blank to keep the saved password' : 'Password required'} /></label>
        <label className="toggle-row"><span><strong>Allow invalid certificates</strong><small>Use only for a trusted local server such as a mail bridge.</small></span><input type="checkbox" checked={server.allowInvalidCertificates} onChange={(event) => updateServer('allowInvalidCertificates', event.target.checked)} /></label>
        <div><button className="button ghost" disabled={Boolean(busy)} onClick={() => void saveServer()}><ShieldCheck size={15} /> {busy === 'server' ? 'Verifying…' : 'Verify and save servers'}</button></div>
      </section>}
    </div>
    <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Cancel</button><span className="spacer" /><button className="button primary" disabled={Boolean(busy) || !displayName.trim()} onClick={() => void save()}><Save size={15} /> {busy === 'save' ? 'Saving…' : 'Save changes'}</button></footer>
  </Modal>
}
