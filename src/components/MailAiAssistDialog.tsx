import { useState } from 'react'
import { Copy, Reply, Sparkles, X } from 'lucide-react'
import { AI_FEATURE_DETAILS, type AiAssistantStatus, type AiSummaryScope } from '../ai-assistant-types'
import type { MailMessageDetail, MailMessageRef } from '../mail-types'
import { aiProviderName, useAiRequest } from '../lib/use-ai-assistant'
import { copyText } from './ContextMenu'
import Modal from './Modal'

export type MailAiAssistMode = 'summarize' | 'replies'

/**
 * Summarize an email or suggest replies. Nothing is sent to the provider until
 * the user presses the action button, and results are previews: the only way
 * to use a reply is the explicit “Reply with this” button, which opens an
 * editable composer and never sends.
 */
export default function MailAiAssistDialog({ mode, message, messageRef, status, onReplyWithText, onToast, onClose }: {
  mode: MailAiAssistMode; message: MailMessageDetail; messageRef: MailMessageRef; status: AiAssistantStatus
  onReplyWithText?(text: string): void; onToast(message: string): void; onClose(): void
}) {
  const request = useAiRequest()
  const [summary, setSummary] = useState('')
  const [scope, setScope] = useState<AiSummaryScope>('message')
  const [replies, setReplies] = useState<string[]>([])
  const provider = aiProviderName(status)
  const generate = async () => {
    if (mode === 'summarize') {
      const result = await request.start((id) => scope === 'conversation' ? window.aerio.ai.summarize(id, messageRef, scope) : window.aerio.ai.summarize(id, messageRef))
      if (result !== undefined) setSummary(result)
    } else {
      const result = await request.start((id) => window.aerio.ai.suggestReplies(id, messageRef))
      if (result !== undefined) setReplies(result)
    }
  }
  const copy = async (text: string) => {
    try { await copyText(text); onToast('Copied') } catch { onToast('Copying failed') }
  }
  const hasResult = mode === 'summarize' ? Boolean(summary) : replies.length > 0

  return <Modal title={mode === 'summarize' ? 'Summarize with AI' : 'Suggested replies'} subtitle={message.subject} width="large" onClose={() => { request.cancel(); onClose() }}>
    <div className="form-stack message-tool-form ai-assist">
      <p className="ai-disclosure"><Sparkles size={14} /> Sends to {provider} ({status.model}): {mode === 'summarize' && scope === 'conversation' ? 'Cached conversation excerpts as described below.' : AI_FEATURE_DETAILS[mode].sends}</p>
      {mode === 'summarize' && <label className="field-label">Summarize
        <select aria-label="Summary scope" value={scope} disabled={request.busy} onChange={(event) => { setScope(event.target.value as AiSummaryScope); setSummary('') }}>
          <option value="message">This message</option><option value="conversation">Whole conversation</option>
        </select>
        {scope === 'conversation' && <small>Sends subject, date and plain-text excerpts from up to the newest 100 cached messages, in chronological order, sharing a 48,000-character budget. Sender details follow your setting. Attachments, recipients and HTML are excluded. Uncached mail is not downloaded.</small>}
      </label>}
      <p className="ai-disclosure">AI output can be wrong. Instructions hidden inside an email are treated as data, and nothing here can send or change mail.</p>
      {request.busy && <p role="status">Waiting for {provider}…</p>}
      {request.notice && <p role="status">{request.notice}</p>}
      {request.error && <p role="alert" className="message-tool-error">{request.error}</p>}
      {mode === 'summarize' && summary && <section aria-label="AI summary"><h3>Summary preview</h3><pre className="mail-text ai-output">{summary}</pre></section>}
      {mode === 'replies' && replies.length > 0 && <section aria-label="Suggested replies" className="ai-replies"><h3>Reply previews</h3>{replies.map((reply, index) => <article key={index} className="ai-reply">
        <pre className="mail-text ai-output">{reply}</pre>
        <div className="settings-actions">
          {onReplyWithText && <button className="button ghost small" onClick={() => { onReplyWithText(reply); onClose() }}><Reply size={14} /> Reply with this</button>}
          <button className="button ghost small" onClick={() => void copy(reply)}><Copy size={14} /> Copy</button>
        </div>
      </article>)}</section>}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" onClick={() => { request.cancel(); onClose() }}>Close</button>
      <span className="spacer" />
      {mode === 'summarize' && summary && !request.busy && <button className="button ghost" onClick={() => void copy(summary)}><Copy size={15} /> Copy summary</button>}
      {request.busy
        ? <button className="button ghost" onClick={request.cancel}><X size={15} /> Cancel request</button>
        : <button className="button primary" disabled={scope !== 'conversation' && !message.text.trim()} onClick={() => void generate()}><Sparkles size={15} /> {hasResult ? 'Try again' : mode === 'summarize' ? 'Summarize' : 'Suggest replies'}</button>}
    </footer>
  </Modal>
}
