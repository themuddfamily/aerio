import {
  CalendarDays, CheckCircle2, ChevronRight, Command, ContactRound, HelpCircle, LockKeyhole, Mail,
  MessagesSquare, Moon, NotebookPen, Pin, PinOff, Plus, Search, Settings, Sparkles, Sun, UserRound, X, Zap
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import { applyTheme as applySavedTheme } from './lib/themes'
import SettingsModal from './components/SettingsModal'
import DuplicateCleanupModal from './components/DuplicateCleanupModal'
import ProfileModal from './components/ProfileModal'
import AppInfoModal from './components/AppInfoModal'
import AppLockScreen from './components/AppLockScreen'
import CalendarView from './views/CalendarView'
import MailAgenda from './components/MailAgenda'
import ContactsView from './views/ContactsView'
import TasksView from './views/TasksView'
import NotesView from './views/NotesView'
import ConnectedMailView from './views/ConnectedMailView'
import ChatView, { type ChatOpenRequest } from './views/ChatView'
import type { ChatSnapshot } from './chat-types'
import CalendarInterchangePanel from './components/CalendarInterchangePanel'
import ContactInterchangePanel from './components/ContactInterchangePanel'
import type { InterchangeSnapshot } from './interchange-types'
import type { DavSnapshot } from './dav-types'
import type { Account, AppLockStatus, AppPreferences, AppState, CalendarEvent, Contact, ContactList, ModuleId, RecurrenceEditScope } from './types'
import type { MailAccountSummary, MailQuickAction } from './mail-types'
import { quickActionCommandId, resolveKeymap, shortcutLabel } from './lib/keymap'
import { KeymapProvider, useKeymapCommands, type KeymapHandlers } from './lib/use-keymap'
import type { LocalModuleSnapshot, ProductivitySnapshot } from './productivity-types'
import { uid, unreadCount } from './lib/domain'
import { planLocalRecurrenceDelete, planLocalRecurrenceSave, storedEvent, type LocalRecurrencePlan } from './lib/recurrence-edit'
import { useContextMenu } from './components/ContextMenu'
import { useDialogFocus } from './lib/dialog-focus'

const modules: { id: ModuleId; label: string; icon: typeof Mail }[] = [
  { id: 'mail', label: 'Mail', icon: Mail },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'contacts', label: 'Contacts', icon: ContactRound },
  { id: 'tasks', label: 'Tasks', icon: CheckCircle2 },
  { id: 'notes', label: 'Notes', icon: NotebookPen }
]
// Chat joins the rail only while its gate passes (docs/chat-matrix-connector.md).
const chatModule: typeof modules[number] = { id: 'chat', label: 'Chat', icon: MessagesSquare }

const emptyProductivity: ProductivitySnapshot = { calendars: [], events: [], contacts: [], sync: [] }
const emptyLocalModules: LocalModuleSnapshot = { tasks: [], notes: [], contacts: [] }
const emptyInterchange: InterchangeSnapshot = { calendars: [], events: [] }

interface ComposeRequest {
  id: number
  initialTo?: string
}

