import { CloudDownload, Database, HardDrive, LoaderCircle, RotateCcw, Save, Search, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MailAccountSummary, MailFolder, MailLabel, MailMessageDetail } from '../mail-types'
import type {
  MailDownloadMode,
  MailOfflineAvailability,
  MailOfflineSettings,
  MailSearchCoverage,
  MailSyncWindow,
  MailSyncWindowUnit
} from '../offline-sync-types'
import { DOWNLOAD_MODE_LABELS, MAX_WINDOW_DAYS, MAX_WINDOW_MONTHS, NOT_DOWNLOADED_NOTICE, describeWindow, folderViewLocation } from '../lib/offline-sync'
import { formatFileSize } from '../lib/domain'
import type { ContextMenuItem } from './ContextMenu'
import Modal from './Modal'

const MODES: MailDownloadMode[] = ['full', 'bodies', 'headers']
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const count = (value: number) => value.toLocaleString()

/** Accounts whose scope can be configured: Local Folders and POP3 keep everything on this computer. */
export const offlineScopeSupported = (account?: MailAccountSummary) => Boolean(account && !account.archived && account.provider !== 'local' && account.provider !== 'pop3' && account.provider !== 'exchange')

export function availabilitySummary(value: MailOfflineAvailability) {
  const parts = [`${count(value.full)} full`]
  if (value.bodyOnly) parts.push(`${count(value.bodyOnly)} without attachments`)
  if (value.headersOnly) parts.push(`${count(value.headersOnly)} headers only`)
  if (value.outsideWindow) parts.push(`${count(value.outsideWindow)} outside the window`)
  return `${count(value.total)} cached message${value.total === 1 ? '' : 's'}: ${parts.join(' · ')} · ${value.bytes ? formatFileSize(value.bytes) : '0 bytes'} on this computer`
}

interface WindowFieldsProps {
  value: MailSyncWindow
  onChange(value: MailSyncWindow): void
  idPrefix: string
}

function WindowFields({ value, onChange, idPrefix }: WindowFieldsProps) {
  const max = value.unit === 'days' ? MAX_WINDOW_DAYS : MAX_WINDOW_MONTHS
  const setUnit = (unit: MailSyncWindowUnit) => onChange(unit === 'all' ? { unit, amount: 0 } : { unit, amount: unit === 'days' ? 30 : 6 })
  return <div className="offline-window-fields">
    <label className="field"><span>Synchronize</span><select id={`${idPrefix}-window`} value={value.unit} onChange={(event) => setUnit(event.target.value as MailSyncWindowUnit)}>
      <option value="all">All mail</option>
      <option value="days">Recent days</option>
      <option value="months">Recent months</option>
    </select></label>
    {value.unit !== 'all' && <label className="field offline-window-amount"><span>{value.unit === 'days' ? 'Days' : 'Months'}</span><input type="number" min={1} max={max} value={value.amount || ''} onChange={(event) => onChange({ unit: value.unit, amount: Math.round(Number(event.target.value)) })} /></label>}
  </div>
}

const windowValid = (value: MailSyncWindow) => value.unit === 'all' || (Number.isInteger(value.amount) && value.amount >= 1 && value.amount <= (value.unit === 'days' ? MAX_WINDOW_DAYS : MAX_WINDOW_MONTHS))

interface ModeChoiceProps {
  value: MailDownloadMode
  name: string
  onChange(value: MailDownloadMode): void
}

function ModeChoice({ value, name, onChange }: ModeChoiceProps) {
  return <div className="offline-mode-choice" role="radiogroup" aria-label="What to download">
    {MODES.map((mode) => <label key={mode} className={`offline-mode-option ${value === mode ? 'selected' : ''}`}>
      <input type="radio" name={name} value={mode} checked={value === mode} onChange={() => onChange(mode)} />
      <span><strong>{DOWNLOAD_MODE_LABELS[mode].title}</strong><small>{DOWNLOAD_MODE_LABELS[mode].detail}</small></span>
    </label>)}
  </div>
}

