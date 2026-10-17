import { LoaderCircle, Save, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import type {
  Pop3AccountInput,
  Pop3AccountSettings,
  Pop3AccountStatus,
  Pop3ConnectionTestResult,
  Pop3Destination,
  Pop3RetentionPolicy,
  Pop3Security,
  Pop3ServerSettings
} from '../pop3-types'
import { DEFAULT_POP3_RETENTION } from '../pop3-types'
import { LOCAL_FOLDERS_ACCOUNT_ID } from '../lib/local-folders'
import { mailFolderTree } from '../lib/mail-folders'
import { defaultPop3Port, pop3RetentionEffects } from '../lib/pop3'

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

/** Local Folders folders that can receive downloaded mail, in tree order. */
function useLocalFolders() {
  const [folders, setFolders] = useState<{ label: MailLabel; depth: number; leafName: string }[]>([])
  useEffect(() => {
    let cancelled = false
    void window.aerio.mail.mail.labels([LOCAL_FOLDERS_ACCOUNT_ID])
      .then((labels) => { if (!cancelled) setFolders(mailFolderTree(LOCAL_FOLDERS_ACCOUNT_ID, labels.filter((label) => label.type === 'user'))) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  return folders
}

export function Pop3ServerFields({ value, onChange }: { value: Pop3ServerSettings; onChange(next: Pop3ServerSettings): void }) {
  const update = <K extends keyof Pop3ServerSettings>(key: K, next: Pop3ServerSettings[K]) => onChange({ ...value, [key]: next })
  const setSecurity = (security: Pop3Security) => onChange({
    ...value,
    pop3Security: security,
    pop3Port: value.pop3Port === defaultPop3Port(value.pop3Security) ? defaultPop3Port(security) : value.pop3Port,
    allowPlaintext: security === 'none' ? value.allowPlaintext : undefined
  })
  return <>
    <div className="server-fields">
      <strong>Incoming mail (POP3)</strong>
      <label className="field grow"><span>Server</span><input required value={value.pop3Host} onChange={(event) => update('pop3Host', event.target.value)} /></label>
      <label className="field port"><span>Port</span><input type="number" required value={value.pop3Port} onChange={(event) => update('pop3Port', Number(event.target.value))} /></label>
      <label className="field security"><span>Security</span><select value={value.pop3Security} onChange={(event) => setSecurity(event.target.value as Pop3Security)}><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">None</option></select></label>
      <label className="field security"><span>Sign-in</span><select value={value.auth ?? 'auto'} onChange={(event) => update('auth', event.target.value as Pop3ServerSettings['auth'])}><option value="auto">Automatic</option><option value="user">USER/PASS</option><option value="apop">APOP</option><option value="plain">AUTH PLAIN</option></select></label>
    </div>
    {value.pop3Security === 'none' && <div className="pop3-plaintext-warning" role="alert">
      <ShieldAlert size={16} />
      <label className="toggle-row"><span><strong>Allow an unencrypted connection</strong><small>Your password (unless APOP is used) and every downloaded message travel unprotected and can be read on the network. Use this only for a server on a network you trust.</small></span><input type="checkbox" checked={Boolean(value.allowPlaintext)} onChange={(event) => update('allowPlaintext', event.target.checked || undefined)} /></label>
    </div>}
    <div className="server-fields">
      <strong>Outgoing mail (SMTP)</strong>
      <label className="field grow"><span>Server</span><input required value={value.smtpHost} onChange={(event) => update('smtpHost', event.target.value)} /></label>
      <label className="field port"><span>Port</span><input type="number" required value={value.smtpPort} onChange={(event) => update('smtpPort', Number(event.target.value))} /></label>
      <label className="field security"><span>Security</span><select value={value.smtpSecurity} onChange={(event) => update('smtpSecurity', event.target.value as 'tls' | 'starttls')}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></label>
    </div>
  </>
}

export function Pop3DestinationField({ value, onChange }: { value: Pop3Destination; onChange(next: Pop3Destination): void }) {
  const folders = useLocalFolders()
  return <fieldset className="pop3-choice-group">
    <legend>Store downloaded mail in</legend>
    <label><input type="radio" name="pop3-destination" checked={value.kind === 'account'} onChange={() => onChange({ kind: 'account' })} /><span><strong>This account’s own folders</strong><small>Inbox, Sent, Drafts and Trash are kept on this computer. You can add your own folders under Folders &amp; labels.</small></span></label>
    <label><input type="radio" name="pop3-destination" disabled={!folders.length} checked={value.kind === 'local-folder'} onChange={() => folders[0] && onChange({ kind: 'local-folder', labelId: folders[0].label.id })} /><span><strong>A Local Folders folder</strong><small>{folders.length ? 'Useful when moving from another mail app that kept everything in one folder tree.' : 'Create Local Folders from Import mail first to use this option.'}</small></span></label>
    {value.kind === 'local-folder' && <label className="field"><span>Local Folders folder</span><select value={value.labelId} onChange={(event) => onChange({ kind: 'local-folder', labelId: event.target.value })}>
      {!folders.some((folder) => folder.label.id === value.labelId) && <option value={value.labelId}>(folder no longer exists)</option>}
      {folders.map((folder) => <option key={folder.label.id} value={folder.label.id}>{`${'  '.repeat(folder.depth)}${folder.leafName}`}</option>)}
    </select></label>}
  </fieldset>
}

export function Pop3RetentionFields({ value, onChange }: { value: Pop3RetentionPolicy; onChange(next: Pop3RetentionPolicy): void }) {
  const [days, setDays] = useState(value.deleteAfterDays ?? 14)
  return <fieldset className="pop3-choice-group">
    <legend>Messages on the server</legend>
    <label><input type="radio" name="pop3-retention" checked={value.leaveOnServer} onChange={() => onChange({ ...value, leaveOnServer: true })} /><span><strong>Leave a copy on the server</strong><small>Recommended. Other devices keep receiving your mail.</small></span></label>
    {value.leaveOnServer && <div className="pop3-retention-options">
      <label className="pop3-inline-check"><input type="checkbox" checked={Boolean(value.deleteAfterDays)} onChange={(event) => onChange({ ...value, deleteAfterDays: event.target.checked ? days : undefined })} /><span>Remove from the server</span><input aria-label="Days after download" type="number" min={1} max={3650} value={value.deleteAfterDays ?? days} disabled={!value.deleteAfterDays} onChange={(event) => { const next = Math.max(1, Math.min(3650, Math.round(Number(event.target.value) || 1))); setDays(next); onChange({ ...value, deleteAfterDays: next }) }} /><span>days after download</span></label>
      <label className="pop3-inline-check"><input type="checkbox" checked={value.removeWhenDeleted} onChange={(event) => onChange({ ...value, removeWhenDeleted: event.target.checked })} /><span>Remove from the server when I delete a message in Aerio</span></label>
    </div>}
    <label><input type="radio" name="pop3-retention" checked={!value.leaveOnServer} onChange={() => onChange({ leaveOnServer: false, removeWhenDeleted: false })} /><span><strong>Remove from the server after download</strong><small>Aerio becomes the only place this mail is kept.</small></span></label>
    <ul className="pop3-retention-effects" aria-label="What this setting does">{pop3RetentionEffects(value).map((effect) => <li key={effect}>{effect}</li>)}</ul>
  </fieldset>
}

const describeTest = (result: Pop3ConnectionTestResult) =>
  `Connected ${result.encrypted ? 'with encryption' : 'WITHOUT encryption'} using ${({ user: 'USER/PASS', apop: 'APOP', plain: 'AUTH PLAIN' })[result.authMethod]}. The server holds ${result.messages.toLocaleString()} message${result.messages === 1 ? '' : 's'}. SMTP sign-in succeeded.`

export function Pop3AccountSetupForm({ onConnected, onToast, onBusy }: { onConnected(): Promise<void> | void; onToast(message: string): void; onBusy(busy: boolean): void }) {
  const [input, setInput] = useState<Pop3AccountInput>({
    email: '', displayName: '', username: '', password: '',
    pop3Host: '', pop3Port: 995, pop3Security: 'tls', auth: 'auto',
    smtpHost: '', smtpPort: 465, smtpSecurity: 'tls',
    retention: DEFAULT_POP3_RETENTION, destination: { kind: 'account' }
  })
  const [busy, setBusy] = useState<'test' | 'connect'>()
  const [tested, setTested] = useState<string>()
  const api = window.aerio.mail.pop3
  const update = (next: Partial<Pop3AccountInput>) => { setInput((current) => ({ ...current, ...next })); setTested(undefined) }
  const run = async (kind: 'test' | 'connect') => {
    if (!api) return
    setBusy(kind)
    onBusy(true)
    try {
      if (kind === 'test') setTested(describeTest(await api.test(input)))
      else {
        await api.connect(input)
        await onConnected()
        onToast('POP3 account connected — downloading mail')
      }
    } catch (error) {
      onToast(errorText(error, kind === 'test' ? 'The connection test failed' : 'The POP3 account could not be connected'))
    } finally {
      setBusy(undefined)
      onBusy(false)
    }
  }
  if (!api) return <p className="setup-note">POP3 accounts are not available in this build.</p>
  return <form className="provider-setup-body imap-form pop3-form" onSubmit={(event) => { event.preventDefault(); void run('connect') }}>
    <div className="field-grid"><label className="field"><span>Email address</span><input type="email" required value={input.email} onChange={(event) => { const value = event.target.value; update({ email: value, ...(!input.username || input.username === input.email ? { username: value } : {}) }) }} /></label><label className="field"><span>Display name</span><input value={input.displayName} onChange={(event) => update({ displayName: event.target.value })} placeholder="Optional" /></label></div>
    <div className="field-grid"><label className="field"><span>Username</span><input required value={input.username} onChange={(event) => update({ username: event.target.value })} placeholder="Usually your full email address" /></label><label className="field"><span>Password</span><input type="password" required value={input.password} onChange={(event) => update({ password: event.target.value })} /></label></div>
    <Pop3ServerFields value={input} onChange={(next) => update(next)} />
    <Pop3DestinationField value={input.destination} onChange={(destination) => update({ destination })} />
    <Pop3RetentionFields value={input.retention} onChange={(retention) => update({ retention })} />
    <p className="setup-note">POP3 downloads mail to this computer; it does not synchronize folders, read status or deletions with the server. The password is encrypted with your operating system’s secure storage.</p>
    {tested && <p className="pop3-test-result" role="status"><ShieldCheck size={15} /> {tested}</p>}
    <footer className="setup-actions pop3-actions">
      <button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => void run('test')}>{busy === 'test' && <LoaderCircle className="spin" size={15} />}Test connection</button>
      <button type="submit" className="button primary" disabled={Boolean(busy)}>{busy === 'connect' && <LoaderCircle className="spin" size={15} />}Connect POP3 account</button>
    </footer>
  </form>
}

export function Pop3AccountSettingsSection({ account, onToast }: { account: MailAccountSummary; onToast(message: string): void }) {
  const api = window.aerio.mail.pop3
  const [settings, setSettings] = useState<Pop3AccountSettings>()
  const [status, setStatus] = useState<Pop3AccountStatus>()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!api) return
    void api.settings(account.id).then(setSettings).catch((error) => onToast(errorText(error, 'POP3 settings could not be loaded')))
    void api.status(account.id).then(setStatus).catch(() => undefined)
  }, [account.id, api, onToast])
  if (!api || !settings) return null
  const save = async () => {
    setBusy(true)
    try {
      const { passwordConfigured: _configured, ...rest } = settings
      setSettings(await api.update(account.id, { ...rest, ...(password ? { password } : {}) }))
      setPassword('')
      setStatus(await api.status(account.id))
      onToast('POP3 settings saved')
    } catch (error) {
      onToast(errorText(error, 'POP3 settings could not be saved'))
    } finally {
      setBusy(false)
    }
  }
  return <section className="pop3-settings">
    <h3>POP3 and SMTP</h3>
    {status && <p className="pop3-status">{status.downloaded.toLocaleString()} downloaded · {status.onServer.toLocaleString()} still on the server · {status.removedFromServer.toLocaleString()} removed from the server{status.pendingRemoval ? ` · ${status.pendingRemoval.toLocaleString()} waiting to be removed` : ''}{status.skipped ? ` · ${status.skipped.toLocaleString()} too large to download` : ''}{status.lastCheckAt ? ` · Last checked ${new Date(status.lastCheckAt).toLocaleString()}` : ''}</p>}
    {status?.lastError && <p className="account-error">{status.lastError}</p>}
    <p>The saved password remains encrypted and is never displayed. Leave the password blank to keep it. Changed server settings are tested before they are saved.</p>
    <label className="field"><span>Username</span><input value={settings.username} onChange={(event) => setSettings({ ...settings, username: event.target.value })} /></label>
    <Pop3ServerFields value={settings} onChange={(next) => setSettings({ ...settings, ...next })} />
    <label className="field"><span>New password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={settings.passwordConfigured ? 'Leave blank to keep the saved password' : 'Password required'} /></label>
    <Pop3DestinationField value={settings.destination} onChange={(destination) => setSettings({ ...settings, destination })} />
    <Pop3RetentionFields value={settings.retention} onChange={(retention) => setSettings({ ...settings, retention })} />
    <div><button className="button ghost" disabled={busy} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : 'Save POP3 settings'}</button></div>
  </section>
}
