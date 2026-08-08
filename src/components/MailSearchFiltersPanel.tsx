import { X } from 'lucide-react'
import { useState } from 'react'
import type { MailSearchFilters } from '../mail-types'

interface MailSearchFiltersPanelProps {
  value: MailSearchFilters
  onApply(value: MailSearchFilters): void
  onClose(): void
}

const booleanValue = (value: boolean | undefined) => value === undefined ? '' : String(value)
const optionalBoolean = (value: string) => value === '' ? undefined : value === 'true'

function cleaned(filters: MailSearchFilters): MailSearchFilters {
  return Object.fromEntries(Object.entries(filters).flatMap(([key, value]) => {
    const next = typeof value === 'string' ? value.trim() : value
    return next === '' || next === undefined ? [] : [[key, next]]
  })) as MailSearchFilters
}

export default function MailSearchFiltersPanel({ value, onApply, onClose }: MailSearchFiltersPanelProps) {
  const [draft, setDraft] = useState<MailSearchFilters>(value)

  return (
    <form className="mail-search-filters" role="dialog" aria-label="Advanced mail search" onSubmit={(event) => {
      event.preventDefault()
      onApply(cleaned(draft))
    }}>
      <header>
        <span><strong>Advanced search</strong><small>Combine any of these filters</small></span>
        <button type="button" className="icon-button" aria-label="Close advanced search" title="Close" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="mail-search-filter-fields">
        <label><span>From</span><input autoFocus value={draft.from ?? ''} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} placeholder="Name or email address" /></label>
        <label><span>To or cc</span><input value={draft.to ?? ''} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} placeholder="Recipient address" /></label>
        <label><span>Subject</span><input value={draft.subject ?? ''} onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))} placeholder="Words in the subject" /></label>
        <label><span>Attachment name</span><input value={draft.attachmentName ?? ''} onChange={(event) => setDraft((current) => ({ ...current, attachmentName: event.target.value }))} placeholder="For example, invoice.pdf" /></label>
      </div>

      <div className="mail-search-filter-grid dates">
        <label><span>From date</span><input type="date" value={draft.dateFrom ?? ''} max={draft.dateTo} onChange={(event) => setDraft((current) => ({ ...current, dateFrom: event.target.value }))} /></label>
        <label><span>To date</span><input type="date" value={draft.dateTo ?? ''} min={draft.dateFrom} onChange={(event) => setDraft((current) => ({ ...current, dateTo: event.target.value }))} /></label>
      </div>

      <div className="mail-search-filter-grid states">
        <label><span>Read status</span><select value={booleanValue(draft.unread)} onChange={(event) => setDraft((current) => ({ ...current, unread: optionalBoolean(event.target.value) }))}><option value="">Any</option><option value="true">Unread</option><option value="false">Read</option></select></label>
        <label><span>Attachments</span><select value={booleanValue(draft.hasAttachments)} onChange={(event) => setDraft((current) => ({ ...current, hasAttachments: optionalBoolean(event.target.value) }))}><option value="">Any</option><option value="true">Has attachments</option><option value="false">No attachments</option></select></label>
        <label><span>Star</span><select value={booleanValue(draft.starred)} onChange={(event) => setDraft((current) => ({ ...current, starred: optionalBoolean(event.target.value) }))}><option value="">Any</option><option value="true">Starred</option><option value="false">Not starred</option></select></label>
        <label><span>Importance</span><select value={booleanValue(draft.important)} onChange={(event) => setDraft((current) => ({ ...current, important: optionalBoolean(event.target.value) }))}><option value="">Any</option><option value="true">Important</option><option value="false">Not important</option></select></label>
      </div>

      <footer>
        <button type="button" className="button ghost small" onClick={() => setDraft({})}>Reset</button>
        <span className="spacer" />
        <button type="button" className="button ghost small" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary small">Apply filters</button>
      </footer>
    </form>
  )
}
