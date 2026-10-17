import { Copy, Download, ExternalLink, LoaderCircle, Paperclip, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MailAccountSummary, MailAttachmentFileType, MailAttachmentListItem, MailAttachmentPage, MailAttachmentQuery } from '../mail-types'
import { formatFileSize } from '../lib/domain'
import { formatMailArrivalTooltip, formatMailListTime } from '../lib/mail-date'
import { copyText, useContextMenu } from './ContextMenu'
import Modal from './Modal'

interface MailAttachmentsModalProps {
  accounts: MailAccountSummary[]
  onToast(message: string): void
  onClose(): void
}

export const attachmentFileTypeNames: Record<MailAttachmentFileType, string> = {
  pdf: 'PDF', document: 'Documents', spreadsheet: 'Spreadsheets', presentation: 'Presentations', image: 'Images',
  archive: 'Archives', calendar: 'Calendar invites', audio: 'Audio', video: 'Video', other: 'Other files'
}

const KB = 1024
const MB = 1024 * KB
export const attachmentSizeRanges: Record<string, { label: string; minSize?: number; maxSize?: number }> = {
  any: { label: 'Any size' },
  small: { label: 'Under 100 KB', maxSize: 100 * KB - 1 },
  medium: { label: '100 KB – 1 MB', minSize: 100 * KB, maxSize: MB - 1 },
  large: { label: '1 – 10 MB', minSize: MB, maxSize: 10 * MB - 1 },
  huge: { label: 'Over 10 MB', minSize: 10 * MB }
}

interface Filters {
  search: string
  sender: string
  recipient: string
  accountId: string
  fileType: '' | MailAttachmentFileType
  size: string
  dateFrom: string
  dateTo: string
  includeArchivedAccounts: boolean
  includeInline: boolean
}

const emptyFilters: Filters = { search: '', sender: '', recipient: '', accountId: 'all', fileType: '', size: 'any', dateFrom: '', dateTo: '', includeArchivedAccounts: true, includeInline: false }

export function attachmentQueryFromFilters(filters: Filters): MailAttachmentQuery {
  const range = attachmentSizeRanges[filters.size] ?? attachmentSizeRanges.any
  return {
    accountIds: filters.accountId === 'all' ? undefined : [filters.accountId],
    includeArchivedAccounts: filters.includeArchivedAccounts,
    includeInline: filters.includeInline,
    search: filters.search.trim() || undefined,
    sender: filters.sender.trim() || undefined,
    recipient: filters.recipient.trim() || undefined,
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    fileTypes: filters.fileType ? [filters.fileType] : undefined,
    minSize: range.minSize,
    maxSize: range.maxSize,
    pageSize: 50
  }
}

const itemKey = (item: MailAttachmentListItem) => `${item.accountId}:${item.messageId}:${item.attachmentId}`
const extension = (filename: string) => filename.includes('.') ? filename.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE'

