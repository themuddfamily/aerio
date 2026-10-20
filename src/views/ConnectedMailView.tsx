import MessageToolbar from '../components/MessageToolbar'
import {
  Archive, AtSign, CalendarClock, CheckSquare, ChevronDown, ChevronRight, Clock3, Copy, Download, Edit3, ExternalLink, Eye, FileText, Filter, FolderInput, Forward, Inbox, LoaderCircle, Mail, MailOpen,
  MoreVertical, Paperclip, Pause, Pin, PinOff, Play, Plus, RefreshCw, Reply, ReplyAll, Search, Send, Settings2,
  Star, Tag, Tags, Trash2, Undo2, UserPlus, Users, WifiOff, X
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mailboxRestriction } from '../lib/mailbox-owners'
import MailComposeModal from '../components/MailComposeModal'
import MailAccountSetupModal from '../components/MailAccountSetupModal'
import MailAccountSettingsModal from '../components/MailAccountSettingsModal'
import MailAttachmentsModal from '../components/MailAttachmentsModal'
import MailOrganizeModal from '../components/MailOrganizeModal'
import MailMessageSourceModal from '../components/MailMessageSourceModal'
import MailRulesModal from '../components/MailRulesModal'
import MailFolderManagerModal from '../components/MailFolderManagerModal'
import { MailFavoritesSidebar, MailFolderDisplayModal, MailFolderTreeSidebar, favoriteMenuItems, folderPreferenceMenuItems, useMailFolderPreferences } from '../components/MailSidebarFolders'
import { folderKey } from '../lib/mail-folder-preferences'
import { LocalFoldersSidebar, MailImportModal, MailLocalTransferModal, localFoldersAccountOf } from '../components/MailLocalFolders'
import { isLocalFoldersAccount } from '../lib/local-folders'
import { HardDrive, Import as ImportIcon } from 'lucide-react'
import MailSearchFiltersPanel from '../components/MailSearchFiltersPanel'
import { MailSavedSearchList, MailSaveSearchModal, savedSearchFromView, useMailSavedSearches, type MailSearchView } from '../components/MailSavedSearches'
import { attachmentSearchStatus } from '../lib/mail-attachment-text'
import { savedSearchMatchesView } from '../lib/mail-saved-search'
import { mailSearchQueryError } from '../lib/mail-search-query'
import { Bookmark, Layers, Sparkles, Zap } from 'lucide-react'
import InboxCategoryTabs, { useInboxCategories } from '../components/InboxCategoryTabs'
import MailCategoryAssignModal from '../components/MailCategoryAssignModal'
import type { MailCategoryId } from '../mail-category-types'
import MailAiSearchDialog from '../components/MailAiSearchDialog'
import { aiFeatureAvailable, useAiAssistantStatus } from '../lib/use-ai-assistant'
import { MailQuickActionButtons, MailQuickActionsModal, useMailQuickActions } from '../components/MailQuickActions'
import { quickActionTargets, summarizeQuickActionRun } from '../lib/mail-quick-actions'
import { quickActionCommandId } from '../lib/keymap'
import { useKeymap, useKeymapCommands } from '../lib/use-keymap'
import type { MailQuickAction, MailSavedSearch, MailSavedSearchInput } from '../mail-types'
import MailSnoozeModal from '../components/MailSnoozeModal'
import { MailReplyWatchesModal } from '../components/MailReplyWatches'
import { MailMergeJobsModal } from '../components/MailMerge'
import SenderAvatar from '../components/SenderAvatar'
import ThreadListPreview from '../components/ThreadListPreview'
import ThreadMessageAccordion from '../components/ThreadMessageAccordion'
import { useMailMessageTools } from '../components/MailMessageTools'
import { useThreadExpansion } from '../lib/use-thread-expansion'
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
  MailAccountUnreadCounts,
  MailFolderUnreadCounts,
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
import { isLocalOnlyMailAction, mailListGroupStart, pendingOperationsMessage, pinActionFor, threadIdsByAccount } from '../lib/mail-pins'
import { isMailboxRefreshing, shouldShowDetailedSync } from '../lib/mail-sync'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import { MailFolderOfflineModal, MailOfflineContentNotice, MailOfflineListFooter, MailSearchCoverageNotice, mailboxOfflineTarget, offlineFolderMenuItems, type OfflineFolderTarget } from '../components/MailOfflineSync'
import { confirmServerNotesRemoval } from '../lib/server-notes-removal'

interface ConnectedMailViewProps {
  onToast(message: string): void
  composeRequest?: { id: number; initialTo?: string }
  searchRequest?: { id: number; query: string }
  quickActionRequest?: { id: number; quickActionId: string }
  /** Command-palette request to pin or unpin the checked conversations, or the open one. */
  pinRequest?: { id: number; action: 'pin' | 'unpin' }
}

const emptyPage: MailPage = { items: [], total: 0 }
const emptyUnreadCounts: MailFolderUnreadCounts = {
  inbox: 0, starred: 0, important: 0, sent: 0, drafts: 0, scheduled: 0,
  snoozed: 0, archive: 0, spam: 0, trash: 0, all: 0
}
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

