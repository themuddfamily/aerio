import {
  Archive, AtSign, CheckCircle2, ChevronDown, Clock3, ExternalLink, FileText, Flag, Inbox,
  Copy, Forward, Mail, MailOpen, MoreVertical, Paperclip, Plus, RefreshCw, Reply, ReplyAll,
  Search, Send, Star, Tag, Trash2, Undo2
} from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { formatFileSize, messageMatches, uid, updateMessage } from '../lib/domain'
import { decodeHtmlEntities } from '../lib/html-entities'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import { MailPaneSeparator, useResizableMailPanes } from '../components/MailPaneResizer'
import MailMessageSourceModal from '../components/MailMessageSourceModal'
import MessageHtml from '../components/MessageHtml'
import { formatMailArrival, formatMailArrivalTooltip, formatMailDateHeading, formatMailListTime, mailDateGroupKey } from '../lib/mail-date'
import type { AppState, Message, ModuleId } from '../types'

interface DemoMailViewProps {
  state: AppState
  query: string
  requestedMessageId?: string
  onChange(next: AppState): void
  onCompose(replyTo?: Message, replyAll?: boolean, forward?: boolean, draft?: Message): void
  onNavigate(module: ModuleId): void
  onToast(message: string): void
}

function demoMessageSource(message: Message) {
  const headers = [
    `From: ${message.from} <${message.fromEmail}>`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Date: ${new Date(message.date).toUTCString()}`,
    `Subject: ${message.subject}`,
    `Message-ID: <${message.id}@demo.aerio.local>`,
    'Content-Type: text/html; charset=utf-8',
    ...(message.labels.length ? [`X-Aerio-Tags: ${message.labels.join(', ')}`] : [])
  ].join('\r\n')
  return { headers, source: `${headers}\r\n\r\n${message.body}` }
}

export default function DemoMailView({ state, query, requestedMessageId, onChange, onCompose, onNavigate, onToast }: DemoMailViewProps) {
  const { showContextMenu } = useContextMenu()
  const mailPanes = useResizableMailPanes()
  const [folder, setFolder] = useState('all')
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred' | 'flagged'>('all')
  const [selectedId, setSelectedId] = useState(() => state.messages.find((message) => !message.trashed && !message.draft && !message.sent)?.id ?? '')
  const [sortNewest, setSortNewest] = useState(true)
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<string>>(() => new Set())
  const [refreshSpin, setRefreshSpin] = useState(0)
  const [sourceViewer, setSourceViewer] = useState<{ mode: 'headers' | 'source'; subject: string; content: string }>()
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

  const belongsToFolder = (message: Message, id: string) => {
    if (id === 'all') return !message.trashed && !message.draft && !message.sent && !message.archived
    if (id === 'starred') return message.starred && !message.trashed
    const item = state.folders.find((candidate) => candidate.id === id)
    if (item?.system === 'trash') return Boolean(message.trashed)
    if (item?.system === 'archive') return Boolean(message.archived) && !message.trashed
    return message.folderId === id && !message.trashed
  }

  const changeMessage = (message: Message, updates: Partial<Message>, toast?: string) => {
    onChange(updateMessage(state, message.id, updates))
    if (toast) onToast(toast)
  }

  const openMessageWindow = (message: Message) => {
    void window.aerio.window.openMessage({ source: 'demo', messageId: message.id, title: message.subject })
      .catch((error) => onToast(error instanceof Error ? error.message : 'The message window could not be opened'))
  }

  const messageMenuItems = (message: Message): ContextMenuItem[] => {
    const inboxId = state.folders.find((item) => item.accountId === message.accountId && item.system === 'inbox')?.id ?? `${message.accountId}-inbox`
    if (message.draft) return [
      { label: 'Edit draft', icon: FileText, action: () => onCompose(undefined, false, false, message) },
      { label: 'Duplicate draft', icon: Copy, separatorBefore: true, action: () => {
        const duplicate = { ...message, id: uid('message'), threadId: uid('thread'), subject: `${message.subject} (copy)`, date: new Date().toISOString() }
        onChange({ ...state, messages: [duplicate, ...state.messages] })
        onToast('Draft duplicated')
      } },
      { label: 'Copy subject', icon: Copy, action: () => copyText(message.subject) },
      { label: 'Move to Trash', icon: Trash2, separatorBefore: true, danger: true, action: () => changeMessage(message, { draft: false, trashed: true, folderId: `${message.accountId}-trash` }, 'Draft moved to Trash') }
    ]
    return [
      { label: 'Open message', icon: MailOpen, action: () => selectMessage(message) },
      { label: 'Open in new window', icon: ExternalLink, action: () => openMessageWindow(message) },
      { label: 'Reply', icon: Reply, separatorBefore: true, action: () => onCompose(message) },
      { label: 'Reply all', icon: ReplyAll, action: () => onCompose(message, true) },
      { label: 'Forward', icon: Forward, action: () => onCompose(message, false, true) },
      { label: message.unread ? 'Mark as read' : 'Mark as unread', icon: message.unread ? MailOpen : Mail, separatorBefore: true, action: () => changeMessage(message, { unread: !message.unread }) },
      { label: message.starred ? 'Remove star' : 'Add star', icon: Star, checked: message.starred, action: () => changeMessage(message, { starred: !message.starred }) },
      { label: message.flagged ? 'Remove flag' : 'Flag message', icon: Flag, checked: message.flagged, action: () => changeMessage(message, { flagged: !message.flagged }) },
      message.archived || message.trashed
        ? { label: 'Move to inbox', icon: Inbox, separatorBefore: true, action: () => changeMessage(message, { archived: false, trashed: false, folderId: inboxId }, 'Message moved to Inbox') }
        : { label: 'Archive', icon: Archive, separatorBefore: true, action: () => changeMessage(message, { archived: true, folderId: `${message.accountId}-archive` }, 'Message archived') },
      ...(!message.trashed ? [{ label: 'Move to Trash', icon: Trash2, danger: true, action: () => changeMessage(message, { trashed: true, folderId: `${message.accountId}-trash` }, 'Message moved to Trash') }] satisfies ContextMenuItem[] : []),
      { label: 'Add to Tasks', icon: CheckCircle2, separatorBefore: true, action: () => addTask(message) },
      { label: 'Add to Calendar', icon: Clock3, action: () => addEvent(message) },
      { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(message.subject) },
      { label: 'Copy sender address', icon: AtSign, action: () => copyText(message.fromEmail) }
    ]
  }

  const showMessageMenu = (event: React.MouseEvent, message: Message) => {
    if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a[href], img[src]'))) return
    showContextMenu(event, messageMenuItems(message), message.subject)
  }

  const showReaderMoreMenu = (event: React.MouseEvent, message: Message) => {
    const raw = demoMessageSource(message)
    const view = (mode: 'headers' | 'source') => setSourceViewer({ mode, subject: message.subject, content: raw[mode] })
    showContextMenu(event, [
      { label: 'Open in new window', icon: ExternalLink, action: () => openMessageWindow(message) },
      { label: 'Reply all', icon: ReplyAll, action: () => onCompose(message, true) },
      { label: 'Forward', icon: Forward, action: () => onCompose(message, false, true) },
      { label: message.flagged ? 'Remove flag' : 'Flag message', icon: Flag, checked: message.flagged, separatorBefore: true, action: () => changeMessage(message, { flagged: !message.flagged }) },
      { label: 'Copy tags', icon: Tag, disabled: !message.labels.length, action: () => copyText(message.labels.join(', ')) },
      { label: 'View message headers', icon: AtSign, separatorBefore: true, action: () => view('headers') },
      { label: 'View message source', icon: FileText, action: () => view('source') },
      { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(message.subject) },
      { label: 'Copy sender address', icon: AtSign, action: () => copyText(message.fromEmail) }
    ], 'More message actions')
  }

  const showFolderMenu = (event: React.MouseEvent, id: string, label: string) => {
    const unread = state.messages.filter((message) => belongsToFolder(message, id) && message.unread).length
    showContextMenu(event, [
      { label: `Open ${label}`, icon: Inbox, action: () => setFolder(id) },
      { label: 'New message', icon: Plus, separatorBefore: true, action: () => onCompose() },
      { label: `Mark all as read${unread ? ` (${unread})` : ''}`, icon: MailOpen, disabled: unread === 0, action: () => {
        onChange({ ...state, messages: state.messages.map((message) => belongsToFolder(message, id) ? { ...message, unread: false } : message) })
        onToast(`${label} marked as read`)
      } }
    ], label)
  }

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

  const addTask = (message = selected) => {
    if (!message) return
    onChange({
      ...state,
      tasks: [{
        id: uid('task'), listId: 'Today', title: `Reply: ${message.subject}`,
        notes: `Created from ${message.from}’s message.`, priority: 'normal', completed: false,
        subtasks: [], recurrence: 'none'
      }, ...state.tasks]
    })
    onToast('Task created from message')
    onNavigate('tasks')
  }

  const addEvent = (message = selected) => {
    if (!message) return
    const start = new Date()
    start.setDate(start.getDate() + 1)
    start.setHours(10, 0, 0, 0)
    const end = new Date(start)
    end.setHours(11)
    onChange({
      ...state,
      events: [{
        id: uid('event'), calendarId: message.accountId, title: message.subject,
        start: start.toISOString(), end: end.toISOString(), description: `Created from ${message.from}’s message.`,
        color: '#6659e8', attendees: [message.fromEmail], reminderMinutes: 15, recurrence: 'none'
      }, ...state.events]
    })
    onToast('Event created for tomorrow at 10:00')
    onNavigate('calendar')
  }

  const toggleAccount = (accountId: string) => setCollapsedAccounts((current) => {
    const next = new Set(current)
    if (next.has(accountId)) next.delete(accountId)
    else next.add(accountId)
    return next
  })

  const refreshMail = () => {
    setRefreshSpin((value) => value + 1)
    onToast('Everything is up to date')
  }

  const showAccountMenu = (event: React.MouseEvent, account: AppState['accounts'][number]) => {
    const inbox = state.folders.find((item) => item.accountId === account.id && item.system === 'inbox')
    const unread = state.messages.filter((message) => message.accountId === account.id && message.unread).length
    showContextMenu(event, [
      { label: `Open ${account.name} Inbox`, icon: Inbox, action: () => setFolder(inbox?.id ?? 'all') },
      { label: 'New message', icon: Plus, action: () => onCompose() },
      { label: collapsedAccounts.has(account.id) ? 'Expand folders' : 'Collapse folders', icon: ChevronDown, separatorBefore: true, action: () => toggleAccount(account.id) },
      { label: `Mark account as read${unread ? ` (${unread})` : ''}`, icon: MailOpen, disabled: unread === 0, action: () => {
        onChange({ ...state, messages: state.messages.map((message) => message.accountId === account.id ? { ...message, unread: false } : message) })
        onToast(`${account.name} marked as read`)
      } },
      { label: 'Copy email address', icon: Copy, separatorBefore: true, action: () => copyText(account.email) }
    ], account.name)
  }

  const folderButton = (id: string, icon: React.ReactNode, label: string, count?: number) => (
    <button className={`sidebar-item ${folder === id ? 'active' : ''}`} onClick={() => setFolder(id)} onContextMenu={(event) => showFolderMenu(event, id, label)}>
      {icon}<span>{label}</span>{count ? <em>{count}</em> : null}
    </button>
  )

  return (
    <div ref={mailPanes.containerRef} className="workspace mail-workspace" style={mailPanes.style}>
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
            <button className="account-heading" aria-expanded={!collapsedAccounts.has(account.id)} onClick={() => toggleAccount(account.id)} onContextMenu={(event) => showAccountMenu(event, account)}>
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

      <MailPaneSeparator pane="sidebar" value={mailPanes.widths.sidebar} onPointerDown={mailPanes.startResize} onKeyDown={mailPanes.resizeWithKeyboard} onReset={mailPanes.resetWidths} />

      <section className="mail-list-panel">
        <header className="panel-heading">
          <div><h1>{folder === 'all' ? 'Inbox' : folder === 'starred' ? 'Starred' : state.folders.find((item) => item.id === folder)?.name ?? 'Mail'}</h1><p>{messages.length} messages</p></div>
          <button className="icon-button" title="Check for mail" onClick={refreshMail}><RefreshCw key={refreshSpin} className={refreshSpin ? 'refresh-spin' : undefined} size={17} /></button>
        </header>
        <div className="filterbar">
          <div className="segmented">
            {(['all', 'unread', 'starred', 'flagged'] as const).map((item) => (
              <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>
            ))}
          </div>
          <button className="text-button" onClick={() => setSortNewest((value) => !value)}>{sortNewest ? 'Newest' : 'Oldest'} <ChevronDown size={13} /></button>
        </div>
        <div className="message-list" onContextMenu={(event) => showContextMenu(event, [
          { label: 'New message', icon: Plus, action: () => onCompose() },
          { label: 'Mark visible messages as read', icon: MailOpen, separatorBefore: true, disabled: !messages.some((message) => message.unread), action: () => onChange({ ...state, messages: state.messages.map((message) => messages.some((visible) => visible.id === message.id) ? { ...message, unread: false } : message) }) },
          { label: sortNewest ? 'Sort oldest first' : 'Sort newest first', icon: ChevronDown, action: () => setSortNewest((value) => !value) }
        ], 'Message list')}>
          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const startsDateGroup = !previous || mailDateGroupKey(previous.date) !== mailDateGroupKey(message.date)
            return <Fragment key={message.id}>
              {startsDateGroup && <h2 className="mail-date-group"><span>{formatMailDateHeading(message.date)}</span></h2>}
              <button className={`message-row ${selected?.id === message.id ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} aria-current={selected?.id === message.id ? 'true' : undefined} onClick={() => selectMessage(message)} onDoubleClick={() => openMessageWindow(message)} onKeyDown={(event) => { if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openMessageWindow(message) } }} onContextMenu={(event) => showMessageMenu(event, message)}>
              <span className="avatar" style={{ background: state.contacts.find((contact) => contact.email === message.fromEmail)?.color ?? '#8892a6' }}>{message.from.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
              <span className="message-copy">
                <span className="message-meta"><strong>{message.from}</strong><time dateTime={message.date} title={formatMailArrivalTooltip(message.date)}>{formatMailListTime(message.date)}</time></span>
                <span className="message-subject">{message.subject}</span>
                <span className="message-preview">{decodeHtmlEntities(message.preview)}</span>
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
            </Fragment>
          })}
          {messages.length === 0 && <div className="empty-state"><Search size={28} /><h3>No messages here</h3><p>Try another folder or filter.</p></div>}
        </div>
      </section>

      <MailPaneSeparator pane="list" value={mailPanes.widths.list} onPointerDown={mailPanes.startResize} onKeyDown={mailPanes.resizeWithKeyboard} onReset={mailPanes.resetWidths} />

      <section className="reader-panel">
        {selected ? (
          <>
            <div className="reader-toolbar">
              <div className="reader-toolbar-primary">
                <button className="reader-toolbar-action" title="Reply" onClick={() => onCompose(selected)}><Reply size={17} /><span>Reply</span></button>
                <button className="reader-toolbar-action" title={selected.unread ? 'Mark read' : 'Mark unread'} onClick={() => apply({ unread: !selected.unread })}>{selected.unread ? <MailOpen size={17} /> : <Mail size={17} />}<span>{selected.unread ? 'Read' : 'Unread'}</span></button>
                <button className="reader-toolbar-action" title="Archive" onClick={() => apply({ archived: true, folderId: `${selected.accountId}-archive` }, 'Message archived')}><Archive size={17} /><span>Archive</span></button>
                <button className="reader-toolbar-action" title="Delete" onClick={() => apply({ trashed: true, folderId: `${selected.accountId}-trash` }, 'Message moved to Trash')}><Trash2 size={17} /><span>Delete</span></button>
                <span className="toolbar-divider" />
                <button className={`reader-toolbar-action ${selected.starred ? 'active' : ''}`} title={selected.starred ? 'Unstar' : 'Star'} onClick={() => apply({ starred: !selected.starred })}><Star size={17} fill={selected.starred ? 'currentColor' : 'none'} /><span>{selected.starred ? 'Unstar' : 'Star'}</span></button>
              </div>
              <div className="reader-toolbar-secondary"><button className="icon-button" aria-label="More message actions" title="More" onClick={(event) => showReaderMoreMenu(event, selected)}><MoreVertical size={18} /></button></div>
            </div>
            <article className="message-reader" onContextMenu={(event) => showMessageMenu(event, selected)}>
              <header>
                <div className="reader-labels">{selected.labels.map((label) => <span key={label}>{label}</span>)}</div>
                <h2>{selected.subject}</h2>
                <div className="sender-card">
                  <span className="avatar large" style={{ background: state.contacts.find((contact) => contact.email === selected.fromEmail)?.color ?? '#8892a6' }}>{selected.from.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                  <span><strong>{selected.from}</strong><small>to me · <time dateTime={selected.date} title={formatMailArrivalTooltip(selected.date)}>{formatMailArrival(selected.date)}</time></small></span>
                  <span className="spacer" />
                  <button className="icon-button" aria-label="Reply" title="Reply" onClick={() => onCompose(selected)}><Reply size={16} /></button>
                </div>
              </header>
              <MessageHtml className="message-body" html={selected.body} />
              {selected.attachments.length > 0 && (
                <div className="reader-attachments">
                  <h3>{selected.attachments.length} attachment{selected.attachments.length > 1 ? 's' : ''}</h3>
                  {selected.attachments.map((attachment) => (
                    <button className="attachment-card" key={attachment.id} title="Demo attachment" onClick={() => onToast(`${attachment.name} is sample metadata; no local file is attached`)} onContextMenu={(event) => showContextMenu(event, [
                      { label: 'Show attachment details', icon: Paperclip, action: () => onToast(`${attachment.name} · ${formatFileSize(attachment.size)}`) },
                      { label: 'Copy filename', icon: Copy, action: () => copyText(attachment.name) }
                    ], attachment.name)}>
                      <span className="file-icon">{attachment.name.split('.').pop()?.toUpperCase()}</span>
                      <span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span>
                    </button>
                  ))}
                </div>
              )}
              <div className="quick-actions">
                <button className="button ghost" onClick={() => onCompose(selected)}><Reply size={16} /> Reply</button>
                <button className="button ghost" onClick={() => onCompose(selected, true)}><ReplyAll size={16} /> Reply all</button>
                <button className="button ghost" onClick={() => addTask()}><CheckCircle2 size={16} /> Add task</button>
                <button className="button ghost" onClick={() => addEvent()}><Clock3 size={16} /> Add event</button>
              </div>
            </article>
          </>
        ) : <div className="empty-state grow"><Inbox size={34} /><h3>Select a message</h3><p>Choose a conversation to read it here.</p></div>}
      </section>
      {sourceViewer && <MailMessageSourceModal {...sourceViewer} onClose={() => setSourceViewer(undefined)} />}
    </div>
  )
}
