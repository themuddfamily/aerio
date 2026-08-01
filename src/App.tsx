import {
  CalendarDays, CheckCircle2, ChevronRight, Command, ContactRound, HelpCircle, Mail,
  MessageCircle, Moon, NotebookPen, Plus, Search, Settings, Sparkles, Sun, UserRound, WifiOff, X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import ComposeModal from './components/ComposeModal'
import SettingsModal from './components/SettingsModal'
import ProfileModal from './components/ProfileModal'
import MailView from './views/MailView'
import CalendarView from './views/CalendarView'
import ContactsView from './views/ContactsView'
import TasksView from './views/TasksView'
import NotesView from './views/NotesView'
import ChatView from './views/ChatView'
import GmailView from './views/GmailView'
import type { AppState, Contact, Message, ModuleId } from './types'
import { unreadCount, uid } from './lib/domain'
import { useContextMenu } from './components/ContextMenu'

const modules: { id: ModuleId; label: string; icon: typeof Mail; shortcut: string }[] = [
  { id: 'mail', label: 'Mail', icon: Mail, shortcut: '1' },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, shortcut: '2' },
  { id: 'contacts', label: 'Contacts', icon: ContactRound, shortcut: '3' },
  { id: 'tasks', label: 'Tasks', icon: CheckCircle2, shortcut: '4' },
  { id: 'notes', label: 'Notes', icon: NotebookPen, shortcut: '5' },
  { id: 'chat', label: 'Chat', icon: MessageCircle, shortcut: '6' }
]

interface ComposeState {
  replyTo?: Message
  initialTo?: string
  replyAll?: boolean
  forward?: boolean
  draft?: Message
}

