import {
  CalendarDays, CheckCircle2, ChevronRight, Command, ContactRound, HelpCircle, Mail,
  Moon, NotebookPen, Plus, Search, Settings, Sparkles, Sun, UserRound, X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import SettingsModal from './components/SettingsModal'
import ProfileModal from './components/ProfileModal'
import AppInfoModal from './components/AppInfoModal'
import CalendarView from './views/CalendarView'
import ContactsView from './views/ContactsView'
import TasksView from './views/TasksView'
import NotesView from './views/NotesView'
import ConnectedMailView from './views/ConnectedMailView'
import type { AppPreferences, AppState, CalendarEvent, ModuleId } from './types'
import type { MailAccountSummary } from './mail-types'
import type { LocalModuleSnapshot, ProductivitySnapshot } from './productivity-types'
import { unreadCount } from './lib/domain'
import { useContextMenu } from './components/ContextMenu'
import { useDialogFocus } from './lib/dialog-focus'

const modules: { id: ModuleId; label: string; icon: typeof Mail; shortcut: string }[] = [
  { id: 'mail', label: 'Mail', icon: Mail, shortcut: '1' },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, shortcut: '2' },
  { id: 'contacts', label: 'Contacts', icon: ContactRound, shortcut: '3' },
  { id: 'tasks', label: 'Tasks', icon: CheckCircle2, shortcut: '4' },
  { id: 'notes', label: 'Notes', icon: NotebookPen, shortcut: '5' }
]

const emptyProductivity: ProductivitySnapshot = { calendars: [], events: [], contacts: [], sync: [] }
const emptyLocalModules: LocalModuleSnapshot = { tasks: [], notes: [], contacts: [] }

interface ComposeRequest {
  id: number
  initialTo?: string
}

