import { ArrowDownLeft, ArrowUpRight, LoaderCircle, Mail, Paperclip } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MailAccountSummary, MailAttachmentPage, MailContactHistoryPage, MailDesktopApi } from '../mail-types'
import type { MessageWindowRequest } from '../types'
import { formatFileSize } from '../lib/domain'
import { formatMailListTime } from '../lib/mail-date'

export type ContactHistoryMailApi = Pick<MailDesktopApi, 'accounts' | 'attachments' | 'contactHistory'>

const PAGE_SIZE = 20
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

// Recent messages and attachments exchanged with any of a contact's addresses (and those of linked
// contacts), read from the offline mail cache across the selected accounts.
export default function ContactHistoryPanel({ addresses, mail, onOpenMessage, onToast }: {
  addresses: string[]
  mail: ContactHistoryMailApi
  onOpenMessage(request: MessageWindowRequest): void
  onToast(message: string): void
}) {
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [tab, setTab] = useState<'messages' | 'attachments'>('messages')
  const [messages, setMessages] = useState<MailContactHistoryPage>({ items: [], total: 0 })
  const [files, setFiles] = useState<MailAttachmentPage>({ items: [], total: 0 })
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const requestId = useRef(0)

  useEffect(() => {
    let active = true
    void mail.accounts.list().then((value) => { if (active) setAccounts(value) }).catch(() => undefined)
    return () => { active = false }
  }, [mail])

  // Deleted accounts are no longer listed, so they drop out of the selection too.
  const selectedIds = useMemo(() => accounts.filter((account) => !excluded.has(account.id)).map((account) => account.id), [accounts, excluded])
  const addressKey = addresses.map((address) => address.toLowerCase()).sort().join('|')
  const selectionKey = selectedIds.join('|')
  const accountsById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])

  useEffect(() => {
    const id = ++requestId.current
    setLoadError(undefined)
    if (!addresses.length || !selectedIds.length || !mail.contactHistory) {
      setMessages({ items: [], total: 0 })
      setFiles({ items: [], total: 0 })
      setLoading(false)
      return
    }
    setLoading(true)
    const request = tab === 'messages'
      ? mail.contactHistory.messages({ addresses, accountIds: selectedIds, pageSize: PAGE_SIZE }).then((page) => { if (id === requestId.current) setMessages(page) })
      : mail.attachments.list({ participants: addresses, accountIds: selectedIds, includeArchivedAccounts: true, pageSize: PAGE_SIZE }).then((page) => { if (id === requestId.current) setFiles(page) })
    void request
      .catch((error: unknown) => { if (id === requestId.current) setLoadError(errorMessage(error, 'History could not be loaded')) })
      .finally(() => { if (id === requestId.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressKey, selectionKey, tab, mail])

  const loadMore = async () => {
    const id = requestId.current
    try {
      if (tab === 'messages' && messages.nextCursor && mail.contactHistory) {
        const next = await mail.contactHistory.messages({ addresses, accountIds: selectedIds, pageSize: PAGE_SIZE, cursor: messages.nextCursor })
        if (id === requestId.current) setMessages((current) => ({ ...next, items: [...current.items, ...next.items] }))
      } else if (tab === 'attachments' && files.nextCursor) {
        const next = await mail.attachments.list({ participants: addresses, accountIds: selectedIds, includeArchivedAccounts: true, pageSize: PAGE_SIZE, cursor: files.nextCursor })
        if (id === requestId.current) setFiles((current) => ({ ...next, items: [...current.items, ...next.items] }))
      }
    } catch (error) {
      onToast(errorMessage(error, 'More history could not be loaded'))
    }
  }

  const toggle = (accountId: string) => setExcluded((current) => {
    const next = new Set(current)
    if (next.has(accountId)) next.delete(accountId)
    else next.add(accountId)
    return next
  })

  const page = tab === 'messages' ? messages : files
  const accountName = (accountId: string, fallback = accountId) => accountsById.get(accountId)?.email ?? fallback

  return (
    <section className="detail-card contact-history" aria-label="Communication history">
      <header className="contact-history-header">
        <h3>Communication history</h3>
        <div className="segmented" role="tablist" aria-label="History type">
          <button role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'active' : ''} onClick={() => setTab('messages')}><Mail size={14} /> Messages</button>
          <button role="tab" aria-selected={tab === 'attachments'} className={tab === 'attachments' ? 'active' : ''} onClick={() => setTab('attachments')}><Paperclip size={14} /> Attachments</button>
        </div>
      </header>
      {accounts.length > 1 && <div className="contact-history-accounts" aria-label="Accounts">
        {accounts.map((account) => (
          <label key={account.id} className="check-label"><input type="checkbox" checked={!excluded.has(account.id)} onChange={() => toggle(account.id)} /> {account.email}{account.archived && <em className="archived-badge"> archived</em>}</label>
        ))}
      </div>}
      {!addresses.length ? <p className="provider-source-note">Add an email address to see messages with this contact.</p>
        : !accounts.length ? <p className="provider-source-note">Connect a mail account to see messages with this contact.</p>
          : !selectedIds.length ? <p className="provider-source-note">Choose at least one account.</p>
            : <>
              <p className="provider-source-note" aria-live="polite">{loading ? 'Searching offline mail…' : loadError ?? `${page.total.toLocaleString()} ${tab === 'messages' ? `message${page.total === 1 ? '' : 's'}` : `attachment${page.total === 1 ? '' : 's'}`} with ${addresses.join(', ')}`}</p>
              {tab === 'messages' ? <ul className="contact-history-list">
                {messages.items.map((item) => (
                  <li key={`${item.accountId}:${item.messageId}`}>
                    <button onClick={() => onOpenMessage({ source: 'connected', accountId: item.accountId, threadId: item.threadId, messageId: item.messageId, title: item.subject })}>
                      {item.direction === 'from' ? <ArrowDownLeft size={14} aria-label="Received from contact" /> : <ArrowUpRight size={14} aria-label="Sent to contact" />}
                      <span><strong>{item.subject}</strong><small>{item.direction === 'from' ? `From ${item.fromName || item.fromEmail}` : `To ${[...item.to, ...item.cc].join(', ')}`} · {item.snippet}</small></span>
                      <small className="contact-history-meta">{formatMailListTime(item.date)} · {item.accountEmail}{item.accountArchived ? ' (archived)' : ''}{item.attachmentCount ? <> · <Paperclip size={11} /> {item.attachmentCount}</> : null}</small>
                    </button>
                  </li>
                ))}
              </ul> : <ul className="contact-history-list">
                {files.items.map((item) => (
                  <li key={`${item.accountId}:${item.messageId}:${item.attachmentId}`} className={item.available ? '' : 'unavailable'}>
                    <button title={item.available ? 'Show the original message' : 'The original message is not available offline'} onClick={() => onOpenMessage({ source: 'connected', accountId: item.accountId, threadId: item.threadId, messageId: item.messageId, title: item.subject })}>
                      <Paperclip size={14} />
                      <span><strong>{item.filename}</strong><small>{formatFileSize(item.size)} · {item.subject}{item.available ? '' : ' · not stored offline'}</small></span>
                      <small className="contact-history-meta">{formatMailListTime(item.date)} · {accountName(item.accountId)}{item.accountArchived ? ' (archived)' : ''}</small>
                    </button>
                  </li>
                ))}
              </ul>}
              {page.nextCursor && <button className="button ghost small" disabled={loading} onClick={() => void loadMore()}>{loading ? <LoaderCircle className="spin" size={14} /> : null} Load more ({(page.total - page.items.length).toLocaleString()} remaining)</button>}
            </>}
    </section>
  )
}