/** Account defaults, folder overrides and what is available offline, in the account settings dialog. */
export function MailOfflineSyncSection({ account, onToast }: { account: MailAccountSummary; onToast(message: string): void }) {
  const api = window.aerio.mail.offline
  const [settings, setSettings] = useState<MailOfflineSettings>()
  const [availability, setAvailability] = useState<MailOfflineAvailability>()
  const [coverage, setCoverage] = useState<MailSearchCoverage>()
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [mode, setMode] = useState<MailDownloadMode>('full')
  const [syncWindow, setSyncWindow] = useState<MailSyncWindow>({ unit: 'all', amount: 0 })
  const [busy, setBusy] = useState<'load' | 'save' | 'reclaim' | string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (!api) return
    const [nextSettings, nextAvailability, nextCoverage, nextLabels] = await Promise.all([
      api.settings(account.id),
      api.availability(account.id),
      api.searchCoverage([account.id]),
      window.aerio.mail.mail.labels([account.id])
    ])
    setSettings(nextSettings)
    setMode(nextSettings.defaults.downloadMode)
    setSyncWindow(nextSettings.defaults.window)
    setAvailability(nextAvailability)
    setCoverage(nextCoverage[0])
    setLabels(nextLabels)
  }, [account.id, api])

  useEffect(() => {
    setBusy('load')
    setError(undefined)
    void refresh().catch((reason) => setError(errorText(reason, 'Offline settings could not be loaded'))).finally(() => setBusy(undefined))
  }, [refresh])

  if (!api) return null
  if (settings && !settings.supported) return <section className="offline-sync-section">
    <h3>Offline availability</h3>
    <p>{settings.unsupportedReason ?? 'All mail in this account is stored on this computer, so it is always available offline and fully searchable.'}</p>
  </section>

  const changed = settings && (settings.defaults.downloadMode !== mode || describeWindow(settings.defaults.window) !== describeWindow(syncWindow))
  const save = async () => {
    setBusy('save')
    try {
      await api.setAccountPolicy(account.id, { downloadMode: mode, window: syncWindow })
      await refresh()
      onToast('Offline settings applied. Mail outside the new scope stays on the server.')
    } catch (reason) {
      onToast(errorText(reason, 'Offline settings could not be saved'))
    } finally {
      setBusy(undefined)
    }
  }
  const reclaim = async () => {
    setBusy('reclaim')
    try {
      const result = await api.reclaim(account.id)
      await refresh()
      onToast(result.messages ? `Freed ${formatFileSize(result.bytes)} from ${count(result.messages)} message${result.messages === 1 ? '' : 's'}` : 'Nothing outside the offline scope to free')
    } catch (reason) {
      onToast(errorText(reason, 'Space could not be freed'))
    } finally {
      setBusy(undefined)
    }
  }
  const clearOverride = async (labelId: string) => {
    setBusy(labelId)
    try {
      await api.setFolderOverride(account.id, labelId, null)
      await refresh()
      onToast('The folder follows the account default again')
    } catch (reason) {
      onToast(errorText(reason, 'The folder setting could not be removed'))
    } finally {
      setBusy(undefined)
    }
  }
  const labelName = (labelId: string) => labels.find((label) => label.id === labelId)?.name ?? roleName(labelId)

  return <section className="offline-sync-section">
    <h3>Offline download and sync scope</h3>
    <p>Choose how much of this mailbox is stored on this computer. Changing it never deletes mail on the server; drafts and messages with changes waiting to sync are always kept.</p>
    {error && <p className="account-error">{error}</p>}
    {busy === 'load' && !settings && <p className="offline-muted"><LoaderCircle className="spin" size={14} /> Loading offline settings…</p>}
    {settings && <>
      <ModeChoice value={mode} name={`offline-mode-${account.id}`} onChange={setMode} />
      <WindowFields value={syncWindow} onChange={setSyncWindow} idPrefix={`offline-${account.id}`} />
      <div className="settings-actions">
        <button className="button ghost" disabled={Boolean(busy) || !changed || !windowValid(syncWindow)} onClick={() => void save()}><Save size={15} /> {busy === 'save' ? 'Applying…' : 'Apply offline settings'}</button>
        <button className="button ghost" disabled={Boolean(busy)} onClick={() => void reclaim()}><HardDrive size={15} /> {busy === 'reclaim' ? 'Freeing space…' : 'Free space outside the scope'}</button>
      </div>
      {availability && <p className="offline-availability" aria-live="polite"><Database size={14} /> {availabilitySummary(availability)}</p>}
      {coverage && <p className={`offline-coverage ${coverage.complete ? 'complete' : ''}`}><Search size={14} /> {coverage.complete ? 'Search covers the whole mailbox.' : `Search covers downloaded mail only: ${coverage.reasons.join('; ')}.${coverage.serverSearch ? ' Use “Search server” in the search results to find the rest.' : ''}`}</p>}
      {settings.overrides.length > 0 && <div className="offline-overrides">
        <h4>Folder overrides</h4>
        <ul>{settings.overrides.map((override) => <li key={override.labelId}>
          <span><strong>{labelName(override.labelId)}</strong><small>{[override.downloadMode ? DOWNLOAD_MODE_LABELS[override.downloadMode].title : undefined, override.window ? describeWindow(override.window) : undefined].filter(Boolean).join(' · ')}</small></span>
          <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void clearOverride(override.labelId)}><RotateCcw size={13} /> Use default</button>
        </li>)}</ul>
      </div>}
      <p className="offline-muted">Change a single folder from its right-click menu: Offline settings…</p>
    </>}
  </section>
}