export default function App() {
  const { showContextMenu } = useContextMenu()
  const [preferences, setPreferences] = useState<AppPreferences | null>(null)
  const [activeModule, setActiveModule] = useState<ModuleId>('mail')
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState<'help' | 'whats-new'>()
  const [toast, setToast] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const [composeRequest, setComposeRequest] = useState<ComposeRequest>({ id: 0 })
  const [mailSearchRequest, setMailSearchRequest] = useState({ id: 0, query: '' })
  const [connectedAccounts, setConnectedAccounts] = useState<MailAccountSummary[]>([])
  const [productivity, setProductivity] = useState<ProductivitySnapshot>(emptyProductivity)
  const [localModules, setLocalModules] = useState<LocalModuleSnapshot>(emptyLocalModules)
  const [productivitySyncing, setProductivitySyncing] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const hydrated = useRef(false)
  const localModulesHydrated = useRef(false)
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

  useEffect(() => {
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
      setLocalModules(localSnapshot)
      queueMicrotask(() => { localModulesHydrated.current = true })
    }).catch(() => showToast('Local Tasks and Notes could not be opened'))
  }, [showToast])

  useEffect(() => {
    if (!localModulesHydrated.current) return
    const timer = setTimeout(() => {
      void window.aerio.productivity.saveLocal(localModules).catch(() => showToast('Local Tasks or Notes could not be saved'))
    }, 350)
    return () => clearTimeout(timer)
  }, [localModules, showToast])

  const syncProductivity = useCallback(async (options?: { quiet?: boolean }) => {
    if (productivitySyncingRef.current) return
    productivitySyncingRef.current = true
    setProductivitySyncing(true)
    try {
      const accounts = (await window.aerio.mail.accounts.list()).filter((account) => !account.archived)
      setConnectedAccounts(accounts)
      const supported = accounts.filter((account) => account.provider === 'gmail' || account.provider === 'microsoft')
      if (!supported.length) {
        if (!options?.quiet) showToast('Connect Google or Microsoft to synchronize Calendar and Contacts')
        return
      }
      let latest = await window.aerio.productivity.snapshot()
      const failures: string[] = []
      for (const account of supported) {
        try { latest = await window.aerio.productivity.sync(account.id) }
        catch (error) { failures.push(error instanceof Error ? error.message : `${account.email} could not synchronize`) }
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
    .filter((account) => !account.archived && (account.provider === 'gmail' || account.provider === 'microsoft'))
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

  const saveProviderEvent = useCallback(async (event: CalendarEvent, exists: boolean) => {
    const latest = exists
      ? await window.aerio.productivity.updateEvent(event)
      : await window.aerio.productivity.createEvent(event)
    setProductivity(latest)
  }, [])

  const deleteProviderEvent = useCallback(async (event: CalendarEvent) => {
    setProductivity(await window.aerio.productivity.deleteEvent(event.id))
  }, [])

  useEffect(() => {
    if (!preferences || !hydrated.current) return
    setSaveStatus('saving')
    const timer = setTimeout(() => {
      void window.aerio.savePreferences(preferences).then(() => setSaveStatus('saved')).catch(() => showToast('Preferences could not be saved'))
    }, 350)
    return () => clearTimeout(timer)
  }, [preferences, showToast])

  useEffect(() => {
    if (!preferences) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = preferences.settings.theme === 'system'
        ? media.matches ? 'dark' : 'light'
        : preferences.settings.theme
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandsOpen((value) => !value)
      }
      if (modifier && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        startCompose()
      }
      if (modifier && ['1', '2', '3', '4', '5'].includes(event.key)) {
        event.preventDefault()
        setActiveModule(modules[Number(event.key) - 1].id)
      }
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

  const commandItems = useMemo(() => {
    const quick = [
      { label: 'Compose a new message', detail: 'Ctrl N', icon: Plus, action: () => startCompose(), preserveQuery: false },
      ...modules.map((item) => ({ label: `Open ${item.label}`, detail: `Ctrl ${item.shortcut}`, icon: item.icon, action: () => setActiveModule(item.id), preserveQuery: false })),
      { label: 'Open settings', detail: '', icon: Settings, action: () => setSettingsOpen(true), preserveQuery: false }
    ].filter((item) => !query || item.label.toLowerCase().includes(query.toLowerCase()))
    return query.trim()
      ? [{ label: `Search ${modules.find((item) => item.id === activeModule)?.label ?? 'Aerio'} for “${query.trim()}”`, detail: 'Enter', icon: Search, action: () => {
        if (activeModule === 'mail') setMailSearchRequest((current) => ({ id: current.id + 1, query: query.trim() }))
      }, preserveQuery: true }, ...quick]
      : quick
  }, [activeModule, query, startCompose])

  useEffect(() => setCommandIndex(0), [commandsOpen, query])

  if (!preferences) {
    return (
      <div className="loading-screen">
        <div className="loading-mark">A</div>
        <h1>Aerio</h1>
        <p>Bringing your day into focus…</p>
        <span className="loading-line"><i /></span>
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
    accounts: productivity.calendars.map((calendar) => {
      const account = accountById.get(calendar.accountId)
      return {
        id: calendar.id,
        name: calendar.name,
        email: account?.email ?? '',
        initials: calendar.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
        color: calendar.color,
        provider: calendar.provider
      }
    }),
    events: productivity.events,
    contacts: [...(localModules.contacts ?? []), ...productivity.contacts],
    tasks: localModules.tasks,
    notes: localModules.notes
  }
  const writableCalendarIds = new Set(productivity.calendars.filter((calendar) => calendar.canWrite).map((calendar) => calendar.id))
  const updateConnectedLocal = (next: AppState) => setLocalModules((current) => ({ ...current, tasks: next.tasks, notes: next.notes }))
  const productivityMessage = productivity.sync.some((item) => item.phase === 'error')
    ? productivity.sync.find((item) => item.phase === 'error')?.error ?? 'A provider needs attention.'
    : productivity.sync.some((item) => item.lastSyncedAt)
      ? `Last synchronized ${new Date(Math.max(...productivity.sync.flatMap((item) => item.lastSyncedAt ? [Date.parse(item.lastSyncedAt)] : []))).toLocaleString()}`
      : 'Calendar and Contacts have not been synchronized yet.'

  const showModuleMenu = (event: React.MouseEvent, module: typeof modules[number]) => showContextMenu(event, [
    { label: `Open ${module.label}`, icon: module.icon, action: () => navigate(module.id) },
    ...(module.id === 'mail' ? [{ label: 'New message', icon: Plus, separatorBefore: true, action: () => startCompose() }] : []),
    { label: `Search ${module.label}`, icon: Search, separatorBefore: module.id !== 'mail', action: () => { navigate(module.id); setCommandsOpen(true) } },
    { label: 'Open on startup', icon: Sparkles, separatorBefore: true, checked: preferences.settings.startModule === module.id, action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, startModule: module.id } }) }
  ], module.label)

  return (
    <div className="app">
      <TitleBar />
      <div className="app-frame">
        <nav className="module-rail" aria-label="Aerio modules">
          <div className="rail-modules">
            {modules.map((module) => {
              const { id, label, icon: Icon } = module
              const badge = unreadCount(connectedState, id)
              return (
                <button key={id} className={activeModule === id ? 'active' : ''} aria-label={label} aria-current={activeModule === id ? 'page' : undefined} title={`${label} · Ctrl ${modules.find((item) => item.id === id)?.shortcut}`} onClick={() => navigate(id)} onContextMenu={(event) => showModuleMenu(event, module)}>
                  <Icon size={21} strokeWidth={1.9} />
                  {badge > 0 && <em>{badge > 9 ? '9+' : badge}</em>}
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          <div className="rail-bottom">
            <button aria-label="What’s new" title="What’s new" onClick={() => setInfoOpen('whats-new')}><Sparkles size={20} /></button>
            <button aria-label="Help" title="Help and keyboard shortcuts" onClick={() => setInfoOpen('help')}><HelpCircle size={20} /></button>
            <button aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)} onContextMenu={(event) => showContextMenu(event, [{ label: 'Open settings', icon: Settings, action: () => setSettingsOpen(true) }], 'Settings')}><Settings size={20} /></button>
            <button className="profile-button" aria-label={`Profile: ${profile.displayName}`} title="Your Aerio profile" onClick={() => setProfileOpen(true)} onContextMenu={(event) => showContextMenu(event, [
              { label: 'Open profile', icon: UserRound, action: () => setProfileOpen(true) }
            ], profile.displayName)}><span>{profile.avatarDataUrl ? <img src={profile.avatarDataUrl} alt="" /> : profileInitials}</span><i /></button>
          </div>
        </nav>
        <main className="app-main">
          <header className="global-bar">
            <button className="command-search" onClick={() => setCommandsOpen(true)} onContextMenu={(event) => showContextMenu(event, [
              { label: 'Search and commands', icon: Search, action: () => setCommandsOpen(true) },
              { label: 'Clear search', icon: X, disabled: !query, action: () => setQuery('') }
            ], 'Search')}>
              <Search size={16} />
              <span>Search {modules.find((item) => item.id === activeModule)?.label.toLowerCase()} or run a command</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button className="local-badge connected" onClick={() => void syncProductivity()} onContextMenu={(event) => showContextMenu(event, [
              { label: 'Sync Calendar and Contacts', icon: CalendarDays, disabled: productivitySyncing, action: () => syncProductivity() },
              { label: 'New message', icon: Plus, separatorBefore: true, action: () => startCompose() }
            ], 'Connected services')}>
              <Mail size={14} />
              Connected services
            </button>
            <span className={`save-indicator ${saveStatus}`} aria-live="polite">{saveStatus === 'saved' ? 'All changes saved' : 'Saving…'}</span>
            <button className="theme-quick" aria-label="Toggle theme" title="Toggle theme" onClick={() => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: preferences.settings.theme === 'dark' ? 'light' : 'dark' } })} onContextMenu={(event) => showContextMenu(event, [
              { label: 'System theme', icon: Settings, checked: preferences.settings.theme === 'system', action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: 'system' } }) },
              { label: 'Light theme', icon: Sun, checked: preferences.settings.theme === 'light', action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: 'light' } }) },
              { label: 'Dark theme', icon: Moon, checked: preferences.settings.theme === 'dark', action: () => setPreferences({ ...preferences, settings: { ...preferences.settings, theme: 'dark' } }) }
            ], 'Theme')}>
              {preferences.settings.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </header>
          <div className="module-content">
            {activeModule === 'mail' && <ConnectedMailView onToast={showToast} composeRequest={composeRequest} searchRequest={mailSearchRequest} />}
            {activeModule === 'calendar' && <CalendarView
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
            />}
            {activeModule === 'contacts' && <ContactsView state={connectedState} query={query} onCompose={startCompose} onToast={showToast} onSync={syncProductivity} onLocalContactsChange={(contacts) => setLocalModules((current) => ({ ...current, contacts }))} syncing={productivitySyncing} sourceMessage={productivityMessage} />}
            {activeModule === 'tasks' && <TasksView state={connectedState} query={query} onChange={updateConnectedLocal} onToast={showToast} />}
            {activeModule === 'notes' && <NotesView state={connectedState} query={query} onChange={updateConnectedLocal} onToast={showToast} />}
          </div>
        </main>
      </div>

      {profileOpen && <ProfileModal profile={profile} onSave={(nextProfile) => setPreferences({ ...preferences, settings: { ...preferences.settings, profile: nextProfile } })} onClose={() => setProfileOpen(false)} onToast={showToast} />}
      {settingsOpen && <SettingsModal preferences={preferences} onChange={setPreferences} onLocalDataRestored={setLocalModules} onClose={() => setSettingsOpen(false)} />}
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
  )
}
