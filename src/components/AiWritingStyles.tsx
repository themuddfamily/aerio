import { useEffect, useState } from 'react'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { MailAccountSummary } from '../mail-types'
import { aiProviderName, useAiRequest } from '../lib/use-ai-assistant'

export default function AiWritingStyles({ status, value, onChange }: { status: AiAssistantStatus; value: Record<string, string>; onChange(value: Record<string, string>): void }) {
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [accountId, setAccountId] = useState('')
  const [sample, setSample] = useState('')
  const [preview, setPreview] = useState('')
  const request = useAiRequest()
  useEffect(() => {
    let active = true
    void Promise.resolve(window.aerio.mail?.accounts?.list?.()).then((items) => {
      if (!active) return
      const senders = (items ?? []).filter((account) => !account.archived && account.provider !== 'local')
      setAccounts(senders); setAccountId(senders[0]?.id ?? '')
    }).catch(() => undefined)
    return () => { active = false }
  }, [])
  return <fieldset className="form-stack"><legend>Writing style per sending account</legend>
    {!accounts.length ? <small>Connect a mail account to save its writing style.</small> : <>
      <label className="field-label">Writing style account<select value={accountId} disabled={request.busy} onChange={(event) => { setAccountId(event.target.value); setSample(''); setPreview('') }}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label>
      <label className="field-label">Saved writing preferences<textarea maxLength={2000} value={value[accountId] ?? ''} onChange={(event) => onChange({ ...value, [accountId]: event.target.value })} placeholder="For example: concise, friendly British English, short paragraphs." /></label>
      <small>Used by AI drafting for this account. Clear the field to remove the style, then Save AI settings.</small>
      <label className="field-label">Optional selected sent-mail examples<textarea maxLength={12000} value={sample} disabled={request.busy} onChange={(event) => setSample(event.target.value)} placeholder="Paste selected examples of your own writing. Remove private details first." /></label>
      <small>Learning sends only these pasted examples to {aiProviderName(status)} using your saved AI settings. Aerio never scans Sent automatically. The result is a preview.</small>
      <button className="button ghost" disabled={request.busy || !sample.trim()} onClick={() => void request.start((id) => window.aerio.ai.learnStyle(id, sample)).then((result) => { if (result !== undefined) setPreview(result) })}>Analyze selected examples</button>
      {request.busy && <button className="button ghost" onClick={request.cancel}>Cancel style analysis</button>}
      {request.error && <p role="alert">{request.error}</p>}
      {preview && <><label className="field-label">Writing style preview<textarea value={preview} maxLength={2000} onChange={(event) => setPreview(event.target.value)} /></label><button className="button ghost" onClick={() => { onChange({ ...value, [accountId]: preview }); setPreview('') }}>Use this style</button><small>Save AI settings to persist this change.</small></>}
    </>}
  </fieldset>
}
