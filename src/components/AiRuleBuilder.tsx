import { useEffect, useState } from 'react'
import { AI_FEATURE_DETAILS } from '../ai-assistant-types'
import type { MailLabel, MailRuleInput } from '../mail-types'
import { MAIL_RULE_FIELDS } from '../lib/mail-rules'
import { aiFeatureAvailable, useAiAssistantStatus, useAiRequest } from '../lib/use-ai-assistant'

export default function AiRuleBuilder({ accountId, labels, onUse }: { accountId: string; labels: MailLabel[]; onUse(rule: MailRuleInput): void }) {
  const status = useAiAssistantStatus()
  const request = useAiRequest()
  const [description, setDescription] = useState('')
  const [preview, setPreview] = useState<MailRuleInput>()
  const available = aiFeatureAvailable(status, 'rules')
  useEffect(() => { setPreview(undefined); request.cancel() }, [accountId, request.cancel])
  useEffect(() => { if (!available) { setPreview(undefined); request.cancel() } }, [available, request.cancel])
  if (!available || !window.aerio?.ai?.generateRule) return null
  const labelName = (id?: string) => labels.find((label) => label.accountId === accountId && label.id === id)?.name ?? id
  const describeCondition = (condition: MailRuleInput['conditions'][number]) => `${MAIL_RULE_FIELDS.find((field) => field.field === condition.field)?.label ?? condition.field}${condition.headerName ? ` (${condition.headerName})` : ''} ${condition.operator.replaceAll('-', ' ')} ${condition.field === 'label' ? labelName(condition.value) : condition.value}`
  const generate = async () => {
    setPreview(undefined)
    const result = await request.start((id) => window.aerio.ai.generateRule(id, { accountId, description }))
    if (result) setPreview(result)
  }
  return <section aria-label="Describe a rule with AI">
    <header><span><strong>Describe a rule with AI</strong><small>{AI_FEATURE_DETAILS.rules.sends}</small></span></header>
    <label className="field"><span>What should the rule do?</span><textarea aria-label="Rule description" maxLength={4000} rows={3} value={description} disabled={request.busy} placeholder="e.g. Star incoming messages from alex@example.com unless the subject contains newsletter" onChange={(event) => setDescription(event.target.value)} /></label>
    <button className="button ghost" disabled={request.busy || !description.trim() || !accountId} onClick={() => void generate()}>{request.busy ? 'Generating…' : 'Generate rule preview'}</button>
    {request.busy && <button className="button ghost" onClick={request.cancel}>Cancel generation</button>}
    {request.error && <p role="alert">{request.error}</p>}
    {request.notice && <p role="status">{request.notice}</p>}
    {preview && <div aria-label="AI rule preview">
      <strong>{preview.name}</strong>
      <p>Disabled local draft · {preview.trigger ?? 'incoming'} · Match {preview.match} conditions</p>
      {preview.schedule && <p>Every {preview.schedule.intervalMinutes} minutes in {preview.schedule.folder}</p>}
      <ul>{preview.conditions.map((condition, index) => <li key={index}>{describeCondition(condition)}</li>)}</ul>
      {(preview.exceptions?.length ?? 0) > 0 && <><strong>Except if any match</strong><ul>{preview.exceptions!.map((condition, index) => <li key={index}>{describeCondition(condition)}</li>)}</ul></>}
      <strong>Actions</strong><ol>{preview.actions.map((action, index) => <li key={index}>{action.action.replaceAll('-', ' ')}{action.labelId ? `: ${labelName(action.labelId)}` : ''}{action.category ? `: ${action.category}` : ''}</li>)}</ol>
      <p>Review this preview. Use this draft to replace the editor’s current draft, then edit, enable and save it when ready. Nothing has been saved or run.</p>
      <button className="button ghost" onClick={() => { onUse(preview); setPreview(undefined) }}>Use this draft</button>
      <button className="button ghost" onClick={() => setPreview(undefined)}>Discard preview</button>
    </div>}
  </section>
}