const ROLE_NAMES: Record<string, string> = { INBOX: 'Inbox', SENT: 'Sent', DRAFT: 'Drafts', SPAM: 'Spam', TRASH: 'Trash' }
const roleName = (labelId: string) => ROLE_NAMES[labelId] ?? labelId.replace(/^folder:/, '')

export interface OfflineFolderTarget {
  accountId: string
  labelId: string
  name: string
}

/** The "Offline settings…" folder menu entry, for accounts whose scope can be configured. */
export function offlineFolderMenuItems(account: MailAccountSummary | undefined, target: Omit<OfflineFolderTarget, 'accountId'> | undefined, open: (target: OfflineFolderTarget) => void, icon?: ContextMenuItem['icon']): ContextMenuItem[] {
  if (!window.aerio.mail.offline || !offlineScopeSupported(account) || !target?.labelId) return []
  return [{ label: 'Offline settings…', icon: icon ?? CloudDownload, separatorBefore: true, action: () => open({ accountId: account!.id, ...target }) }]
}

/** The folder location a sidebar mailbox maps to, for its menu. */
export function mailboxOfflineTarget(folder: MailFolder, name: string) {
  const labelId = folderViewLocation(folder)
  return labelId ? { labelId, name } : undefined
}

type OverrideChoice = MailDownloadMode | 'inherit'

