import { useEffect, useState } from 'react'
import type { MailMessageDetail } from '../mail-types'
import { aiFeatureAvailable, aiProviderName, friendlyAiError, useAiAssistantStatus } from '../lib/use-ai-assistant'

/** Mounted only for expanded messages. Unmount cancels and drops late results. */
export default function MailAutomaticReplies({ message, onReply }: { message: MailMessageDetail; onReply?(text: string): void }) {
  const status = useAiAssistantStatus()
  const [replies, setReplies] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const allowed = aiFeatureAvailable(status, 'replies') && status?.automaticReplies === true && Boolean(message.text.trim())
  useEffect(() => {
    setReplies([]); setError(''); setBusy(false)
    if (!allowed) return
    let active = true
    const id = crypto.randomUUID()
    // Let a transient expansion settle, avoiding calls while rapidly browsing.
    let started = false
    const timer = window.setTimeout(() => {
      started = true; setBusy(true)
      void window.aerio.ai.suggestReplies(id, { accountId: message.accountId, threadId: message.threadId, messageId: message.id }, true)
        .then((result) => { if (active) setReplies(result) })
        .catch((reason) => { if (active) setError(friendlyAiError(reason)) })
        .finally(() => { if (active) setBusy(false) })
    }, 400)
    return () => { active = false; window.clearTimeout(timer); if (started) void window.aerio.ai.cancel(id).catch(() => undefined) }
  }, [allowed, message.accountId, message.threadId, message.id, status?.provider, status?.model, status?.baseUrl, status?.includeSenderDetails])
  if (!allowed || !status) return null
  return <section aria-label="Automatic reply suggestions" className="ai-replies">
    <small>Automatic suggestions from {aiProviderName(status)} · Review before using. Disable in AI assistance settings.</small>
    {busy && <p role="status">Suggesting replies…</p>}
    {error && <p role="status">{error}</p>}
    {replies.map((reply, index) => <article key={index}><p>{reply}</p>{onReply && <button className="button ghost small" onClick={() => onReply(reply)}>Reply with this</button>}</article>)}
  </section>
}