export default function MailAttachmentsModal({ accounts, onToast, onClose }: MailAttachmentsModalProps) {
  const { showContextMenu } = useContextMenu()
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  // Typed filters wait briefly so each keystroke does not query SQLite.
  const [debouncedFilters, setDebouncedFilters] = useState<Filters>(emptyFilters)
  const [page, setPage] = useState<MailAttachmentPage>({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [busyKey, setBusyKey] = useState<string>()
  const requestId = useRef(0)
  const accountsById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])
  // Archiving or deleting an account changes what the cache holds, so the list reloads.
  const accountsKey = accounts.map((account) => `${account.id}:${account.archived ? 1 : 0}`).join('|')
  const query = useMemo(() => attachmentQueryFromFilters(debouncedFilters), [debouncedFilters])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedFilters(filters), 250)
    return () => window.clearTimeout(timer)
  }, [filters])

  useEffect(() => {
    if (filters.accountId !== 'all' && !accountsById.has(filters.accountId)) setFilters((current) => ({ ...current, accountId: 'all' }))
  }, [accountsById, filters.accountId])

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setLoadError(undefined)
    window.aerio.mail.attachments.list(query)
      .then((next) => { if (id === requestId.current) setPage(next) })
      .catch((error) => {
        if (id !== requestId.current) return
        setPage({ items: [], total: 0 })
        setLoadError(error instanceof Error ? error.message : 'Attachments could not be loaded')
      })
      .finally(() => { if (id === requestId.current) setLoading(false) })
  }, [query, accountsKey])

  const loadMore = async () => {
    if (!page.nextCursor || loadingMore) return
    const id = requestId.current
    setLoadingMore(true)
    try {
      const next = await window.aerio.mail.attachments.list({ ...query, cursor: page.nextCursor })
      if (id !== requestId.current) return
      setPage((current) => {
        const known = new Set(current.items.map(itemKey))
        return { items: [...current.items, ...next.items.filter((item) => !known.has(itemKey(item)))], total: next.total, nextCursor: next.nextCursor }
      })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'More attachments could not be loaded')
    } finally {
      setLoadingMore(false)
    }
  }

  const run = async (item: MailAttachmentListItem, action: () => Promise<void>) => {
    setBusyKey(itemKey(item))
    try { await action() } finally { setBusyKey((current) => current === itemKey(item) ? undefined : current) }
  }

  const openAttachment = (item: MailAttachmentListItem) => run(item, async () => {
    try {
      const result = await window.aerio.mail.attachments.open(item.accountId, item.messageId, item.attachmentId, item.filename)
      if (result.error) onToast(result.error)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be opened')
    }
  })

  const saveAttachment = (item: MailAttachmentListItem) => run(item, async () => {
    try {
      const result = await window.aerio.mail.attachments.save(item.accountId, item.messageId, item.attachmentId, item.filename)
      if (result.error) onToast(result.error)
      else if (result.savedPath) onToast(`Saved ${item.filename}`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be saved')
    }
  })

  const showMessage = (item: MailAttachmentListItem) => {
    void window.aerio.window.openMessage({ source: 'connected', accountId: item.accountId, threadId: item.threadId, messageId: item.messageId, title: item.subject })
      .catch((error) => onToast(error instanceof Error ? error.message : 'The message window could not be opened'))
  }

  const showMenu = (event: React.MouseEvent, item: MailAttachmentListItem) => showContextMenu(event, [
    { label: 'Open attachment', icon: Download, disabled: !item.available, action: () => openAttachment(item) },
    { label: 'Save as…', icon: Download, disabled: !item.available, action: () => saveAttachment(item) },
    { label: 'Show original message', icon: ExternalLink, separatorBefore: true, action: () => showMessage(item) },
    { label: 'Copy filename', icon: Copy, separatorBefore: true, action: () => copyText(item.filename) }
  ], item.filename)

  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }))
  const filtered = JSON.stringify(filters) !== JSON.stringify(emptyFilters)

  return (
    <Modal title="Attachments" subtitle={loading ? 'Searching offline mail…' : `${page.total.toLocaleString()} attachment${page.total === 1 ? '' : 's'} in offline mail`} className="mail-attachments-modal" popoutSize={{ width: 1040, height: 780 }} onClose={onClose}>
      <div className="mail-attachment-filters">
        <label className="mail-attachment-search"><Search size={14} /><input autoFocus aria-label="Attachment name" value={filters.search} onChange={(event) => update('search', event.target.value)} placeholder="Search attachment names…" /></label>
        <label><span>From</span><input value={filters.sender} onChange={(event) => update('sender', event.target.value)} placeholder="Sender" /></label>
        <label><span>To or cc</span><input value={filters.recipient} onChange={(event) => update('recipient', event.target.value)} placeholder="Recipient" /></label>
        <label><span>Account</span><select value={filters.accountId} onChange={(event) => update('accountId', event.target.value)}><option value="all">All accounts</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}{account.archived ? ' (archive)' : ''}</option>)}</select></label>
        <label><span>Type</span><select value={filters.fileType} onChange={(event) => update('fileType', event.target.value as Filters['fileType'])}><option value="">All types</option>{Object.entries(attachmentFileTypeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Size</span><select value={filters.size} onChange={(event) => update('size', event.target.value)}>{Object.entries(attachmentSizeRanges).map(([value, range]) => <option key={value} value={value}>{range.label}</option>)}</select></label>
        <label><span>Received after</span><input type="date" value={filters.dateFrom} onChange={(event) => update('dateFrom', event.target.value)} /></label>
        <label><span>Received before</span><input type="date" value={filters.dateTo} onChange={(event) => update('dateTo', event.target.value)} /></label>
        <div className="mail-attachment-toggles">
          <label><input type="checkbox" checked={filters.includeArchivedAccounts} onChange={(event) => update('includeArchivedAccounts', event.target.checked)} /> Include archived accounts</label>
          <label><input type="checkbox" checked={filters.includeInline} onChange={(event) => update('includeInline', event.target.checked)} /> Show inline images</label>
          {filtered && <button className="text-button" onClick={() => setFilters(emptyFilters)}>Clear filters</button>}
        </div>
      </div>
      <div className="mail-attachment-list" role="list" aria-busy={loading}>
        {loading && !page.items.length && <div className="rules-empty"><LoaderCircle className="spin" size={24} /><span>Loading attachments…</span></div>}
        {!loading && loadError && <div className="rules-empty"><Paperclip size={26} /><strong>Attachments could not be loaded</strong><span>{loadError}</span></div>}
        {!loading && !loadError && !page.items.length && <div className="rules-empty"><Paperclip size={26} /><strong>{filtered ? 'No attachments match these filters' : 'No attachments yet'}</strong><span>{filtered ? 'Try a broader search or clear the filters.' : 'Attachments from downloaded mail appear here.'}</span></div>}
        {page.items.map((item) => {
          const account = accountsById.get(item.accountId)
          const busy = busyKey === itemKey(item)
          const sender = item.fromName || item.fromEmail || 'Unknown sender'
          return <article key={itemKey(item)} role="listitem" className={item.available ? '' : 'unavailable'} onContextMenu={(event) => showMenu(event, item)} onDoubleClick={() => item.available && void openAttachment(item)}>
            <span className="file-icon">{extension(item.filename)}</span>
            <span className="mail-attachment-copy">
              <strong title={item.filename}>{item.filename}</strong>
              <small>{formatFileSize(item.size)} · {attachmentFileTypeNames[item.fileType]}{!item.available && ' · Original not downloaded'}{item.accountArchived && ' · Archived account'}</small>
              <small title={`${sender}${item.fromEmail && item.fromName ? ` <${item.fromEmail}>` : ''} — ${item.subject}`}><span className="account-dot" style={{ background: account?.color }} />{sender} · {item.subject}</small>
            </span>
            <time dateTime={item.date} title={formatMailArrivalTooltip(item.date)}>{formatMailListTime(item.date)}</time>
            <button className="icon-button" aria-label={`Open ${item.filename}`} title={item.available ? 'Open' : 'The original message is not available offline'} disabled={!item.available || busy} onClick={() => void openAttachment(item)}><Download size={15} /></button>
            <button className="button ghost small" aria-label={`Save ${item.filename}`} disabled={!item.available || busy} onClick={() => void saveAttachment(item)}>Save as</button>
            <button className="icon-button" aria-label={`Show message for ${item.filename}`} title="Show original message" onClick={() => showMessage(item)}><ExternalLink size={15} /></button>
          </article>
        })}
        {page.nextCursor && <div className="mail-attachment-more"><button className="button ghost small" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <><LoaderCircle className="spin" size={14} /> Loading…</> : `Load more (${(page.total - page.items.length).toLocaleString()} remaining)`}</button></div>}
      </div>
    </Modal>
  )
}