/** Folder properties: a per-folder override of the account's download mode and window. */
export function MailFolderOfflineModal({ target, onClose, onToast }: { target: OfflineFolderTarget; onClose(): void; onToast(message: string): void }) {
  const api = window.aerio.mail.offline!
  const [settings, setSettings] = useState<MailOfflineSettings>()
  const [availability, setAvailability] = useState<MailOfflineAvailability>()
  const [mode, setMode] = useState<OverrideChoice>('inherit')
  const [windowChoice, setWindowChoice] = useState<MailSyncWindow | 'inherit'>('inherit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void Promise.all([api.settings(target.accountId), api.availability(target.accountId, target.labelId)]).then(([nextSettings, nextAvailability]) => {
      setSettings(nextSettings)
      setAvailability(nextAvailability)
      const override = nextSettings.overrides.find((item) => item.labelId === target.labelId)
      setMode(override?.downloadMode ?? 'inherit')
      setWindowChoice(override?.window ?? 'inherit')
    }).catch((reason) => setError(errorText(reason, 'Offline settings could not be loaded')))
  }, [api, target.accountId, target.labelId])

  const hasOverride = Boolean(settings?.overrides.some((item) => item.labelId === target.labelId))
  const custom = mode !== 'inherit' || windowChoice !== 'inherit'
  const save = async (useDefault = false) => {
    setBusy(true)
    try {
      await api.setFolderOverride(target.accountId, target.labelId, useDefault || !custom ? null : {
        ...(mode !== 'inherit' ? { downloadMode: mode } : {}),
        ...(windowChoice !== 'inherit' ? { window: windowChoice } : {})
      })
      onToast(useDefault || !custom ? `${target.name} follows the account default` : `Offline settings saved for ${target.name}`)
      onClose()
    } catch (reason) {
      onToast(errorText(reason, 'Offline settings could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={`Offline settings: ${target.name}`} subtitle="Overrides the account default for this folder" width="small" onClose={onClose}>
    <div className="offline-folder-form">
      {error && <p className="account-error">{error}</p>}
      {settings && <>
        <p className="offline-muted">Account default: {DOWNLOAD_MODE_LABELS[settings.defaults.downloadMode].title} · {describeWindow(settings.defaults.window)}. A message filed in several folders keeps the most complete content any of them asks for.</p>
        <label className="field"><span>Download</span><select value={mode} onChange={(event) => setMode(event.target.value as OverrideChoice)}>
          <option value="inherit">Account default</option>
          {MODES.map((item) => <option key={item} value={item}>{DOWNLOAD_MODE_LABELS[item].title}</option>)}
        </select></label>
        {mode !== 'inherit' && <p className="offline-muted">{DOWNLOAD_MODE_LABELS[mode].detail}</p>}
        <label className="toggle-row"><span><strong>Use the account’s date window</strong><small>{describeWindow(settings.defaults.window)}</small></span><input type="checkbox" checked={windowChoice === 'inherit'} onChange={(event) => setWindowChoice(event.target.checked ? 'inherit' : settings.defaults.window)} /></label>
        {windowChoice !== 'inherit' && <WindowFields value={windowChoice} onChange={setWindowChoice} idPrefix={`offline-folder-${target.labelId}`} />}
        {availability && <p className="offline-availability"><Database size={14} /> {availabilitySummary(availability)}</p>}
      </>}
    </div>
    <footer className="modal-footer">
      {hasOverride && <button className="button ghost" disabled={busy} onClick={() => void save(true)}><RotateCcw size={15} /> Use account default</button>}
      <span className="spacer" />
      <button className="button ghost" onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={busy || !settings || (windowChoice !== 'inherit' && !windowValid(windowChoice))} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : 'Save'}</button>
    </footer>
  </Modal>
}

interface ListFooterProps {
  accounts: MailAccountSummary[]
  folder: MailFolder
  labelId?: string
  /** Changes whenever the list reloads, so the window report stays current. */
  refreshKey: string
  onExtended(): void
  onToast(message: string): void
}

/** "Load more" / "Load all" at the end of a list limited by a sync window. */
export function MailOfflineListFooter({ accounts, folder, labelId, refreshKey, onExtended, onToast }: ListFooterProps) {
  const api = window.aerio.mail.offline
  const scoped = useMemo(() => accounts.filter(offlineScopeSupported), [accounts])
  const location = folderViewLocation(folder, labelId)
  const [reports, setReports] = useState<MailOfflineAvailability[]>([])
  const [busy, setBusy] = useState<'more' | 'all'>()
  const accountKey = scoped.map((account) => account.id).join(',')

  useEffect(() => {
    if (!api || !accountKey) {
      setReports([])
      return
    }
    let active = true
    void Promise.all(accountKey.split(',').map((id) => api.availability(id, location || undefined)))
      .then((values) => { if (active) setReports(values) })
      .catch(() => { if (active) setReports([]) })
    return () => { active = false }
  }, [accountKey, api, location, refreshKey])

  const scopedReports = reports.filter((report) => scoped.some((account) => account.id === report.accountId))
  const limited = scopedReports.filter((report) => report.windowStart)
  const loadingAll = scopedReports.find((report) => report.loadAllUntil)
  if (!api || (!limited.length && !loadingAll)) return null
  const earliest = limited.map((report) => report.windowStart!).sort()[0]
  const extend = async (mode: 'more' | 'all') => {
    setBusy(mode)
    try {
      await api.extend({ accountIds: (limited.length ? limited : scopedReports).map((report) => report.accountId), folder, ...(labelId ? { labelId } : {}), mode })
      onToast(mode === 'all' ? 'Downloading all mail for this folder for the next 24 hours' : 'Downloading older mail for this folder')
      onExtended()
    } catch (reason) {
      onToast(errorText(reason, 'Older mail could not be requested'))
    } finally {
      setBusy(undefined)
    }
  }
  return <div className="offline-list-footer" role="status">
    <CloudDownload size={16} />
    <span>{earliest ? <>Mail since <strong>{new Date(earliest).toLocaleDateString()}</strong> is synchronized. Older mail stays on the server.</> : <>All mail for this folder is being synchronized until {new Date(loadingAll!.loadAllUntil!).toLocaleString()}.</>}</span>
    {earliest && <div>
      <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void extend('more')}>{busy === 'more' ? 'Requesting…' : 'Load more'}</button>
      <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void extend('all')}>{busy === 'all' ? 'Requesting…' : 'Load all'}</button>
    </div>}
  </div>
}

