import {
  Archive, ArrowDown, ArrowUp, Bookmark, Briefcase, ChevronDown, ChevronRight, Eye, EyeOff, Flag, Folder, FolderOpen, Heart, House,
  Inbox, Palette, Receipt, Save, Star, StarOff, Tag, Trash2, Users, type LucideIcon
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import { MAIL_FOLDER_ICONS, type MailFolderAppearance, type MailFolderAppearanceInput, type MailFolderFavorite, type MailFolderIcon, type MailFolderPreferences } from '../mail-folder-preference-types'
import {
  EMPTY_FOLDER_PREFERENCES,
  LOCAL_FOLDER_COLORS,
  appearanceIndex,
  canSetLocalFolderColor,
  favoriteIndex,
  folderKey,
  folderNameColor,
  moveListItem,
  resolveFavorites,
  sidebarFolderRows,
  sidebarFoldersFor,
  type FavoriteRow
} from '../lib/mail-folder-preferences'
import { mailFolderLeafName } from '../lib/mail-folders'
import type { ContextMenuItem } from './ContextMenu'
import Modal from './Modal'

const ICONS: Record<MailFolderIcon, LucideIcon> = {
  folder: Folder, inbox: Inbox, star: Star, flag: Flag, bookmark: Bookmark, briefcase: Briefcase,
  receipt: Receipt, users: Users, home: House, heart: Heart, archive: Archive, tag: Tag
}
const ICON_NAMES: Record<MailFolderIcon, string> = {
  folder: 'Folder', inbox: 'Inbox', star: 'Star', flag: 'Flag', bookmark: 'Bookmark', briefcase: 'Briefcase',
  receipt: 'Receipt', users: 'People', home: 'Home', heart: 'Heart', archive: 'Archive', tag: 'Tag'
}
// Expand/collapse state and the hidden-folder toggle are per-window
// conveniences; losing them only resets the tree to its default look.
const COLLAPSED_KEY = 'aerio.mail.sidebarFolders.collapsed'
const SHOW_HIDDEN_KEY = 'aerio.mail.sidebarFolders.showHidden'
const FILTER_THRESHOLD = 12

const readStorage = (key: string) => { try { return window.localStorage.getItem(key) } catch { return null } }
const writeStorage = (key: string, value: string) => { try { window.localStorage.setItem(key, value) } catch { /* Storage can be unavailable. */ } }
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function FolderGlyph({ icon, open, label, size = 15 }: { icon?: MailFolderIcon; open?: boolean; label?: MailLabel; size?: number }) {
  if (icon) {
    const Icon = ICONS[icon]
    return <Icon size={size} />
  }
  if (label && !label.id.startsWith('folder:')) return <Tag size={size} />
  return open ? <FolderOpen size={size} /> : <Folder size={size} />
}

/** Loads and changes display-only folder preferences; a missing API (older preload, tests) means none. */
export function useMailFolderPreferences(onToast: (message: string) => void) {
  const api = window.aerio?.mail?.folderPreferences
  const [preferences, setPreferences] = useState<MailFolderPreferences>(EMPTY_FOLDER_PREFERENCES)
  const [showHidden, setShowHidden] = useState(() => readStorage(SHOW_HIDDEN_KEY) === 'true')
  const toggleShowHidden = useCallback(() => setShowHidden((current) => { writeStorage(SHOW_HIDDEN_KEY, String(!current)); return !current }), [])
  const reload = useCallback(() => {
    if (!api) return
    void api.get().then(setPreferences).catch(() => undefined)
  }, [api])
  useEffect(() => {
    reload()
    // Renames through Aerio and sync reconciliation change preferences in the worker.
    return window.aerio.mail.onEvent((event) => {
      if (event.type === 'mail-changed' || (event.type === 'sync-progress' && event.payload.phase === 'complete')) reload()
    })
  }, [reload])
  const run = useCallback(async (change: () => Promise<MailFolderPreferences>, fallback: string) => {
    try {
      setPreferences(await change())
      return true
    } catch (error) {
      onToast(errorText(error, fallback))
      return false
    }
  }, [onToast])
  const favorites = useMemo(() => favoriteIndex(preferences), [preferences])
  const appearance = useMemo(() => appearanceIndex(preferences), [preferences])
  return {
    available: Boolean(api),
    preferences,
    showHidden,
    toggleShowHidden,
    favorites,
    appearance,
    isFavorite: (accountId: string, labelId: string) => favorites.has(folderKey(accountId, labelId)),
    addFavorite: (accountId: string, labelId: string) => api ? run(() => api.addFavorite(accountId, labelId), 'The folder could not be added to Favorites') : Promise.resolve(false),
    removeFavorite: (accountId: string, labelId: string) => api ? run(() => api.removeFavorite(accountId, labelId), 'The favorite could not be removed') : Promise.resolve(false),
    reorder: (order: MailFolderFavorite[]) => {
      if (!api) return Promise.resolve(false)
      // Show the new order at once; the saved order replaces it when it returns.
      setPreferences((current) => ({ ...current, favorites: order.map((item, position) => ({ ...item, position })) }))
      return run(() => api.reorderFavorites(order.map(({ accountId, labelId }) => ({ accountId, labelId }))), 'Favorites could not be reordered')
    },
    setAlias: (accountId: string, labelId: string, alias: string | null) => api ? run(() => api.setFavoriteAlias(accountId, labelId, alias), 'The favorite name could not be saved') : Promise.resolve(false),
    setAppearance: (input: MailFolderAppearanceInput) => api ? run(() => api.setAppearance(input), 'The folder appearance could not be saved') : Promise.resolve(false)
  }
}

export type MailFolderPreferencesController = ReturnType<typeof useMailFolderPreferences>

/** Context-menu entries shared by the folder tree, Local Folders, and Favorites. */
export function folderPreferenceMenuItems(controller: MailFolderPreferencesController, label: MailLabel, onEditAppearance: () => void): ContextMenuItem[] {
  if (!controller.available) return []
  const favorite = controller.isFavorite(label.accountId, label.id)
  const hidden = Boolean(controller.appearance.get(folderKey(label.accountId, label.id))?.hidden)
  return [
    favorite
      ? { label: 'Remove from Favorites', icon: StarOff, separatorBefore: true, action: () => { void controller.removeFavorite(label.accountId, label.id) } }
      : { label: 'Add to Favorites', icon: Star, separatorBefore: true, action: () => { void controller.addFavorite(label.accountId, label.id) } },
    { label: 'Folder appearance…', icon: Palette, action: onEditAppearance },
    hidden
      ? { label: 'Show in sidebar', icon: Eye, action: () => { void controller.setAppearance({ accountId: label.accountId, labelId: label.id, hidden: false }) } }
      : { label: 'Hide from sidebar', icon: EyeOff, action: () => { void controller.setAppearance({ accountId: label.accountId, labelId: label.id, hidden: true }) } }
  ]
}

interface FavoritesProps {
  favorites: MailFolderFavorite[]
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  appearance: Map<string, MailFolderAppearance>
  selectedAccountId: string
  selectedLabelId?: string
  onOpen(label: MailLabel): void
  onReorder(order: MailFolderFavorite[]): void
  onRemove(favorite: MailFolderFavorite): void
  onContextMenu(event: React.MouseEvent, row: FavoriteRow, index: number, rows: FavoriteRow[]): void
}

/** Favorites from every account, in the saved order, at the top of the mail sidebar. */
export function MailFavoritesSidebar({ favorites, accounts, labels, appearance, selectedAccountId, selectedLabelId, onOpen, onReorder, onRemove, onContextMenu }: FavoritesProps) {
  const rows = useMemo(() => resolveFavorites(favorites, labels, accounts), [accounts, favorites, labels])
  const [dragging, setDragging] = useState<number>()
  const [dropTarget, setDropTarget] = useState<number>()
  if (!rows.length) return null
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return
    onReorder(moveListItem(rows, from, to).map((row) => row.favorite))
  }
  return <div className="sidebar-group mail-favorites" aria-label="Favorites" role="group">
    <span className="sidebar-label">Favorites</span>
    {rows.map((row, index) => {
      const { favorite, label, account } = row
      const key = folderKey(favorite.accountId, favorite.labelId)
      const look = appearance.get(key)
      const selected = Boolean(label) && selectedAccountId === favorite.accountId && selectedLabelId === favorite.labelId
      const color = label ? folderNameColor(label, account?.provider, look) : undefined
      return <div
        key={key}
        className={`mail-favorite-row ${dragging === index ? 'dragging' : ''} ${dropTarget === index && dragging !== index ? 'drop-target' : ''}`}
        data-testid={`favorite-${favorite.accountId}-${favorite.labelId}`}
        draggable
        onDragStart={(event) => { setDragging(index); event.dataTransfer?.setData('text/plain', key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }}
        onDragOver={(event) => { if (dragging === undefined) return; event.preventDefault(); setDropTarget(index) }}
        onDragLeave={() => setDropTarget((current) => current === index ? undefined : current)}
        onDrop={(event) => { event.preventDefault(); if (dragging !== undefined) move(dragging, index); setDragging(undefined); setDropTarget(undefined) }}
        onDragEnd={() => { setDragging(undefined); setDropTarget(undefined) }}
        onContextMenu={(event) => onContextMenu(event, row, index, rows)}
      >
        {row.available && label ? <button
          className={`sidebar-item ${selected ? 'active' : ''}`}
          aria-pressed={selected}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title={[label.name, account?.email].filter(Boolean).join(' · ')}
          onClick={() => onOpen(label)}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
            event.preventDefault()
            move(index, index + (event.key === 'ArrowUp' ? -1 : 1))
          }}
        >
          <span className="account-dot favorite-account" style={{ background: account?.color }} aria-hidden="true" />
          <FolderGlyph icon={look?.icon} open={selected} label={label} />
          <span style={color ? { color } : undefined}>{row.name}{row.hint && <small className="mail-favorite-hint"> {row.hint}</small>}</span>
        </button> : <div className="sidebar-item mail-favorite-stale" title="This folder was deleted, renamed in another app, or its account was removed">
          <FolderGlyph icon={look?.icon} />
          <span>{row.name}<small className="mail-favorite-hint"> Unavailable{row.hint ? ` · ${row.hint}` : ''}</small></span>
          <button className="icon-button" aria-label={`Remove ${row.name} from Favorites`} title="Remove from Favorites" onClick={() => onRemove(favorite)}><Trash2 size={13} /></button>
        </div>}
      </div>
    })}
  </div>
}

