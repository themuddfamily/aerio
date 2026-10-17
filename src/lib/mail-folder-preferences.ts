import type { MailAccountSummary, MailLabel, MailProviderId } from '../mail-types'
import type { MailFolderAppearance, MailFolderFavorite, MailFolderPreferences } from '../mail-folder-preference-types'
import { isSystemMailFolder, mailFolderLeafName, mailFolderTree } from './mail-folders'

export const EMPTY_FOLDER_PREFERENCES: MailFolderPreferences = { favorites: [], appearance: [] }

// Local name colors offered for non-Gmail folders. Gmail labels keep using
// Gmail's own palette, which is synchronized with the label on Gmail.
export const LOCAL_FOLDER_COLORS: { name: string; value: string }[] = [
  { name: 'Red', value: '#d93025' },
  { name: 'Orange', value: '#e8710a' },
  { name: 'Amber', value: '#b58105' },
  { name: 'Green', value: '#188038' },
  { name: 'Teal', value: '#00897b' },
  { name: 'Blue', value: '#1a73e8' },
  { name: 'Indigo', value: '#5c6bc0' },
  { name: 'Purple', value: '#8e24aa' },
  { name: 'Pink', value: '#d81b60' },
  { name: 'Gray', value: '#5f6368' }
]

export const folderKey = (accountId: string, labelId: string) => `${accountId}\u0000${labelId}`

export function appearanceIndex(preferences: MailFolderPreferences) {
  return new Map(preferences.appearance.map((item) => [folderKey(item.accountId, item.labelId), item]))
}

export function favoriteIndex(preferences: MailFolderPreferences) {
  return new Map(preferences.favorites.map((item) => [folderKey(item.accountId, item.labelId), item]))
}

/** Gmail labels show their synchronized Gmail color; other folders show the local color, if any. */
export function folderNameColor(label: Pick<MailLabel, 'color'>, provider: MailProviderId | undefined, appearance?: MailFolderAppearance) {
  return provider === 'gmail' ? label.color : appearance?.color
}

export function canSetLocalFolderColor(provider: MailProviderId | undefined) {
  return provider !== 'gmail'
}

export interface FavoriteRow {
  favorite: MailFolderFavorite
  label?: MailLabel
  account?: MailAccountSummary
  /** False when the folder no longer exists (deleted or renamed in another client) or its account is gone. */
  available: boolean
  name: string
  /** Shown next to the name when another favorite has the same name. */
  hint?: string
}

const leafOfPath = (name: string) => name.split('/').filter(Boolean).pop() ?? name

/** Favorites in their saved order, resolved against the current folder lists. */
export function resolveFavorites(favorites: MailFolderFavorite[], labels: MailLabel[], accounts: MailAccountSummary[]): FavoriteRow[] {
  const rows = [...favorites].sort((left, right) => left.position - right.position).map((favorite): FavoriteRow => {
    const account = accounts.find((item) => item.id === favorite.accountId)
    const scoped = labels.filter((label) => label.accountId === favorite.accountId)
    const label = account ? scoped.find((item) => item.id === favorite.labelId) : undefined
    const name = favorite.alias || (label ? mailFolderLeafName(label, scoped) : leafOfPath(favorite.lastKnownName))
    return { favorite, label, account, available: Boolean(label), name }
  })
  for (const row of rows) {
    const same = rows.filter((other) => other !== row && other.name.toLocaleLowerCase() === row.name.toLocaleLowerCase())
    if (!same.length) continue
    const parts: string[] = []
    if (same.some((other) => other.favorite.accountId !== row.favorite.accountId)) parts.push(row.account?.email ?? 'Removed account')
    const fullName = row.label?.name ?? row.favorite.lastKnownName
    if (same.some((other) => other.favorite.accountId === row.favorite.accountId) && fullName !== row.name) parts.push(fullName)
    if (parts.length) row.hint = parts.join(' · ')
  }
  return rows
}

/** Returns a copy with the item at `from` moved to index `to` (clamped). */
export function moveListItem<T>(items: T[], from: number, to: number) {
  if (from < 0 || from >= items.length) return [...items]
  const target = Math.max(0, Math.min(items.length - 1, to))
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/**
 * Folders that belong in the sidebar tree for an account. Gmail exposes many
 * system labels (categories, chats) that the Mailboxes group already covers,
 * so only its user labels are listed; folder providers show their whole tree.
 */
export function sidebarFoldersFor(account: MailAccountSummary, labels: MailLabel[]) {
  const scoped = labels.filter((label) => label.accountId === account.id)
  return account.provider === 'gmail' ? scoped.filter((label) => label.type === 'user') : scoped
}

export interface SidebarFolderRow {
  label: MailLabel
  depth: number
  leafName: string
  hasChildren: boolean
  collapsed: boolean
  hidden: boolean
  system: boolean
}

export interface SidebarFolderTreeOptions {
  appearance: Map<string, MailFolderAppearance>
  showHidden: boolean
  collapsed: ReadonlySet<string>
  filter?: string
}

/**
 * Flattens one account's folders into visible sidebar rows. Collapsed folders
 * hide their subfolders; hidden folders (and their subfolders) are left out
 * unless `showHidden` is set. A filter shows every matching folder with its
 * ancestors, ignoring collapse so matches inside closed folders are found.
 */
export function sidebarFolderRows(accountId: string, labels: MailLabel[], options: SidebarFolderTreeOptions): SidebarFolderRow[] {
  const tree = mailFolderTree(accountId, labels)
  const ids = new Set(tree.map((row) => row.label.id))
  const parentOf = new Map(tree.map((row) => [row.label.id, row.label.parentId && ids.has(row.label.parentId) ? row.label.parentId : undefined]))
  const hasChildren = new Set([...parentOf.values()].filter(Boolean) as string[])
  const isHidden = (labelId: string) => Boolean(options.appearance.get(folderKey(accountId, labelId))?.hidden)
  const ancestors = (labelId: string) => {
    const result: string[] = []
    let current = parentOf.get(labelId)
    while (current && !result.includes(current)) {
      result.push(current)
      current = parentOf.get(current)
    }
    return result
  }
  const filter = options.filter?.trim().toLocaleLowerCase()
  const matches = filter ? new Set(tree.filter((row) => row.label.name.toLocaleLowerCase().includes(filter) || row.leafName.toLocaleLowerCase().includes(filter)).map((row) => row.label.id)) : undefined
  const shownByFilter = matches ? new Set([...matches, ...[...matches].flatMap(ancestors)]) : undefined
  return tree.filter((row) => {
    const chain = [row.label.id, ...ancestors(row.label.id)]
    if (!options.showHidden && chain.some(isHidden)) return false
    if (shownByFilter) return shownByFilter.has(row.label.id)
    return !chain.slice(1).some((id) => options.collapsed.has(folderKey(accountId, id)))
  }).map((row) => ({
    label: row.label,
    depth: row.depth,
    leafName: row.leafName,
    hasChildren: hasChildren.has(row.label.id),
    collapsed: !shownByFilter && options.collapsed.has(folderKey(accountId, row.label.id)),
    hidden: isHidden(row.label.id),
    system: isSystemMailFolder(row.label)
  }))
}
