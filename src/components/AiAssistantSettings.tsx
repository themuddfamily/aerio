import { useEffect, useState } from 'react'
import { KeyRound, Sparkles } from 'lucide-react'
import { AI_DEFAULT_ANTHROPIC_MODEL, AI_FEATURE_DETAILS, AI_FEATURES, type AiAssistantSettingsInput, type AiAssistantStatus, type AiProviderId } from '../ai-assistant-types'
import { friendlyAiError, notifyAiSettingsChanged } from '../lib/use-ai-assistant'
import AiWritingStyles from './AiWritingStyles'

/** Settings section for the optional, off-by-default AI assistant. */
export default function AiAssistantSettings() {
  const [status, setStatus] = useState<AiAssistantStatus>()
  const [form, setForm] = useState<Omit<AiAssistantSettingsInput, 'apiKey' | 'clearApiKey'>>()
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)

  const apply = (next: AiAssistantStatus) => {
    setStatus(next)
    setForm({ enabled: next.enabled, automaticReplies: next.automaticReplies === true, writingStyles: next.writingStyles ?? {}, provider: next.provider, model: next.model, baseUrl: next.baseUrl, features: { ...next.features }, includeSenderDetails: next.includeSenderDetails })
  }
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => window.aerio.ai.status()).then((next) => { if (active) apply(next) }).catch((error) => {
      if (active) { setMessageIsError(true); setMessage(friendlyAiError(error)) }
    })
    return () => { active = false }
  }, [])

  const save = async (extra: Pick<AiAssistantSettingsInput, 'apiKey' | 'clearApiKey'> = {}) => {
    if (!form) return
    setSaving(true); setMessage('')
    try {
      const next = await window.aerio.ai.configure({ ...form, ...extra })
      apply(next)
      setApiKey('')
      notifyAiSettingsChanged(next)
      setMessageIsError(false)
      setMessage(extra.clearApiKey ? 'API key removed.' : next.enabled ? 'AI assistance settings saved.' : 'AI assistance is off. Nothing is sent to an AI provider.')
    } catch (error) {
      setMessageIsError(true)
      setMessage(friendlyAiError(error))
    } finally { setSaving(false) }
  }
  const update = (changes: Partial<NonNullable<typeof form>>) => setForm((current) => current && { ...current, ...changes })
  const chooseProvider = (provider: AiProviderId) => update({ provider, model: provider === 'anthropic' ? AI_DEFAULT_ANTHROPIC_MODEL : form?.provider === provider ? form.model : '' })

  return (
    <section className="settings-section ai-settings">
      <div className="settings-icon"><Sparkles size={18} /></div>
      <div className="settings-content">
        <h3>AI assistance</h3>
        <p>Optional summaries, drafting help, suggested replies, and natural-language search. Off by default. Automatic suggestions require a separate opt-in below. Suggestions are previews: they never send, move, or change mail unless you apply them yourself.</p>
        {!form || !status ? <small>{message || 'Reading AI assistance settings…'}</small> : <>
          <label className="toggle-row">
            <span><strong>Turn on AI assistance</strong><small>Adds AI actions to the message menu, the composer, and the search box.</small></span>
            <input type="checkbox" checked={form.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          </label>
          {form.enabled && <>
            <label className="field-label">Provider
              <select value={form.provider} onChange={(event) => chooseProvider(event.target.value as AiProviderId)}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai-compatible">OpenAI-compatible server (OpenAI, Ollama, LM Studio…)</option>
              </select>
            </label>
            {form.provider === 'openai-compatible' && <label className="field-label">Server URL
              <input type="url" value={form.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} placeholder="http://localhost:11434/v1" />
              <small>HTTPS, or plain HTTP to a model running on this computer. Aerio adds /chat/completions.</small>
            </label>}
            <label className="field-label">Model
              <input value={form.model} onChange={(event) => update({ model: event.target.value })} placeholder={form.provider === 'anthropic' ? AI_DEFAULT_ANTHROPIC_MODEL : 'llama3.1'} />
            </label>
            <label className="field-label">API key{form.provider === 'openai-compatible' ? ' (if your server needs one)' : ''}
              <input type="password" autoComplete="off" value={apiKey} disabled={!status.secureStorage} onChange={(event) => setApiKey(event.target.value)} placeholder={status.hasApiKey ? 'Saved — enter a new key to replace it' : 'Paste your API key'} />
              <small>{status.secureStorage ? 'Encrypted with your operating system’s secure storage and only used by Aerio’s background process. It is never shown again or stored with other settings.' : 'Secure credential storage is unavailable, so an API key cannot be saved. A local server without a key still works.'}</small>
            </label>
            {status.hasApiKey && <div className="settings-actions"><button className="button ghost" disabled={saving} onClick={() => void save({ clearApiKey: true })}><KeyRound size={16} /> Remove saved key</button></div>}
            <AiWritingStyles status={status} value={form.writingStyles ?? {}} onChange={(writingStyles) => update({ writingStyles })} />
            <fieldset className="ai-settings-features">
              <legend>Features and the data each one sends to {form.provider === 'anthropic' ? 'Anthropic' : 'your server'}</legend>
              {AI_FEATURES.map((feature) => (
                <label key={feature} className="toggle-row">
                  <span><strong>{AI_FEATURE_DETAILS[feature].label}</strong><small>Sends: {AI_FEATURE_DETAILS[feature].sends}</small></span>
                  <input type="checkbox" checked={form.features[feature]} onChange={(event) => update({ features: { ...form.features, [feature]: event.target.checked } })} />
                </label>
              ))}
              <label className="toggle-row">
                <span><strong>Include sender details</strong><small>Adds the sender’s name and email address to summaries and suggestions. Off keeps addresses on this computer.</small></span>
                <input type="checkbox" checked={form.includeSenderDetails} onChange={(event) => update({ includeSenderDetails: event.target.checked })} />
              </label>
              <label className="toggle-row">
                <span><strong>Suggest replies when I open a message</strong><small>Off by default. When enabled, expanding a message automatically sends its subject, date and plain-text body to your AI provider, plus sender details only if allowed above. Recipients, attachments and HTML are excluded. Requires Suggested replies to be enabled. Replies stay as previews.</small></span>
                <input type="checkbox" checked={form.automaticReplies === true} onChange={(event) => update({ automaticReplies: event.target.checked })} />
              </label>
            </fieldset>
          </>}
          <div className="settings-actions">
            <button className="button primary" disabled={saving} onClick={() => void save(apiKey.trim() ? { apiKey } : {})}>{saving ? 'Saving…' : 'Save AI settings'}</button>
          </div>
          {message && <small className={messageIsError ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message}</small>}
        </>}
      </div>
    </section>
  )
}
