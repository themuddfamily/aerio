import { useMemo, useState } from 'react'
import { Search, Sparkles, X } from 'lucide-react'
import { AI_FEATURE_DETAILS, type AiAssistantStatus } from '../ai-assistant-types'
import { mailSearchQueryError } from '../lib/mail-search-query'
import { aiProviderName, useAiRequest } from '../lib/use-ai-assistant'
import Modal from './Modal'

/**
 * Turns a plain-language request into Aerio's search syntax. The proposed
 * query is validated by the same parser as the search box, stays editable, and
 * only runs when the user presses “Run search”.
 */
export default function MailAiSearchDialog({ status, onRun, onClose }: { status: AiAssistantStatus; onRun(query: string): void; onClose(): void }) {
  const request = useAiRequest()
  const [description, setDescription] = useState('')
  const [query, setQuery] = useState('')
  const [proposed, setProposed] = useState(false)
  const queryError = useMemo(() => proposed ? mailSearchQueryError(query) ?? (query.trim() ? undefined : 'Enter a search') : undefined, [proposed, query])
  const provider = aiProviderName(status)
  const generate = async () => {
    const result = await request.start((id) => window.aerio.ai.search(id, description))
    if (result) { setQuery(result.query); setProposed(true) }
  }

  return <Modal title="Ask AI to search" subtitle="Describe the mail you want to find" width="small" onClose={() => { request.cancel(); onClose() }}>
    <div className="form-stack message-tool-form ai-assist">
      <label className="field-label">What are you looking for?
        <textarea autoFocus rows={3} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. invoices from Ada that aren't paid yet" />
      </label>
      <small className="ai-disclosure"><Sparkles size={13} /> Sends to {provider} ({status.model}): {AI_FEATURE_DETAILS.search.sends}</small>
      {request.busy && <p role="status">Waiting for {provider}…</p>}
      {request.notice && <p role="status">{request.notice}</p>}
      {request.error && <p role="alert" className="message-tool-error">{request.error}</p>}
      {proposed && <label className="field-label">Proposed search — review or edit before running
        <input aria-label="Proposed search" className="ai-search-query" value={query} onChange={(event) => setQuery(event.target.value)} aria-invalid={Boolean(queryError)} />
        {queryError ? <small className="message-tool-error" role="alert">{queryError}</small> : <small>Searches your offline mail only. Dates, folders, and read state are not part of the query; use Filters for those.</small>}
      </label>}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" onClick={() => { request.cancel(); onClose() }}>Close</button>
      <span className="spacer" />
      {request.busy
        ? <button className="button ghost" onClick={request.cancel}><X size={15} /> Cancel request</button>
        : <button className={`button ${proposed ? 'ghost' : 'primary'}`} disabled={!description.trim()} onClick={() => void generate()}><Sparkles size={15} /> {proposed ? 'Suggest again' : 'Suggest search'}</button>}
      {proposed && !request.busy && <button className="button primary" disabled={Boolean(queryError)} onClick={() => { onRun(query.trim()); onClose() }}><Search size={15} /> Run search</button>}
    </footer>
  </Modal>
}
