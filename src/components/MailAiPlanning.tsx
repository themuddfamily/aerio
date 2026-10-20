import { useEffect, useRef, useState } from 'react'
import type { AiPlanningSuggestion } from '../ai-assistant-types'
import type { MailAccountSummary, MailMessageDetail } from '../mail-types'
import { aiFeatureAvailable, friendlyAiError, useAiAssistantStatus } from '../lib/use-ai-assistant'
import { MessageToolDialog } from './MailMessageTools'

export default function MailAiPlanning({ message, onToast }: { message: MailMessageDetail; onToast(message: string): void }) {
  const status = useAiAssistantStatus()
  const [items, setItems] = useState<AiPlanningSuggestion[]>([])
  const [selected, setSelected] = useState<AiPlanningSuggestion>()
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [notice, setNotice] = useState('')
  const epoch = useRef(0)
  const allowed = status?.automaticPlanning === true && aiFeatureAvailable(status, 'planning') && Boolean(message.text.trim())
  useEffect(() => {
    epoch.current += 1
    setItems([]); setSelected(undefined); setNotice('')
    if (!allowed) return
    let active = true, started = false
    const id = crypto.randomUUID()
    const timer = window.setTimeout(() => {
      started = true; setNotice('Looking for tasks and events…')
      void window.aerio.ai.detectPlanning(id, { accountId: message.accountId, threadId: message.threadId, messageId: message.id }, Intl.DateTimeFormat().resolvedOptions().timeZone)
        .then((suggestions) => { if (active) { setItems(suggestions); setNotice(suggestions.length ? '' : 'No concrete tasks or events detected.') } })
        .catch((reason) => { if (active) setNotice(friendlyAiError(reason)) })
    }, 400)
    return () => { active = false; epoch.current += 1; window.clearTimeout(timer); if (started) void window.aerio.ai.cancel(id).catch(() => undefined) }
  }, [allowed, message.accountId, message.threadId, message.id, status?.provider, status?.model, status?.baseUrl, status?.includeSenderDetails])
  if (!allowed) return null
  const choose = async (item: AiPlanningSuggestion) => {
    const current = epoch.current
    try { const values = await window.aerio.mail.accounts.list(); if (epoch.current === current) { setAccounts(values); setSelected(item) } }
    catch (reason) { onToast(friendlyAiError(reason)) }
  }
  return <section aria-label="Suggested tasks and events" className="ai-replies">
    <small>AI suggestions · Check dates and details before creating. Disable automatic detection in AI settings.</small>
    {notice && <p role="status">{notice}</p>}
    {items.map((item, index) => <article key={index}><strong>{item.title}</strong><p>{item.kind === 'event' ? `${item.start} – ${item.end}` : item.due ? `Due ${item.due}` : 'No due date specified'}</p><p>{item.notes}</p><button className="button ghost small" onClick={() => void choose(item)}>Review {item.kind === 'event' ? 'event' : 'task'}</button></article>)}
    {selected && <MessageToolDialog tool={selected.kind === 'event' ? 'meeting' : 'task'} message={message} accounts={accounts} suggestion={selected} onToast={onToast} onUpdated={() => {}} onClose={() => setSelected(undefined)} />}
  </section>
}
