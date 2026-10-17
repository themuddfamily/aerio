import type { MailFolderCapabilities, MailLabel, MailProviderId } from '../mail-types'

// Gmail rejects label colors outside its fixed palette, so the editor only
// offers documented background/text pairs instead of a free color picker.
export const GMAIL_LABEL_COLORS: { backgroundColor: string; textColor: string; name: string }[] = [
  { name: 'Red', backgroundColor: '#fb4c2f', textColor: '#ffffff' },
  { name: 'Orange', backgroundColor: '#ffad47', textColor: '#000000' },
  { name: 'Yellow', backgroundColor: '#fad165', textColor: '#000000' },
  { name: 'Green', backgroundColor: '#16a766', textColor: '#ffffff' },
  { name: 'Mint', backgroundColor: '#43d692', textColor: '#000000' },
  { name: 'Blue', backgroundColor: '#4a86e8', textColor: '#ffffff' },
  { name: 'Purple', backgroundColor: '#a479e2', textColor: '#ffffff' },
  { name: 'Pink', backgroundColor: '#f691b3', textColor: '#000000' },
  { name: 'Dark red', backgroundColor: '#cc3a21', textColor: '#ffffff' },
  { name: 'Dark blue', backgroundColor: '#3c78d8', textColor: '#ffffff' },
  { name: 'Violet', backgroundColor: '#8e63ce', textColor: '#ffffff' },
  { name: 'Gray', backgroundColor: '#666666', textColor: '#ffffff' }
]

export function gmailLabelColor(backgroundColor: string) {
  return GMAIL_LABEL_COLORS.find((color) => color.backgroundColor === backgroundColor.toLowerCase())
}

export function mailFolderCapabilities(provider: MailProviderId | undefined): MailFolderCapabilities {
  if (provider === 'gmail') return { kind: 'label', canCreate: true, canRename: true, canDelete: true, canNest: true, canColor: true, deleteKeepsMessages: true }
  if (provider === 'microsoft') return { kind: 'folder', canCreate: true, canRename: true, canDelete: true, canNest: true, canColor: false, deleteKeepsMessages: true }
  if (!provider) return { kind: 'folder', canCreate: false, canRename: false, canDelete: false, canNest: false, canColor: false, deleteKeepsMessages: false }
  return { kind: 'folder', canCreate: true, canRename: true, canDelete: true, canNest: true, canColor: false, deleteKeepsMessages: false }
}

// System folders/labels (Inbox, Sent, Trash, Gmail categories, special-use
// IMAP mailboxes and Microsoft well-known folders) are provider-owned.
export function isSystemMailFolder(label: Pick<MailLabel, 'id' | 'type'>) {
  return label.type === 'system' || label.id.toUpperCase() === 'INBOX' || label.id.toUpperCase() === 'FOLDER:INBOX'
}

export function managedMailFolders(accountId: string, labels: MailLabel[]) {
  return labels.filter((label) => label.accountId === accountId && !isSystemMailFolder(label))
}

export function mailFolderLeafName(label: MailLabel, labels: MailLabel[]) {
  const parent = label.parentId ? labels.find((item) => item.accountId === label.accountId && item.id === label.parentId) : undefined
  if (parent && label.name.length > parent.name.length + 1 && label.name.startsWith(parent.name)) return label.name.slice(parent.name.length + 1)
  return label.name
}

export function mailFolderDescendants(label: Pick<MailLabel, 'accountId' | 'id'>, labels: MailLabel[]) {
  const result: MailLabel[] = []
  const pending = [label.id]
  while (pending.length) {
    const parentId = pending.shift()!
    for (const child of labels) {
      if (child.accountId !== label.accountId || child.parentId !== parentId || result.includes(child)) continue
      result.push(child)
      pending.push(child.id)
    }
  }
  return result
}

export interface MailFolderTreeRow {
  label: MailLabel
  depth: number
  leafName: string
}

// Flattens folders into display order so nested folders follow their parent.
export function mailFolderTree(accountId: string, labels: MailLabel[]): MailFolderTreeRow[] {
  const scoped = labels.filter((label) => label.accountId === accountId)
  const ids = new Set(scoped.map((label) => label.id))
  const byParent = new Map<string, MailLabel[]>()
  for (const label of scoped) {
    const key = label.parentId && ids.has(label.parentId) ? label.parentId : ''
    byParent.set(key, [...(byParent.get(key) ?? []), label])
  }
  const rows: MailFolderTreeRow[] = []
  const visit = (parentId: string, depth: number) => {
    const children = (byParent.get(parentId) ?? []).sort((left, right) =>
      Number(isSystemMailFolder(right)) - Number(isSystemMailFolder(left)) || left.name.localeCompare(right.name))
    for (const label of children) {
      if (rows.some((row) => row.label.id === label.id)) continue
      rows.push({ label, depth, leafName: mailFolderLeafName(label, scoped) })
      visit(label.id, depth + 1)
    }
  }
  visit('', 0)
  return rows
}

// Returns a user-facing error when a proposed folder or label name is invalid.
export function mailFolderNameError(name: string, provider: MailProviderId | undefined, delimiter?: string) {
  const value = name.trim()
  if (!value) return 'Enter a name'
  if (value.length > 225) return 'Use a name of 225 characters or fewer'
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'The name cannot contain control characters'
  if (provider === 'gmail' && value.includes('/')) return 'Use the parent setting instead of “/” to nest labels'
  if (provider !== 'gmail' && provider !== 'microsoft' && delimiter && value.includes(delimiter)) return `The name cannot contain the folder separator “${delimiter}”`
  if (provider !== 'gmail' && provider !== 'microsoft' && /[*%]/.test(value)) return 'IMAP folder names cannot contain * or %'
  if (value.toUpperCase() === 'INBOX') return 'Inbox is reserved by the provider'
  return undefined
}

export function mailFolderNameConflict(accountId: string, name: string, parentId: string | undefined, labels: MailLabel[], ignoreId?: string) {
  const wanted = name.trim().toLocaleLowerCase()
  const scoped = labels.filter((label) => label.accountId === accountId)
  return scoped.find((label) => label.id !== ignoreId
    && (label.parentId ?? undefined) === (parentId ?? undefined)
    && mailFolderLeafName(label, scoped).trim().toLocaleLowerCase() === wanted)
}
