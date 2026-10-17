import { useEffect, useState } from 'react'
import { Bot, Copy, KeyRound, Trash2 } from 'lucide-react'
import type { MailAccountSummary } from '../mail-types'
import type { McpCapability, McpIssuedClient, McpSettings, McpStatus } from '../mcp-types'

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const formatTime = (value?: string) => value ? new Date(value).toLocaleString() : 'Never'

const CAPABILITIES: { id: Exclude<McpCapability, 'read'>; label: string; summary: string }[] = [
  { id: 'write', label: 'Allow changes', summary: 'Mark read, flag, move, archive, and create or edit drafts.' },
  { id: 'send', label: 'Allow sending', summary: 'Send drafts from your accounts. Each send uses Aerio’s Outbox and undo window.' },
  { id: 'delete', label: 'Allow moving to Trash', summary: 'Move conversations to Trash. Providers may empty Trash later.' }
]

/** Settings › External automation (MCP): off by default, with separately enabled capabilities. */
export default function McpAutomationSection() {
  const api = window.aerio.mcp
  const [status, setStatus] = useState<McpStatus>()
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const [clientName, setClientName] = useState('Claude Desktop')
  const [issued, setIssued] = useState<McpIssuedClient>()
  const [snippet, setSnippet] = useState<'claudeDesktop' | 'generic'>('claudeDesktop')

  useEffect(() => {
    if (!api) return
    let active = true
    void api.status().then((next) => { if (active) setStatus(next) }).catch((error) => {
      if (active) { setMessageIsError(true); setMessage(errorText(error, 'External automation status is unavailable.')) }
    })
    void window.aerio.mail.accounts.list().then((list) => { if (active) setAccounts(list) }).catch(() => undefined)
    const unsubscribe = api.onChanged((next) => { if (active) setStatus(next) })
    return () => { active = false; unsubscribe() }
  }, [api])

  if (!api) return null
  const report = (text: string, isError = false) => { setMessage(text); setMessageIsError(isError) }

  const save = async (updates: Partial<McpSettings>) => {
    if (!status) return
    setBusy(true)
    try { setStatus(await api.save({ ...status.settings, ...updates })); report('') }
    catch (error) { report(errorText(error, 'The automation settings could not be saved.'), true) }
    finally { setBusy(false) }
  }

  const setCapability = (id: Exclude<McpCapability, 'read'>, enabled: boolean) =>
    status && void save({ capabilities: { ...status.settings.capabilities, [id]: enabled } })

  const toggleAccount = (accountId: string, included: boolean) => {
    if (!status) return
    const current = status.settings.accountScope === 'all' ? accounts.map((account) => account.id) : status.settings.accountScope
    void save({ accountScope: included ? [...new Set([...current, accountId])] : current.filter((id) => id !== accountId) })
  }

  const issue = async () => {
    setBusy(true)
    report('')
    try {
      const next = await api.createClient(clientName)
      setIssued(next)
      setStatus(await api.status())
    } catch (error) { report(errorText(error, 'The client could not be issued.'), true) }
    finally { setBusy(false) }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    try {
      setStatus(await api.revokeClient(id))
      if (issued?.client.id === id) setIssued(undefined)
      report('Client revoked. Its token stopped working immediately.')
    } catch (error) { report(errorText(error, 'The client could not be revoked.'), true) }
    finally { setBusy(false) }
  }

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); report('Copied. Paste it into your MCP client’s configuration.') }
    catch { report('Copy failed. Select the text and copy it manually.', true) }
  }

  const settings = status?.settings
  const scoped = settings && settings.accountScope !== 'all'
  return (
    <section className="settings-section mcp-automation">
      <div className="settings-icon"><Bot size={18} /></div>
      <div className="settings-content">
        <h3>External automation (MCP)</h3>
        <p>Let AI assistants and scripts on this computer use your mail through a local Model Context Protocol bridge. Clients connect only while Aerio is running and unlocked; nothing is reachable from the network.</p>
        <label className="toggle-row">
          <span><strong>Enable automation bridge</strong><small>{status ? status.listening ? 'Listening for local clients.' : 'Off. No client can connect.' : 'Reading status…'}</small></span>
          <input type="checkbox" disabled={!status || busy} checked={Boolean(settings?.enabled)} onChange={(event) => void save({ enabled: event.target.checked })} />
        </label>
        {settings && <>
          <div className="mcp-capabilities" role="group" aria-label="Automation capabilities">
            <div className="mcp-capability">
              <strong>Read access (always on while enabled)</strong>
              <ul>{status!.tools.filter((tool) => tool.capability === 'read').map((tool) => <li key={tool.name}><code>{tool.name}</code> {tool.effect}</li>)}</ul>
            </div>
            {CAPABILITIES.map((capability) => (
              <div className="mcp-capability" key={capability.id}>
                <label className="toggle-row">
                  <span><strong>{capability.label}</strong><small>{capability.summary}</small></span>
                  <input type="checkbox" disabled={busy || !settings.enabled} checked={settings.capabilities[capability.id]} onChange={(event) => setCapability(capability.id, event.target.checked)} />
                </label>
                <ul>{status!.tools.filter((tool) => tool.capability === capability.id).map((tool) => <li key={tool.name}><code>{tool.name}</code> {tool.effect}</li>)}</ul>
              </div>
            ))}
          </div>
          <fieldset className="mcp-scope" disabled={busy}>
            <legend>Accounts clients can use</legend>
            <label><input type="radio" name="mcp-scope" checked={!scoped} onChange={() => void save({ accountScope: 'all' })} /> All accounts</label>
            <label><input type="radio" name="mcp-scope" checked={Boolean(scoped)} onChange={() => void save({ accountScope: accounts.map((account) => account.id) })} /> Only selected accounts</label>
            {scoped && <ul aria-label="Allowed accounts">
              {accounts.map((account) => <li key={account.id}><label>
                <input type="checkbox" checked={(settings.accountScope as string[]).includes(account.id)} onChange={(event) => toggleAccount(account.id, event.target.checked)} />
                {account.displayName || account.email} <small>{account.email}</small>
              </label></li>)}
              {!accounts.length && <li><small>No accounts are connected.</small></li>}
            </ul>}
          </fieldset>
          <h4>Connected clients</h4>
          {status!.clients.length ? <ul className="profile-backup-list" aria-label="Automation clients">
            {status!.clients.map((client) => <li key={client.id}>
              <span><strong>{client.name}{client.connected ? ' · connected' : ''}</strong><small>Issued {formatTime(client.createdAt)} · last used {formatTime(client.lastUsedAt)}</small></span>
              <button className="button danger-subtle" disabled={busy} onClick={() => void revoke(client.id)}><Trash2 size={14} /> Revoke</button>
            </li>)}
          </ul> : <small>No clients have been issued a token.</small>}
          <div className="mcp-issue">
            <label className="field-label">Client name
              <input value={clientName} maxLength={80} onChange={(event) => setClientName(event.target.value)} />
            </label>
            <button className="button ghost" disabled={busy || !clientName.trim()} onClick={() => void issue()}><KeyRound size={16} /> Issue client token</button>
          </div>
          {issued && <div className="profile-restore-preview mcp-issued" role="region" aria-label="Client configuration">
            <strong>Configuration for {issued.client.name}</strong>
            <small>This token is shown only once. Aerio keeps only a hash; if it is lost, revoke the client and issue a new one.</small>
            <div className="segmented" role="tablist" aria-label="Configuration format">
              <button role="tab" aria-selected={snippet === 'claudeDesktop'} className={snippet === 'claudeDesktop' ? 'active' : ''} onClick={() => setSnippet('claudeDesktop')}>Claude Desktop</button>
              <button role="tab" aria-selected={snippet === 'generic'} className={snippet === 'generic' ? 'active' : ''} onClick={() => setSnippet('generic')}>Generic mcpServers</button>
            </div>
            <pre className="mcp-snippet" aria-label="MCP client configuration">{issued.config[snippet]}</pre>
            <div className="settings-actions">
              <button className="button primary" onClick={() => void copy(issued.config[snippet])}><Copy size={16} /> Copy configuration</button>
              <button className="button ghost" onClick={() => setIssued(undefined)}>Done</button>
            </div>
          </div>}
          <small title={status!.endpoint}>Bridge command: {[status!.command, ...status!.args].join(' ')}</small>
        </>}
        {message && <small className={messageIsError ? 'diagnostic-error' : 'diagnostic-result'} aria-live="polite">{message}</small>}
      </div>
    </section>
  )
}