export default function App() {
  const { showContextMenu } = useContextMenu()
  const [state, setState] = useState<AppState | null>(null)
  const [activeModule, setActiveModule] = useState<ModuleId>('mail')
  const [query, setQuery] = useState('')
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const [mailMode, setMailMode] = useState<'gmail' | 'demo'>(() =>
    new URLSearchParams(window.location.search).get('workspace') === 'gmail' ? 'gmail' : 'demo')
  const [realComposeRequest, setRealComposeRequest] = useState(0)
  const [requestedDemoMessageId, setRequestedDemoMessageId] = useState<string>()
  const [requestedConversationId, setRequestedConversationId] = useState<string>()
  const [commandIndex, setCommandIndex] = useState(0)
  const hydrated = useRef(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showToast = useCallback((message: string) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }, [])

  useEffect(() => {
    void window.aerio.loadState().then((loaded) => {
      setState(loaded)
      setActiveModule(loaded.settings.startModule)
      queueMicrotask(() => { hydrated.current = true })
    }).catch(() => showToast('Aerio could not open its local data'))
    void window.aerio.mail.accounts.list().then((accounts) => {
      if (accounts.length) setMailMode('gmail')
    }).catch(() => {
      // The separate demo workspace remains usable if the mail engine cannot initialize.
    })
  }, [showToast])

  useEffect(() => {
    if (!state || !hydrated.current) return
    setSaveStatus('saving')
    const timer = setTimeout(() => {
      void window.aerio.saveState(state).then(() => setSaveStatus('saved')).catch(() => showToast('Changes could not be saved'))
    }, 350)
    return () => clearTimeout(timer)
  }, [showToast, state])

  useEffect(() => {
    if (!state) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = state.settings.theme === 'system'
        ? media.matches ? 'dark' : 'light'
        : state.settings.theme
    }
    applyTheme()
    document.documentElement.dataset.density = state.settings.density
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [state])

  const startCompose = useCallback((input: ComposeState = {}) => {
    if (mailMode === 'gmail') {
      setActiveModule('mail')
      setRealComposeRequest((value) => value + 1)
    } else {
      setCompose(input)
    }
  }, [mailMode])

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
      if (modifier && ['1', '2', '3', '4', '5', '6'].includes(event.key)) {
        event.preventDefault()
        setActiveModule(modules[Number(event.key) - 1].id)
      }
      if (event.key === 'Escape') {
        setCommandsOpen(false)
        setCompose(null)
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
      ? [{ label: `Search ${modules.find((item) => item.id === activeModule)?.label ?? 'Aerio'} for “${query.trim()}”`, detail: 'Enter', icon: Search, action: () => undefined, preserveQuery: true }, ...quick]
      : quick
  }, [activeModule, query, startCompose])

  useEffect(() => setCommandIndex(0), [commandsOpen, query])

  if (!state) {
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

  const profile = state.settings.profile ?? {
    displayName: state.accounts[0]?.name ?? 'Aerio user',
    email: state.accounts[0]?.email
  }
  const profileInitials = profile.displayName.trim().split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'A'

  const openContactChat = (contact: Contact) => {
    const existing = state.conversations.find((conversation) => conversation.name === contact.name)
    const conversationId = existing?.id ?? uid('conversation')
    if (!existing) {
      setState({
        ...state,
        conversations: [{ id: conversationId, name: contact.name, participants: [contact.name], color: contact.color, online: false, unread: 0, messages: [] }, ...state.conversations]
      })
    }
    setRequestedConversationId(conversationId)
    setActiveModule('chat')
  }

  const openDemoMessage = (messageId: string) => {
    setRequestedDemoMessageId(messageId)
    setMailMode('demo')
    setActiveModule('mail')
  }

  const showModuleMenu = (event: React.MouseEvent, module: typeof modules[number]) => showContextMenu(event, [
    { label: `Open ${module.label}`, icon: module.icon, action: () => navigate(module.id) },
    ...(module.id === 'mail' ? [{ label: 'New message', icon: Plus, separatorBefore: true, action: () => startCompose() }] : []),
    { label: `Search ${module.label}`, icon: Search, separatorBefore: module.id !== 'mail', action: () => { navigate(module.id); setCommandsOpen(true) } },
    { label: 'Open on startup', icon: Sparkles, separatorBefore: true, checked: state.settings.startModule === module.id, action: () => setState({ ...state, settings: { ...state.settings, startModule: module.id } }) }
  ], module.label)

  const setWorkspace = (mode: 'demo' | 'gmail') => {
    setMailMode(mode)
    setActiveModule('mail')
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-frame">
        <nav className="module-rail" aria-label="Aerio modules">
          <div className="rail-modules">
            {modules.map((module) => {
              const { id, label, icon: Icon } = module
              const badge = unreadCount(state, id)
              return (
                <button key={id} className={activeModule === id ? 'active' : ''} aria-label={label} title={`${label} · Ctrl ${modules.find((item) => item.id === id)?.shortcut}`} onClick={() => navigate(id)} onContextMenu={(event) => showModuleMenu(event, module)}>
                  <Icon size={21} strokeWidth={1.9} />
                  {badge > 0 && <em>{badge > 9 ? '9+' : badge}</em>}
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          <div className="rail-bottom">
            <button aria-label="What’s new" title="What’s new" onClick={() => showToast('Welcome to the first Aerio preview')}><Sparkles size={20} /></button>
            <button aria-label="Help" title="Keyboard shortcuts: Ctrl K" onClick={() => setCommandsOpen(true)}><HelpCircle size={20} /></button>
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
            <button className={`local-badge mode-switch ${mailMode === 'gmail' ? 'gmail' : ''}`} onClick={() => setWorkspace(mailMode === 'gmail' ? 'demo' : 'gmail')} onContextMenu={(event) => showContextMenu(event, [
              { label: 'Demo workspace', icon: WifiOff, checked: mailMode === 'demo', action: () => setWorkspace('demo') },
              { label: 'Real mail', icon: Mail, checked: mailMode === 'gmail', action: () => setWorkspace('gmail') },
              { label: 'New message', icon: Plus, separatorBefore: true, action: () => startCompose() }
            ], 'Mail workspace')}>
              {mailMode === 'gmail' ? <Mail size={14} /> : <WifiOff size={14} />}
              {mailMode === 'gmail' ? 'Real mail' : 'Demo workspace'}
            </button>
            <span className={`save-indicator ${saveStatus}`}>{saveStatus === 'saved' ? 'All changes saved' : 'Saving…'}</span>
            <button className="theme-quick" title="Toggle theme" onClick={() => setState({ ...state, settings: { ...state.settings, theme: state.settings.theme === 'dark' ? 'light' : 'dark' } })} onContextMenu={(event) => showContextMenu(event, [
              { label: 'System theme', icon: Settings, checked: state.settings.theme === 'system', action: () => setState({ ...state, settings: { ...state.settings, theme: 'system' } }) },
              { label: 'Light theme', icon: Sun, checked: state.settings.theme === 'light', action: () => setState({ ...state, settings: { ...state.settings, theme: 'light' } }) },
              { label: 'Dark theme', icon: Moon, checked: state.settings.theme === 'dark', action: () => setState({ ...state, settings: { ...state.settings, theme: 'dark' } }) }
            ], 'Theme')}>
              {state.settings.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </header>
          <div className="module-content">
            {activeModule === 'mail' && mailMode === 'gmail' && <GmailView onToast={showToast} composeRequest={realComposeRequest} />}
            {activeModule === 'mail' && mailMode === 'demo' && <MailView state={state} query={query} requestedMessageId={requestedDemoMessageId} onChange={setState} onCompose={(replyTo, replyAll, forward, draft) => setCompose({ replyTo, replyAll, forward, draft })} onNavigate={navigate} onToast={showToast} />}
            {activeModule === 'calendar' && <CalendarView state={state} query={query} onChange={setState} onToast={showToast} />}
            {activeModule === 'contacts' && <ContactsView state={state} query={query} onChange={setState} onCompose={(replyTo, initialTo) => setCompose({ replyTo, initialTo })} onChat={openContactChat} onOpenMessage={openDemoMessage} onToast={showToast} />}
            {activeModule === 'tasks' && <TasksView state={state} query={query} onChange={setState} onToast={showToast} />}
            {activeModule === 'notes' && <NotesView state={state} query={query} onChange={setState} onToast={showToast} />}
            {activeModule === 'chat' && <ChatView state={state} query={query} requestedConversationId={requestedConversationId} onChange={setState} onToast={showToast} />}
          </div>
        </main>
      </div>

      {compose && mailMode === 'demo' && <ComposeModal state={state} replyTo={compose.replyTo} replyAll={compose.replyAll} forward={compose.forward} draft={compose.draft} initialTo={compose.initialTo} onChange={setState} onClose={() => setCompose(null)} onToast={showToast} />}
      {profileOpen && <ProfileModal profile={profile} onSave={(nextProfile) => setState({ ...state, settings: { ...state.settings, profile: nextProfile } })} onClose={() => setProfileOpen(false)} onToast={showToast} />}
      {settingsOpen && <SettingsModal state={state} onChange={setState} onClose={() => setSettingsOpen(false)} onReset={async () => {
        try {
          const next = await window.aerio.resetState()
          hydrated.current = false
          setState(next)
          setActiveModule(next.settings.startModule)
          setSettingsOpen(false)
          showToast('Demo data restored')
          queueMicrotask(() => { hydrated.current = true })
        } catch (error) {
          showToast(error instanceof Error ? error.message : 'Demo data could not be reset')
        }
      }} />}
      {commandsOpen && (
        <div className="command-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setCommandsOpen(false) }}>
          <section className="command-palette" role="dialog" aria-label="Command palette">
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
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  )
}
