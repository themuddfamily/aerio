import { describe, expect, it } from 'vitest'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import type { MailFolderAppearance, MailFolderFavorite } from '../mail-folder-preference-types'
import { appearanceIndex, folderKey, folderNameColor, moveListItem, resolveFavorites, sidebarFolderRows, sidebarFoldersFor } from './mail-folder-preferences'

const account = (id: string, provider: MailAccountSummary['provider'], email: string): MailAccountSummary => ({
  id, provider, email, displayName: email, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
})
const folder = (accountId: string, path: string, type: MailLabel['type'] = 'user'): MailLabel => {
  const split = path.lastIndexOf('/')
  return { accountId, id: `folder:${path}`, name: path, type, ...(split > 0 ? { parentId: `folder:${path.slice(0, split)}` } : {}) }
}
const favorite = (accountId: string, labelId: string, position: number, overrides: Partial<MailFolderFavorite> = {}): MailFolderFavorite => ({
  accountId, labelId, position, lastKnownName: labelId.replace(/^folder:/, ''), addedAt: '2026-10-01T00:00:00Z', ...overrides
})

const accounts = [account('work', 'imap', 'me@work.test'), account('home', 'gmail', 'me@home.test')]
const labels: MailLabel[] = [
  folder('work', 'INBOX', 'system'), folder('work', 'Projects'), folder('work', 'Archive/Projects'), folder('work', 'Archive'),
  { accountId: 'home', id: 'Label_1', name: 'Projects', type: 'user', color: '#4a86e8' },
  { accountId: 'home', id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' }
]

describe('resolveFavorites', () => {
  it('orders favorites and disambiguates same names by account and by path', () => {
    const rows = resolveFavorites([
      favorite('home', 'Label_1', 2),
      favorite('work', 'folder:Projects', 0),
      favorite('work', 'folder:Archive/Projects', 1)
    ], labels, accounts)
    expect(rows.map((row) => [row.name, row.hint, row.available])).toEqual([
      ['Projects', 'me@work.test', true],
      ['Projects', 'me@work.test · Archive/Projects', true],
      ['Projects', 'me@home.test', true]
    ])
  })

  it('uses aliases for display and marks favorites of missing folders or accounts as unavailable', () => {
    const rows = resolveFavorites([
      favorite('work', 'folder:Projects', 0, { alias: 'Client work' }),
      favorite('work', 'folder:Old/Deleted', 1),
      favorite('gone', 'folder:Receipts', 2)
    ], labels, accounts)
    expect(rows.map((row) => [row.name, row.available, row.hint])).toEqual([
      ['Client work', true, undefined],
      ['Deleted', false, undefined],
      ['Receipts', false, undefined]
    ])
  })
})

describe('folder appearance helpers', () => {
  it('keeps Gmail label colors and uses local colors for other providers', () => {
    const local: MailFolderAppearance = { accountId: 'work', labelId: 'folder:Projects', color: '#188038', hidden: false }
    expect(folderNameColor({ color: '#4a86e8' }, 'gmail', { ...local, color: '#d93025' })).toBe('#4a86e8')
    expect(folderNameColor({}, 'imap', local)).toBe('#188038')
    expect(folderNameColor({}, 'microsoft', undefined)).toBeUndefined()
  })

  it('moves list items with clamping', () => {
    expect(moveListItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveListItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b'])
    expect(moveListItem(['a', 'b'], 4, 0)).toEqual(['a', 'b'])
  })
})

describe('sidebarFolderRows', () => {
  const work = accounts[0]
  const tree = [folder('work', 'INBOX', 'system'), folder('work', 'Clients'), folder('work', 'Clients/Acme'), folder('work', 'Clients/Acme/2026'), folder('work', 'Clients/Globex'), folder('work', 'Receipts')]
  const base = { appearance: new Map<string, MailFolderAppearance>(), showHidden: false, collapsed: new Set<string>() }
  const names = (rows: ReturnType<typeof sidebarFolderRows>) => rows.map((row) => `${'  '.repeat(row.depth)}${row.leafName}`)

  it('lists the full nested tree with system folders first, and only user labels for Gmail', () => {
    expect(names(sidebarFolderRows('work', tree, base))).toEqual(['INBOX', 'Clients', '  Acme', '    2026', '  Globex', 'Receipts'])
    expect(sidebarFoldersFor(accounts[1], labels).map((label) => label.id)).toEqual(['Label_1'])
    expect(sidebarFoldersFor(work, labels)).toHaveLength(4)
  })

  it('collapses subtrees, hides hidden folders with their subfolders, and shows them on request', () => {
    const collapsed = new Set([folderKey('work', 'folder:Clients/Acme')])
    const rows = sidebarFolderRows('work', tree, { ...base, collapsed })
    expect(names(rows)).toEqual(['INBOX', 'Clients', '  Acme', '  Globex', 'Receipts'])
    expect(rows.find((row) => row.leafName === 'Acme')).toMatchObject({ hasChildren: true, collapsed: true })
    const appearance = appearanceIndex({ favorites: [], appearance: [{ accountId: 'work', labelId: 'folder:Clients', hidden: true }] })
    expect(names(sidebarFolderRows('work', tree, { ...base, appearance }))).toEqual(['INBOX', 'Receipts'])
    const shown = sidebarFolderRows('work', tree, { ...base, appearance, showHidden: true })
    expect(shown.find((row) => row.leafName === 'Clients')?.hidden).toBe(true)
    expect(shown).toHaveLength(6)
  })

  it('filters by name, keeping ancestors and ignoring collapse', () => {
    const collapsed = new Set([folderKey('work', 'folder:Clients')])
    expect(names(sidebarFolderRows('work', tree, { ...base, collapsed, filter: '2026' }))).toEqual(['Clients', '  Acme', '    2026'])
    expect(sidebarFolderRows('work', tree, { ...base, filter: 'nothing' })).toEqual([])
  })
})
