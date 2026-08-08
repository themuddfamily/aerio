import {
  Archive, AtSign, CalendarClock, CheckSquare, ChevronDown, Clock3, Copy, Download, Edit3, ExternalLink, FileText, Filter, FolderInput, Forward, Image, Inbox, LoaderCircle, Mail, MailOpen,
  MoreVertical, Paperclip, Pause, Play, Plus, RefreshCw, Reply, ReplyAll, Search, Send, Settings2,
  Star, Tag, Tags, Trash2, Undo2, UserPlus, WifiOff, X
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MailComposeModal from '../components/MailComposeModal'
import MailAccountSetupModal from '../components/MailAccountSetupModal'
import MailAccountSettingsModal from '../components/MailAccountSettingsModal'
import MailOrganizeModal from '../components/MailOrganizeModal'
import MailMessageSourceModal from '../components/MailMessageSourceModal'
import MailRulesModal from '../components/MailRulesModal'
import MailSearchFiltersPanel from '../components/MailSearchFiltersPanel'
import MailSnoozeModal from '../components/MailSnoozeModal'
import SenderAvatar from '../components/SenderAvatar'
import ThreadListPreview from '../components/ThreadListPreview'
import ThreadMessageAccordion from '../components/ThreadMessageAccordion'
import { MailPaneSeparator, useResizableMailPanes } from '../components/MailPaneResizer'
import type {
  MailAccountSummary,
  ApplyMailActionInput,
  MailAttachment,
  MailDraftRecord,
  MailDraftResult,
  MailLabel,
  MailMessageDetail,
  MailThreadDetail,
  MailActionKind,
  MailPage,
  MailQuery,
  MailSearchFilters,
  MailThreadSummary,
  PendingOperation,
  SyncProgress
} from '../mail-types'
import { formatFileSize } from '../lib/domain'
import { decodeHtmlEntities } from '../lib/html-entities'
import { formatMailArrivalTooltip, formatMailDateHeading, formatMailListTime, mailDateGroupKey } from '../lib/mail-date'
import { visibleMailLabels } from '../lib/mail-labels'
import { isMailboxRefreshing, shouldShowDetailedSync } from '../lib/mail-sync'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'

interface ConnectedMailViewProps {
  onToast(message: string): void
  composeRequest?: number
}

const emptyPage: MailPage = { items: [], total: 0 }
const folderNames: Record<NonNullable<MailQuery['folder']>, string> = {
  inbox: 'Inbox', starred: 'Starred', important: 'Important', sent: 'Sent',
  drafts: 'Drafts', scheduled: 'Scheduled', snoozed: 'Snoozed', archive: 'Archive', spam: 'Spam', trash: 'Trash', all: 'All mail'
}

function shortDate(date: string) {
  const value = new Date(date)
  const today = new Date()
  return value.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(value)
    : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(value)
}

export default function ConnectedMailView({ onToast, composeRequest = 0 }: ConnectedMailViewProps) {
  const { showContextMenu } = useContextMenu()
  const mailPanes = useResizableMailPanes()
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [page, setPage] = useState<MailPage>(emptyPage)
  const [localDrafts, setLocalDrafts] = useState<MailDraftRecord[]>([])
  const [folder, setFolder] = useState<NonNullable<MailQuery['folder']>>('inbox')
  const [labelId, setLabelId] = useState<string>()
  const [accountId, setAccountId] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [searchFilters, setSearchFilters] = useState<MailSearchFilters>({})
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState('')
  const [thread, setThread] = useState<MailThreadDetail>()
  const [expandedMessageId, setExpandedMessageId] = useState<string>()
  const [threadLoading, setThreadLoading] = useState(false)
  const [expandedListThreadKey, setExpandedListThreadKey] = useState<string>()
  const [listThreadDetails, setListThreadDetails] = useState<Record<string, MailThreadDetail>>({})
  const [listThreadLoadingKey, setListThreadLoadingKey] = useState<string>()
  const [sync, setSync] = useState<SyncProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState(false)
  const [compose, setCompose] = useState<{ draft?: MailDraftRecord; reply?: MailThreadDetail; replyAll?: boolean; forward?: boolean }>()
  const [pending, setPending] = useState<PendingOperation[]>([])
  const [pendingSend, setPendingSend] = useState<MailDraftResult>()
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [organizeMode, setOrganizeMode] = useState<'move' | 'label'>()
  const [snoozeItems, setSnoozeItems] = useState<MailThreadSummary[]>()
  const [rulesOpen, setRulesOpen] = useState(false)
  const [sourceViewer, setSourceViewer] = useState<{ mode: 'headers' | 'source'; subject: string; content: string }>()
  const [remoteImages, setRemoteImages] = useState(false)
  const [accountSetup, setAccountSetup] = useState(false)
  const [settingsAccount, setSettingsAccount] = useState<MailAccountSummary>()
  const handledComposeRequest = useRef(0)
  const requestedMessage = useRef<{ threadKey: string; messageId: string } | undefined>(undefined)
  const pageRequest = useRef(0)
  const loadingMoreRef = useRef(false)
  const messageListRef = useRef<HTMLDivElement>(null)
  const searchShellRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const selected = page.items.find((item) => `${item.accountId}:${item.id}` === selectedKey)
  const selectedAccount = accounts.find((item) => item.id === selected?.accountId)
  const selectedLabels = selected ? visibleMailLabels(selected.accountId, selected.labelIds, labels) : []
  const checkedItems = useMemo(() => page.items.filter((item) => checkedKeys.has(`${item.accountId}:${item.id}`)), [checkedKeys, page.items])
  const activeSearchFilterCount = Object.values(searchFilters).filter((value) => value !== undefined && value !== '').length

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

  const requestMailPage = useCallback((cursor?: string) => window.aerio.mail.mail.list({
    folder,
    accountIds: accountId === 'all' ? undefined : [accountId],
    labelId,
    search: search.trim() || undefined,
    filters: activeSearchFilterCount ? searchFilters : undefined,
    cursor,
    pageSize: 50
  }), [accountId, folder, labelId, search, searchFilters, activeSearchFilterCount])

  const loadPage = useCallback(async () => {
    const request = ++pageRequest.current
    loadingMoreRef.current = false
    setLoadingMore(false)
    setLoadMoreError(false)
    if (!accounts.length) {
      setPage(emptyPage)
      return
    }
    setLoading(true)
    try {
      const next = await requestMailPage()
      if (request !== pageRequest.current) return
      setPage(next)
      setSelectedKey((current) => current && next.items.some((item) => `${item.accountId}:${item.id}` === current)
        ? current
        : next.items[0] ? `${next.items[0].accountId}:${next.items[0].id}` : '')
    } catch (error) {
      if (request === pageRequest.current) onToast(error instanceof Error ? error.message : 'Mail could not be loaded')
    } finally {
      if (request === pageRequest.current) setLoading(false)
    }
  }, [accounts.length, onToast, requestMailPage])

  const loadMore = useCallback(async () => {
    const cursor = page.nextCursor
    if (!cursor || loading || loadingMoreRef.current) return
    const request = pageRequest.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setLoadMoreError(false)
    try {
      const next = await requestMailPage(cursor)
      if (request !== pageRequest.current) return
      setPage((current) => {
        if (current.nextCursor !== cursor) return current
        const existing = new Set(current.items.map((item) => `${item.accountId}:${item.id}`))
        const items = [...current.items, ...next.items.filter((item) => !existing.has(`${item.accountId}:${item.id}`))]
        return { items, total: next.total, nextCursor: next.nextCursor }
      })
    } catch (error) {
      if (request === pageRequest.current) {
        setLoadMoreError(true)
        onToast(error instanceof Error ? error.message : 'More mail could not be loaded')
      }
    } finally {
      if (request === pageRequest.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [loading, onToast, page.nextCursor, requestMailPage])

  useEffect(() => {
    void Promise.all([
      window.aerio.mail.accounts.list(),
      window.aerio.mail.sync.progress()
    ]).then(([accountList, progress]) => {
      const visible = accountList
      setAccounts(visible)
      setSync(progress)
      return window.aerio.mail.mail.labels(visible.map((item) => item.id))
    }).then(setLabels).catch((error) => onToast(error instanceof Error ? error.message : 'Mail could not start')).finally(() => setLoading(false))
  }, [onToast])

  useEffect(() => {
    const unsubscribe = window.aerio.mail.onEvent((event) => {
      if (event.type === 'accounts-changed') setAccounts(event.payload)
      if (event.type === 'sync-progress') {
        setSync((items) => [...items.filter((item) => item.accountId !== event.payload.accountId), event.payload])
        if (event.payload.phase === 'complete') void window.aerio.mail.mail.labels().then(setLabels).catch(() => undefined)
      }
      if (event.type === 'mail-changed') void loadPage()
      if (event.type === 'operation' && event.payload.status === 'failed') onToast(event.payload.error ?? 'The mail provider rejected the change')
      if (event.type === 'operation' && event.payload.status === 'succeeded') setPending((items) => items.filter((item) => item.id !== event.payload.id))
      if (event.type === 'draft-delivery') {
        setPendingSend((current) => current?.id === event.payload.id ? undefined : current)
        if (event.payload.status === 'sent') onToast('Message sent')
        if (event.payload.status === 'failed') onToast(event.payload.error ?? 'Message could not be sent')
        void loadDrafts()
      }
      if (event.type === 'connectivity' && !event.payload.online) onToast('Offline — changes will be sent when you reconnect')
    })
    return unsubscribe
  }, [loadDrafts, loadPage, onToast])

  useEffect(() => {
    const undoUntil = pending.map((item) => item.undoUntil).filter(Boolean).sort()[0]
    if (!undoUntil) return
    const delay = Math.max(0, new Date(undoUntil).getTime() - Date.now())
    const timer = setTimeout(() => setPending([]), delay)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    if (!pendingSend?.undoUntil) return
    const delay = Math.max(0, new Date(pendingSend.undoUntil).getTime() - Date.now())
    const timer = setTimeout(() => setPendingSend(undefined), delay)
    return () => clearTimeout(timer)
  }, [pendingSend])

  useEffect(() => setCheckedKeys(new Set()), [accountId, folder, labelId, search, searchFilters])

  useEffect(() => {
    if (!searchFiltersOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !searchShellRef.current?.contains(event.target)) setSearchFiltersOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchFiltersOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [searchFiltersOpen])

  useEffect(() => { void loadPage() }, [loadPage])

  useEffect(() => {
    const root = messageListRef.current
    const target = loadMoreSentinelRef.current
    if (!root || !target || !page.nextCursor || loading || loadingMore || loadMoreError) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    }, { root, rootMargin: '240px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [loadMore, loading, loadingMore, loadMoreError, page.nextCursor])

  useEffect(() => {
    if (folder === 'drafts' || folder === 'scheduled') void loadDrafts()
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
      const threadKey = `${selected.accountId}:${selected.id}`
      const preferred = requestedMessage.current?.threadKey === threadKey && detail.messages.some((message) => message.id === requestedMessage.current?.messageId)
        ? requestedMessage.current.messageId
        : detail.messages.at(-1)?.id
      setThread(detail)
      setListThreadDetails((current) => ({ ...current, [threadKey]: detail }))
      setExpandedMessageId(preferred)
      if (requestedMessage.current?.threadKey === threadKey) requestedMessage.current = undefined
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

  const toggleSync = async (account: MailAccountSummary, paused: boolean) => {
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

  const disconnect = async (account: MailAccountSummary) => {
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

  const refreshMail = () => void startSync(accountId === 'all' ? undefined : accountId)

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

  const openSummary = (item: MailThreadSummary, messageId?: string) => {
    const threadKey = `${item.accountId}:${item.id}`
    requestedMessage.current = messageId ? { threadKey, messageId } : undefined
    if (threadKey === selectedKey && messageId && thread?.messages.some((message) => message.id === messageId)) {
      setExpandedMessageId(messageId)
      return
    }
    setSelectedKey(threadKey)
  }

  const toggleListThread = async (item: MailThreadSummary) => {
    const threadKey = `${item.accountId}:${item.id}`
    if (expandedListThreadKey === threadKey) {
      setExpandedListThreadKey(undefined)
      setListThreadDetails((current) => {
        const next = { ...current }
        delete next[threadKey]
        return next
      })
      return
    }
    if (expandedListThreadKey) {
      setListThreadDetails((current) => {
        const next = { ...current }
        delete next[expandedListThreadKey]
        return next
      })
    }
    setExpandedListThreadKey(threadKey)
    if (listThreadDetails[threadKey]) return
    if (selectedKey === threadKey && thread) {
      setListThreadDetails((current) => ({ ...current, [threadKey]: thread }))
      return
    }
    setListThreadLoadingKey(threadKey)
    try {
      const detail = await window.aerio.mail.mail.thread(item.accountId, item.id)
      setListThreadDetails((current) => ({ ...current, [threadKey]: detail }))
    } catch (error) {
      setExpandedListThreadKey((current) => current === threadKey ? undefined : current)
      onToast(error instanceof Error ? error.message : 'Conversation replies could not be loaded')
    } finally {
      setListThreadLoadingKey((current) => current === threadKey ? undefined : current)
    }
  }

  function selectAccount(nextAccountId: string) {
    setAccountId(nextAccountId)
    setLabelId(undefined)
  }

  function toggleLabel(label: MailLabel) {
    const selected = accountId === label.accountId && labelId === label.id
    setAccountId(label.accountId)
    setLabelId(selected ? undefined : label.id)
    setFolder('all')
  }

  const openMessageWindow = (item: MailThreadSummary, messageId?: string) => {
    void window.aerio.window.openMessage({ source: 'connected', accountId: item.accountId, threadId: item.id, messageId, title: item.subject })
      .catch((error) => onToast(error instanceof Error ? error.message : 'The message window could not be opened'))
  }

  const composeFromSummary = async (item: MailThreadSummary, forward = false, replyAll = false) => {
    try {
      const detail = selected?.id === item.id && thread ? thread : await window.aerio.mail.mail.thread(item.accountId, item.id)
      setCompose({ reply: detail, forward, replyAll })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Conversation could not be opened')
    }
  }

  const discardLocalDraft = async (draft: MailDraftRecord) => {
    if (!window.confirm(`Discard “${draft.subject || '(No subject)'}”?`)) return
    try {
      const result = await window.aerio.mail.drafts.delete(draft.id)
      onToast(result.status === 'discard-queued' ? 'Offline — draft will be discarded after reconnecting' : 'Draft discarded')
      await loadDrafts()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Draft could not be discarded')
    }
  }

  const cancelQueuedDraft = async (draft: MailDraftRecord, edit = false) => {
    try {
      const result = await window.aerio.mail.drafts.cancelSend(draft.id)
      setPendingSend((current) => current?.id === draft.id ? undefined : current)
      await loadDrafts()
      onToast(draft.status === 'scheduled' ? 'Scheduled delivery cancelled' : 'Send undone — message returned to Drafts')
      if (edit) setCompose({ draft: { ...draft, ...result, deliveryAt: undefined, undoUntil: undefined } })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The queued message could not be cancelled')
    }
  }

  const openLocalDraft = (draft: MailDraftRecord) => {
    if (['scheduled', 'send-pending', 'queued'].includes(draft.status)) void cancelQueuedDraft(draft, true)
    else setCompose({ draft })
  }

  const undoSend = async () => {
    if (!pendingSend) return
    const draft = localDrafts.find((item) => item.id === pendingSend.id) ?? await window.aerio.mail.drafts.get(pendingSend.id)
    if (draft) await cancelQueuedDraft(draft)
    else setPendingSend(undefined)
  }

  const applySnooze = async (items: MailThreadSummary[], until: string) => {
    const groups = new Map<string, string[]>()
    for (const item of items) groups.set(item.accountId, [...(groups.get(item.accountId) ?? []), item.id])
    try {
      for (const [targetAccount, threadIds] of groups) await window.aerio.mail.mail.snooze(targetAccount, threadIds, until)
      setCheckedKeys(new Set())
      await loadPage()
      onToast(`${items.length === 1 ? 'Conversation' : `${items.length.toLocaleString()} conversations`} snoozed until ${new Date(until).toLocaleString()}`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The conversations could not be snoozed')
      throw error
    }
  }

  const unsnoozeMany = async (items: MailThreadSummary[]) => {
    const groups = new Map<string, string[]>()
    for (const item of items) groups.set(item.accountId, [...(groups.get(item.accountId) ?? []), item.id])
    try {
      for (const [targetAccount, threadIds] of groups) await window.aerio.mail.mail.unsnooze(targetAccount, threadIds)
      setCheckedKeys(new Set())
      await loadPage()
      onToast(items.length === 1 ? 'Conversation returned to Inbox' : `${items.length.toLocaleString()} conversations returned to Inbox`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The conversations could not be restored')
    }
  }
  const unsnooze = (item: MailThreadSummary) => unsnoozeMany([item])

  const visibleLocalDrafts = (folder === 'drafts' || folder === 'scheduled') ? localDrafts.filter((draft) => {
    const delivery = ['scheduled', 'send-pending', 'queued'].includes(draft.status)
    if (folder === 'scheduled' ? !delivery : delivery) return false
    const term = search.trim().toLowerCase()
    if (term && !`${draft.subject} ${draft.to.join(' ')} ${draft.cc.join(' ')} ${draft.bcc.join(' ')} ${draft.text} ${draft.attachmentPaths.join(' ')}`.toLowerCase().includes(term)) return false
    const account = accounts.find((item) => item.id === draft.accountId)
    const includes = (value: string, needle?: string) => !needle?.trim() || value.toLowerCase().includes(needle.trim().toLowerCase())
    if (!includes(`${account?.displayName ?? ''} ${account?.email ?? ''}`, searchFilters.from)) return false
    if (!includes([...draft.to, ...draft.cc, ...draft.bcc].join(' '), searchFilters.to)) return false
    if (!includes(draft.subject, searchFilters.subject)) return false
    if (!includes(draft.attachmentPaths.join(' '), searchFilters.attachmentName)) return false
    const draftDate = draft.updatedAt.slice(0, 10)
    if (searchFilters.dateFrom && draftDate < searchFilters.dateFrom) return false
    if (searchFilters.dateTo && draftDate > searchFilters.dateTo) return false
    if (typeof searchFilters.hasAttachments === 'boolean' && (draft.attachmentPaths.length > 0) !== searchFilters.hasAttachments) return false
    if (searchFilters.unread === true || searchFilters.starred === true || searchFilters.important === true) return false
    return true
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
      { label: 'Reply all', icon: ReplyAll, disabled: readOnly || item.draft, action: () => composeFromSummary(item, false, true) },
      { label: 'Forward', icon: Forward, disabled: readOnly, action: () => composeFromSummary(item, true) },
      { label: item.unread ? 'Mark as read' : 'Mark as unread', icon: item.unread ? MailOpen : Mail, separatorBefore: true, disabled: readOnly, action: () => applyAction(item.unread ? 'read' : 'unread', item.accountId, [item.id]) },
      { label: item.starred ? 'Remove star' : 'Add star', icon: Star, checked: item.starred, disabled: readOnly, action: () => applyAction(item.starred ? 'unstar' : 'star', item.accountId, [item.id]) },
      { label: item.important ? 'Mark as not important' : 'Mark as important', icon: Tag, checked: item.important, disabled: readOnly, action: () => applyAction(item.important ? 'unimportant' : 'important', item.accountId, [item.id]) },
      ...(!item.trashed ? [{ label: inInbox ? 'Archive' : 'Move to inbox', icon: inInbox ? Archive : Inbox, separatorBefore: true, disabled: readOnly, action: () => applyAction(inInbox ? 'archive' : inSpam ? 'move' : 'unarchive', item.accountId, [item.id], true, inSpam ? 'INBOX' : undefined) }] satisfies ContextMenuItem[] : []),
      { label: 'Move to…', icon: FolderInput, disabled: readOnly, action: () => { setCheckedKeys(new Set([`${item.accountId}:${item.id}`])); setOrganizeMode('move') } },
      { label: 'Manage labels…', icon: Tags, disabled: readOnly || accounts.find((account) => account.id === item.accountId)?.provider !== 'gmail', action: () => { setCheckedKeys(new Set([`${item.accountId}:${item.id}`])); setOrganizeMode('label') } },
      { label: item.snoozedUntil ? 'Return to Inbox now' : 'Snooze…', icon: Clock3, disabled: readOnly, action: () => item.snoozedUntil ? unsnooze(item) : setSnoozeItems([item]) },
      { label: item.trashed ? 'Restore from Trash' : 'Move to Trash', icon: Trash2, danger: !item.trashed, disabled: readOnly, action: () => applyAction(item.trashed ? 'untrash' : 'trash', item.accountId, [item.id]) },
      { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(item.subject) },
      { label: 'Copy participants', icon: AtSign, action: () => copyText(item.participants.join(', ')) }
    ]
  }

  const showSummaryMenu = (event: React.MouseEvent, item: MailThreadSummary) => {
    if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a[href], img[src]'))) return
    showContextMenu(event, summaryMenu(item), item.subject)
  }

  const viewMessageData = async (message: MailMessageDetail, mode: 'headers' | 'source') => {
    try {
      const result = await window.aerio.mail.mail.source(message.accountId, message.id)
      setSourceViewer({ mode, subject: message.subject, content: result[mode] })
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The original message is not available')
    }
  }

  const showReaderMoreMenu = (event: React.MouseEvent) => {
    if (!selected || !thread) return
    const message = thread.messages.find((item) => item.id === expandedMessageId) ?? thread.messages.at(-1)
    if (!message) return
    const readOnly = Boolean(selectedAccount?.archived)
    const canManageLabels = selectedAccount?.provider === 'gmail' && !readOnly
    const selectForOrganizing = (mode: 'move' | 'label') => {
      setCheckedKeys(new Set([`${selected.accountId}:${selected.id}`]))
      setOrganizeMode(mode)
    }
    showContextMenu(event, [
      { label: 'Open in new window', icon: ExternalLink, action: () => openMessageWindow(selected, message.id) },
      { label: 'Reply all', icon: ReplyAll, disabled: readOnly, action: () => setCompose({ reply: thread, replyAll: true }) },
      { label: 'Forward', icon: Forward, disabled: readOnly, action: () => setCompose({ reply: thread, forward: true }) },
      { label: selected.important ? 'Mark as not important' : 'Mark as important', icon: Tag, checked: selected.important, separatorBefore: true, disabled: readOnly, action: () => applyAction(selected.important ? 'unimportant' : 'important', selected.accountId, [selected.id]) },
      { label: 'Move to…', icon: FolderInput, disabled: readOnly, action: () => selectForOrganizing('move') },
      { label: 'Manage tags / labels…', icon: Tags, disabled: !canManageLabels, action: () => selectForOrganizing('label') },
      { label: selected.snoozedUntil ? 'Return to Inbox now' : 'Snooze…', icon: Clock3, disabled: readOnly, action: () => selected.snoozedUntil ? unsnooze(selected) : setSnoozeItems([selected]) },
      { label: 'View message headers', icon: AtSign, separatorBefore: true, action: () => viewMessageData(message, 'headers') },
      { label: 'View message source', icon: FileText, action: () => viewMessageData(message, 'source') },
      { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(selected.subject) },
      ...(message.messageIdHeader ? [{ label: 'Copy message ID', icon: Copy, action: () => copyText(message.messageIdHeader!) }] satisfies ContextMenuItem[] : [])
    ], 'More message actions')
  }

  const openAttachment = async (message: MailMessageDetail, attachment: MailAttachment) => {
    try {
      const result = await window.aerio.mail.attachments.open(message.accountId, message.id, attachment.id, attachment.filename)
      if (result.error) onToast(result.error)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be opened')
    }
  }

  const saveAttachment = async (message: MailMessageDetail, attachment: MailAttachment) => {
    try {
      const result = await window.aerio.mail.attachments.save(message.accountId, message.id, attachment.id, attachment.filename)
      if (result.error) onToast(result.error)
      else if (result.savedPath) onToast(`Saved ${attachment.filename}`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be saved')
    }
  }

  const showAttachmentMenu = (event: React.MouseEvent, message: MailMessageDetail, attachment: MailAttachment) => showContextMenu(event, [
    { label: 'Open attachment', icon: Download, action: () => openAttachment(message, attachment) },
    { label: 'Save as…', icon: Download, action: () => saveAttachment(message, attachment) },
    { label: 'Copy filename', icon: Copy, separatorBefore: true, action: () => copyText(attachment.filename) }
  ], attachment.filename)

  const showProviderMessageMenu = (event: React.MouseEvent, message: MailMessageDetail) => {
    if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a[href], img[src]'))) return
    const replyThread = replyThreadFor(message)
    showContextMenu(event, [
      { label: 'Reply', icon: Reply, disabled: selectedAccount?.archived || !replyThread, action: () => setCompose({ reply: replyThread }) },
      { label: 'Reply all', icon: ReplyAll, disabled: selectedAccount?.archived || !replyThread, action: () => setCompose({ reply: replyThread, replyAll: true }) },
      { label: 'Forward', icon: Forward, disabled: selectedAccount?.archived || !replyThread, action: () => setCompose({ reply: replyThread, forward: true }) },
      { label: 'Copy sender name', icon: Copy, separatorBefore: true, action: () => copyText(message.fromName || message.fromEmail) },
      { label: 'Copy sender address', icon: AtSign, action: () => copyText(message.fromEmail) },
      { label: 'Copy message text', icon: Copy, action: () => copyText(message.text) }
    ], message.subject)
  }

  const replyThreadFor = (message: MailMessageDetail) => {
    const index = thread?.messages.findIndex((item) => item.id === message.id) ?? -1
    return thread && index >= 0 ? { ...thread, messages: thread.messages.slice(0, index + 1) } : thread
  }

  const showAccountMenu = (event: React.MouseEvent, account?: MailAccountSummary) => {
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
      <div className="mail-onboarding">
        <section>
          <span className="mail-mark"><Mail size={28} /></span>
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

  const activeProgress = sync.filter((item) => shouldShowDetailedSync(item, accounts.find((account) => account.id === item.accountId)))
  const mailboxRefreshing = isMailboxRefreshing(accounts, sync, accountId)
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
    <div ref={mailPanes.containerRef} className="workspace mail-workspace real-mail" style={mailPanes.style}>
      <aside className="context-sidebar">
        <button className="compose-button" disabled={!accounts.some((account) => !account.archived)} onClick={() => setCompose({})}><Plus size={18} /> New message</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Mailboxes</span>
          {folderButton('inbox', <Inbox size={17} />)}
          {folderButton('starred', <Star size={17} />)}
          {folderButton('important', <Tag size={17} />)}
          {folderButton('snoozed', <Clock3 size={17} />)}
          {folderButton('drafts', <FileText size={17} />)}
          {folderButton('scheduled', <CalendarClock size={17} />)}
          {folderButton('sent', <Send size={17} />)}
          {folderButton('archive', <Archive size={17} />)}
          {folderButton('spam', <WifiOff size={17} />)}
          {folderButton('trash', <Trash2 size={17} />)}
          {folderButton('all', <Mail size={17} />)}
        </div>
        <div className="sidebar-group">
          <span className="sidebar-label">Accounts</span>
          <button className={`sidebar-item ${accountId === 'all' ? 'active' : ''}`} onClick={() => selectAccount('all')} onContextMenu={(event) => showAccountMenu(event)}><span className="account-dot multi" /><span>All accounts</span></button>
          {accounts.map((account) => <button className={`sidebar-item mail-account-row ${accountId === account.id ? 'active' : ''}`} key={account.id} onClick={() => selectAccount(account.id)} onContextMenu={(event) => showAccountMenu(event, account)} title={`${account.email} · ${account.provider}${account.archived ? ' · offline archive' : ''}`}><span className="account-dot" style={{ background: account.color }} /><span>{account.email}{account.archived ? ' · archive' : ''}<small className="provider-name">{account.provider}</small></span><i className={`account-state ${account.status}`} /></button>)}
          <button className="sidebar-item" onClick={addAccount}><UserPlus size={16} /><span>Add mail account</span></button>
        </div>
          {visibleLabels.length > 0 && <div className="sidebar-group"><span className="sidebar-label">Labels</span>{visibleLabels.map((label) => { const selected = labelId === label.id && accountId === label.accountId; return <button className={`sidebar-item ${selected ? 'active' : ''}`} aria-pressed={selected} key={`${label.accountId}:${label.id}`} onClick={() => toggleLabel(label)} onContextMenu={(event) => showContextMenu(event, [
            { label: selected ? `Clear ${label.name} filter` : `Open ${label.name}`, icon: Tag, action: () => toggleLabel(label) },
            { label: 'New message', icon: Plus, separatorBefore: true, disabled: !accounts.some((account) => account.id === label.accountId && !account.archived), action: () => setCompose({}) },
            { label: 'Check account for mail', icon: RefreshCw, disabled: Boolean(accounts.find((account) => account.id === label.accountId)?.archived), action: () => startSync(label.accountId) }
          ], label.name)}><Tag size={15} /><span>{label.name}</span></button> })}</div>}
        <div className="mail-sidebar-footer">
          <button onClick={() => setRulesOpen(true)}><Filter size={14} /> Mail rules</button>
          <button onClick={() => void showStorage()}><Download size={14} /> Offline storage</button>
          {accounts.filter((account) => !account.archived).map((account) => <button key={account.id} title={`Settings for ${account.email}`} onClick={() => setSettingsAccount(account)} onContextMenu={(event) => showAccountMenu(event, account)}><Settings2 size={14} /> {account.email.split('@')[0]}</button>)}
        </div>
      </aside>

      <MailPaneSeparator pane="sidebar" value={mailPanes.widths.sidebar} onPointerDown={mailPanes.startResize} onKeyDown={mailPanes.resizeWithKeyboard} onReset={mailPanes.resetWidths} />

      <section className="mail-list-panel">
        <header className="panel-heading">
          <div><h1>{labels.find((label) => label.id === labelId && label.accountId === accountId)?.name ?? folderNames[folder]}</h1><p>{folder === 'scheduled' ? `${visibleLocalDrafts.length.toLocaleString()} queued message${visibleLocalDrafts.length === 1 ? '' : 's'}` : `${page.total.toLocaleString()} conversations${folder === 'drafts' && visibleLocalDrafts.length ? ` · ${visibleLocalDrafts.length.toLocaleString()} editable drafts` : ''}`}</p></div>
          <button className="icon-button" aria-label={mailboxRefreshing ? 'Checking for mail' : 'Check for mail'} title={mailboxRefreshing ? 'Checking for mail' : 'Check for mail'} onClick={refreshMail}><RefreshCw className={mailboxRefreshing ? 'spin' : undefined} size={17} /></button>
        </header>
        <div className="mail-search-shell" ref={searchShellRef}>
          <div className="mail-search">
            <Search size={15} />
            <input aria-label="Search mail" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search offline mail…" />
            {(search || activeSearchFilterCount > 0) && <button className="mail-search-clear" aria-label="Clear mail search" title="Clear search and filters" onClick={() => { setSearch(''); setSearchFilters({}); setSearchFiltersOpen(false) }}><X size={14} /></button>}
            <button className={`mail-search-filter-button ${activeSearchFilterCount ? 'active' : ''}`} aria-expanded={searchFiltersOpen} aria-haspopup="dialog" title="Advanced search filters" onClick={() => setSearchFiltersOpen((open) => !open)}><Filter size={14} /><span>{activeSearchFilterCount || 'Filters'}</span></button>
          </div>
          {searchFiltersOpen && <MailSearchFiltersPanel value={searchFilters} onApply={(next) => { setSearchFilters(next); setSearchFiltersOpen(false) }} onClose={() => setSearchFiltersOpen(false)} />}
        </div>
        {checkedItems.length > 0 && <div className="bulk-mail-toolbar">
          <button className="icon-button" title="Clear selection" onClick={() => setCheckedKeys(new Set())}><X size={16} /></button>
          <strong>{checkedItems.length.toLocaleString()} selected</strong>
          <span className="toolbar-divider" />
          <button className="button ghost small" onClick={() => void applyBulkAction('archive')}><Archive size={15} /> Archive</button>
          <button className="button ghost small" onClick={() => void applyBulkAction('read')}><MailOpen size={15} /> Read</button>
          <button className="button ghost small" onClick={() => void applyBulkAction('star')}><Star size={15} /> Star</button>
          <button className="button ghost small" onClick={() => folder === 'snoozed' ? void unsnoozeMany(checkedItems) : setSnoozeItems(checkedItems)}>{folder === 'snoozed' ? <Inbox size={15} /> : <Clock3 size={15} />} {folder === 'snoozed' ? 'Return now' : 'Snooze'}</button>
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
        <div className="message-list" ref={messageListRef} onContextMenu={(event) => showContextMenu(event, [
          { label: 'New message', icon: Plus, disabled: !accounts.some((account) => !account.archived), action: () => setCompose({}) },
          { label: 'Check for mail', icon: RefreshCw, separatorBefore: true, disabled: syncUnavailable, action: () => startSync(accountId === 'all' ? undefined : accountId) },
          { label: 'Mark visible conversations as read', icon: MailOpen, disabled: !page.items.some((item) => item.unread), action: markVisibleRead }
        ], 'Conversation list')}>
          {visibleLocalDrafts.map((draft) => <button key={`draft:${draft.id}`} className={`message-row local-draft-row ${draft.status === 'failed' ? 'draft-failed' : ''} ${draft.status === 'scheduled' ? 'draft-scheduled' : ''}`} onClick={() => openLocalDraft(draft)} onContextMenu={(event) => showContextMenu(event, [
            { label: ['scheduled', 'send-pending', 'queued'].includes(draft.status) ? 'Cancel delivery and edit' : 'Edit draft', icon: Edit3, action: () => openLocalDraft(draft) },
            ...(['scheduled', 'send-pending', 'queued'].includes(draft.status) ? [{ label: 'Cancel delivery', icon: Undo2, action: () => cancelQueuedDraft(draft) }] satisfies ContextMenuItem[] : []),
            { label: 'Discard draft', icon: Trash2, separatorBefore: true, danger: true, action: () => discardLocalDraft(draft) }
          ], draft.subject || 'Draft')}>
            <span className="avatar draft-avatar">{['scheduled', 'send-pending', 'queued'].includes(draft.status) ? <CalendarClock size={16} /> : <FileText size={16} />}</span>
            <span className="message-copy">
              <span className="message-meta"><strong>{draft.status === 'scheduled' ? 'Scheduled' : draft.status === 'send-pending' ? 'Sending shortly' : draft.status === 'queued' ? 'Outbox' : 'Draft'} · {draft.to.join(', ') || 'No recipients'}</strong><time>{shortDate(draft.deliveryAt ?? draft.updatedAt)}</time></span>
              <span className="message-subject">{draft.subject || '(No subject)'}</span>
              <span className="message-preview">{draft.error || draft.text || 'Empty draft'}</span>
              <span className="message-tags"><em>{draft.status === 'scheduled' && draft.deliveryAt ? `Sends ${new Date(draft.deliveryAt).toLocaleString()}` : draft.status === 'send-pending' ? 'Undo available briefly' : draft.status === 'queued' ? 'Waiting for connection' : draft.status === 'failed' ? 'Save failed' : draft.status === 'local' ? 'Waiting for connection' : 'Editable draft'}</em>{draft.attachmentPaths.length > 0 && <Paperclip size={13} />}</span>
            </span>
          </button>)}
          {page.items.length > 0 && <button className="select-visible-mail" onClick={toggleAllVisible}><CheckSquare size={14} /> {page.items.every((item) => checkedKeys.has(`${item.accountId}:${item.id}`)) ? 'Clear visible selection' : 'Select visible conversations'}</button>}
          {page.items.map((item, index) => {
            const threadKey = `${item.accountId}:${item.id}`
            const listExpanded = expandedListThreadKey === threadKey
            const listDetail = listThreadDetails[threadKey]
            const itemLabels = visibleMailLabels(item.accountId, item.labelIds, labels).slice(0, 3)
            const previous = page.items[index - 1]
            const startsDateGroup = !previous || mailDateGroupKey(previous.lastDate) !== mailDateGroupKey(item.lastDate)
            return <Fragment key={threadKey}>
              {startsDateGroup && <h2 className="mail-date-group"><span>{formatMailDateHeading(item.lastDate)}</span></h2>}
              <div className={`message-thread-stack ${listExpanded ? 'expanded' : ''}`}>
              <div role="button" tabIndex={0} aria-current={selectedKey === threadKey ? 'true' : undefined} className={`message-row ${selectedKey === threadKey ? 'selected' : ''} ${checkedKeys.has(threadKey) ? 'checked' : ''} ${item.unread ? 'unread' : ''}`} onClick={() => openSummary(item)} onDoubleClick={() => openMessageWindow(item)} onKeyDown={(event) => { if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openMessageWindow(item) } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSummary(item) } }} onContextMenu={(event) => showSummaryMenu(event, item)}>
                <input className="message-select" type="checkbox" aria-label={`Select ${item.subject}`} checked={checkedKeys.has(threadKey)} readOnly onClick={(event) => { event.stopPropagation(); toggleChecked(item, index, event.shiftKey) }} />
                <SenderAvatar email={item.senderEmail} name={item.participants[0]} fallbackColor={accounts.find((account) => account.id === item.accountId)?.color} />
                <span className="message-copy">
                  <span className="message-meta"><strong>{item.participants.join(', ') || 'Unknown sender'}</strong><time dateTime={item.lastDate} title={formatMailArrivalTooltip(item.lastDate)}>{formatMailListTime(item.lastDate)}</time></span>
                  <span className="message-subject">{item.subject}</span>
                  <span className="message-preview">{decodeHtmlEntities(item.snippet)}</span>
                  <span className="message-tags">
                    {itemLabels.map((label) => <em className="mail-label-badge" key={label.id} title={label.name}>{label.name}</em>)}
                    {item.snoozedUntil && <em>Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</em>}
                    {item.messageCount > 1 && <><em>{item.messageCount} messages</em><button type="button" className={`thread-list-toggle ${listExpanded ? 'expanded' : ''}`} aria-label={`${listExpanded ? 'Collapse' : 'Expand'} ${item.messageCount} messages in ${item.subject}`} aria-expanded={listExpanded} onClick={(event) => { event.stopPropagation(); void toggleListThread(item) }} onDoubleClick={(event) => event.stopPropagation()}><ChevronDown size={13} /></button></>}
                    {item.hasAttachments && <Paperclip size={13} />}
                  </span>
                </span>
                <span className="row-flags">{item.starred && <Star size={13} fill="currentColor" />}</span>
              </div>
              {listExpanded && <div className="thread-list-region">
                {listThreadLoadingKey === threadKey && !listDetail && <div className="thread-list-loading"><LoaderCircle className="spin" size={14} /> Loading thread…</div>}
                {listDetail && <ThreadListPreview thread={listDetail} selectedMessageId={selectedKey === threadKey ? expandedMessageId : undefined} dateLabel={shortDate} onSelect={(message) => openSummary(item, message.id)} onOpenWindow={(message) => openMessageWindow(item, message.id)} onContextMenu={(event) => showSummaryMenu(event, item)} />}
              </div>}
              </div>
            </Fragment>
          })}
          {!loading && !page.items.length && !visibleLocalDrafts.length && <div className="empty-state"><Search size={28} /><h3>No conversations here</h3><p>Try another mailbox or search.</p></div>}
          {loading && <div className="empty-state"><LoaderCircle className="spin" size={28} /><p>Loading local mail…</p></div>}
          {page.nextCursor && <div className="mail-scroll-sentinel" ref={loadMoreSentinelRef} aria-live="polite">{loadingMore ? <><LoaderCircle className="spin" size={17} /><span>Loading more…</span></> : loadMoreError ? <button className="text-button" onClick={() => void loadMore()}>Couldn’t load more · Retry</button> : null}</div>}
        </div>
      </section>

      <MailPaneSeparator pane="list" value={mailPanes.widths.list} onPointerDown={mailPanes.startResize} onKeyDown={mailPanes.resizeWithKeyboard} onReset={mailPanes.resetWidths} />

      <section className="reader-panel">
        {selected && thread ? <>
          <div className="reader-toolbar">
            <div className="reader-toolbar-primary">
              <button className="reader-toolbar-action" disabled={selectedAccount?.archived} title="Reply" onClick={() => setCompose({ reply: thread })}><Reply size={17} /><span>Reply</span></button>
              <button className="reader-toolbar-action" disabled={selectedAccount?.archived} title="Reply all" onClick={() => setCompose({ reply: thread, replyAll: true })}><ReplyAll size={17} /><span>Reply all</span></button>
              <button className="reader-toolbar-action" disabled={selectedAccount?.archived} title={selected.unread ? 'Mark read' : 'Mark unread'} onClick={() => void applyAction(selected.unread ? 'read' : 'unread')}>{selected.unread ? <MailOpen size={17} /> : <Mail size={17} />}<span>{selected.unread ? 'Read' : 'Unread'}</span></button>
              <button className="reader-toolbar-action" disabled={selectedAccount?.archived || selected.trashed} title={selected.labelIds.includes('INBOX') ? 'Archive' : 'Move to inbox'} onClick={() => void applyAction(selected.labelIds.includes('INBOX') ? 'archive' : selected.labelIds.includes('SPAM') ? 'move' : 'unarchive', undefined, undefined, true, selected.labelIds.includes('SPAM') ? 'INBOX' : undefined)}>{selected.labelIds.includes('INBOX') ? <Archive size={17} /> : <Inbox size={17} />}<span>{selected.labelIds.includes('INBOX') ? 'Archive' : 'Inbox'}</span></button>
              <button className="reader-toolbar-action" disabled={selectedAccount?.archived} title={selected.trashed ? 'Restore from Trash' : 'Move to Trash'} onClick={() => void applyAction(selected.trashed ? 'untrash' : 'trash')}>{selected.trashed ? <Undo2 size={17} /> : <Trash2 size={17} />}<span>{selected.trashed ? 'Restore' : 'Trash'}</span></button>
              <span className="toolbar-divider" />
              <button className={`reader-toolbar-action ${selected.starred ? 'active' : ''}`} disabled={selectedAccount?.archived} title={selected.starred ? 'Unstar' : 'Star'} onClick={() => void applyAction(selected.starred ? 'unstar' : 'star')}><Star size={17} fill={selected.starred ? 'currentColor' : 'none'} /><span>{selected.starred ? 'Unstar' : 'Star'}</span></button>
            </div>
            <div className="reader-toolbar-secondary">
              {!remoteImages && <button className="button ghost small" onClick={() => void loadRemoteImages()}><Image size={15} /> Load remote images</button>}
              <button className="icon-button" aria-label="More message actions" title="More" onClick={showReaderMoreMenu}><MoreVertical size={18} /></button>
            </div>
          </div>
          <article className="message-reader mail-thread" onContextMenu={(event) => showSummaryMenu(event, selected)}>
            <header><div className="reader-labels">{selectedLabels.slice(0, 5).map((label) => <span key={label.id}>{label.name}</span>)}</div><h2>{thread.subject}</h2></header>
            {thread.messages.map((message) => <ThreadMessageAccordion
              key={message.id}
              message={message}
              expanded={expandedMessageId === message.id}
              onToggle={() => setExpandedMessageId((current) => current === message.id ? undefined : message.id)}
              onReply={selectedAccount?.archived ? undefined : () => setCompose({ reply: replyThreadFor(message) })}
              onContextMenu={(event) => showProviderMessageMenu(event, message)}
            >
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id} onContextMenu={(event) => showAttachmentMenu(event, message, attachment)}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)}</small></span><button className="icon-button" title="Open" onClick={() => void openAttachment(message, attachment)}><Download size={16} /></button><button className="button ghost small" onClick={() => void saveAttachment(message, attachment)}>Save as</button></div>)}</div>}
            </ThreadMessageAccordion>)}
            {!selectedAccount?.archived && <div className="quick-actions"><button className="button ghost" onClick={() => setCompose({ reply: thread })}><Reply size={16} /> Reply</button><button className="button ghost" onClick={() => setCompose({ reply: thread, replyAll: true })}><ReplyAll size={16} /> Reply all</button></div>}
          </article>
        </> : <div className="empty-state grow">{threadLoading ? <><LoaderCircle className="spin" size={34} /><h3>Opening conversation</h3><p>Loading the selected thread from local storage.</p></> : accounts.some((item) => item.status === 'syncing') ? <><LoaderCircle className="spin" size={34} /><h3>Downloading your mailbox</h3><p>Conversations appear here as soon as they are available.</p></> : <><Inbox size={34} /><h3>Select a conversation</h3><p>Choose a conversation to read it here.</p></>}</div>}
      </section>

      {pending.length > 0 && <div className="undo-toast"><span>{pending.length > 1 ? `${pending.length} mail changes queued` : 'Mail change queued'}</span><button onClick={() => void undo()}><Undo2 size={15} /> Undo</button><button onClick={() => setPending([])}>Dismiss</button></div>}
      {pendingSend && <div className="undo-toast send-undo-toast"><span>Message will send shortly</span><button onClick={() => void undoSend()}><Undo2 size={15} /> Undo Send</button><button onClick={() => setPendingSend(undefined)}>Dismiss</button></div>}
      {compose && <MailComposeModal accounts={accounts.filter((account) => !account.archived)} draft={compose.draft} replyTo={compose.reply} replyAll={compose.replyAll} forward={compose.forward} onClose={() => { setCompose(undefined); if (folder === 'drafts' || folder === 'scheduled') void loadDrafts() }} onSent={(result) => { if (result.status === 'send-pending') setPendingSend(result); void loadPage(); void loadDrafts() }} onToast={onToast} />}
      {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
      {settingsAccount && <MailAccountSettingsModal account={settingsAccount} onSaved={(updated) => { setAccounts((items) => items.map((item) => item.id === updated.id ? updated : item)); setSettingsAccount(updated) }} onClose={() => setSettingsAccount(undefined)} onToast={onToast} />}
      {organizeMode && <MailOrganizeModal mode={organizeMode} items={checkedItems} accounts={accounts} labels={labels} onApply={applyOrganizeRequests} onClose={() => setOrganizeMode(undefined)} />}
      {snoozeItems && <MailSnoozeModal count={snoozeItems.length} onApply={(until) => applySnooze(snoozeItems, until)} onClose={() => setSnoozeItems(undefined)} />}
      {rulesOpen && <MailRulesModal accounts={accounts} labels={labels} onToast={onToast} onClose={() => setRulesOpen(false)} />}
      {sourceViewer && <MailMessageSourceModal {...sourceViewer} onClose={() => setSourceViewer(undefined)} />}
    </div>
  )
}