export default function ConnectedMailView({ onToast, composeRequest = { id: 0 }, searchRequest = { id: 0, query: '' }, quickActionRequest = { id: 0, quickActionId: '' }, pinRequest = { id: 0, action: 'pin' } }: ConnectedMailViewProps) {
  const { showContextMenu } = useContextMenu()
  const mailPanes = useResizableMailPanes()
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [page, setPage] = useState<MailPage>(emptyPage)
  const [folderUnreadCounts, setFolderUnreadCounts] = useState<MailFolderUnreadCounts>(emptyUnreadCounts)
  const [accountUnreadCounts, setAccountUnreadCounts] = useState<MailAccountUnreadCounts>({})
  const [localDrafts, setLocalDrafts] = useState<MailDraftRecord[]>([])
  const [folder, setFolder] = useState<NonNullable<MailQuery['folder']>>('inbox')
  const [labelId, setLabelId] = useState<string>()
  const folderPrefs = useMailFolderPreferences(onToast)
  const [folderDisplay, setFolderDisplay] = useState<{ label: MailLabel; focusAlias?: boolean }>()
  // Offline scope (E36): folder override dialog and the active server search.
  const [offlineFolder, setOfflineFolder] = useState<OfflineFolderTarget>()
  const [serverSearch, setServerSearch] = useState<{ id: string; matched: number }>()
  const [accountId, setAccountId] = useState<string>('all')
  // Inbox category tabs (E33) only split the Inbox; pinned conversations still list first within a tab.
  const inboxCategories = useInboxCategories(onToast, accountId)
  const [inboxTab, setInboxTab] = useState<MailCategoryId>('primary')
  const [categoryItems, setCategoryItems] = useState<MailThreadSummary[]>()
  const inboxTabsShown = folder === 'inbox' && !labelId && inboxCategories.active
  const activeInboxTab: MailCategoryId = inboxTabsShown && inboxCategories.tabs.some((tab) => tab.id === inboxTab) ? inboxTab : 'primary'
  const [search, setSearch] = useState('')
  const [searchFilters, setSearchFilters] = useState<MailSearchFilters>({})
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false)
  const savedSearches = useMailSavedSearches(onToast)
  const [savingSearch, setSavingSearch] = useState<MailSavedSearchInput>()
  const quickActions = useMailQuickActions(onToast)
  const [quickActionsOpen, setQuickActionsOpen] = useState(false)
  // Requests that existed before this view mounted were meant for an earlier instance.
  const handledQuickActionRequest = useRef(quickActionRequest.id)
  const handledPinRequest = useRef(pinRequest.id)
  const [selectedKey, setSelectedKey] = useState('')
  const [thread, setThread] = useState<MailThreadDetail>()
  const [expandedMessageId, setExpandedMessageId] = useState<string>()
  const expansion = useThreadExpansion(thread, expandedMessageId, setExpandedMessageId)
  const messageTools = useMailMessageTools({ accounts, onToast, collapseAll: expansion.collapseAll, expandAll: expansion.expandAll, onUpdated: (message, local) => setThread((current) => current && ({ ...current, messages: current.messages.map((item) => item.id === message.id ? { ...item, local } : item) })), onReplyWithText: (message, text) => { const reply = replyThreadFor(message); if (reply) setCompose({ reply, initialBody: text }) } })
  const aiStatus = useAiAssistantStatus()
  const [aiSearchOpen, setAiSearchOpen] = useState(false)
  const [threadLoading, setThreadLoading] = useState(false)
  const [expandedListThreadKey, setExpandedListThreadKey] = useState<string>()
  const [listThreadDetails, setListThreadDetails] = useState<Record<string, MailThreadDetail>>({})
  const [listThreadLoadingKey, setListThreadLoadingKey] = useState<string>()
  const [sync, setSync] = useState<SyncProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState(false)
  const [compose, setCompose] = useState<{ draft?: MailDraftRecord; reply?: MailThreadDetail; replyAll?: boolean; forward?: boolean; initialTo?: string; initialBody?: string }>()
  const [pending, setPending] = useState<PendingOperation[]>([])
  const [pendingSend, setPendingSend] = useState<MailDraftResult>()
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [organizeMode, setOrganizeMode] = useState<'move' | 'label'>()
  const [snoozeItems, setSnoozeItems] = useState<MailThreadSummary[]>()
  const [rulesOpen, setRulesOpen] = useState(false)
  const [replyWatchesOpen, setReplyWatchesOpen] = useState(false)
  const [mailMergesOpen, setMailMergesOpen] = useState(false)
  const mergeStatuses = useRef(new Map<string, string>())
  const [foldersOpen, setFoldersOpen] = useState<string | true>()
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [sourceViewer, setSourceViewer] = useState<{ mode: 'headers' | 'source'; subject: string; content: string }>()
  const [remoteImages, setRemoteImages] = useState(false)
  const [accountSetup, setAccountSetup] = useState(false)
  const [settingsAccount, setSettingsAccount] = useState<MailAccountSummary>()
  const [importOpen, setImportOpen] = useState(false)
  const [localTransferOpen, setLocalTransferOpen] = useState(false)
  const localAccount = localFoldersAccountOf(accounts)
  // Local Folders cannot send, so compose and reply only use server accounts.
  const sendableAccounts = accounts.filter((account) => !account.archived && !isLocalFoldersAccount(account))
  const reloadLabels = useCallback(() => { void window.aerio.mail.mail.labels().then(setLabels).catch(() => undefined) }, [])
  const handledComposeRequest = useRef(0)
  const requestedMessage = useRef<{ threadKey: string; messageId: string } | undefined>(undefined)
  const pageRequest = useRef(0)
  const unreadCountRequest = useRef(0)
  const accountUnreadCountRequest = useRef(0)
  const loadingMoreRef = useRef(false)
  const messageListRef = useRef<HTMLDivElement>(null)
  const searchShellRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const selected = page.items.find((item) => `${item.accountId}:${item.id}` === selectedKey)
  const selectedAccount = accounts.find((item) => item.id === selected?.accountId)
  // Read-only shared folders and removed mailboxes (E40); the worker refuses these changes too.
  const selectedRestriction = selected ? mailboxRestriction(labels, selected.accountId, selected.labelIds) : undefined
  const selectedLabels = selected ? visibleMailLabels(selected.accountId, selected.labelIds, labels) : []
  const checkedItems = useMemo(() => page.items.filter((item) => checkedKeys.has(`${item.accountId}:${item.id}`)), [checkedKeys, page.items])
  const activeSearchFilterCount = Object.values(searchFilters).filter((value) => value !== undefined && value !== '').length
  const searchError = useMemo(() => mailSearchQueryError(search), [search])
  const searchView: MailSearchView = { accountId, folder, labelId, query: search, filters: searchFilters }
  const activeSavedSearch = savedSearches.searches.find((item) => savedSearchMatchesView(item, searchView))

  useEffect(() => {
    if (!searchRequest.id) return
    setSearch(searchRequest.query)
    setSearchFiltersOpen(false)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [searchRequest.id, searchRequest.query])
  const accountKeys = accounts.map((item) => item.id).join('\n')

  const refreshAccounts = useCallback(async () => {
    const next = await window.aerio.mail.accounts.list()
    setAccounts(next)
    return next
  }, [])

  const loadUnreadCounts = useCallback(async () => {
    const request = ++unreadCountRequest.current
    if (!accounts.length) {
      setFolderUnreadCounts(emptyUnreadCounts)
      return
    }
    try {
      const counts = await window.aerio.mail.mail.unreadCounts(accountId === 'all' ? undefined : [accountId])
      if (request === unreadCountRequest.current) setFolderUnreadCounts(counts)
    } catch (error) {
      if (request === unreadCountRequest.current) onToast(error instanceof Error ? error.message : 'Unread counts could not be loaded')
    }
  }, [accountId, accounts.length, onToast])

  const loadAccountUnreadCounts = useCallback(async () => {
    const request = ++accountUnreadCountRequest.current
    if (!accountKeys) {
      setAccountUnreadCounts({})
      return
    }
    try {
      const counts = await window.aerio.mail.mail.accountUnreadCounts()
      if (request === accountUnreadCountRequest.current) setAccountUnreadCounts(counts)
    } catch (error) {
      if (request === accountUnreadCountRequest.current) onToast(error instanceof Error ? error.message : 'Account unread counts could not be loaded')
    }
  }, [accountKeys, onToast])

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

  const requestMailPage = useCallback((cursor?: string) => window.aerio.mail.mail.list(serverSearch ? {
    // Server matches span the whole mailbox and may be header rows the local index cannot match.
    folder: 'all',
    accountIds: accountId === 'all' ? undefined : [accountId],
    serverSearchId: serverSearch.id,
    cursor,
    pageSize: 50
  } : {
    folder,
    accountIds: accountId === 'all' ? undefined : [accountId],
    labelId,
    search: search.trim() || undefined,
    filters: activeSearchFilterCount ? searchFilters : undefined,
    category: inboxTabsShown ? activeInboxTab : undefined,
    cursor,
    pageSize: 50
  }), [accountId, folder, labelId, search, searchFilters, activeSearchFilterCount, inboxTabsShown, activeInboxTab, serverSearch])

  const loadPage = useCallback(async () => {
    const request = ++pageRequest.current
    loadingMoreRef.current = false
    setLoadingMore(false)
    setLoadMoreError(false)
    // An invalid search shows its validation message instead of stale or unfiltered results.
    if (!accounts.length || searchError) {
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
  }, [accounts.length, onToast, requestMailPage, searchError])

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

  // Sends interrupted by a restart wait for review; say so once at startup.
  useEffect(() => {
    void window.aerio.mail.merge?.list().then((jobs) => {
      for (const job of jobs) mergeStatuses.current.set(job.id, job.status)
      const review = jobs.filter((job) => job.status === 'needs-review').length
      if (review) onToast(`${review === 1 ? 'A mail merge needs' : `${review} mail merges need`} review — open Mail merges`)
    }).catch(() => undefined)
  }, [onToast])

  useEffect(() => {
    const unsubscribe = window.aerio.mail.onEvent((event) => {
      if (event.type === 'accounts-changed') setAccounts(event.payload)
      if (event.type === 'sync-progress') {
        setSync((items) => [...items.filter((item) => item.accountId !== event.payload.accountId), event.payload])
        if (event.payload.phase === 'complete') void window.aerio.mail.mail.labels().then(setLabels).catch(() => undefined)
      }
      if (event.type === 'mail-changed') {
        void loadPage()
        void loadUnreadCounts()
        void loadAccountUnreadCounts()
      }
      if (event.type === 'operation' && event.payload.status === 'failed') onToast(event.payload.error ?? 'The mail provider rejected the change')
      // Pins are applied locally and succeed at once; their undo stays offered until it expires.
      if (event.type === 'operation' && event.payload.status === 'succeeded' && !isLocalOnlyMailAction(event.payload.kind)) setPending((items) => items.filter((item) => item.id !== event.payload.id))
      if (event.type === 'draft-delivery') {
        setPendingSend((current) => current?.id === event.payload.id ? undefined : current)
        if (event.payload.status === 'sent') onToast('Message sent')
        if (event.payload.status === 'failed') onToast(event.payload.error ?? 'Message could not be sent')
        void loadDrafts()
      }
      if (event.type === 'mail-merge') {
        if (event.payload.status === 'needs-review' && mergeStatuses.current.get(event.payload.id) !== 'needs-review') onToast(`Mail merge “${event.payload.name}” needs review: a send may not have gone out`)
        mergeStatuses.current.set(event.payload.id, event.payload.status)
      }
      if (event.type === 'connectivity' && !event.payload.online) onToast('Offline — changes will be sent when you reconnect')
    })
    return unsubscribe
  }, [loadAccountUnreadCounts, loadDrafts, loadPage, loadUnreadCounts, onToast])

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

  useEffect(() => setCheckedKeys(new Set()), [accountId, folder, labelId, search, searchFilters, activeInboxTab])
  useEffect(() => setServerSearch(undefined), [accountId, folder, labelId, search, searchFilters, activeInboxTab])

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

  useEffect(() => { void loadUnreadCounts() }, [loadUnreadCounts])

  useEffect(() => { void loadAccountUnreadCounts() }, [loadAccountUnreadCounts])

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
    if (!composeRequest.id || handledComposeRequest.current === composeRequest.id) return
    handledComposeRequest.current = composeRequest.id
    if (sendableAccounts.length) setCompose({ initialTo: composeRequest.initialTo })
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
      // Undo newest first so each operation's snapshot restores onto the state it captured (multi-step quick actions).
      const restored: boolean[] = []
      for (const operation of [...pending].reverse()) restored.push(await window.aerio.mail.mail.undo(operation.id))
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
    const mode = keep ? 'archive' : window.confirm(account.provider === 'pop3'
      ? `Delete all mail stored for ${account.email} on this computer? The POP3 server is not changed, but messages already removed from it, plus your local Sent mail and folders, cannot be recovered.`
      : `Delete all downloaded mail for ${account.email}? The provider mailbox itself will not be changed.`) ? 'delete' : undefined
    if (!mode) return
    // Exchange Notes (docs/server-notes.md) are removed with the account; offer to keep a Local copy.
    if (account.provider === 'exchange' && !(await confirmServerNotesRemoval(account.id, account.email))) return
    try {
      await window.aerio.mail.accounts.disconnect(account.id, mode)
      await refreshAccounts()
      onToast('Account disconnected')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The account could not be disconnected')
    }
  }

  const removeLocalFolders = async (account: MailAccountSummary) => {
    if (!window.confirm('Remove Local Folders and permanently delete every message stored in them on this computer? This cannot be undone.')) return
    try {
      await window.aerio.mail.accounts.disconnect(account.id, 'delete')
      await refreshAccounts()
      reloadLabels()
      if (accountId === account.id) selectAccount('all')
      onToast('Local Folders removed')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Local Folders could not be removed')
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

  // Quick actions run on the checked conversations, or the open conversation when nothing is checked.
  const runQuickAction = async (quickAction: MailQuickAction, items = checkedItems.length ? checkedItems : selected ? [selected] : []) => {
    if (!items.length) {
      onToast(`Select a conversation to run “${quickAction.name}”`)
      return
    }
    try {
      const result = await window.aerio.mail.quickActions.run(quickAction.id, quickActionTargets(items))
      if (result.operations.length) setPending(result.operations)
      if (items === checkedItems) setCheckedKeys(new Set())
      await loadPage()
      onToast(summarizeQuickActionRun(quickAction, result, accounts))
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The quick action could not be run')
    }
  }

  useEffect(() => {
    if (!quickActionRequest.id || handledQuickActionRequest.current === quickActionRequest.id) return
    handledQuickActionRequest.current = quickActionRequest.id
    const quickAction = quickActions.quickActions.find((item) => item.id === quickActionRequest.quickActionId)
    if (quickAction) void runQuickAction(quickAction)
    else onToast('That quick action no longer exists')
    // Only a new palette request triggers a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickActionRequest.id])

  // Mail shortcuts (src/lib/keymap.ts) act on the checked conversations, or the open one; they never fire in text fields or dialogs.
  const { label: keyLabel } = useKeymap()
  const shortcutAction = (action: MailActionKind | ((item: MailThreadSummary) => MailActionKind)) => () => {
    const items = checkedItems.length ? checkedItems : selected ? [selected] : []
    if (!items.length) return
    const kind = typeof action === 'function' ? action(items[0]) : action
    if (checkedItems.length) void applyBulkAction(kind)
    else void applyAction(kind, items[0].accountId, [items[0].id])
  }
  useKeymapCommands('mail', {
    'mail.reply': () => { if (selected && !selected.draft) void composeFromSummary(selected) },
    'mail.replyAll': () => { if (selected && !selected.draft) void composeFromSummary(selected, false, true) },
    'mail.forward': () => { if (selected) void composeFromSummary(selected, true) },
    'mail.markRead': shortcutAction('read'),
    'mail.markUnread': shortcutAction('unread'),
    'mail.toggleStar': shortcutAction((item) => item.starred ? 'unstar' : 'star'),
    'mail.archive': shortcutAction('archive'),
    'mail.trash': shortcutAction('trash'),
    'mail.openWindow': () => { if (selected) openMessageWindow(selected) },
    'mail.refresh': () => refreshMail(),
    ...Object.fromEntries(quickActions.quickActions.flatMap((quickAction) => quickAction.shortcut
      ? [[quickActionCommandId(quickAction.shortcut), () => void runQuickAction(quickAction)]] : []))
  }, { blockInTextEntry: true, ignoreDialogs: true })

  // Pin state is local-only, so archived (read-only) accounts can still be pinned.
  const togglePin = async (items: MailThreadSummary[], action = pinActionFor(items)) => {
    if (!items.length) {
      onToast(`Select a conversation to ${action}`)
      return
    }
    try {
      const operations: PendingOperation[] = []
      for (const [targetAccount, threadIds] of threadIdsByAccount(items)) operations.push(await window.aerio.mail.mail.action({ accountId: targetAccount, threadIds, action }))
      setPending(operations)
      if (items === checkedItems) setCheckedKeys(new Set())
      await loadPage()
    } catch (error) {
      onToast(error instanceof Error ? error.message : `The conversation could not be ${action === 'pin' ? 'pinned' : 'unpinned'}`)
    }
  }

  useEffect(() => {
    if (!pinRequest.id || handledPinRequest.current === pinRequest.id) return
    handledPinRequest.current = pinRequest.id
    void togglePin(checkedItems.length ? checkedItems : selected ? [selected] : [], pinRequest.action)
    // Only a new palette request triggers a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinRequest.id])

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
      expansion.focus(messageId)
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

  function openSavedSearch(item: MailSavedSearch) {
    setAccountId(item.accountId && accounts.some((account) => account.id === item.accountId) ? item.accountId : 'all')
    setFolder(item.folder)
    setLabelId(item.labelId)
    setSearch(item.query)
    setSearchFilters(item.filters)
    setSearchFiltersOpen(false)
  }

  async function replaceSavedSearch(item: MailSavedSearch) {
    try {
      await savedSearches.save(savedSearchFromView(searchView, item.name, item.id))
      onToast(`Updated “${item.name}”`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The saved search could not be updated')
    }
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
    const changeLocked = readOnly || Boolean(mailboxRestriction(labels, item.accountId, item.labelIds))
    const inInbox = item.labelIds.includes('INBOX')
    const inSpam = item.labelIds.includes('SPAM')
    return [
      { label: 'Open conversation', icon: MailOpen, action: () => openSummary(item) },
      { label: 'Open in new window', icon: ExternalLink, shortcut: keyLabel('mail.openWindow'), action: () => openMessageWindow(item) },
      { label: 'Reply', icon: Reply, shortcut: keyLabel('mail.reply'), separatorBefore: true, disabled: readOnly || item.draft, action: () => composeFromSummary(item) },
      { label: 'Reply all', icon: ReplyAll, shortcut: keyLabel('mail.replyAll'), disabled: readOnly || item.draft, action: () => composeFromSummary(item, false, true) },
      { label: 'Forward', icon: Forward, shortcut: keyLabel('mail.forward'), disabled: readOnly, action: () => composeFromSummary(item, true) },
      { label: item.unread ? 'Mark as read' : 'Mark as unread', icon: item.unread ? MailOpen : Mail, shortcut: keyLabel(item.unread ? 'mail.markRead' : 'mail.markUnread'), separatorBefore: true, disabled: changeLocked, action: () => applyAction(item.unread ? 'read' : 'unread', item.accountId, [item.id]) },
      { label: item.starred ? 'Remove star' : 'Add star', icon: Star, shortcut: keyLabel('mail.toggleStar'), checked: item.starred, disabled: changeLocked, action: () => applyAction(item.starred ? 'unstar' : 'star', item.accountId, [item.id]) },
      { label: item.pinned ? 'Unpin conversation' : 'Pin to top', icon: item.pinned ? PinOff : Pin, checked: Boolean(item.pinned), action: () => togglePin(checkedKeys.has(`${item.accountId}:${item.id}`) ? checkedItems : [item], item.pinned ? 'unpin' : 'pin') },
      ...(inboxCategories.config ? [{ label: 'Move to inbox tab…', icon: Layers, action: () => setCategoryItems(checkedKeys.has(`${item.accountId}:${item.id}`) ? checkedItems : [item]) }] : []),
      { label: item.important ? 'Mark as not important' : 'Mark as important', icon: Tag, checked: item.important, disabled: changeLocked, action: () => applyAction(item.important ? 'unimportant' : 'important', item.accountId, [item.id]) },
      ...(!item.trashed ? [{ label: inInbox ? 'Archive' : 'Move to inbox', icon: inInbox ? Archive : Inbox, shortcut: inInbox ? keyLabel('mail.archive') : undefined, separatorBefore: true, disabled: changeLocked, action: () => applyAction(inInbox ? 'archive' : inSpam ? 'move' : 'unarchive', item.accountId, [item.id], true, inSpam ? 'INBOX' : undefined) }] satisfies ContextMenuItem[] : []),
      { label: 'Move to…', icon: FolderInput, disabled: changeLocked, action: () => { setCheckedKeys(new Set([`${item.accountId}:${item.id}`])); setOrganizeMode('move') } },
      { label: 'Manage labels…', icon: Tags, disabled: readOnly || accounts.find((account) => account.id === item.accountId)?.provider !== 'gmail', action: () => { setCheckedKeys(new Set([`${item.accountId}:${item.id}`])); setOrganizeMode('label') } },
      { label: item.snoozedUntil ? 'Return to Inbox now' : 'Snooze…', icon: Clock3, disabled: changeLocked, action: () => item.snoozedUntil ? unsnooze(item) : setSnoozeItems([item]) },
      { label: item.trashed ? 'Restore from Trash' : 'Move to Trash', icon: Trash2, shortcut: item.trashed ? undefined : keyLabel('mail.trash'), danger: !item.trashed, disabled: changeLocked, action: () => applyAction(item.trashed ? 'untrash' : 'trash', item.accountId, [item.id]) },
      ...quickActions.quickActions.map((quickAction, index): ContextMenuItem => ({
        label: `Quick action: ${quickAction.name}`, icon: Zap, separatorBefore: index === 0, disabled: changeLocked,
        shortcut: quickAction.shortcut ? keyLabel(quickActionCommandId(quickAction.shortcut)) : undefined,
        action: () => runQuickAction(quickAction, checkedKeys.has(`${item.accountId}:${item.id}`) ? checkedItems : [item])
      })),
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
    const changeLocked = readOnly || Boolean(selectedRestriction)
    const canManageLabels = selectedAccount?.provider === 'gmail' && !readOnly
    const selectForOrganizing = (mode: 'move' | 'label') => {
      setCheckedKeys(new Set([`${selected.accountId}:${selected.id}`]))
      setOrganizeMode(mode)
    }
    showContextMenu(event, [
      { label: 'Open in new window', icon: ExternalLink, action: () => openMessageWindow(selected, message.id) },
      { label: 'Reply all', icon: ReplyAll, shortcut: keyLabel('mail.replyAll'), disabled: readOnly, action: () => setCompose({ reply: thread, replyAll: true }) },
      { label: 'Forward', icon: Forward, shortcut: keyLabel('mail.forward'), disabled: readOnly, action: () => setCompose({ reply: thread, forward: true }) },
      { label: selected.important ? 'Mark as not important' : 'Mark as important', icon: Tag, checked: selected.important, separatorBefore: true, disabled: changeLocked, action: () => applyAction(selected.important ? 'unimportant' : 'important', selected.accountId, [selected.id]) },
      { label: 'Move to…', icon: FolderInput, disabled: changeLocked, action: () => selectForOrganizing('move') },
      { label: 'Manage tags / labels…', icon: Tags, disabled: !canManageLabels, action: () => selectForOrganizing('label') },
      { label: selected.snoozedUntil ? 'Return to Inbox now' : 'Snooze…', icon: Clock3, disabled: changeLocked, action: () => selected.snoozedUntil ? unsnooze(selected) : setSnoozeItems([selected]) },
      { label: 'View message headers', icon: AtSign, separatorBefore: true, action: () => viewMessageData(message, 'headers') },
      { label: 'View message source', icon: FileText, action: () => viewMessageData(message, 'source') },
      { label: 'Copy subject', icon: Copy, separatorBefore: true, action: () => copyText(selected.subject) },
      ...messageTools.items(message),
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
    if (event.type === 'contextmenu' && (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a[href], img[src]')))) return
    const replyThread = replyThreadFor(message)
    showContextMenu(event, [
      { label: 'Reply', icon: Reply, disabled: selectedAccount?.archived || isLocalFoldersAccount(selectedAccount) || !replyThread, action: () => setCompose({ reply: replyThread }) },
      { label: 'Reply all', icon: ReplyAll, disabled: selectedAccount?.archived || isLocalFoldersAccount(selectedAccount) || !replyThread, action: () => setCompose({ reply: replyThread, replyAll: true }) },
      { label: 'Forward', icon: Forward, disabled: selectedAccount?.archived || isLocalFoldersAccount(selectedAccount) || !replyThread, action: () => setCompose({ reply: replyThread, forward: true }) },
      ...(selected ? summaryMenu(selected).slice(6, -2) : []),
      ...messageTools.items(message),
      { label: 'View message headers', icon: AtSign, separatorBefore: true, action: () => viewMessageData(message, 'headers') },
      { label: 'View message source', icon: FileText, action: () => viewMessageData(message, 'source') },
      ...message.attachments.map((attachment) => ({ label: `Save attachment: ${attachment.filename}`, icon: Download, action: () => saveAttachment(message, attachment) })),
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
      { label: 'New message', icon: Plus, disabled: account ? account.archived || isLocalFoldersAccount(account) : !sendableAccounts.length, action: () => setCompose({}) },
      { label: 'Check for mail', icon: RefreshCw, separatorBefore: true, disabled: account?.archived || isLocalFoldersAccount(account), action: () => startSync(account?.id) },
      ...(account && progress ? [{ label: progress.phase === 'paused' ? 'Resume sync' : 'Pause sync', icon: progress.phase === 'paused' ? Play : Pause, action: () => toggleSync(account, progress.phase === 'paused') }] satisfies ContextMenuItem[] : []),
      { label: 'Offline storage', icon: Download, action: showStorage },
      ...(account ? [{ label: 'Account settings…', icon: Settings2, separatorBefore: true, action: () => setSettingsAccount(account) }] satisfies ContextMenuItem[] : []),
      ...(account ? [{ label: 'Copy email address', icon: Copy, separatorBefore: true, action: () => copyText(account.email) }] satisfies ContextMenuItem[] : []),
      ...(account && !account.archived && !isLocalFoldersAccount(account) ? [{ label: 'Disconnect account…', icon: Settings2, separatorBefore: true, danger: true, action: () => disconnect(account) }] satisfies ContextMenuItem[] : []),
      ...(account && isLocalFoldersAccount(account) ? [
        { label: 'Import mail…', icon: ImportIcon, separatorBefore: true, action: () => setImportOpen(true) },
        { label: 'Remove Local Folders…', icon: Trash2, danger: true, action: () => void removeLocalFolders(account) }
      ] satisfies ContextMenuItem[] : [])
    ], account?.email ?? 'All accounts')
  }

  if (!loading && accounts.length === 0) {
    return (
      <div className="mail-onboarding">
        <section>
          <span className="mail-mark"><Mail size={28} /></span>
          <p className="eyebrow">Aerio mail</p>
          <h1>Your inboxes, together and available offline.</h1>
          <p>Connect Gmail, Outlook, iCloud, Yahoo, Fastmail, Proton Bridge, or another IMAP/SMTP provider. Aerio protects credentials with OS secure storage and blocks remote images until you load them.</p>
          <button className="button primary onboarding-connect" onClick={() => setAccountSetup(true)}><UserPlus size={16} /> Add your first account</button>
          <small>OAuth providers open sign-in in your browser. iCloud, Yahoo, and Fastmail use provider-issued app passwords.</small>
        </section>
        {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
      </div>
    )
  }

  const activeProgress = sync.filter((item) => shouldShowDetailedSync(item, accounts.find((account) => account.id === item.accountId)))
  const mailboxRefreshing = isMailboxRefreshing(accounts, sync, accountId)
  const syncUnavailable = accountId === 'all'
    ? !accounts.some((account) => !account.archived)
    : Boolean(accounts.find((account) => account.id === accountId)?.archived)
  const showFolderMenu = (event: React.MouseEvent, value: typeof folder) => showContextMenu(event, [
    { label: `Open ${folderNames[value]}`, icon: Mail, action: () => { setLabelId(undefined); setFolder(value) } },
    { label: 'New message', icon: Plus, separatorBefore: true, disabled: !sendableAccounts.length, action: () => setCompose({}) },
    { label: 'Check for mail', icon: RefreshCw, disabled: syncUnavailable, action: () => startSync(accountId === 'all' ? undefined : accountId) },
    ...offlineFolderMenuItems(accounts.find((account) => account.id === accountId), mailboxOfflineTarget(value, folderNames[value]), setOfflineFolder)
  ], folderNames[value])
  const folderButton = (value: typeof folder, icon: React.ReactNode) => {
    const unread = folderUnreadCounts[value]
    return (
      <button aria-label={`${folderNames[value]}${unread > 0 ? ` ${unread.toLocaleString()} unread conversation${unread === 1 ? '' : 's'}` : ''}`} className={`sidebar-item ${folder === value && !labelId ? 'active' : ''}`} onClick={() => { setLabelId(undefined); setFolder(value) }} onContextMenu={(event) => showFolderMenu(event, value)}>
        {icon}<span>{folderNames[value]}</span>
        {unread > 0 && <em className="mail-unread-count" aria-hidden="true">{unread.toLocaleString()}</em>}
      </button>
    )
  }
  const allAccountsUnread = Object.values(accountUnreadCounts).reduce((total, count) => total + count, 0)
  const accountLabel = (label: string, unread: number) => `${label}${unread > 0 ? ` ${unread.toLocaleString()} unread conversation${unread === 1 ? '' : 's'}` : ''}`
  const accountBadge = (unread: number) => unread > 0 ? <em className="mail-unread-count" aria-hidden="true">{unread.toLocaleString()}</em> : null

  return (
    <div ref={mailPanes.containerRef} className="workspace mail-workspace real-mail" style={mailPanes.style}>
      <aside className="context-sidebar">
        <button className="compose-button" disabled={!sendableAccounts.length} onClick={() => setCompose({})}><Plus size={18} /> New message</button>
        <MailFavoritesSidebar favorites={folderPrefs.preferences.favorites} accounts={accounts} labels={labels} appearance={folderPrefs.appearance} selectedAccountId={accountId} selectedLabelId={labelId} onOpen={toggleLabel} onReorder={(order) => void folderPrefs.reorder(order)} onRemove={(favorite) => void folderPrefs.removeFavorite(favorite.accountId, favorite.labelId)} onContextMenu={(event, row, index, rows) => showContextMenu(event, favoriteMenuItems(row, index, rows, {
          open: toggleLabel, reorder: (order) => void folderPrefs.reorder(order), rename: () => row.label && setFolderDisplay({ label: row.label, focusAlias: true }), remove: () => void folderPrefs.removeFavorite(row.favorite.accountId, row.favorite.labelId)
        }), row.name)} />
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
          <button aria-label={accountLabel('All accounts', allAccountsUnread)} className={`sidebar-item ${accountId === 'all' ? 'active' : ''}`} onClick={() => selectAccount('all')} onContextMenu={(event) => showAccountMenu(event)}><span className="account-dot multi" /><span>All accounts</span>{accountBadge(allAccountsUnread)}</button>
          {accounts.map((account) => { const unread = accountUnreadCounts[account.id] ?? 0; return <button aria-label={accountLabel(account.email, unread)} className={`sidebar-item mail-account-row ${accountId === account.id ? 'active' : ''}`} key={account.id} onClick={() => selectAccount(account.id)} onContextMenu={(event) => showAccountMenu(event, account)} title={`${account.email} · ${account.provider}${account.archived ? ' · offline archive' : ''}`}><span className="account-dot" style={{ background: account.color }} /><span>{account.email}{account.archived ? ' · archive' : ''}<small className="provider-name">{account.provider}</small></span>{accountBadge(unread)}<i className={`account-state ${account.status}`} /></button> })}
          <button className="sidebar-item" onClick={addAccount}><UserPlus size={16} /><span>Add mail account</span></button>
        </div>
          <MailFolderTreeSidebar accounts={accounts.filter((account) => account.id !== localAccount?.id)} labels={labels} accountFilter={accountId} appearance={folderPrefs.appearance} favorites={folderPrefs.favorites} selectedAccountId={accountId} selectedLabelId={labelId} showHidden={folderPrefs.showHidden} onToggleHidden={folderPrefs.toggleShowHidden} onOpen={toggleLabel} onContextMenu={(event, label) => { const selected = labelId === label.id && accountId === label.accountId; showContextMenu(event, [
            { label: selected ? `Clear ${label.name} filter` : `Open ${label.name}`, icon: Tag, action: () => toggleLabel(label) },
            { label: 'New message', icon: Plus, separatorBefore: true, disabled: !sendableAccounts.some((account) => account.id === label.accountId), action: () => setCompose({}) },
            { label: 'Check account for mail', icon: RefreshCw, disabled: Boolean(accounts.find((account) => account.id === label.accountId)?.archived), action: () => startSync(label.accountId) },
            ...folderPreferenceMenuItems(folderPrefs, label, () => setFolderDisplay({ label })),
            ...offlineFolderMenuItems(accounts.find((account) => account.id === label.accountId), { labelId: label.id, name: label.name }, setOfflineFolder),
            { label: 'Manage folders and labels…', icon: FolderInput, separatorBefore: true, disabled: Boolean(accounts.find((account) => account.id === label.accountId)?.archived), action: () => setFoldersOpen(label.accountId) }
          ], label.name) }} />
        {localAccount && <LocalFoldersSidebar account={localAccount} labels={labels} selectedAccountId={accountId} selectedLabelId={labelId} onOpen={toggleLabel} onManage={() => setFoldersOpen(localAccount.id)} onImport={() => setImportOpen(true)} appearance={folderPrefs.appearance} showHidden={folderPrefs.showHidden} onToggleHidden={folderPrefs.toggleShowHidden} onContextMenu={(event, label) => showContextMenu(event, [
          { label: `Open ${label.name}`, icon: FolderInput, action: () => toggleLabel(label) },
          ...folderPreferenceMenuItems(folderPrefs, label, () => setFolderDisplay({ label })),
          { label: 'Manage Local Folders…', icon: Settings2, separatorBefore: true, action: () => setFoldersOpen(localAccount.id) },
          { label: 'Import mail…', icon: ImportIcon, action: () => setImportOpen(true) }
        ], label.name)} />}
        <MailSavedSearchList searches={savedSearches.searches} view={searchView} onOpen={openSavedSearch} onEdit={setSavingSearch} onReplace={(item) => void replaceSavedSearch(item)} onDelete={(item) => { if (window.confirm(`Delete the saved search “${item.name}”? Mail is not affected.`)) void savedSearches.remove(item) }} />
        <div className="mail-sidebar-footer">
          <button onClick={() => setAttachmentsOpen(true)}><Paperclip size={14} /> All attachments</button>
          <button onClick={() => setRulesOpen(true)}><Filter size={14} /> Mail rules</button>
          <button onClick={() => setReplyWatchesOpen(true)}><Eye size={14} /> Reply watches</button>
          {window.aerio.mail.merge && <button onClick={() => setMailMergesOpen(true)}><Users size={14} /> Mail merges</button>}
          <button disabled={!accounts.some((account) => !account.archived)} onClick={() => setFoldersOpen(accountId === 'all' ? true : accountId)}><FolderInput size={14} /> Folders &amp; labels</button>
          <button onClick={() => setQuickActionsOpen(true)}><Zap size={14} /> Quick actions</button>
          <button onClick={() => setImportOpen(true)}><ImportIcon size={14} /> Import mail</button>
          <button onClick={() => void showStorage()}><Download size={14} /> Offline storage</button>
          {sendableAccounts.map((account) => <button key={account.id} title={`Settings for ${account.email}`} onClick={() => setSettingsAccount(account)} onContextMenu={(event) => showAccountMenu(event, account)}><Settings2 size={14} /> {account.email.split('@')[0]}</button>)}
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
            <input ref={searchInputRef} aria-label="Search mail" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search offline mail…" />
            {(search || activeSearchFilterCount > 0) && <button className="mail-search-clear" aria-label="Clear mail search" title="Clear search and filters" onClick={() => { setSearch(''); setSearchFilters({}); setSearchFiltersOpen(false) }}><X size={14} /></button>}
            {(search.trim() || activeSearchFilterCount > 0) && <button className={`mail-search-clear mail-search-save ${activeSavedSearch ? 'active' : ''}`} aria-label={activeSavedSearch ? `Saved as ${activeSavedSearch.name}` : 'Save search'} title={activeSavedSearch ? `Saved as “${activeSavedSearch.name}”` : 'Save this search to the sidebar'} disabled={Boolean(searchError)} onClick={() => setSavingSearch(activeSavedSearch ?? savedSearchFromView(searchView, search.trim().slice(0, 100)))}><Bookmark size={14} fill={activeSavedSearch ? 'currentColor' : 'none'} /></button>}
            {aiFeatureAvailable(aiStatus, 'search') && <button className="mail-search-clear mail-search-ai" aria-label="Ask AI to search" title="Describe what you're looking for and review the search before it runs" onClick={() => setAiSearchOpen(true)}><Sparkles size={14} /></button>}
            <button className={`mail-search-filter-button ${activeSearchFilterCount ? 'active' : ''}`} aria-expanded={searchFiltersOpen} aria-haspopup="dialog" title="Advanced search filters" onClick={() => setSearchFiltersOpen((open) => !open)}><Filter size={14} /><span>{activeSearchFilterCount || 'Filters'}</span></button>
          </div>
          {searchError && <p className="mail-search-error" role="alert">{searchError}</p>}
          <MailSearchCoverageNotice accounts={accounts.filter((account) => accountId === 'all' || account.id === accountId)} query={search} active={Boolean(search.trim()) && !searchError} serverResults={serverSearch} online={navigator.onLine} onServerSearch={(id, matched) => setServerSearch({ id, matched })} onLocalResults={() => setServerSearch(undefined)} onToast={onToast} />
          {searchFiltersOpen && <MailSearchFiltersPanel value={searchFilters} onApply={(next) => { setSearchFilters(next); setSearchFiltersOpen(false) }} onClose={() => setSearchFiltersOpen(false)} />}
        </div>
        {inboxTabsShown && <InboxCategoryTabs tabs={inboxCategories.tabs} selected={activeInboxTab} counts={inboxCategories.counts} onSelect={setInboxTab} />}
        {checkedItems.length > 0 && <div className="bulk-mail-toolbar">
          <button className="icon-button" title="Clear selection" onClick={() => setCheckedKeys(new Set())}><X size={16} /></button>
          <strong>{checkedItems.length.toLocaleString()} selected</strong>
          <span className="toolbar-divider" />
          <button className="button ghost small" onClick={() => void applyBulkAction('archive')}><Archive size={15} /> Archive</button>
          <button className="button ghost small" onClick={() => void applyBulkAction('read')}><MailOpen size={15} /> Read</button>
          <button className="button ghost small" onClick={() => void applyBulkAction('star')}><Star size={15} /> Star</button>
          {pinActionFor(checkedItems) === 'pin' ? <button className="button ghost small" onClick={() => void togglePin(checkedItems, 'pin')}><Pin size={15} /> Pin</button> : <button className="button ghost small" onClick={() => void togglePin(checkedItems, 'unpin')}><PinOff size={15} /> Unpin</button>}
          <button className="button ghost small" onClick={() => folder === 'snoozed' ? void unsnoozeMany(checkedItems) : setSnoozeItems(checkedItems)}>{folder === 'snoozed' ? <Inbox size={15} /> : <Clock3 size={15} />} {folder === 'snoozed' ? 'Return now' : 'Snooze'}</button>
          <button className="button ghost small" onClick={() => setOrganizeMode('move')}><FolderInput size={15} /> Move</button>
          <button className="button ghost small" onClick={() => setOrganizeMode('label')}><Tags size={15} /> Labels</button>
          {inboxCategories.config && <button className="button ghost small" onClick={() => setCategoryItems(checkedItems)}><Layers size={15} /> Tab</button>}
          {localAccount && checkedItems.some((item) => item.accountId !== localAccount.id) && <button className="button ghost small" onClick={() => setLocalTransferOpen(true)}><HardDrive size={15} /> Local Folders</button>}
          <MailQuickActionButtons quickActions={quickActions.quickActions} className="button ghost small" onRun={(quickAction) => void runQuickAction(quickAction, checkedItems)} />
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
        <div className="message-list" id="mail-message-list" role={inboxTabsShown ? 'tabpanel' : undefined} aria-labelledby={inboxTabsShown ? `inbox-tab-${activeInboxTab.replace(':', '-')}` : undefined} ref={messageListRef} onContextMenu={(event) => showContextMenu(event, [
          { label: 'New message', icon: Plus, disabled: !sendableAccounts.length, action: () => setCompose({}) },
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
            const groupStart = mailListGroupStart(previous, item, mailDateGroupKey)
            return <Fragment key={threadKey}>
              {groupStart === 'pinned' && <h2 className="mail-date-group mail-pinned-group"><span><Pin size={12} /> Pinned</span></h2>}
              {groupStart === 'date' && <h2 className="mail-date-group"><span>{formatMailDateHeading(item.lastDate)}</span></h2>}
              <div className={`message-thread-stack ${listExpanded ? 'expanded' : ''}`}>
              <div role="button" tabIndex={0} aria-current={selectedKey === threadKey ? 'true' : undefined} aria-pressed={checkedKeys.has(threadKey)} className={`message-row ${selectedKey === threadKey ? 'selected' : ''} ${checkedKeys.has(threadKey) ? 'checked' : ''} ${item.unread ? 'unread' : ''} ${item.pinned ? 'pinned' : ''}`} onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey) toggleChecked(item, index, event.shiftKey); else openSummary(item) }} onDoubleClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) openMessageWindow(item) }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && (event.ctrlKey || event.metaKey)) { event.preventDefault(); toggleChecked(item, index, event.shiftKey) } else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openMessageWindow(item) } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSummary(item) } }} onContextMenu={(event) => showSummaryMenu(event, item)}>
                <span className="message-unread-dot" aria-hidden="true" />
                <SenderAvatar email={item.senderEmail} name={item.participants[0]} fallbackColor={accounts.find((account) => account.id === item.accountId)?.color} />
                <span className="message-copy">
                  <span className="message-meta"><strong>{item.participants.join(', ') || 'Unknown sender'}</strong><time dateTime={item.lastDate} title={formatMailArrivalTooltip(item.lastDate)}>{formatMailListTime(item.lastDate)}</time></span>
                  <span className="message-subject">{item.subject}</span>
                  <span className="message-preview-line">
                    <span className="message-preview">{decodeHtmlEntities(item.snippet)}</span>
                    {item.messageCount > 1 && <button type="button" className={`thread-list-toggle ${listExpanded ? 'expanded' : ''}`} aria-label={`${listExpanded ? 'Collapse' : 'Expand'} ${item.messageCount} messages in ${item.subject}`} aria-expanded={listExpanded} onClick={(event) => { event.stopPropagation(); void toggleListThread(item) }} onDoubleClick={(event) => event.stopPropagation()}><span>{item.messageCount}</span><ChevronRight size={13} /></button>}
                  </span>
                  {(itemLabels.length > 0 || item.snoozedUntil || item.hasAttachments) && <span className="message-tags">
                    {itemLabels.map((label) => <em className="mail-label-badge" key={label.id} title={label.name}>{label.name}</em>)}
                    {item.snoozedUntil && <em>Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</em>}
                    {item.hasAttachments && <Paperclip size={13} />}
                  </span>}
                </span>
                <span className="row-flags">{item.pinned && <Pin size={13} aria-label="Pinned" />}{item.starred && <Star size={13} fill="currentColor" />}</span>
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
          {!page.nextCursor && !loading && !serverSearch && <MailOfflineListFooter accounts={accounts.filter((account) => accountId === 'all' || account.id === accountId)} folder={folder} labelId={labelId} refreshKey={`${page.total}:${page.items[0]?.id ?? ''}`} onExtended={() => void loadPage()} onToast={onToast} />}
        </div>
      </section>

      <MailPaneSeparator pane="list" value={mailPanes.widths.list} onPointerDown={mailPanes.startResize} onKeyDown={mailPanes.resizeWithKeyboard} onReset={mailPanes.resetWidths} />

      <section className="reader-panel">
        {selected && thread ? <>
          {selectedRestriction && <p className="mailbox-readonly-banner" role="status">{selectedRestriction}</p>}
          <div className="reader-toolbar">
            <div className="reader-toolbar-primary">
              <MessageToolbar onToast={onToast} commands={{
                reply: <button className="reader-toolbar-action" disabled={selectedAccount?.archived || isLocalFoldersAccount(selectedAccount)} title="Reply" onClick={() => setCompose({ reply: thread })}><Reply size={17} /><span>Reply</span></button>,
                replyAll: <button className="reader-toolbar-action" disabled={selectedAccount?.archived || isLocalFoldersAccount(selectedAccount)} title="Reply all" onClick={() => setCompose({ reply: thread, replyAll: true })}><ReplyAll size={17} /><span>Reply all</span></button>,
                read: <button className="reader-toolbar-action" disabled={selectedAccount?.archived || Boolean(selectedRestriction)} title={selected.unread ? 'Mark read' : 'Mark unread'} onClick={() => void applyAction(selected.unread ? 'read' : 'unread')}>{selected.unread ? <MailOpen size={17} /> : <Mail size={17} />}<span>{selected.unread ? 'Read' : 'Unread'}</span></button>,
                archive: <button className="reader-toolbar-action" disabled={selectedAccount?.archived || selected.trashed || Boolean(selectedRestriction)} title={selected.labelIds.includes('INBOX') ? 'Archive' : 'Move to inbox'} onClick={() => void applyAction(selected.labelIds.includes('INBOX') ? 'archive' : selected.labelIds.includes('SPAM') ? 'move' : 'unarchive', undefined, undefined, true, selected.labelIds.includes('SPAM') ? 'INBOX' : undefined)}>{selected.labelIds.includes('INBOX') ? <Archive size={17} /> : <Inbox size={17} />}<span>{selected.labelIds.includes('INBOX') ? 'Archive' : 'Inbox'}</span></button>,
                trash: <button className="reader-toolbar-action" disabled={selectedAccount?.archived || Boolean(selectedRestriction)} title={selected.trashed ? 'Restore from Trash' : 'Move to Trash'} onClick={() => void applyAction(selected.trashed ? 'untrash' : 'trash')}>{selected.trashed ? <Undo2 size={17} /> : <Trash2 size={17} />}<span>{selected.trashed ? 'Restore' : 'Trash'}</span></button>,
                star: <button className={`reader-toolbar-action ${selected.starred ? 'active' : ''}`} disabled={selectedAccount?.archived || Boolean(selectedRestriction)} title={selected.starred ? 'Unstar' : 'Star'} onClick={() => void applyAction(selected.starred ? 'unstar' : 'star')}><Star size={17} fill={selected.starred ? 'currentColor' : 'none'} /><span>{selected.starred ? 'Unstar' : 'Star'}</span></button>,
                pin: <button className={`reader-toolbar-action ${selected.pinned ? 'active' : ''}`} title={selected.pinned ? 'Unpin conversation' : 'Pin to top'} onClick={() => void togglePin([selected], selected.pinned ? 'unpin' : 'pin')}>{selected.pinned ? <PinOff size={17} /> : <Pin size={17} />}<span>{selected.pinned ? 'Unpin' : 'Pin'}</span></button>,
                forward: <button className="reader-toolbar-action" disabled={selectedAccount?.archived || isLocalFoldersAccount(selectedAccount)} title="Forward" onClick={() => setCompose({ reply: thread, forward: true })}><Forward size={17} /><span>Forward</span></button>
              }} />
              <MailQuickActionButtons quickActions={quickActions.quickActions} disabled={selectedAccount?.archived || Boolean(selectedRestriction)} className="reader-toolbar-action" onRun={(quickAction) => void runQuickAction(quickAction, [selected])} />
            </div>
            <div className="reader-toolbar-secondary">
              <button className="icon-button" aria-label="More message actions" title="More" onClick={showReaderMoreMenu}><MoreVertical size={18} /></button>
            </div>
          </div>
          <article className="message-reader mail-thread" onContextMenu={(event) => showSummaryMenu(event, selected)}>
            <header><div className="reader-labels">{selectedLabels.slice(0, 5).map((label) => <span key={label.id}>{label.name}</span>)}</div><h2>{thread.subject}</h2></header>
            {thread.messages.map((message) => <ThreadMessageAccordion
              key={message.id}
              message={message}
              expanded={expansion.isExpanded(message.id)}
              onLoadRemoteImages={remoteImages ? undefined : () => void loadRemoteImages()}
              onToggle={() => expansion.toggle(message.id)}
              onReply={selectedAccount?.archived || isLocalFoldersAccount(selectedAccount) ? undefined : () => setCompose({ reply: replyThreadFor(message) })}
              onReplyWithText={selectedAccount?.archived || isLocalFoldersAccount(selectedAccount) ? undefined : (text) => setCompose({ reply: replyThreadFor(message), initialBody: text })}
              onMoreActions={(event) => showProviderMessageMenu(event, message)}
              onContextMenu={(event) => showProviderMessageMenu(event, message)}
            >
              <MailOfflineContentNotice message={message} />
              {message.attachments.length > 0 && <div className="reader-attachments"><h3>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</h3>{message.attachments.map((attachment) => <div className="attachment-card" key={attachment.id} title={attachmentSearchStatus(attachment.textIndex)?.label} onContextMenu={(event) => showAttachmentMenu(event, message, attachment)}><span className="file-icon">{attachment.filename.split('.').pop()?.slice(0, 4).toUpperCase()}</span><span><strong>{attachment.filename}</strong><small>{[formatFileSize(attachment.size), attachmentSearchStatus(attachment.textIndex)?.notice].filter(Boolean).join(' · ')}</small></span><button className="icon-button" title="Open" onClick={() => void openAttachment(message, attachment)}><Download size={16} /></button><button className="button ghost small" onClick={() => void saveAttachment(message, attachment)}>Save as</button></div>)}</div>}
            </ThreadMessageAccordion>)}
            {!selectedAccount?.archived && !isLocalFoldersAccount(selectedAccount) && <div className="quick-actions"><button className="button ghost" onClick={() => setCompose({ reply: thread })}><Reply size={16} /> Reply</button><button className="button ghost" onClick={() => setCompose({ reply: thread, replyAll: true })}><ReplyAll size={16} /> Reply all</button></div>}
          </article>
        </> : <div className="empty-state grow">{threadLoading ? <><LoaderCircle className="spin" size={34} /><h3>Opening conversation</h3><p>Loading the selected thread from local storage.</p></> : accounts.some((item) => item.status === 'syncing') ? <><LoaderCircle className="spin" size={34} /><h3>Downloading your mailbox</h3><p>Conversations appear here as soon as they are available.</p></> : <><Inbox size={34} /><h3>Select a conversation</h3><p>Choose a conversation to read it here.</p></>}</div>}
      </section>

      {pending.length > 0 && <div className="undo-toast"><span>{pendingOperationsMessage(pending)}</span><button onClick={() => void undo()}><Undo2 size={15} /> Undo</button><button onClick={() => setPending([])}>Dismiss</button></div>}
      {pendingSend && <div className="undo-toast send-undo-toast"><span>Message will send shortly</span><button onClick={() => void undoSend()}><Undo2 size={15} /> Undo Send</button><button onClick={() => setPendingSend(undefined)}>Dismiss</button></div>}
      {aiSearchOpen && aiStatus && <MailAiSearchDialog status={aiStatus} onRun={(query) => { setSearch(query); setSearchFiltersOpen(false) }} onClose={() => setAiSearchOpen(false)} />}
      {compose && <MailComposeModal accounts={sendableAccounts} draft={compose.draft} replyTo={compose.reply} replyAll={compose.replyAll} forward={compose.forward} initialTo={compose.initialTo} initialBody={compose.initialBody} onClose={() => { setCompose(undefined); if (folder === 'drafts' || folder === 'scheduled') void loadDrafts() }} onSent={(result) => { if (result.status === 'send-pending') setPendingSend(result); void loadPage(); void loadDrafts() }} onToast={onToast} />}
      {accountSetup && <MailAccountSetupModal onClose={() => setAccountSetup(false)} onConnected={accountConnected} onToast={onToast} />}
      {settingsAccount && <MailAccountSettingsModal account={settingsAccount} onSaved={(updated) => { setAccounts((items) => items.map((item) => item.id === updated.id ? updated : item)); setSettingsAccount(updated) }} onClose={() => setSettingsAccount(undefined)} onToast={onToast} />}
      {organizeMode && <MailOrganizeModal mode={organizeMode} items={checkedItems} accounts={accounts} labels={labels} onApply={applyOrganizeRequests} onClose={() => setOrganizeMode(undefined)} />}
      {categoryItems && inboxCategories.config && <MailCategoryAssignModal items={categoryItems} config={inboxCategories.config} accounts={accounts} onClose={() => setCategoryItems(undefined)} onError={onToast} onDone={(message) => { onToast(message); if (categoryItems === checkedItems) setCheckedKeys(new Set()); void loadPage(); void inboxCategories.reload() }} />}
      {snoozeItems && <MailSnoozeModal count={snoozeItems.length} onApply={(until) => applySnooze(snoozeItems, until)} onClose={() => setSnoozeItems(undefined)} />}
      {savingSearch && <MailSaveSearchModal accounts={accounts} labels={labels} initial={savingSearch} onClose={() => setSavingSearch(undefined)} onSave={async (input) => { const saved = await savedSearches.save(input); openSavedSearch(saved); onToast(`Saved “${saved.name}”`) }} />}
      {replyWatchesOpen && <MailReplyWatchesModal accounts={accounts} onToast={onToast} onClose={() => setReplyWatchesOpen(false)} />}
      {mailMergesOpen && <MailMergeJobsModal accounts={accounts} onToast={onToast} onClose={() => setMailMergesOpen(false)} />}
      {attachmentsOpen && <MailAttachmentsModal accounts={accounts} onToast={onToast} onClose={() => setAttachmentsOpen(false)} />}
      {quickActionsOpen && <MailQuickActionsModal accounts={accounts} labels={labels} quickActions={quickActions.quickActions} onSave={async (input) => { const saved = await quickActions.save(input); onToast(`Saved “${saved.name}”`) }} onDelete={quickActions.remove} onClose={() => setQuickActionsOpen(false)} />}
      {rulesOpen && <MailRulesModal accounts={accounts} labels={labels} onToast={onToast} onClose={() => setRulesOpen(false)} />}
      {offlineFolder && <MailFolderOfflineModal target={offlineFolder} onClose={() => setOfflineFolder(undefined)} onToast={onToast} />}
      {folderDisplay && <MailFolderDisplayModal label={folderDisplay.label} account={accounts.find((account) => account.id === folderDisplay.label.accountId)} labels={labels} appearance={folderPrefs.appearance.get(folderKey(folderDisplay.label.accountId, folderDisplay.label.id))} favorite={folderPrefs.favorites.get(folderKey(folderDisplay.label.accountId, folderDisplay.label.id))} focusAlias={folderDisplay.focusAlias} onClose={() => setFolderDisplay(undefined)} onSave={async ({ alias, appearance }) => (alias === undefined || await folderPrefs.setAlias(appearance.accountId, appearance.labelId, alias)) && await folderPrefs.setAppearance(appearance)} />}
      {foldersOpen && <MailFolderManagerModal accounts={accounts} labels={labels} initialAccountId={foldersOpen === true ? undefined : foldersOpen} onToast={onToast} isFavorite={folderPrefs.available ? folderPrefs.isFavorite : undefined} onToggleFavorite={(label) => void (folderPrefs.isFavorite(label.accountId, label.id) ? folderPrefs.removeFavorite(label.accountId, label.id) : folderPrefs.addFavorite(label.accountId, label.id))} onClose={() => setFoldersOpen(undefined)} onChanged={(changedAccount, result) => {
        setLabels((items) => [...items.filter((label) => label.accountId !== changedAccount), ...result.labels])
        // Keep the open folder selected across path-based renames; leave it when deleted.
        if (accountId === changedAccount && labelId) {
          if (result.deletedId === labelId) setLabelId(undefined)
          else if (result.renamed[labelId]) setLabelId(result.renamed[labelId])
        }
      }} />}
      {importOpen && <MailImportModal accounts={accounts} labels={labels} onClose={() => setImportOpen(false)} onToast={onToast} onLocalFoldersChanged={reloadLabels} />}
      {localTransferOpen && <MailLocalTransferModal items={checkedItems} accounts={accounts} labels={labels} onClose={() => setLocalTransferOpen(false)} onToast={onToast} onDone={() => { setCheckedKeys(new Set()); void loadPage() }} />}
      {sourceViewer && <MailMessageSourceModal {...sourceViewer} onClose={() => setSourceViewer(undefined)} />}
      {messageTools.dialog}
    </div>
  )
}