/** Context-menu entries for a favorite row: open, reorder, rename, remove. */
export function favoriteMenuItems(row: FavoriteRow, index: number, rows: FavoriteRow[], handlers: { open(label: MailLabel): void; reorder(order: MailFolderFavorite[]): void; rename(): void; remove(): void }): ContextMenuItem[] {
  const order = (to: number) => handlers.reorder(moveListItem(rows, index, to).map((item) => item.favorite))
  return [
    ...(row.label ? [{ label: `Open ${row.name}`, icon: FolderOpen, action: () => handlers.open(row.label!) }] : []),
    { label: 'Move up', icon: ArrowUp, shortcut: 'Alt+↑', disabled: index === 0, separatorBefore: Boolean(row.label), action: () => order(index - 1) },
    { label: 'Move down', icon: ArrowDown, shortcut: 'Alt+↓', disabled: index === rows.length - 1, action: () => order(index + 1) },
    ...(row.label ? [{ label: 'Rename favorite…', icon: Palette, action: handlers.rename }] : []),
    { label: 'Remove from Favorites', icon: StarOff, separatorBefore: true, action: handlers.remove }
  ]
}

interface TreeProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  accountFilter: string
  appearance: Map<string, MailFolderAppearance>
  favorites: Map<string, MailFolderFavorite>
  selectedAccountId: string
  selectedLabelId?: string
  showHidden: boolean
  onToggleHidden(): void
  onOpen(label: MailLabel): void
  onContextMenu(event: React.MouseEvent, label: MailLabel): void
}