interface SearchNoticeProps {
  accounts: MailAccountSummary[]
  query: string
  active: boolean
  serverResults?: { matched: number }
  online: boolean
  onServerSearch(searchId: string, matched: number): void
  onLocalResults(): void
  onToast(message: string): void
}

/** Tells the user whether a search sees the whole mailbox, and offers a server search when it does not. */
export function MailSearchCoverageNotice({ accounts, query, active, serverResults, online, onServerSearch, onLocalResults, onToast }: SearchNoticeProps) {
  const api = window.aerio.mail.offline
  const [coverage, setCoverage] = useState<MailSearchCoverage[]>([])
  const [busy, setBusy] = useState(false)
  const accountKey = accounts.map((account) => account.id).join(',')
  const currentAccountKey = useRef(accountKey)
  currentAccountKey.current = accountKey
  useEffect(() => { currentAccountKey.current = accountKey; setBusy(false); return () => { currentAccountKey.current = '' } }, [accountKey])


  useEffect(() => {
    if (!api || !active || !accountKey) return
    let current = true
    void api.searchCoverage(accountKey.split(',')).then((value) => { if (current) setCoverage(value) }).catch(() => { if (current) setCoverage([]) })
    return () => { current = false }
  }, [accountKey, active, api])

  if (!api || !active || !accountKey) return null
  if (serverResults) return <div className="mail-search-coverage server">
    <CloudDownload size={14} />
    <span>Showing {count(serverResults.matched)} server match{serverResults.matched === 1 ? '' : 'es'} across the whole mailbox. Messages that were not downloaded open from the server.</span>
    <button className="text-button" onClick={onLocalResults}>Show downloaded results</button>
  </div>
  const incomplete = coverage.filter((item) => !item.complete && accounts.some((account) => account.id === item.accountId))
  if (!incomplete.length) return null
  const searchable = incomplete.filter((item) => item.serverSearch)
  const run = async () => {
    setBusy(true)
    try {
      const result = await api.serverSearch({ accountIds: searchable.map((item) => item.accountId), query: query.trim() })
      if (currentAccountKey.current !== accountKey) return
      for (const failure of result.errors) onToast(`${accounts.find((account) => account.id === failure.accountId)?.email ?? 'An account'}: ${failure.message}`)
      onServerSearch(result.searchId, result.matched)
    } catch (reason) {
      onToast(errorText(reason, 'The server could not be searched'))
    } finally {
      setBusy(false)
    }
  }
  return <div className="mail-search-coverage" title={incomplete.flatMap((item) => item.reasons).join('\n')}>
    <Search size={14} />
    <span>{searchable.length ? 'Search covers downloaded mail only.' : 'Search covers downloaded mail only, and this account can’t be searched on the server.'}</span>
    {searchable.length > 0 && <button className="text-button" disabled={busy || !online || !query.trim()} title={!online ? 'Connect to the internet to search the server' : undefined} onClick={() => void run()}>{busy ? 'Searching the server…' : 'Search server'}</button>}
  </div>
}

/** In the reader: header-only messages that could not be downloaded, and bodies whose attachments load on open. */
export function MailOfflineContentNotice({ message }: { message: MailMessageDetail }) {
  if (!message.offline) return null
  if (message.offline.state === 'body') {
    return message.attachments.length ? <p className="mail-offline-notice subtle"><CloudDownload size={14} /> Attachments download when you open them.</p> : null
  }
  return <p className="mail-offline-notice" role="status"><WifiOff size={14} /> {message.offline.notice ?? NOT_DOWNLOADED_NOTICE}</p>
}
