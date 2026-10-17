import { AlertTriangle, LoaderCircle, Search, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ExchangeAuthPreference, ExchangeDiscoverResult } from '../exchange-types'

interface Props {
  busy: boolean
  onConnect(task: () => Promise<unknown>, success: string): Promise<void>
  onToast(message: string): void
}

const reasons: Record<Extract<ExchangeDiscoverResult, { status: 'confirm-redirect' }>['reason'], string> = {
  'http-redirect': 'The autodiscover address of your domain redirects to',
  srv: 'Your domain’s DNS (SRV record) points Autodiscover to',
  'redirect-url': 'Your Autodiscover server redirects to',
  'redirect-address': 'Your Autodiscover server says this mailbox is configured through'
}

const hostOf = (value: string) => { try { return new URL(value).host } catch { return value } }

/** Add-account flow for on-premises Exchange: Autodiscover (with redirect consent) or a manual EWS URL. */
export default function ExchangeAccountSetup({ busy, onConnect, onToast }: Props) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [auth, setAuth] = useState<ExchangeAuthPreference>('auto')
  const [bearerToken, setBearerToken] = useState('')
  const [ewsUrl, setEwsUrl] = useState('')
  const [manual, setManual] = useState(false)
  const [trustedHosts, setTrustedHosts] = useState<string[]>([])
  const [result, setResult] = useState<ExchangeDiscoverResult>()
  const [discovering, setDiscovering] = useState(false)
  const api = window.aerio.exchange

  const discover = async (trusted = trustedHosts) => {
    if (!api) return
    setDiscovering(true)
    try {
      const found = await api.discover({ email, ...(username.trim() ? { username: username.trim() } : {}), ...(password ? { password } : {}), trustedHosts: trusted })
      setResult(found)
      if (found.status === 'found') {
        setEwsUrl(found.ewsUrl)
        if (found.displayName && !displayName) setDisplayName(found.displayName)
      }
      if (found.status === 'not-found') setManual(true)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Autodiscover failed')
    } finally {
      setDiscovering(false)
    }
  }

  const allowRedirect = (host: string) => {
    const next = [...new Set([...trustedHosts, host.toLowerCase()])]
    setTrustedHosts(next)
    void discover(next)
  }

  const connect = () => onConnect(() => api!.connect({
    email, ewsUrl: ewsUrl.trim(), auth,
    ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
    ...(username.trim() ? { username: username.trim() } : {}),
    ...(password ? { password } : {}),
    ...(auth === 'bearer' || bearerToken.trim() ? { bearerToken: bearerToken.trim() } : {})
  }), 'Exchange account connected — sync has started')

  if (!api) return <div className="provider-setup-body"><p className="setup-note">Exchange accounts are not available in this build.</p></div>

  const canConnect = Boolean(email.trim() && ewsUrl.trim() && (auth === 'bearer' ? bearerToken.trim() : password))
  return <form className="provider-setup-body exchange-setup" onSubmit={(event) => { event.preventDefault(); if (canConnect) void connect() }}>
    <div className="field-grid">
      <label className="field"><span>Email address</span><input type="email" required value={email} onChange={(event) => { setEmail(event.target.value); setResult(undefined) }} /></label>
      <label className="field"><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Optional" /></label>
    </div>
    <div className="field-grid">
      <label className="field"><span>User name</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="DOMAIN\user or user@domain (defaults to the email)" /></label>
      <label className="field"><span>Authentication</span><select value={auth} onChange={(event) => setAuth(event.target.value as ExchangeAuthPreference)}>
        <option value="auto">Automatic (NTLM or Basic)</option>
        <option value="ntlm">NTLM (Windows authentication)</option>
        <option value="basic">Basic over HTTPS</option>
        <option value="bearer">OAuth access token (hybrid)</option>
      </select></label>
    </div>
    {auth === 'bearer'
      ? <label className="field"><span>OAuth access token for EWS</span><textarea aria-label="OAuth access token" value={bearerToken} onChange={(event) => setBearerToken(event.target.value)} placeholder="Paste a token issued for your Exchange EWS resource" /></label>
      : <label className="field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}

    {!manual && <div className="exchange-discovery">
      <button type="button" className="button ghost" disabled={discovering || busy || !email.includes('@')} onClick={() => void discover()}>{discovering ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />} Find my server</button>
      <button type="button" className="button ghost small" onClick={() => setManual(true)}>Enter the EWS URL instead</button>
    </div>}

    {result?.status === 'confirm-redirect' && <div className="exchange-redirect" role="alert">
      <AlertTriangle size={16} />
      <div>
        <p>{reasons[result.reason]} <strong>{result.host}</strong>, outside <strong>{result.email.split('@')[1]}</strong>. Aerio would send your password there.</p>
        <p className="setup-note">Continue only if you recognize this server as your organization’s.</p>
        <div className="settings-actions">
          <button type="button" className="button ghost" disabled={discovering} onClick={() => allowRedirect(result.host)}>Trust {result.host} and continue</button>
          <button type="button" className="button ghost" onClick={() => { setResult(undefined); setManual(true) }}>Enter the EWS URL instead</button>
        </div>
      </div>
    </div>}

    {result?.status === 'not-found' && <div className="exchange-redirect" role="status">
      <AlertTriangle size={16} />
      <div>
        <p>Autodiscover did not find an Exchange server for {result.email}. Enter the EWS URL from your administrator.</p>
        <details><summary>What Aerio tried</summary><ul>{result.attempts.map((attempt, index) => <li key={`${attempt.url}-${index}`}><code>{attempt.url}</code> — {attempt.error}</li>)}</ul></details>
      </div>
    </div>}

    {result?.status === 'found' && !manual && <p className="setup-note exchange-found"><ShieldCheck size={15} /> Found {result.serverVersion ? `Exchange ${result.serverVersion}` : 'an Exchange server'} at <code>{result.ewsUrl}</code>. Your password will be sent to {hostOf(result.ewsUrl)}.</p>}

    {(manual || result?.status === 'found') && <label className="field"><span>EWS URL</span><input value={ewsUrl} onChange={(event) => setEwsUrl(event.target.value)} placeholder="https://mail.example.com/EWS/Exchange.asmx" /></label>}

    <p className="setup-note">For Exchange Server 2013 SP1, 2016, 2019, and Subscription Edition. Use “Outlook &amp; Microsoft 365” for Exchange Online. Kerberos-only servers and plain HTTP are not supported.</p>
    <footer className="setup-actions"><button type="submit" className="button primary" disabled={busy || !canConnect}>{busy && <LoaderCircle className="spin" size={15} />}Connect Exchange account</button></footer>
  </form>
}