/** Every folder or label of the visible accounts as a collapsible, filterable tree. */
export function MailFolderTreeSidebar({ accounts, labels, accountFilter, appearance, favorites, selectedAccountId, selectedLabelId, showHidden, onToggleHidden, onOpen, onContextMenu }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(readStorage(COLLAPSED_KEY) ?? '[]') as string[]) } catch { return new Set() }
  })
  const [filter, setFilter] = useState('')
  const visibleAccounts = accounts.filter((account) => accountFilter === 'all' || account.id === accountFilter)
  const groups = visibleAccounts.map((account) => {
    const folders = sidebarFoldersFor(account, labels)
    return { account, folders, rows: sidebarFolderRows(account.id, folders, { appearance, showHidden, collapsed, filter }) }
  }).filter((group) => group.folders.length > 0)
  const total = groups.reduce((sum, group) => sum + group.folders.length, 0)
  const hiddenCount = groups.reduce((sum, group) => sum + group.folders.filter((label) => appearance.get(folderKey(label.accountId, label.id))?.hidden).length, 0)
  if (!groups.length) return null
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    writeStorage(COLLAPSED_KEY, JSON.stringify([...next]))
    return next
  })
  const multiple = groups.length > 1
  const allLabels = groups.every((group) => group.account.provider === 'gmail')
  return <div className="sidebar-group mail-folder-tree">
    <span className="sidebar-label">{allLabels ? 'Labels' : 'Folders'}</span>
    {total > FILTER_THRESHOLD && <input className="mail-folder-filter" type="search" aria-label="Filter folders" placeholder="Filter folders" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setFilter('') }} />}
    {hiddenCount > 0 && <button className="sidebar-item mail-folder-hidden-toggle" aria-pressed={showHidden} onClick={onToggleHidden}>{showHidden ? <EyeOff size={14} /> : <Eye size={14} />}<span>{showHidden ? 'Hide hidden folders' : `Show hidden folders (${hiddenCount.toLocaleString()})`}</span></button>}
    {groups.map(({ account, rows }) => {
      const accountKey = `account:${account.id}`
      const accountCollapsed = multiple && collapsed.has(accountKey) && !filter.trim()
      return <div key={account.id} className="mail-folder-tree-account" role="tree" aria-label={`Folders in ${account.email}`}>
        {multiple && <button className="mail-folder-tree-account-heading" aria-expanded={!accountCollapsed} onClick={() => toggle(accountKey)} title={account.email}>
          {accountCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span className="account-dot" style={{ background: account.color }} aria-hidden="true" /><span>{account.email}</span>
        </button>}
        {!accountCollapsed && rows.map((row) => {
          const { label, depth, leafName } = row
          const key = folderKey(account.id, label.id)
          const look = appearance.get(key)
          const selected = selectedAccountId === account.id && selectedLabelId === label.id
          const color = folderNameColor(label, account.provider, look)
          return <div key={key} role="treeitem" aria-level={depth + 1} aria-expanded={row.hasChildren ? !row.collapsed : undefined} aria-selected={selected} className={`mail-folder-tree-row ${row.hidden ? 'is-hidden' : ''}`} style={{ paddingInlineStart: depth * 14 }}>
            {row.hasChildren
              ? <button className="mail-folder-twisty" aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${leafName}`} onClick={() => toggle(key)}>{row.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
              : <span className="mail-folder-twisty" aria-hidden="true" />}
            <button
              className={`sidebar-item ${selected ? 'active' : ''}`}
              aria-pressed={selected}
              title={`${label.name}${multiple ? '' : ` · ${account.email}`}`}
              onClick={() => onOpen(label)}
              onContextMenu={(event) => onContextMenu(event, label)}
              onKeyDown={(event) => {
                if (!row.hasChildren) return
                if ((event.key === 'ArrowRight' && row.collapsed) || (event.key === 'ArrowLeft' && !row.collapsed)) { event.preventDefault(); toggle(key) }
              }}
            >
              <FolderGlyph icon={look?.icon} open={selected} label={label} />
              <span style={color ? { color } : undefined}>{leafName}</span>
              {favorites.has(key) && <Star size={12} className="mail-folder-favorite-mark" aria-hidden="true" />}
              {row.hidden && <EyeOff size={12} className="mail-folder-hidden-mark" aria-hidden="true" />}
            </button>
          </div>
        })}
        {!accountCollapsed && !rows.length && filter.trim() && <p className="mail-folder-tree-empty">No folders match</p>}
      </div>
    })}
  </div>
}

interface DisplayModalProps {
  label: MailLabel
  account?: MailAccountSummary
  labels: MailLabel[]
  appearance?: MailFolderAppearance
  favorite?: MailFolderFavorite
  /** Focuses the favorite name field (from “Rename favorite…”). */
  focusAlias?: boolean
  onSave(changes: { alias?: string | null; appearance: MailFolderAppearanceInput }): Promise<boolean>
  onClose(): void
}

/** Edits how one folder looks in Aerio. Nothing here changes the folder on the provider. */
export function MailFolderDisplayModal({ label, account, labels, appearance, favorite, focusAlias, onSave, onClose }: DisplayModalProps) {
  const scoped = labels.filter((item) => item.accountId === label.accountId)
  const leafName = mailFolderLeafName(label, scoped)
  const [alias, setAlias] = useState(favorite?.alias ?? '')
  const [icon, setIcon] = useState<MailFolderIcon | undefined>(appearance?.icon)
  const [color, setColor] = useState<string | undefined>(appearance?.color)
  const [hidden, setHidden] = useState(Boolean(appearance?.hidden))
  const [busy, setBusy] = useState(false)
  const localColor = canSetLocalFolderColor(account?.provider)
  const save = async () => {
    setBusy(true)
    const ok = await onSave({
      ...(favorite ? { alias: alias.trim() || null } : {}),
      appearance: { accountId: label.accountId, labelId: label.id, icon: icon ?? null, hidden, ...(localColor ? { color: color ?? null } : {}) }
    })
    setBusy(false)
    if (ok) onClose()
  }
  return <Modal title="Folder appearance" subtitle={`${label.name}${account ? ` · ${account.email}` : ''}`} width="small" onClose={onClose}>
    <div className="mail-rule-editor mail-folder-display">
      <p className="mail-folder-display-note">These settings only change how the {label.id.startsWith('folder:') ? 'folder' : 'label'} looks in Aerio on this computer. The name, color, and contents on the mail server stay as they are.</p>
      {favorite && <label className="field"><span>Name in Favorites</span><input autoFocus={focusAlias} value={alias} maxLength={120} placeholder={leafName} onChange={(event) => setAlias(event.target.value)} /></label>}
      <fieldset className="mail-folder-icons"><legend>Icon</legend>
        <button type="button" aria-pressed={!icon} title="Default" aria-label="Default icon" onClick={() => setIcon(undefined)}><FolderGlyph label={label} /></button>
        {MAIL_FOLDER_ICONS.map((value) => { const Icon = ICONS[value]; return <button type="button" key={value} aria-pressed={icon === value} title={ICON_NAMES[value]} aria-label={`${ICON_NAMES[value]} icon`} onClick={() => setIcon(value)}><Icon size={15} /></button> })}
      </fieldset>
      {localColor ? <fieldset className="mail-folder-colors"><legend>Name color</legend>
        <button type="button" className="mail-folder-color-none" aria-pressed={!color} aria-label="No color" title="No color" onClick={() => setColor(undefined)} />
        {LOCAL_FOLDER_COLORS.map((item) => <button type="button" key={item.value} aria-label={item.name} aria-pressed={color === item.value} title={item.name} style={{ background: item.value }} onClick={() => setColor(item.value)} />)}
      </fieldset> : <p className="mail-folder-display-note">Gmail label colors are synchronized with Gmail. Change this label’s color in Manage labels.</p>}
      <label className="rule-enabled"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} /> Hide from the sidebar folder list</label>
    </div>
    <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button><span className="spacer" /><button className="button primary" disabled={busy} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : 'Save'}</button></footer>
  </Modal>
}
