import {
  Archive, AtSign, CheckCircle2, ChevronDown, Clock3, FileText, Flag, Inbox,
  Mail, MailOpen, Paperclip, Plus, RefreshCw, Reply, ReplyAll,
  Search, Send, Star, Tag, Trash2, Undo2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { formatFileSize, messageMatches, uid, updateMessage } from '../lib/domain'
import type { AppState, Message, ModuleId } from '../types'

interface MailViewProps {
  state: AppState
  query: string
  requestedMessageId?: string
  onChange(next: AppState): void
  onCompose(replyTo?: Message, replyAll?: boolean): void
  onNavigate(module: ModuleId): void
  onToast(message: string): void
}

const shortDate = (date: string) => {
  const value = new Date(date)
  if (isToday(value)) return format(value, 'HH:mm')
  if (isYesterday(value)) return 'Yesterday'
  return format(value, 'd MMM')
}

export default function MailView({ state, query, requestedMessageId, onChange, onCompose, onNavigate, onToast }: MailViewProps) {
  const [folder, setFolder] = useState('all')
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred' | 'flagged'>('all')
  const [selectedId, setSelectedId] = useState(() => state.messages.find((message) => !message.trashed && !message.draft && !message.sent)?.id ?? '')
  const [sortNewest, setSortNewest] = useState(true)
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<string>>(() => new Set())
  const handledMessageRequest = useRef<string | undefined>(undefined)

  const messages = useMemo(() => state.messages
    .filter((message) => {
      if (folder === 'all') return !message.trashed && !message.draft && !message.sent && !message.archived
      if (folder === 'starred') return message.starred && !message.trashed
      const selectedFolder = state.folders.find((item) => item.id === folder)
      if (selectedFolder?.system === 'trash') return Boolean(message.trashed)
      if (selectedFolder?.system === 'archive') return Boolean(message.archived) && !message.trashed
      return message.folderId === folder && !message.trashed
    })
    .filter((message) => filter === 'all' || Boolean(message[filter]))
    .filter((message) => messageMatches(message, query))
    .sort((a, b) => (sortNewest ? -1 : 1) * (new Date(a.date).getTime() - new Date(b.date).getTime())),
  [filter, folder, query, sortNewest, state.folders, state.messages])

  const selected = messages.find((message) => message.id === selectedId) ?? messages[0]

  useEffect(() => {
    if (!requestedMessageId || handledMessageRequest.current === requestedMessageId) return
    const message = state.messages.find((item) => item.id === requestedMessageId)
    if (!message) return
    handledMessageRequest.current = requestedMessageId
    setSelectedId(message.id)
    if (message.trashed) setFolder(`${message.accountId}-trash`)
    else if (message.archived) setFolder(`${message.accountId}-archive`)
    else if (message.draft) setFolder(`${message.accountId}-drafts`)
    else if (message.sent) setFolder(`${message.accountId}-sent`)
    else setFolder(message.folderId || 'all')
  }, [requestedMessageId, state.messages])
  const selectMessage = (message: Message) => {
    setSelectedId(message.id)
    if (message.unread) onChange(updateMessage(state, message.id, { unread: false }))
  }

  const apply = (updates: Partial<Message>, toast?: string) => {
    if (!selected) return
    onChange(updateMessage(state, selected.id, updates))
    if (toast) onToast(toast)
  }

  const addTask = () => {
    if (!selected) return
    onChange({
      ...state,
      tasks: [{
        id: uid('task'), listId: 'Today', title: `Reply: ${selected.subject}`,
        notes: `Created from ${selected.from}’s message.`, priority: 'normal', completed: false,
        subtasks: [], recurrence: 'none'
      }, ...state.tasks]
    })
    onToast('Task created from message')
    onNavigate('tasks')
  }

  const addEvent = () => {
    if (!selected) return
    const start = new Date()
    start.setDate(start.getDate() + 1)
    start.setHours(10, 0, 0, 0)
    const end = new Date(start)
    end.setHours(11)
    onChange({
      ...state,
      events: [{
        id: uid('event'), calendarId: selected.accountId, title: selected.subject,
        start: start.toISOString(), end: end.toISOString(), description: `Created from ${selected.from}’s message.`,
        color: '#6659e8', attendees: [selected.fromEmail], reminderMinutes: 15, recurrence: 'none'
      }, ...state.events]
    })
    onToast('Event created for tomorrow at 10:00')
    onNavigate('calendar')
  }

  const folderButton = (id: string, icon: React.ReactNode, label: string, count?: number) => (
    <button className={`sidebar-item ${folder === id ? 'active' : ''}`} onClick={() => setFolder(id)}>
      {icon}<span>{label}</span>{count ? <em>{count}</em> : null}
    </button>
  )

  return (
    <div className="workspace mail-workspace">
      <aside className="context-sidebar">
        <button className="compose-button" onClick={() => onCompose()}><Plus size={18} /> New message</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Favourites</span>
          {folderButton('all', <Inbox size={17} />, 'Unified inbox', state.messages.filter((message) => message.unread && !message.trashed).length)}
          {folderButton('starred', <Star size={17} />, 'Starred', state.messages.filter((message) => message.starred && !message.trashed).length)}
          {folderButton('personal-drafts', <FileText size={17} />, 'Drafts', state.messages.filter((message) => message.draft).length)}
          {folderButton('personal-sent', <Send size={17} />, 'Sent')}
        </div>
        {state.accounts.map((account) => (
          <div className="sidebar-group" key={account.id}>
            <button className="account-heading" aria-expanded={!collapsedAccounts.has(account.id)} onClick={() => setCollapsedAccounts((current) => {
              const next = new Set(current)
              if (next.has(account.id)) next.delete(account.id)
              else next.add(account.id)
              return next
            })}>
              <span className="account-dot" style={{ background: account.color }} />
              <span>{account.name}</span><ChevronDown size={14} />
            </button>
            {!collapsedAccounts.has(account.id) && state.folders.filter((item) => item.accountId === account.id).map((item) => {
              const Icon = item.system === 'inbox' ? Inbox : item.system === 'sent' ? Send : item.system === 'drafts' ? FileText : item.system === 'trash' ? Trash2 : item.system === 'archive' ? Archive : Tag
              const count = state.messages.filter((message) => message.folderId === item.id && message.unread).length
              return folderButton(item.id, <Icon size={16} />, item.name, count)
            })}
          </div>
        ))}
      </aside>

      <section className="mail-list-panel">
        <header className="panel-heading">
          <div><h1>{folder === 'all' ? 'Inbox' : folder === 'starred' ? 'Starred' : state.folders.find((item) => item.id === folder)?.name ?? 'Mail'}</h1><p>{messages.length} messages</p></div>
          <button className="icon-button" title="Check for mail" onClick={() => onToast('Everything is up to date')}><RefreshCw size={17} /></button>
        </header>
        <div className="filterbar">
          <div className="segmented">
            {(['all', 'unread', 'starred', 'flagged'] as const).map((item) => (
              <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>
            ))}
          </div>
          <button className="text-button" onClick={() => setSortNewest((value) => !value)}>{sortNewest ? 'Newest' : 'Oldest'} <ChevronDown size={13} /></button>
        </div>
        <div className="message-list" role="list">
          {messages.map((message) => (
            <button key={message.id} className={`message-row ${selected?.id === message.id ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} onClick={() => selectMessage(message)}>
              <span className="avatar" style={{ background: state.contacts.find((contact) => contact.email === message.fromEmail)?.color ?? '#8892a6' }}>{message.from.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
              <span className="message-copy">
                <span className="message-meta"><strong>{message.from}</strong><time>{shortDate(message.date)}</time></span>
                <span className="message-subject">{message.subject}</span>
                <span className="message-preview">{message.preview}</span>
                <span className="message-tags">
                  {message.labels.slice(0, 2).map((label) => <em key={label}>{label}</em>)}
                  {message.attachments.length > 0 && <Paperclip size={13} />}
                </span>
              </span>
              <span className="row-flags">
                {message.flagged && <Flag size={13} fill="currentColor" />}
                {message.starred && <Star size={13} fill="currentColor" />}
              </span>
            </button>
          ))}
          {messages.length === 0 && <div className="empty-state"><Search size={28} /><h3>No messages here</h3><p>Try another folder or filter.</p></div>}
        </div>
      </section>

      <section className="reader-panel">
        {selected ? (
          <>
            <div className="reader-toolbar">
              <button className="icon-button" title={selected.unread ? 'Mark read' : 'Mark unread'} onClick={() => apply({ unread: !selected.unread })}>{selected.unread ? <MailOpen size={18} /> : <Mail size={18} />}</button>
              <button className="icon-button" title="Archive" onClick={() => apply({ archived: true, folderId: `${selected.accountId}-archive` }, 'Message archived')}><Archive size={18} /></button>
              <button className="icon-button" title="Delete" onClick={() => apply({ trashed: true, folderId: `${selected.accountId}-trash` }, 'Message moved to Trash')}><Trash2 size={18} /></button>
              <span className="toolbar-divider" />
              <button className={`icon-button ${selected.starred ? 'active' : ''}`} title="Star" onClick={() => apply({ starred: !selected.starred })}><Star size={18} fill={selected.starred ? 'currentColor' : 'none'} /></button>
              <button className={`icon-button ${selected.flagged ? 'active danger' : ''}`} title="Flag" onClick={() => apply({ flagged: !selected.flagged })}><Flag size={18} fill={selected.flagged ? 'currentColor' : 'none'} /></button>
              <span className="spacer" />
            </div>
            <article className="message-reader">
              <header>
                <div className="reader-labels">{selected.labels.map((label) => <span key={label}>{label}</span>)}</div>
                <h2>{selected.subject}</h2>
                <div className="sender-card">
                  <span className="avatar large" style={{ background: state.contacts.find((contact) => contact.email === selected.fromEmail)?.color ?? '#8892a6' }}>{selected.from.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                  <span><strong>{selected.from}</strong><small>to me · {format(new Date(selected.date), 'd MMM yyyy, HH:mm')}</small></span>
                  <span className="spacer" />
                  <button className="button ghost small" onClick={() => onCompose(selected)}><Reply size={15} /> Reply</button>
                </div>
              </header>
              <div className="message-body" dangerouslySetInnerHTML={{ __html: selected.body }} />
              {selected.attachments.length > 0 && (
                <div className="reader-attachments">
                  <h3>{selected.attachments.length} attachment{selected.attachments.length > 1 ? 's' : ''}</h3>
                  {selected.attachments.map((attachment) => (
                    <button className="attachment-card" key={attachment.id} title="Demo attachment" onClick={() => onToast(`${attachment.name} is sample metadata; no local file is attached`)}>
                      <span className="file-icon">{attachment.name.split('.').pop()?.toUpperCase()}</span>
                      <span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span>
                    </button>
                  ))}
                </div>
              )}
              <div className="quick-actions">
                <button className="button ghost" onClick={() => onCompose(selected)}><Reply size={16} /> Reply</button>
                <button className="button ghost" onClick={() => onCompose(selected, true)}><ReplyAll size={16} /> Reply all</button>
                <button className="button ghost" onClick={addTask}><CheckCircle2 size={16} /> Add task</button>
                <button className="button ghost" onClick={addEvent}><Clock3 size={16} /> Add event</button>
              </div>
            </article>
          </>
        ) : <div className="empty-state grow"><Inbox size={34} /><h3>Select a message</h3><p>Choose a conversation to read it here.</p></div>}
      </section>
    </div>
  )
}
