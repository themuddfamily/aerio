import { useState, type RefObject } from 'react'
import { Sparkles, X } from 'lucide-react'
import { AI_FEATURE_DETAILS, type AiAssistantStatus } from '../ai-assistant-types'
import type { MailMessageRef } from '../mail-types'
import { aiProviderName, useAiRequest } from '../lib/use-ai-assistant'
import { insertHtmlAtRange } from './MailTemplatePicker'

const QUICK_INSTRUCTIONS = ['Rephrase this more clearly', 'Make it more formal', 'Make it friendlier', 'Make it shorter', 'Fix spelling and grammar']

/** Model output is plain text; escaping it is what keeps it from becoming markup in the editor. */
export const plainTextToEditorHtml = (value: string) => value.split('\n').map((line) => line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') || '<br>').map((line) => `<div>${line}</div>`).join('')

/**
 * Drafting and rephrasing panel for the composer. The generated text is only a
 * preview until the user chooses Replace or Insert; neither action sends.
 */
export function MailAiComposeAssist({ status, editorRef, text, replyTo, onEditorChange, onClose }: {
  status: AiAssistantStatus; editorRef: RefObject<HTMLDivElement | null>; text: string; replyTo?: MailMessageRef
  onEditorChange(): void; onClose(): void
}) {
  const request = useAiRequest()
  const [instruction, setInstruction] = useState('')
  const [includeReply, setIncludeReply] = useState(false)
  const [preview, setPreview] = useState('')
  const provider = aiProviderName(status)
  const generate = async () => {
    const result = await request.start((id) => window.aerio.ai.compose(id, { instruction, draft: text, ...(includeReply && replyTo ? { replyTo } : {}) }))
    if (result !== undefined) setPreview(result)
  }
  const apply = (mode: 'replace' | 'insert') => {
    const editor = editorRef.current
    if (!editor || !preview) return
    if (mode === 'replace') editor.innerHTML = plainTextToEditorHtml(preview)
    else insertHtmlAtRange(editor, plainTextToEditorHtml(preview))
    onEditorChange()
    setPreview('')
    onClose()
  }

  return <section className="ai-compose-assist" aria-label="AI writing assistant">
    <header><strong><Sparkles size={14} /> Draft with AI</strong><button className="icon-button" aria-label="Close AI writing assistant" onClick={() => { request.cancel(); onClose() }}><X size={14} /></button></header>
    <label className="field-label">What should the assistant do?
      <input autoFocus value={instruction} maxLength={1000} onChange={(event) => setInstruction(event.target.value)} placeholder="e.g. Write a polite reply accepting the meeting" onKeyDown={(event) => { if (event.key === 'Enter' && !request.busy) void generate() }} />
    </label>
    <div className="ai-quick-instructions">{QUICK_INSTRUCTIONS.map((value) => <button key={value} type="button" className="chip" onClick={() => setInstruction(value)}>{value}</button>)}</div>
    {replyTo && <label className="checkbox-row"><input type="checkbox" checked={includeReply} onChange={(event) => setIncludeReply(event.target.checked)} /> Include the email I’m replying to</label>}
    <small className="ai-disclosure">Sends to {provider} ({status.model}): {AI_FEATURE_DETAILS.compose.sends}</small>
    {request.busy && <p role="status">Waiting for {provider}…</p>}
    {request.notice && <p role="status">{request.notice}</p>}
    {request.error && <p role="alert" className="message-tool-error">{request.error}</p>}
    {preview && <section aria-label="AI draft preview"><h4>Preview — not yet in your message</h4><pre className="mail-text ai-output">{preview}</pre></section>}
    <div className="settings-actions">
      {request.busy
        ? <button className="button ghost small" onClick={request.cancel}><X size={14} /> Cancel request</button>
        : <button className="button ghost small" disabled={!instruction.trim() && !text.trim()} onClick={() => void generate()}><Sparkles size={14} /> {preview ? 'Try again' : 'Generate'}</button>}
      {preview && !request.busy && <>
        <button className="button primary small" onClick={() => apply('replace')}>Replace message text</button>
        <button className="button ghost small" onClick={() => apply('insert')}>Insert at cursor</button>
      </>}
    </div>
  </section>
}