export default function App() {
  const { showContextMenu } = useContextMenu()
  const [preferences, setPreferences] = useState<AppPreferences | null>(null)
  // Merge updates from detached readers before any later general-preference autosave.
  useEffect(() => window.aerio.messageToolbar?.onChange((messageToolbar) => {
    setPreferences((current) => current ? { ...current, settings: { ...current.settings, messageToolbar } } : current)
  }), [])
  const [appLock, setAppLock] = useState<AppLockStatus>()
  const [appLockError, setAppLockError] = useState('')
  const [activeModule, setActiveModule] = useState<ModuleId>('mail')
  const [agendaOpen, setAgendaOpen] = useState(() => {
    try { return window.localStorage.getItem('aerio.mail.dailyAgenda') !== 'hidden' } catch { return true }
  })
  const [calendarOpenRequest, setCalendarOpenRequest] = useState<{ id: number; day: Date; event?: CalendarEvent }>()
  useEffect(() => { if (activeModule !== 'calendar') setCalendarOpenRequest(undefined) }, [activeModule])
  const setAgendaVisible = (visible: boolean) => {
    setAgendaOpen(visible)
    try { window.localStorage.setItem('aerio.mail.dailyAgenda', visible ? 'visible' : 'hidden') } catch { /* The choice still applies for this session. */ }
  }
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [duplicatesOpen, setDuplicatesOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState<'help' | 'whats-new'>()
  const [toast, setToast] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const [composeRequest, setComposeRequest] = useState<ComposeRequest>({ id: 0 })
  const [mailSearchRequest, setMailSearchRequest] = useState({ id: 0, query: '' })
  const [mailQuickActions, setMailQuickActions] = useState<MailQuickAction[]>([])
  const [mailQuickActionRequest, setMailQuickActionRequest] = useState({ id: 0, quickActionId: '' })
  const [mailPinRequest, setMailPinRequest] = useState<{ id: number; action: 'pin' | 'unpin' }>({ id: 0, action: 'pin' })
  const [connectedAccounts, setConnectedAccounts] = useState<MailAccountSummary[]>([])
  const [productivity, setProductivity] = useState<ProductivitySnapshot>(emptyProductivity)
  const [localModules, setLocalModules] = useState<LocalModuleSnapshot>(emptyLocalModules)
  // Local calendars and read-only internet subscriptions from file interchange.
  const [interchange, setInterchange] = useState<InterchangeSnapshot>(emptyInterchange)
  useEffect(() => window.aerio.interchange?.onChanged(setInterchange), [])
  // CalDAV/CardDAV accounts; their calendars and contacts arrive through the productivity snapshot.
  const [dav, setDav] = useState<DavSnapshot>()
  useEffect(() => {
    void window.aerio.dav?.snapshot().then(setDav).catch(() => undefined)
    return window.aerio.dav?.onChanged(setDav)
  }, [])
  // Matrix chat: a display snapshot (gate, accounts, rooms) pushed by the main process.
  const [chatSnapshot, setChatSnapshot] = useState<ChatSnapshot>()
  const [chatOpenRequest, setChatOpenRequest] = useState<ChatOpenRequest>()
  const chatAvailable = Boolean(window.aerio.chat && chatSnapshot?.gate.enabled)
  const visibleModules = useMemo(() => chatAvailable ? [...modules, chatModule] : modules, [chatAvailable])
  useEffect(() => window.aerio.chat?.onEvent((event) => {
    if (event.type === 'snapshot') setChatSnapshot(event.snapshot)
    else if (event.type === 'open-room') {
      setActiveModule('chat')
      setChatOpenRequest((current) => ({ id: (current?.id ?? 0) + 1, accountId: event.accountId, roomId: event.roomId }))
    }
  }), [])
  const persistedLocalModules = useRef<LocalModuleSnapshot | undefined>(undefined)
  const localSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const localRestoreActive = useRef(false)
  const [localSaveRevision, setLocalSaveRevision] = useState(0)
  const applyLocalSnapshot = useCallback((snapshot: LocalModuleSnapshot) => {
    clearTimeout(localSaveTimer.current)
    persistedLocalModules.current = snapshot
    setLocalModules(snapshot)
  }, [])
  useEffect(() => window.aerio.productivity.onChanged?.((data) => {
    if (data.local) applyLocalSnapshot(data.local)
    if (data.snapshot) setProductivity(data.snapshot)
  }), [applyLocalSnapshot])
  const [productivitySyncing, setProductivitySyncing] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const hydrated = useRef(false)
  const workspaceLoadStarted = useRef(false)
  const productivitySyncingRef = useRef(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commandDialogRef = useDialogFocus<HTMLElement>(() => {
    setQuery('')
    setCommandsOpen(false)
  }, commandsOpen)

  const showToast = useCallback((message: string) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }, [])

  const loadWorkspace = useCallback(() => {
    if (workspaceLoadStarted.current) return
    workspaceLoadStarted.current = true
    void window.aerio.loadPreferences().then((loaded) => {
      setPreferences(loaded)
      setActiveModule(modules.some((module) => module.id === loaded.settings.startModule) ? loaded.settings.startModule : 'mail')
      queueMicrotask(() => { hydrated.current = true })
    }).catch(() => showToast('Aerio could not open its local data'))
    void window.aerio.mail.accounts.list().then(setConnectedAccounts).catch(() => showToast('Mail accounts could not be loaded'))
    void window.aerio.productivity.snapshot().then(setProductivity).catch(() => {
      // Cached provider data can be retried from the connected Calendar or Contacts view.
    })
    void window.aerio.productivity.localSnapshot().then((localSnapshot) => {
      applyLocalSnapshot(localSnapshot)
    }).catch(() => showToast('Local Tasks and Notes could not be opened'))
    void window.aerio.interchange?.snapshot().then(setInterchange).catch(() => {
      // Local and subscribed calendars are optional; provider data still loads without them.
    })
    void window.aerio.chat?.snapshot().then(setChatSnapshot).catch(() => {
      // Chat stays hidden when its snapshot is unavailable.
    })
  }, [applyLocalSnapshot, showToast])

  const applyAppLockStatus = useCallback((status: AppLockStatus) => {
    setAppLock(status)
    if (!status.locked) loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    let active = true
    const handleStatus = (status: AppLockStatus) => {
      if (!active) return
      applyAppLockStatus(status)
    }
    const unsubscribe = window.aerio.appLock.onStatus(handleStatus)
    void window.aerio.appLock.status().then(handleStatus).catch(() => setAppLockError('Aerio could not read its app-lock status. Restart Aerio and try again.'))
    return () => { active = false; unsubscribe() }
  }, [applyAppLockStatus])

  useEffect(() => {
    if (!persistedLocalModules.current || localModules === persistedLocalModules.current || localRestoreActive.current) return
    localSaveTimer.current = setTimeout(() => {
      if (localRestoreActive.current) return
      void window.aerio.productivity.saveLocal(localModules).catch(() => showToast('Local Tasks or Notes could not be saved'))
    }, 350)
    return () => clearTimeout(localSaveTimer.current)
  }, [localModules, localSaveRevision, showToast])

  const syncProductivity = useCallback(async (options?: { quiet?: boolean }) => {
    if (productivitySyncingRef.current) return
    productivitySyncingRef.current = true
    setProductivitySyncing(true)
    try {
      const accounts = (await window.aerio.mail.accounts.list()).filter((account) => !account.archived)
      setConnectedAccounts(accounts)
      const supported = accounts.filter((account) => account.provider === 'gmail' || account.provider === 'microsoft' || account.provider === 'exchange')
      const davAccounts = (await window.aerio.dav?.snapshot().catch(() => undefined))?.accounts.filter((account) => account.status !== 'needs-auth') ?? []
      if (!supported.length && !davAccounts.length) {
        if (!options?.quiet) showToast('Connect Google or Microsoft to synchronize Calendar and Contacts')
        return
      }
      let latest = await window.aerio.productivity.snapshot()
      const failures: string[] = []
      for (const account of supported) {
        try { latest = await window.aerio.productivity.sync(account.id) }
        catch (error) { failures.push(error instanceof Error ? error.message : `${account.email} could not synchronize`) }
      }
      for (const account of davAccounts) {
        try { latest = await window.aerio.productivity.sync(account.id) }
        catch (error) { failures.push(error instanceof Error ? error.message : `${account.name} could not synchronize`) }
      }
      if (failures.length) latest = await window.aerio.productivity.snapshot()
      setProductivity(latest)
      if (!options?.quiet) showToast(failures.length ? `Some provider data could not synchronize: ${failures[0]}` : 'Calendar and Contacts synchronized')
    } finally {
      productivitySyncingRef.current = false
      setProductivitySyncing(false)
    }
  }, [showToast])

  const supportedProductivityAccounts = connectedAccounts
    .filter((account) => !account.archived && (account.provider === 'gmail' || account.provider === 'microsoft' || account.provider === 'exchange'))
    .map((account) => account.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!supportedProductivityAccounts) return
    const initial = setTimeout(() => void syncProductivity({ quiet: true }), 30_000)
    const interval = setInterval(() => void syncProductivity({ quiet: true }), 15 * 60_000)
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, [supportedProductivityAccounts, syncProductivity])

  const enableCalendarEditing = useCallback(async () => {
    setProductivitySyncing(true)
    try {
      const accounts = (await window.aerio.mail.accounts.list()).filter((account) => !account.archived)
      setConnectedAccounts(accounts)
      const supported = accounts.filter((account) => account.provider === 'gmail' || account.provider === 'microsoft')
      const target = supported.find((account) => productivity.calendars.some((calendar) => calendar.accountId === account.id && !calendar.canWrite)) ?? supported[0]
      if (!target) throw new Error('Connect Google or Microsoft to enable Calendar editing')
      await window.aerio.mail.accounts.reconnect(target.id)
      const latest = await window.aerio.productivity.sync(target.id)
      setProductivity(latest)
      showToast(`${target.provider === 'gmail' ? 'Google' : 'Microsoft'} Calendar editing enabled`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Calendar editing could not be enabled')
    } finally {
      setProductivitySyncing(false)
    }
  }, [productivity.calendars, showToast])

  const localCalendarIds = useMemo(() => new Set(interchange.calendars.filter((calendar) => calendar.kind === 'local').map((calendar) => calendar.id)), [interchange.calendars])

  // Applies a series edit plan to local calendars: saves first so a split series never loses events.
  const applyLocalPlan = useCallback(async (plan: LocalRecurrencePlan) => {
    let snapshot: InterchangeSnapshot | undefined
    for (const item of plan.save) snapshot = await window.aerio.interchange.saveLocalEvent(storedEvent(item))
    for (const id of plan.remove) snapshot = await window.aerio.interchange.deleteLocalEvent(id)
    if (snapshot) setInterchange(snapshot)
  }, [])

  const saveProviderEvent = useCallback(async (event: CalendarEvent, exists: boolean, scope?: RecurrenceEditScope) => {
    if (localCalendarIds.has(event.calendarId)) {
      if (scope) await applyLocalPlan(planLocalRecurrenceSave(interchange.events, event, event, scope, () => uid('event')))
      else setInterchange(await window.aerio.interchange.saveLocalEvent(storedEvent(event)))
      return
    }
    const input = storedEvent(event)
    const latest = exists
      ? scope ? await window.aerio.productivity.updateEvent(input, scope) : await window.aerio.productivity.updateEvent(input)
      : await window.aerio.productivity.createEvent(input)
    setProductivity(latest)
  }, [applyLocalPlan, interchange.events, localCalendarIds])

  const deleteProviderEvent = useCallback(async (event: CalendarEvent, scope?: RecurrenceEditScope) => {
    if (localCalendarIds.has(event.calendarId)) {
      if (scope) await applyLocalPlan(planLocalRecurrenceDelete(interchange.events, event, scope))
      else setInterchange(await window.aerio.interchange.deleteLocalEvent(event.id))
      return
    }
    setProductivity(scope ? await window.aerio.productivity.deleteEvent(event.id, scope) : await window.aerio.productivity.deleteEvent(event.id))
  }, [applyLocalPlan, interchange.events, localCalendarIds])

  const enableContactEditing = useCallback(async (accountId?: string) => {
    setProductivitySyncing(true)
    try {
      const accounts = (await window.aerio.mail.accounts.list()).filter((account) => !account.archived)
      setConnectedAccounts(accounts)
      const supported = accounts.filter((account) => account.provider === 'gmail' || account.provider === 'microsoft')
      const target = supported.find((account) => account.id === accountId) ??
        supported.find((account) => productivity.contacts.some((contact) => contact.accountId === account.id && contact.readOnly)) ?? supported[0]
      if (!target) throw new Error('Connect Google or Microsoft to enable Contacts editing')
      await window.aerio.mail.accounts.reconnect(target.id)
      setProductivity(await window.aerio.productivity.sync(target.id))
      showToast(`${target.provider === 'gmail' ? 'Google' : 'Microsoft'} Contacts editing enabled`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Contacts editing could not be enabled')
    } finally {
      setProductivitySyncing(false)
    }
  }, [productivity.contacts, showToast])

  const saveProviderContact = useCallback(async (accountId: string, contact: Contact, exists: boolean) => {
    const result = exists
      ? await window.aerio.productivity.updateContact(contact)
      : await window.aerio.productivity.createContact(accountId, contact)
    setProductivity(result.snapshot)
    return result.contact
  }, [])

  const deleteProviderContact = useCallback(async (contactId: string) => {
    setProductivity(await window.aerio.productivity.deleteContact(contactId))
  }, [])

  // Distribution lists: local lists persist with the local modules; Google groups go through IPC.
  const contactListActions = useMemo(() => {
    const api = window.aerio.productivity
    const applying = <T extends unknown[]>(call: ((...args: T) => Promise<ProductivitySnapshot>) | undefined) => call && (async (...args: T) => {
      const snapshot = await call(...args)
      setProductivity(snapshot)
      return snapshot
    })
    return {
      localLists: localModules.contactLists ?? [],
      groups: productivity.contactGroups ?? [],
      onLocalListsChange: (contactLists: ContactList[]) => setLocalModules((current) => ({ ...current, contactLists })),
      createGroup: applying(api.createContactGroup),
      renameGroup: applying(api.renameContactGroup),
      deleteGroup: applying(api.deleteContactGroup),
      updateGroupMembers: applying(api.updateContactGroupMembers)
    }
  }, [localModules.contactLists, productivity.contactGroups])

  useEffect(() => {
    if (!preferences || !hydrated.current) return
    setSaveStatus('saving')
    const timer = setTimeout(() => {
      void window.aerio.savePreferences(preferences).then(() => setSaveStatus('saved')).catch((error) => showToast(error instanceof Error ? `Preferences could not be saved: ${error.message}` : 'Preferences could not be saved'))
    }, 350)
    return () => clearTimeout(timer)
  }, [preferences, showToast])

  useEffect(() => {
    if (!preferences) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      applySavedTheme(preferences.settings, document.documentElement, media.matches)
    }
    applyTheme()
    document.documentElement.dataset.density = preferences.settings.density
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [preferences])

  const startCompose = useCallback((initialTo?: string) => {
    setActiveModule('mail')
    setComposeRequest((current) => ({ id: current.id + 1, initialTo }))
  }, [])

  // Remappable global shortcuts come from the keymap registry (src/lib/keymap.ts); Escape stays fixed.
  const keymap = useMemo(() => resolveKeymap(preferences?.settings.keyboardShortcuts), [preferences?.settings.keyboardShortcuts])
  const keyLabel = (commandId: string) => shortcutLabel(keymap, commandId)
  const globalShortcuts: KeymapHandlers = {
    'app.commandPalette': () => setCommandsOpen((value) => !value),
    'mail.compose': () => startCompose(),
    'app.settings': () => setSettingsOpen(true),
    'app.help': () => setInfoOpen('help'),
    ...(appLock?.enabled ? { 'app.lock': () => { void window.aerio.appLock.lock() } } : {}),
    ...Object.fromEntries(visibleModules.map((module) => [`module.${module.id}`, () => setActiveModule(module.id)]))
  }
  useKeymapCommands('global', globalShortcuts, { keymap, enabled: Boolean(preferences) && !appLock?.locked })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCommandsOpen(false)
        setSettingsOpen(false)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const unsubscribe = window.aerio.onComposeCommand(() => startCompose())
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unsubscribe()
    }
  }, [startCompose])

  // Saved mail Quick Actions are listed in the palette while Mail is open, so they run on the visible selection.
  useEffect(() => {
    if (!commandsOpen || activeModule !== 'mail') return
    let cancelled = false
    void Promise.resolve().then(() => window.aerio.mail.quickActions.list())
      .then((items) => { if (!cancelled) setMailQuickActions(items) })
      .catch(() => { if (!cancelled) setMailQuickActions([]) })
    return () => { cancelled = true }
  }, [activeModule, commandsOpen])

  const commandItems = useMemo(() => {
    const mailQuick = activeModule === 'mail' ? mailQuickActions.map((item) => ({
      label: `Run quick action: ${item.name}`, detail: item.shortcut ? keyLabel(quickActionCommandId(item.shortcut)) ?? '' : '', icon: Zap,
      action: () => setMailQuickActionRequest((current) => ({ id: current.id + 1, quickActionId: item.id })), preserveQuery: false
    })) : []
    const mailPins = activeModule === 'mail' ? (['pin', 'unpin'] as const).map((action) => ({
      label: action === 'pin' ? 'Pin selected conversations to the top' : 'Unpin selected conversations', detail: '', icon: action === 'pin' ? Pin : PinOff,
      action: () => setMailPinRequest((current) => ({ id: current.id + 1, action })), preserveQuery: false
    })) : []
    const quick = [
      { label: 'Compose a new message', detail: keyLabel('mail.compose') ?? '', icon: Plus, action: () => startCompose(), preserveQuery: false },
      ...visibleModules.map((item) => ({ label: `Open ${item.label}`, detail: keyLabel(`module.${item.id}`) ?? '', icon: item.icon, action: () => setActiveModule(item.id), preserveQuery: false })),
      ...(appLock?.enabled ? [{ label: 'Lock Aerio', detail: keyLabel('app.lock') ?? '', icon: LockKeyhole, action: () => { void window.aerio.appLock.lock() }, preserveQuery: false }] : []),
      { label: 'Open settings', detail: keyLabel('app.settings') ?? '', icon: Settings, action: () => setSettingsOpen(true), preserveQuery: false },
      { label: 'Open help and keyboard shortcuts', detail: keyLabel('app.help') ?? '', icon: HelpCircle, action: () => setInfoOpen('help'), preserveQuery: false },
      ...mailPins,
      ...mailQuick
    ].filter((item) => !query || item.label.toLowerCase().includes(query.toLowerCase()))
    return query.trim()
      ? [{ label: `Search ${visibleModules.find((item) => item.id === activeModule)?.label ?? 'Aerio'} for “${query.trim()}”`, detail: 'Enter', icon: Search, action: () => {
        if (activeModule === 'mail') setMailSearchRequest((current) => ({ id: current.id + 1, query: query.trim() }))
      }, preserveQuery: true }, ...quick]
      : quick
    // keyLabel reads the memoized keymap listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, appLock?.enabled, keymap, mailQuickActions, query, startCompose, visibleModules])

  useEffect(() => setCommandIndex(0), [commandsOpen, query])

  if (appLock?.locked) return <AppLockScreen onUnlocked={applyAppLockStatus} />

  if (!appLock || !preferences) {
    return (
      <div className="loading-screen">
        <div className="loading-mark">A</div>
        <h1>Aerio</h1>
        <p>{appLockError || 'Bringing your day into focus…'}</p>
        {!appLockError && <span className="loading-line"><i /></span>}
      </div>
    )
  }

  const navigate = (module: ModuleId) => {
    setActiveModule(module)
    setQuery('')
  }

  const profile = preferences.settings.profile ?? {
    displayName: connectedAccounts[0]?.displayName ?? connectedAccounts[0]?.email ?? 'Aerio user',
    email: connectedAccounts[0]?.email
  }
  const profileInitials = profile.displayName.trim().split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'A'
  const accountById = new Map(connectedAccounts.map((account) => [account.id, account]))
  const connectedState: AppState = {
    accounts: productivity.calendars.map((calendar): Account => {
      const account = accountById.get(calendar.accountId)
      return {
        id: calendar.id,
        name: calendar.name,
        email: account?.email ?? '',
        initials: calendar.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
        color: calendar.color,
        provider: calendar.provider
      }
    }).concat(interchange.calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      email: calendar.url ?? 'On this PC',
      initials: calendar.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
      color: calendar.color,
      provider: 'local' as const
    }))),
    events: [...productivity.events, ...interchange.events],
    contacts: [...(localModules.contacts ?? []), ...productivity.contacts],
    tasks: localModules.tasks,
    notes: localModules.notes
  }
  const writableCalendarIds = new Set([...productivity.calendars.filter((calendar) => calendar.canWrite).map((calendar) => calendar.id), ...localCalendarIds])
  const providerContactAccounts = connectedAccounts.flatMap((account): { id: string; email: string; provider: import('./productivity-types').ProductivityProvider }[] => !account.archived && (account.provider === 'gmail' || account.provider === 'microsoft' || account.provider === 'exchange')
    ? [{ id: account.id, email: account.email, provider: account.provider }]
    : []).concat((dav?.accounts ?? [])
    .filter((account) => dav?.collections.some((collection) => collection.accountId === account.id && collection.kind === 'addressbook' && collection.enabled && !collection.readOnly))
    .map((account) => ({ id: account.id, email: account.name, provider: 'dav' as const })))
  const updateConnectedLocal = (next: AppState) => setLocalModules((current) => ({ ...current, tasks: next.tasks, notes: next.notes }))
  const productivityMessage = productivity.sync.some((item) => item.phase === 'error')
    ? productivity.sync.find((item) => item.phase === 'error')?.error ?? 'A provider needs attention.'
    : productivity.sync.some((item) => item.lastSyncedAt)
      ? `Last synchronized ${new Date(Math.max(...productivity.sync.flatMap((item) => item.lastSyncedAt ? [Date.parse(item.lastSyncedAt)] : []))).toLocaleString()}`
      : 'Calendar and Contacts have not been synchronized yet.'

  const showModuleMenu = (event: React.MouseEvent, module: typeof modules[number]) => showContextMenu(event, [
    { label: `Open ${module.label}`, icon: module.icon, shortcut: keyLabel(`module.${module.id}`), action: () => navigate(module.id) },
    ...(module.id === 'mail' ? [{ label: 'New message', icon: Plus, shortcut: keyLabel('mail.compose'), separatorBefore: true, action: () => startCompose() }] : []),
    { label: `Search ${module.label}`, icon: Search, separatorBefore: module.id !== 'mail', action: () => { navigate(module.id); setCommandsOpen(true) } },
    { label: 'Open on startup', icon: Sparkles, separatorBefore: true, checked: preferences.settings.startModule === module.id, action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, startModule: module.id } }) }
  ], module.label)

  return (
    <KeymapProvider keymap={keymap}>
    <div className="app">
      <TitleBar>
        <button className="command-search" onClick={() => setCommandsOpen(true)} onContextMenu={(event) => showContextMenu(event, [
          { label: 'Search and commands', icon: Search, shortcut: keyLabel('app.commandPalette'), action: () => setCommandsOpen(true) },
          { label: 'Clear search', icon: X, disabled: !query, action: () => setQuery('') }
        ], 'Search')}>
          <Search size={16} />
          <span>Search {visibleModules.find((item) => item.id === activeModule)?.label.toLowerCase()} or run a command</span>
          {keyLabel('app.commandPalette') && <kbd>{keyLabel('app.commandPalette')}</kbd>}
        </button>
      </TitleBar>
      <div className="app-frame">
        <nav className="module-rail" aria-label="Aerio modules">
          <div className="rail-modules">
            {visibleModules.map((module) => {
              const { id, label, icon: Icon } = module
              const badge = id === 'chat'
                ? (chatSnapshot?.rooms ?? []).reduce((total, room) => total + (room.membership === 'invite' ? 1 : room.membership === 'join' && !room.muted ? room.unread : 0), 0)
                : unreadCount(connectedState, id)
              return (
                <button key={id} className={activeModule === id ? 'active' : ''} aria-label={label} aria-current={activeModule === id ? 'page' : undefined} title={keyLabel(`module.${id}`) ? `${label} · ${keyLabel(`module.${id}`)}` : label} onClick={() => navigate(id)} onContextMenu={(event) => showModuleMenu(event, module)}>
                  <Icon size={21} strokeWidth={1.9} />
                  {badge > 0 && <em>{badge > 9 ? '9+' : badge}</em>}
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          <div className="rail-bottom">
            <button aria-label="What’s new" title="What’s new" onClick={() => setInfoOpen('whats-new')}><Sparkles size={20} /></button>
            <button aria-label="Help" title={`Help and keyboard shortcuts${keyLabel('app.help') ? ` · ${keyLabel('app.help')}` : ''}`} onClick={() => setInfoOpen('help')}><HelpCircle size={20} /></button>
            {appLock.enabled && <button aria-label="Lock Aerio" title={`Lock Aerio${keyLabel('app.lock') ? ` · ${keyLabel('app.lock')}` : ''}`} onClick={() => void window.aerio.appLock.lock()}><LockKeyhole size={20} /></button>}
            <button aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)} onContextMenu={(event) => showContextMenu(event, [{ label: 'Open settings', icon: Settings, shortcut: keyLabel('app.settings'), action: () => setSettingsOpen(true) }], 'Settings')}><Settings size={20} /></button>
            <button className="profile-button" aria-label={`Profile: ${profile.displayName}`} title="Your Aerio profile" onClick={() => setProfileOpen(true)} onContextMenu={(event) => showContextMenu(event, [
              { label: 'Open profile', icon: UserRound, action: () => setProfileOpen(true) }
            ], profile.displayName)}><span>{profile.avatarDataUrl ? <img src={profile.avatarDataUrl} alt="" /> : profileInitials}</span><i /></button>
          </div>
        </nav>
        <main className="app-main">
          <header className="global-bar">
            <span className={`save-indicator ${saveStatus}`} aria-live="polite">{saveStatus === 'saved' ? 'All changes saved' : 'Saving…'}</span>
            {activeModule === 'mail' && <button className="theme-quick" aria-label="Toggle daily agenda" title="Daily agenda" aria-pressed={agendaOpen} onClick={() => setAgendaVisible(!agendaOpen)}><CalendarDays size={17} /></button>}
            <button className="theme-quick" aria-label="Toggle theme" title="Toggle theme" onClick={() => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', customThemeId: undefined } })} onContextMenu={(event) => showContextMenu(event, [
              { label: 'System theme', icon: Settings, checked: !preferences.settings.customThemeId && preferences.settings.theme === 'system', action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: 'system', customThemeId: undefined } }) },
              { label: 'Light theme', icon: Sun, checked: !preferences.settings.customThemeId && preferences.settings.theme === 'light', action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: 'light', customThemeId: undefined } }) },
              { label: 'Dark theme', icon: Moon, checked: !preferences.settings.customThemeId && preferences.settings.theme === 'dark', action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: 'dark', customThemeId: undefined } }) }
            ], 'Theme')}>
              {preferences.settings.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </header>
          <div className="module-content">
            {activeModule === 'mail' && <div className="mail-with-agenda"><div className="mail-agenda-primary"><ConnectedMailView onToast={showToast} composeRequest={composeRequest} searchRequest={mailSearchRequest} quickActionRequest={mailQuickActionRequest} pinRequest={mailPinRequest} /></div>
              {agendaOpen && <MailAgenda events={connectedState.events} calendars={connectedState.accounts} syncing={productivitySyncing} status={productivityMessage} onSync={() => void syncProductivity()} onClose={() => setAgendaVisible(false)} onOpen={(day, event) => { setCalendarOpenRequest((current) => ({ id: (current?.id ?? 0) + 1, day, event })); navigate('calendar') }} />}
            </div>}
            {activeModule === 'calendar' && <CalendarView
              openRequest={calendarOpenRequest}
              state={connectedState}
              query={query}
              onToast={showToast}
              writableCalendarIds={writableCalendarIds}
              onSync={syncProductivity}
              onEnableEditing={enableCalendarEditing}
              onSaveProviderEvent={saveProviderEvent}
              onDeleteProviderEvent={deleteProviderEvent}
              syncing={productivitySyncing}
              sourceMessage={productivityMessage}
              conferenceCalendars={productivity.calendars}
              interchangePanel={window.aerio.interchange && <CalendarInterchangePanel
                api={window.aerio.interchange}
                snapshot={interchange}
                calendars={[
                  ...productivity.calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, color: calendar.color, writable: calendar.canWrite })),
                  ...interchange.calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, color: calendar.color, writable: calendar.kind === 'local' }))
                ]}
                events={connectedState.events}
                onSnapshot={setInterchange}
                onSaveProviderEvent={saveProviderEvent}
                onToast={showToast}
              />}
            />}
            {activeModule === 'contacts' && <ContactsView
              state={connectedState}
              query={query}
              onCompose={startCompose}
              onToast={showToast}
              onSync={syncProductivity}
              onEnableEditing={enableContactEditing}
              onLocalContactsChange={(contacts) => setLocalModules((current) => ({ ...current, contacts }))}
              onSaveProviderContact={saveProviderContact}
              onDeleteProviderContact={deleteProviderContact}
              providerAccounts={providerContactAccounts}
              syncing={productivitySyncing}
              sourceMessage={productivityMessage}
              listActions={contactListActions}
              mergeApi={window.aerio.contactMerge}
              onProviderSnapshot={setProductivity}
              historyMail={window.aerio.mail}
              onOpenMessage={(request) => void window.aerio.window.openMessage(request)}
              interchangePanel={window.aerio.interchange && <ContactInterchangePanel
                api={window.aerio.interchange}
                contacts={connectedState.contacts}
                providerAccounts={providerContactAccounts}
                onLocalContactsChange={(contacts) => setLocalModules((current) => ({ ...current, contacts }))}
                onSaveProviderContact={saveProviderContact}
                onToast={showToast}
              />}
            />}
            {activeModule === 'tasks' && <TasksView state={connectedState} query={query} accounts={connectedAccounts} onChange={updateConnectedLocal} onToast={showToast} />}
            {activeModule === 'notes' && <NotesView state={connectedState} query={query} onChange={updateConnectedLocal} onToast={showToast} />}
            {activeModule === 'chat' && chatAvailable && chatSnapshot && <ChatView chat={window.aerio.chat!} snapshot={chatSnapshot} openRequest={chatOpenRequest} onToast={showToast} />}
          </div>
        </main>
      </div>

      {profileOpen && <ProfileModal profile={profile} onSave={(nextProfile) => setPreferences({ ...preferences, settings: { ...preferences.settings, profile: nextProfile } })} onClose={() => setProfileOpen(false)} onToast={showToast} />}
      {settingsOpen && <SettingsModal preferences={preferences} onChange={setPreferences} onLocalDataRestored={applyLocalSnapshot}
        onLocalDataRestoreStart={() => { localRestoreActive.current = true; clearTimeout(localSaveTimer.current) }}
        onLocalDataRestoreEnd={() => { localRestoreActive.current = false; setLocalSaveRevision((revision) => revision + 1) }}
        onFindDuplicates={() => { setSettingsOpen(false); setDuplicatesOpen(true) }}
        onClose={() => setSettingsOpen(false)} />}
      {duplicatesOpen && <DuplicateCleanupModal onClose={() => setDuplicatesOpen(false)} />}
      {infoOpen && <AppInfoModal kind={infoOpen} onClose={() => setInfoOpen(undefined)} />}
      {commandsOpen && (
        <div className="command-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandsOpen(false) }}>
          <section ref={commandDialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1}>
            <header><Search size={19} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex((value) => Math.min(value + 1, commandItems.length - 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((value) => Math.max(value - 1, 0)) }
              if (event.key === 'Enter' && commandItems[commandIndex]) {
                event.preventDefault()
                const item = commandItems[commandIndex]
                item.action()
                setCommandsOpen(false)
                if (!item.preserveQuery) setQuery('')
              }
            }} placeholder="Search Aerio…" /><button aria-label="Close search" onClick={() => { setQuery(''); setCommandsOpen(false) }}><X size={17} /></button></header>
            <span className="command-section-label">Quick actions</span>
            <div>
              {commandItems.map(({ label, detail, icon: Icon, action, preserveQuery }, index) => (
                <button className={index === commandIndex ? 'active' : ''} key={label} onMouseEnter={() => setCommandIndex(index)} onClick={() => { action(); setCommandsOpen(false); if (!preserveQuery) setQuery('') }}><span><Icon size={17} /></span><strong>{label}</strong><em>{detail}</em><ChevronRight size={15} /></button>
              ))}
            </div>
            <footer><span><Command size={13} /> Navigate with arrow keys</span><span>Enter to select</span><span>Esc to close</span></footer>
          </section>
        </div>
      )}
      {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
    </div>
    </KeymapProvider>
  )
}
