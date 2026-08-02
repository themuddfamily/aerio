import {
  Archive, AtSign, CheckSquare, Copy, Download, Edit3, ExternalLink, FileText, FolderInput, Forward, Image, Inbox, LoaderCircle, Mail, MailOpen,
  Paperclip, Pause, Play, Plus, RefreshCw, Reply, Search, Send, Settings2,
  Star, Tag, Tags, Trash2, Undo2, UserPlus, WifiOff, X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GmailComposeModal from '../components/GmailComposeModal'
import MailAccountSetupModal from '../components/MailAccountSetupModal'
import MailAccountSettingsModal from '../components/MailAccountSettingsModal'
import MailOrganizeModal from '../components/MailOrganizeModal'
import SenderAvatar from '../components/SenderAvatar'
import ThreadMessageAccordion from '../components/ThreadMessageAccordion'
import type {
  GmailAccountSummary,
  ApplyMailActionInput,
  GmailAttachment,
  GmailDraftRecord,
  GmailLabel,
  GmailMessageDetail,
  GmailThreadDetail,
  MailActionKind,
  MailPage,
  MailQuery,
  MailThreadSummary,
  PendingOperation,
  SyncProgress
} from '../gmail-types'
import { formatFileSize } from '../lib/domain'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'

interface GmailViewProps {
  onToast(message: string): void
  composeRequest?: number
}

const emptyPage: MailPage = { items: [], total: 0 }
const folderNames: Record<NonNullable<MailQuery['folder']>, string> = {
  inbox: 'Inbox', starred: 'Starred', important: 'Important', sent: 'Sent',
  drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash', all: 'All mail'
}

function shortDate(date: string) {
  const value = new Date(date)
  const today = new Date()
  return value.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(value)
    : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(value)
}

export default function GmailView({ onToast, composeRequest = 0 }: GmailViewProps) {
  const { showContextMenu } = useContextMenu()
  const [accounts, setAccounts] = useState<GmailAccountSummary[]>([])
  const [labels, setLabels] = useState<GmailLabel[]>([])
  const [page, setPage] = useState<MailPage>(emptyPage)
  const [localDrafts, setLocalDrafts] = useState<GmailDraftRecord[]>([])
  const [history, setHistory] = useState<(string | undefined)[]>([])
  const [folder, setFolder] = useState<NonNullable<MailQuery['folder']>>('inbox')
  const [labelId, setLabelId] = useState<string>()
  const [accountId, setAccountId] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [thread, setThread] = useState<GmailThreadDetail>()
  const [expandedMessageId, setExpandedMessageId] = useState<string>()
  const [threadLoading, setThreadLoading] = useState(false)
  const [sync, setSync] = useState<SyncProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [compose, setCompose] = useState<{ draft?: GmailDraftRecord; reply?: GmailThreadDetail; forward?: boolean }>()
  const [pending, setPending] = useState<PendingOperation[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [organizeMode, setOrganizeMode] = useState<'move' | 'label'>()
  const [remoteImages, setRemoteImages] = useState(false)
  const [accountSetup, setAccountSetup] = useState(false)
  const [settingsAccount, setSettingsAccount] = useState<GmailAccountSummary>()
  const handledComposeRequest = useRef(0)
  const selected = page.items.find((item) => `${item.accountId}:${item.id}` === selectedKey)
  const selectedAccount = accounts.find((item) => item.id === selected?.accountId)
  const checkedItems = useMemo(() => page.items.filter((item) => checkedKeys.has(`${item.accountId}:${item.id}`)), [checkedKeys, page.items])

  const refreshAccounts = useCallback(async () => {
    const next = await window.aerio.mail.accounts.list()
    setAccounts(next)
    return next
  }, [])

  const loadDrafts = useCallback(async () => {
    if (!accounts.length) {
      setLocalDrafts([])
      return
    }
    try {
      setLocalDrafts(await window.aerio.mail.drafts.list(accountId === 'all' ? undefined : [accountId]))
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Drafts could not be loaded')
    }
  }, [accountId, accounts.length, onToast])

  const loadPage = useCallback(async (cursor?: string) => {
    if (!accounts.length) {
      setPage(emptyPage)
      return
    }
    setLoading(true)
    try {
      const next = await window.aerio.mail.mail.list({
        folder,
        accountIds: accountId === 'all' ? undefined : [accountId],
        labelId,
        search: search.trim() || undefined,
        cursor,
        pageSize: 50
      })
      setPage(next)
      setSelectedKey((current) => current && next.items.some((item) => `${item.accountId}:${item.id}` === current)
        ? current
        : next.items[0] ? `${next.items[0].accountId}:${next.items[0].id}` : '')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Mail could not be loaded')
    } finally {
      setLoading(false)
    }
  }, [accountId, accounts.length, folder, labelId, onToast, search])

  useEffect(() => {
    void Promise.all([
      window.aerio.mail.accounts.list(),
      window.aerio.mail.sync.progress()
    ]).then(([accountList, progress]) => {
      const visible = accountList
      setAccounts(visible)
      setSync(progress)
      return window.aerio.mail.mail.labels(visible.map((item) => item.id))
    }).then(setLabels).catch((error) => onToast(error instanceof Error ? error.message : 'Gmail could not start')).finally(() => setLoading(false))
  }, [onToast])

  useEffect(() => {
    const unsubscribe = window.aerio.mail.onEvent((event) => {
      if (event.type === 'accounts-changed') setAccounts(event.payload)
      if (event.type === 'sync-progress') setSync((items) => [...items.filter((item) => item.accountId !== event.payload.accountId), event.payload])
      if (event.type === 'mail-changed') void loadPage()
      if (event.type === 'operation' && event.payload.status === 'failed') onToast(event.payload.error ?? 'The mail provider rejected the change')
      if (event.type === 'operation' && event.payload.status === 'succeeded') setPending((items) => items.filter((item) => item.id !== event.payload.id))
      if (event.type === 'connectivity' && !event.payload.online) onToast('Offline — changes will be sent when you reconnect')
    })
    return unsubscribe
  }, [loadPage, onToast])

  useEffect(() => {
    const undoUntil = pending.map((item) => item.undoUntil).filter(Boolean).sort()[0]
    if (!undoUntil) return
    const delay = Math.max(0, new Date(undoUntil).getTime() - Date.now())
    const timer = setTimeout(() => setPending([]), delay)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => setCheckedKeys(new Set()), [accountId, folder, labelId, search])

  useEffect(() => {
    setHistory([])
    void loadPage()
  }, [loadPage])

  useEffect(() => {
    if (folder === 'drafts') void loadDrafts()
  }, [folder, loadDrafts])

  useEffect(() => {
    if (!selected) {
      setThread(undefined)
      setExpandedMessageId(undefined)
      setThreadLoading(false)
      return
    }
    let cancelled = false
    setRemoteImages(false)
    setThread(undefined)
    setThreadLoading(true)
    void window.aerio.mail.mail.thread(selected.accountId, selected.id).then((detail) => {
      if (cancelled) return
      setThread(detail)
      setExpandedMessageId(detail.messages.at(-1)?.id)
    }).catch((error) => {
      if (!cancelled) onToast(error instanceof Error ? error.message : 'Conversation could not be opened')
    }).finally(() => {
      if (!cancelled) setThreadLoading(false)
    })
    if (selected.unread) void applyAction('read', selected.accountId, [selected.id], false)
    return () => { cancelled = true }
    // The action helper is intentionally excluded: selecting a row is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  useEffect(() => {
    if (!composeRequest || handledComposeRequest.current === composeRequest) return
    handledComposeRequest.current = composeRequest
    if (accounts.some((account) => !account.archived)) setCompose({})
    else setAccountSetup(true)
  }, [accounts, composeRequest])

  async function applyAction(action: MailActionKind, targetAccount = selected?.accountId, threadIds = selected ? [selected.id] : [], showUndo = true, labelId?: string) {
    if (!targetAccount || !threadIds.length) return
    try {
      const operation = await window.aerio.mail.mail.action({ accountId: targetAccount, threadIds, action, labelId })
      if (showUndo) setPending([operation])
      await loadPage()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The change could not be queued')
    }
  }

  const undo = async () => {
    if (!pending.length) return
    try {
      const restored = await Promise.all(pending.map((operation) => window.aerio.mail.mail.undo(operation.id)))
      if (restored.some(Boolean)) {
        onToast('Change undone')
        setPending([])
        await loadPage()
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The change could not be undone')
    }
  }

  const loadRemoteImages = async () => {
    if (!selected) return
    try {
      setRemoteImages(true)
      setThread(await window.aerio.mail.mail.thread(selected.accountId, selected.id, true))
    } catch (error) {
      setRemoteImages(false)
      onToast(error instanceof Error ? error.message : 'Remote images could not be loaded')
    }
  }

  const addAccount = () => setAccountSetup(true)

  const toggleSync = async (account: GmailAccountSummary, paused: boolean) => {
    try {
      if (paused) await window.aerio.mail.sync.resume(account.id)
      else await window.aerio.mail.sync.pause(account.id)
    } catch (error) {
      onToast(error instanceof Error ? error.message : `Sync could not be ${paused ? 'resumed' : 'paused'}`)
    }
  }

  const accountConnected = async () => {
    const next = await refreshAccounts()
    setLabels(await window.aerio.mail.mail.labels(next.map((account) => account.id)))
  }

  const disconnect = async (account: GmailAccountSummary) => {
    const keep = window.confirm(`Disconnect ${account.email}?\n\nOK keeps its downloaded mail as a read-only archive. Cancel lets you choose whether to delete it.`)
    try {
      if (keep) {
        await window.aerio.mail.accounts.disconnect(account.id, 'archive')
      } else if (window.confirm(`Delete all downloaded mail for ${account.email}? The provider mailbox itself will not be changed.`)) {
        await window.aerio.mail.accounts.disconnect(account.id, 'delete')
      } else return
      await refreshAccounts()
      onToast('Account disconnected')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The account could not be disconnected')
    }
  }

  const showStorage = async () => {
    try {
      const stats = await window.aerio.mail.storage()
      onToast(`${formatFileSize(stats.totalBytes)} stored offline · ${formatFileSize(stats.freeBytes)} free`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Storage information is unavailable')
    }
  }

  const startSync = async (targetAccount?: string) => {
    try {
      await window.aerio.mail.sync.start(targetAccount)
      onToast('Checking for mail')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Sync could not start')
    }
  }

  const markVisibleRead = async () => {
    const groups = new Map<string, string[]>()
    for (const item of page.items.filter((entry) => entry.unread)) groups.set(item.accountId, [...(groups.get(item.accountId) ?? []), item.id])
    for (const [targetAccount, ids] of groups) await applyAction('read', targetAccount, ids, false)
    if (groups.size) onToast('Visible conversations marked as read')
  }

  const applyOrganizeRequests = async (requests: ApplyMailActionInput[]) => {
    try {
      const operations: PendingOperation[] = []
      for (const request of requests) operations.push(await window.aerio.mail.mail.action(request))
      setPending(operations)
      setCheckedKeys(new Set())
      await loadPage()
      onToast(`${checkedItems.length.toLocaleString()} conversation${checkedItems.length === 1 ? '' : 's'} updated`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The bulk change could not be queued')
    }
  }

  const applyBulkAction = async (action: MailActionKind) => {
    const groups = new Map<string, string[]>()
    for (const item of checkedItems) groups.set(item.accountId, [...(groups.get(item.accountId) ?? []), item.id])
    await applyOrganizeRequests([...groups].map(([targetAccount, threadIds]) => ({ accountId: targetAccount, threadIds, action })))
  }

  const toggleChecked = (item: MailThreadSummary, index: number, range: boolean) => {
    const key = `${item.accountId}:${item.id}`
    setCheckedKeys((current) => {
      const next = new Set(current)
      if (range && current.size) {
        const lastIndex = Math.max(...page.items.map((entry, itemIndex) => current.has(`${entry.accountId}:${entry.id}`) ? itemIndex : -1))
        const [start, end] = [Math.min(lastIndex, index), Math.max(lastIndex, index)]
        for (const entry of page.items.slice(start, end + 1)) next.add(`${entry.accountId}:${entry.id}`)
      } else if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAllVisible = () => setCheckedKeys((current) => {
    const visible = page.items.map((item) => `${item.accountId}:${item.id}`)
    const all = visible.length > 0 && visible.every((key) => current.has(key))
    const next = new Set(current)
    for (const key of visible) all ? next.delete(key) : next.add(key)
    return next
  })

  const openSummary = (item: MailThreadSummary) => setSelectedKey(`${item.accountId}:${item.id}`)

  function selectAccount(nextAccountId: string) {
    setAccountId(nextAccountId)
    setLabelId(undefined)
  }

  function toggleLabel(label: GmailLabel) {
    const selected = accountId === label.accountId && labelId === label.id
    setAccountId(label.accountId)
    setLabelId(selected ? undefined : label.id)
    setFolder('all')
  }

  const openMessageWindow = (item: MailThreadSummary) => {
    void window.aerio.window.openMessage({ source: 'gmail', accountId: item.accountId, threadId: item.id, title: item.subject })
      .catch((error) => onToast(error instanceof Error ? error.message : 'The message window could not be opened'))
  }

  const composeFromSummary = async (item: MailThreadSummary, forward = false) => {
    try {
      const detail = selected?.id === item.id && thread ? thread : await window.aerio.mail.mail.thread(item.accountId, item.id)
      setCompose({ reply: detail, forward })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Conversation could not be opened')
    }
  }

  const discardLocalDraft = async (draft: GmailDraftRecord) => {
    if (!window.confirm(`Discard “${draft.subject || '(No subject)'}”?`)) return
    try {
      const result = await window.aerio.mail.drafts.delete(draft.id)
      onToast(result.status === 'discard-queued' ? 'Offline — draft will be discarded after reconnecting' : 'Draft discarded')
      await loadDrafts()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Draft could not be discarded')
    }
  }

  const visibleLocalDrafts = folder === 'drafts' ? localDrafts.filter((draft) => {
    const term = search.trim().toLowerCase()
    return !term || `${draft.subject} ${draft.to.join(' ')} ${draft.text}`.toLowerCase().includes(term)
  }) : []

  const summaryMenu = (item: MailThreadSummary): ContextMenuItem[] => {
    const account = accounts.find((candidate) => candidate.id === item.accountId)
    const readOnly = Boolean(account?.archived)
    const inInbox = item.labelIds.includes('INBOX')
    const inSpam = item.labelIds.includes('SPAM')
    return [
      { label: 'Open conversation', icon: MailOpen, action: () => openSummary(item) },
      { label: 'Open in new window', icon: ExternalLink, action: () => openMessageWindow(item) },
      { label: 'Reply', icon: Reply, separatorBefore: true, disabled: readOnly || item.draft, action: () => composeFromSummary(item) },
      { label: 'Forward', icon: Forward, disabled: readOnly, action: () => composeFromSummary(item, true) },
      { label: item.unread ? 'Mark as read' : 'Mark as unread', icon: item.unread ? MailOpen : Mail, separatorBefore: true, disabled: readOnly, action: () => applyAction(item.unread ? 'read' : 'unread', item.accountId, [item.id]) },
      { label: item.starred ? 'Remove star' : 'Add star', icon: Star, checked: item.starred, disabled: readOnly, action: () => applyAction(item.starred ? 'unstar' : 'star', item.accountId, [item.id]) },
      { label: item.important ? 'Mark as not important' : 'Mark as important', icon: Tag, checked: item.important, disabled: readOnly, action: () => applyAction(item.important ? 'unimportant' : 'important', item.accountId, [item.id]) },
      ...(!item.trashed ? [{ label: inInbox ? 'Archive' : 'Move to inbox', icon: inInbox ? Archive : Inbox, separatorBefore: true, disabled: readOnly, action: () => applyAction(inInbox ? 'archive' : inSpam ? 'move' : 'unarchive', item.accountId, [item.id], true, inSpam ? 'INBOX' : undefined) }] satisfies ContextMenuItem[] : []),
      { label: 'Move to…', icon: FolderInput, disabled: readOnly, action: () => { setCheckedKeys(new Set([`${item.accountId}:${item.id}`])); setOrganizeMode('move') } },
      { label: 'Manage labels…', icon: Tags, disabled: readOnly || accounts.find((account) => account.id === item.accountId)?.provider !== 'gmail', action: () => { setCheckedKeys(new Set([`${item.accountId}:${item.id}`])); setOrganizeMode('label') } },
      { label: item.trashed ? 'Restore from Trash' : 'Move to Trash', icon: Trash2, danger: !item.trashed, disabled: readOnly, action: () => applyAction(item.trashed ? 'untrash' : 'trash', item.accountId, [item.id]) },
      { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(item.subject) },
      { label: 'Copy participants', icon: AtSign, action: () => copyText(item.participants.join(', ')) }
    ]
  }

  const showSummaryMenu = (event: React.MouseEvent, item: MailThreadSummary) => {
    if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a[href], img[src]'))) return
    showContextMenu(event, summaryMenu(item), item.subject)
  }

  const openAttachment = async (message: GmailMessageDetail, attachment: GmailAttachment) => {
    try {
      const result = await window.aerio.mail.attachments.open(message.accountId, message.id, attachment.id, attachment.filename)
      if (result.error) onToast(result.error)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be opened')
    }
  }

  const saveAttachment = async (message: GmailMessageDetail, attachment: GmailAttachment) => {
    try {
      const result = await window.aerio.mail.attachments.save(message.accountId, message.id, attachment.id, attachment.filename)
      if (result.error) onToast(result.error)
      else if (result.savedPath) onToast(`Saved ${attachment.filename}`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be saved')
    }
  }

  const showAttachmentMenu = (event: React.MouseEvent, message: GmailMessageDetail, attachment: GmailAttachment) => showContextMenu(event, [
    { label: 'Open attachment', icon: Download, action: () => openAttachment(message, attachment) },
    { label: 'Save as…', icon: Download, action: () => saveAttachment(message, attachment) },
    { label: 'Copy filename', icon: Copy, separatorBefore: true, action: () => copyText(attachment.filename) }
  ], attachment.filename)

  const showProviderMessageMenu = (event: React.MouseEvent, message: GmailMessageDetail) => {
    if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a[href], img[src]'))) return
    const replyThread = replyThreadFor(message)
    showContextMenu(event, [
      { label: 'Reply', icon: Reply, disabled: selectedAccount?.archived || !replyThread, action: () => setCompose({ reply: replyThread }) },
      { label: 'Forward', icon: Forward, disabled: selectedAccount?.archived || !replyThread, action: () => setCompose({ reply: replyThread, forward: true }) },
      { label: 'Copy sender name', icon: Copy, separatorBefore: true, action: () => copyText(message.fromName || message.fromEmail) },
      { label: 'Copy sender address', icon: AtSign, action: () => copyText(message.fromEmail) },
      { label: 'Copy message text', icon: Copy, action: () => copyText(message.text) }
    ], message.subject)
  }

  const replyThreadFor = (message: GmailMessageDetail) => {
    const index = thread?.messages.findIndex((item) => item.id === message.id) ?? -1
    return thread && index >= 0 ? { ...thread, messages: thread.messages.slice(0, index + 1) } : thread
  }

  const showAccountMenu = (event: React.MouseEvent, account?: GmailAccountSummary) => {
    const progress = account ? sync.find((item) => item.accountId === account.id) : undefined
    showContextMenu(event, [
      { label: account ? `Open ${account.email}` : 'Open all accounts', icon: Mail, action: () => selectAccount(account?.id ?? 'all') },
      { label: 'New message', icon: Plus, disabled: account?.archived, action: () => setCompose({}) },
      { label: 'Check for mail', icon: RefreshCw, separatorBefore: true, disabled: account?.archived, action: () => startSync(account?.id) },
      ...(account && progress ? [{ label: progress.phase === 'paused' ? 'Resume sync' : 'Pause sync', icon: progress.phase === 'paused' ? Play : Pause, action: () => toggleSync(account, progress.phase === 'paused') }] satisfies ContextMenuItem[] : []),
      { label: 'Offline storage', icon: Download, action: showStorage },
      ...(account ? [{ label: 'Account settings…', icon: Settings2, separatorBefore: true, action: () => setSettingsAccount(account) }] satisfies ContextMenuItem[] : []),
      ...(account ? [{ label: 'Copy email address', icon: Copy, separatorBefore: true, action: () => copyText(account.email) }] satisfies ContextMenuItem[] : []),
      ...(account && !account.archived ? [{ label: 'Disconnect account…', icon: Settings2, separatorBefore: true, danger: true, action: () => disconnect(account) }] satisfies ContextMenuItem[] : [])
    ], account?.email ?? 'All accounts')
  }

  if (!loading && accounts.length === 0) {
    return (
      <div className="gmail-onboarding">
        <section>
          <span className="gmail-mark"><Mail size={28} /></span>
          <p className="eyebrow">Aerio mail</p>
          <h1>Your inboxes, together and available offline.</h1>
          <p>Connect Gmail, Outlook, iCloud, Yahoo, Fastmail, Proton Bridge, or another IMAP/SMTP provider. Aerio protects credentials with Windows secure storage and blocks remote images until you load them.</p>
          <button className="button primary onboarding-connect" onClick={() => setAccountSetup(true)}><UserPlus size={16} /> Add your first account</button>
          <small>OAuth providers open sign-in in your browser. iCloud, Yahoo, and Fastmail use provider-issued app passwords.</small>
        </section>
        {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
      </div>
    )
  }

  const activeProgress = sync.filter((item) => item.phase !== 'complete' && item.phase !== 'idle')
  const visibleLabels = labels.filter((label) => label.type === 'user' && (accountId === 'all' || label.accountId === accountId)).slice(0, 12)
  const syncUnavailable = accountId === 'all'
    ? !accounts.some((account) => !account.archived)
    : Boolean(accounts.find((account) => account.id === accountId)?.archived)
  const showFolderMenu = (event: React.MouseEvent, value: typeof folder) => showContextMenu(event, [
    { label: `Open ${folderNames[value]}`, icon: Mail, action: () => { setLabelId(undefined); setFolder(value) } },
    { label: 'New message', icon: Plus, separatorBefore: true, disabled: !accounts.some((account) => !account.archived), action: () => setCompose({}) },
    { label: 'Check for mail', icon: RefreshCw, disabled: syncUnavailable, action: () => startSync(accountId === 'all' ? undefined : accountId) }
  ], folderNames[value])
  const folderButton = (value: typeof folder, icon: React.ReactNode) => (
    <button className={`sidebar-item ${folder === value && !labelId ? 'active' : ''}`} onClick={() => { setLabelId(undefined); setFolder(value) }} onContextMenu={(event) => showFolderMenu(event, value)}>{icon}<span>{folderNames[value]}</span></button>
  )

  return (
    <div className="workspace mail-workspace real-mail">
      <aside className="context-sidebar">
        <button className="compose-button" disabled={!accounts.some((account) => !account.archived)} onClick={() => setCompose({})}><Plus size={18} /> New message</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Mailboxes</span>
          {folderButton('inbox', <Inbox size={17} />)}
          {folderButton('starred', <Star size={17} />)}
          {folderButton('important', <Tag size={17} />)}
          {folderButton('drafts', <FileText size={17} />)}
          {folderButton('sent', <Send size={17} />)}
          {folderButton('archive', <Archive size={17} />)}
          {folderButton('spam', <WifiOff size={17} />)}
          {folderButton('trash', <Trash2 size={17} />)}
          {folderButton('all', <Mail size={17} />)}
        </div>
        <div className="sidebar-group">
          <span className="sidebar-label">Accounts</span>
          <button className={`sidebar-item ${accountId === 'all' ? 'active' : ''}`} onClick={() => selectAccount('all')} onContextMenu={(event) => showAccountMenu(event)}><span className="account-dot multi" /><span>All accounts</span></button>
          {accounts.map((account) => <button className={`sidebar-item gmail-account-row ${accountId === account.id ? 'active' : ''}`} key={account.id} onClick={() => selectAccount(account.id)} onContextMenu={(event) => showAccountMenu(event, account)} title={`${account.email} · ${account.provider}${account.archived ? ' · offline archive' : ''}`}><span className="account-dot" style={{ background: account.color }} /><span>{account.email}{account.archived ? ' · archive' : ''}<small className="provider-name">{account.provider}</small></span><i className={`account-state ${account.status}`} /></button>)}
          <button className="sidebar-item" onClick={addAccount}><UserPlus size={16} /><span>Add mail account</span></button>
        </div>
          {visibleLabels.length > 0 && <div className="sidebar-group"><span className="sidebar-label">Labels</span>{visibleLabels.map((label) => { const selected = labelId === label.id && accountId === label.accountId; return <button className={`sidebar-item ${selected ? 'active' : ''}`} aria-pressed={selected} key={`${label.accountId}:${label.id}`} onClick={() => toggleLabel(label)} onContextMenu={(event) => showContextMenu(event, [
            { label: selected ? `Clear ${label.name} filter` : `Open ${label.name}`, icon: Tag, action: () => toggleLabel(label) },
            { label: 'New message', icon: Plus, separatorBefore: true, disabled: !accounts.some((account) => account.id === label.accountId && !account.archived), action: () => setCompose({}) },
            { label: 'Check account for mail', icon: RefreshCw, disabled: Boolean(accounts.find((account) => account.id === label.accountId)?.archived), action: () => startSync(label.accountId) }
          ], label.name)}><Tag size={15} /><span>{label.name}</span></button> })}</div>}
        <div className="gmail-sidebar-footer">
          <button onClick={() => void showStorage()}><Download size={14} /> Offline storage</button>
          {accounts.filter((account) => !account.archived).map((account) => <button key={account.id} title={`Settings for ${account.email}`} onClick={() => setSettingsAccount(account)} onContextMenu={(event) => showAccountMenu(event, account)}><Settings2 size={14} /> {account.email.split('@')[0]}</button>)}
        </div>
      </aside>

      <section className="mail-list-panel">
        <header className="panel-heading">
          <div><h1>{labels.find((label) => label.id === labelId && label.accountId === accountId)?.name ?? folderNames[folder]}</h1><p>{page.total.toLocaleString()} conversations{folder === 'drafts' && localDrafts.length ? ` · ${localDrafts.length.toLocaleString()} editable drafts` : ''}</p></div>
          <button className="icon-button" title="Check for mail" onClick={() => void startSync(accountId === 'all' ? undefined : accountId)}><RefreshCw size={17} /></button>
        </header>
        <div className="gmail-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search offline mail…" /><span>FTS</span></div>
        {checkedItems.length > 0 && <div className="bulk-mail-toolbar">
          <button className="icon-button" title="Clear selection" onClick={() => setCheckedKeys(new Set())}><X size={16} /></button>
          <strong>{checkedItems.length.toLocaleString()} selected</strong>
          <span className="toolbar-divider" />
          <button className="button ghost small" onClick={() => void applyBulkAction('archive')}><Archive size={15} /> Archive</button>
          <button className="button ghost small" onClick={() => void applyBulkAction('read')}><MailOpen size={15} /> Read</button>
          <button className="button ghost small" onClick={() => void applyBulkAction('star')}><Star size={15} /> Star</button>
          <button className="button ghost small" onClick={() => setOrganizeMode('move')}><FolderInput size={15} /> Move</button>
          <button className="button ghost small" onClick={() => setOrganizeMode('label')}><Tags size={15} /> Labels</button>
          <span className="spacer" />
          <button className="button danger-subtle small" onClick={() => void applyBulkAction('trash')}><Trash2 size={15} /> Trash</button>
        </div>}
        {activeProgress.map((item) => {
          const account = accounts.find((entry) => entry.id === item.accountId)
          const percent = item.total ? Math.round(item.completed / item.total * 100) : 0
          return <div className="sync-strip" key={item.accountId} onContextMenu={(event) => account && showContextMenu(event, [
            { label: item.phase === 'paused' ? 'Resume sync' : 'Pause sync', icon: item.phase === 'paused' ? Play : Pause, action: () => toggleSync(account, item.phase === 'paused') },
            { label: 'Check for mail now', icon: RefreshCw, action: () => startSync(account.id) },
            { label: 'Offline storage', icon: Download, separatorBefore: true, action: showStorage }
          ], `${account.email} sync`)}><span><strong>{account?.email ?? 'Mail'}</strong><small>{item.message ?? item.phase} · {item.completed.toLocaleString()}/{item.total.toLocaleString()}</small></span><progress max={Math.max(item.total, 1)} value={item.completed} /><button className="icon-button" disabled={!account} aria-label={item.phase === 'paused' ? 'Resume sync' : 'Pause sync'} onClick={() => account && void toggleSync(account, item.phase === 'paused')}>{item.phase === 'paused' ? <Play size={14} /> : <Pause size={14} />}</button><em>{percent}%</em></div>
        })}
        <div className="message-list" onContextMenu={(event) => showContextMenu(event, [
          { label: 'New message', icon: Plus, disabled: !accounts.some((account) => !account.archived), action: () => setCompose({}) },
          { label: 'Check for mail', icon: RefreshCw, separatorBefore: true, disabled: syncUnavailable, action: () => startSync(accountId === 'all' ? undefined : accountId) },
          { label: 'Mark visible conversations as read', icon: MailOpen, disabled: !page.items.some((item) => item.unread), action: markVisibleRead }
        ], 'Conversation list')}>
          {visibleLocalDrafts.map((draft) => <button key={`draft:${draft.id}`} className={`message-row local-draft-row ${draft.status === 'failed' ? 'draft-failed' : ''}`} onClick={() => setCompose({ draft })} onDoubleClick={() => setCompose({ draft })} onContextMenu={(event) => showContextMenu(event, [
            { label: 'Edit draft', icon: Edit3, action: () => setCompose({ draft }) },
            { label: 'Discard draft', icon: Trash2, separatorBefore: true, danger: true, action: () => discardLocalDraft(draft) }
          ], draft.subject || 'Draft')}>
            <span className="avatar draft-avatar"><FileText size={16} /></span>
            <span className="message-copy">
              <span className="message-meta"><strong>Draft · {draft.to.join(', ') || 'No recipients'}</strong><time>{shortDate(draft.updatedAt)}</time></span>
              <span className="message-subject">{draft.subject || '(No subject)'}</span>
              <span className="message-preview">{draft.error || draft.text || 'Empty draft'}</span>
              <span className="message-tags"><em>{draft.status === 'failed' ? 'Save failed' : draft.status === 'local' ? 'Waiting for connection' : 'Editable draft'}</em>{draft.attachmentPaths.length > 0 && <Paperclip size={13} />}</span>
            </span>
          </button>)}
          {page.items.length > 0 && <button className="select-visible-mail" onClick={toggleAllVisible}><CheckSquare size={14} /> {page.items.every((item) => checkedKeys.has(`${item.accountId}:${item.id}`)) ? 'Clear visible selection' : 'Select visible conversations'}</button>}
          {page.items.map((item, index) => (
            <div key={`${item.accountId}:${item.id}`} role="button" tabIndex={0} aria-current={selectedKey === `${item.accountId}:${item.id}` ? 'true' : undefined} className={`message-row ${selectedKey === `${item.accountId}:${item.id}` ? 'selected' : ''} ${checkedKeys.has(`${item.accountId}:${item.id}`) ? 'checked' : ''} ${item.unread ? 'unread' : ''}`} onClick={() => openSummary(item)} onDoubleClick={() => openMessageWindow(item)} onKeyDown={(event) => { if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openMessageWindow(item) } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSummary(item) } }} onContextMenu={(event) => showSummaryMenu(event, item)}>
              <input className="message-select" type="checkbox" aria-label={`Select ${item.subject}`} checked={checkedKeys.has(`${item.accountId}:${item.id}`)} readOnly onClick={(event) => { event.stopPropagation(); toggleChecked(item, index, event.shiftKey) }} />
              <SenderAvatar email={item.senderEmail} name={item.participants[0]} fallbackColor={accounts.find((account) => account.id === item.accountId)?.color} />
              <span className="message-copy">
                <span className="message-meta"><strong>{item.participants.join(', ') || 'Unknown sender'}</strong><time>{shortDate(item.lastDate)}</time></span>
                <span className="message-subject">{item.subject}</span>
                <span className="message-preview">{item.snippet}</span>
                <span className="message-tags">{item.messageCount > 1 && <em>{item.messageCount} messages</em>}{item.hasAttachments && <Paperclip size={13} />}</span>
              </span>
              <span className="row-flags">{item.starred && <Star size={13} fill="currentColor" />}</span>
            </div>
          ))}
          {!loading && !page.items.length && !visibleLocalDrafts.length && <div className="empty-state"><Search size={28} /><h3>No conversations here</h3><p>Try another mailbox or search.</p></div>}
          {loading && <div className="empty-state"><LoaderCircle className="spin" size={28} /><p>Loading local mail…</p></div>}
        </div>
        <footer className="gmail-pagination"><button className="button ghost small" disabled={!history.length} onClick={() => { const prior = history.slice(0, -1); setHistory(prior); void loadPage(prior.at(-1)) }}>Previous</button><button className="button ghost small" disabled={!page.nextCursor} onClick={() => { setHistory((items) => [...items, page.nextCursor]); void loadPage(page.nextCursor) }}>Next</button></footer>
      </section>

      <section className="reader-panel">
        {selected && thread ? <>
          <div className="reader-toolbar">
            <button className="icon-button" disabled={selectedAccount?.archived} title={selected.unread ? 'Mark read' : 'Mark unread'} onClick={() => void applyAction(selected.unread ? 'read' : 'unread')}>{selected.unread ? <MailOpen size={18} /> : <Mail size={18} />}</button>
            <button className="icon-button" disabled={selectedAccount?.archived || selected.trashed} title={selected.labelIds.includes('INBOX') ? 'Archive' : 'Move to inbox'} onClick={() => void applyAction(selected.labelIds.includes('INBOX') ? 'archive' : selected.labelIds.includes('SPAM') ? 'move' : 'unarchive', undefined, undefined, true, selected.labelIds.includes('SPAM') ? 'INBOX' : undefined)}>{selected.labelIds.includes('INBOX') ? <Archive size={18} /> : <Inbox size={18} />}</button>
            <button className="icon-button" disabled={selectedAccount?.archived} title={selected.trashed ? 'Restore from Trash' : 'Move to Trash'} onClick={() => void applyAction(selected.trashed ? 'untrash' : 'trash')}>{selected.trashed ? <Undo2 size={18} /> : <Trash2 size={18} />}</button>
            <span className="toolbar-divider" />
            <button className={`icon-button ${selected.starred ? 'active' : ''}`} disabled={selectedAccount?.archived} title="Star" onClick={() => void applyAction(selected.starred ? 'unstar' : 'star')}><Star size={18} fill={selected.starred ? 'currentColor' : 'none'} /></button>
            <span className="spacer" />
            {!remoteImages && <button className="button ghost small" onClick={() => void loadRemoteImages()}><Image size={15} /> Load remote images</button>}
          </div>
          <article className="message-reader gmail-thread" onContextMenu={(event) => showSummaryMenu(event, selected)}>
            <header><div className="reader-labels">{selected.labelIds.filter((label) => !['INBOX', 'UNREAD'].includes(label)).slice(0, 5).map((label) => <span key={label}>{label}</span>)}</div><h2>{thread.subject}</h2></header>
            {thread.messages.map((message) => <ThreadMessageAccordion
              key={message.id}
              message={message}
              expanded={expandedMessageId === message.id}
              dateLabel={new Date(message.date).toLocaleString()}
              onToggle={() => setExpandedMessageId((current) => current === message.id ? undefined : message.id)}
              onReply={selectedAccount?.archived ? undefined : () => setCompose({ reply: replyThreadFor(message) })}
              onContextMenu={(event) => showProviderMessageMenu(event, message)}
            >
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id} onContextMenu={(event) => showAttachmentMenu(event, message, attachment)}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small></span><button className="icon-button" title="Open" onClick={() => void openAttachment(message, attachment)}><Download size={16} /></button><button className="button ghost small" onClick={() => void saveAttachment(message, attachment)}>Save as</button></div>)}</div>}
            </ThreadMessageAccordion>)}
            {!selectedAccount?.archived && <div className="quick-actions"><button className="button ghost" onClick={() => setCompose({ reply: thread })}><Reply size={16} /> Reply</button></div>}
          </article>
        </> : <div className="empty-state grow">{threadLoading ? <><LoaderCircle className="spin" size={34} /><h3>Opening conversation</h3><p>Loading the selected thread from local storage.</p></> : accounts.some((item) => item.status === 'syncing') ? <><LoaderCircle className="spin" size={34} /><h3>Downloading your mailbox</h3><p>Conversations appear here as soon as they are available.</p></> : <><Inbox size={34} /><h3>Select a conversation</h3><p>Choose a conversation to read it here.</p></>}</div>}
      </section>

      {pending.length > 0 && <div className="undo-toast"><span>{pending.length > 1 ? `${pending.length} mail changes queued` : 'Mail change queued'}</span><button onClick={() => void undo()}><Undo2 size={15} /> Undo</button><button onClick={() => setPending([])}>Dismiss</button></div>}
      {compose && <GmailComposeModal accounts={accounts.filter((account) => !account.archived)} draft={compose.draft} replyTo={compose.reply} forward={compose.forward} onClose={() => { setCompose(undefined); if (folder === 'drafts') void loadDrafts() }} onSent={() => { void loadPage(); void loadDrafts() }} onToast={onToast} />}
      {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
      {settingsAccount && <MailAccountSettingsModal account={settingsAccount} onSaved={(updated) => { setAccounts((items) => items.map((item) => item.id === updated.id ? updated : item)); setSettingsAccount(updated) }} onClose={() => setSettingsAccount(undefined)} onToast={onToast} />}
      {organizeMode && <MailOrganizeModal mode={organizeMode} items={checkedItems} accounts={accounts} labels={labels} onApply={applyOrganizeRequests} onClose={() => setOrganizeMode(undefined)} />}
    </div>
  )
}
