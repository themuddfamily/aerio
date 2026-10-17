import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel, MailProviderId } from '../../src/mail-types'
import { MailDatabase } from './database'
import { MailFolderManager } from './folder-management'
import { handleMailFolderPreferenceCommand, inferFolderPathRenames } from './folder-preferences'
import { applyPendingProfileRestore, createProfileBackup, previewProfileBackup, stageProfileRestore } from '../profile-backup'
import { PROFILE_BACKUP_LAYOUT } from '../profile-backup-layout'

const directories: string[] = []
const opened: MailDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) try { database.close() } catch { /* Closed by the test. */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
const temporary = (name: string) => { const directory = mkdtempSync(join(tmpdir(), `aerio-folder-prefs-${name}-`)); directories.push(directory); return directory }
const open = (directory: string) => { const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail')); opened.push(database); return database }

const account = (id: string, provider: MailProviderId, email = `${id}@example.test`): MailAccountSummary => ({
  id, provider, email, displayName: email, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
})
const folder = (accountId: string, path: string, type: MailLabel['type'] = 'user'): MailLabel => {
  const split = path.lastIndexOf('/')
  return { accountId, id: `folder:${path}`, name: path, type, ...(split > 0 ? { parentId: `folder:${path.slice(0, split)}` } : {}) }
}
const run = (database: MailDatabase, command: Parameters<typeof handleMailFolderPreferenceCommand>[1]) => handleMailFolderPreferenceCommand(database, command)
const add = (database: MailDatabase, accountId: string, labelId: string) => run(database, { type: 'folder-preferences:add-favorite', payload: { accountId, labelId } })
const ids = (database: MailDatabase) => database.folderPreferences.list().favorites.map((item) => `${item.accountId}:${item.labelId}`)

function setup() {
  const directory = temporary('db')
  const database = open(directory)
  database.upsertAccount(account('imap', 'imap'))
  database.upsertAccount(account('gmail', 'gmail'))
  database.replaceLabels('imap', [folder('imap', 'INBOX', 'system'), folder('imap', 'Projects'), folder('imap', 'Projects/2026'), folder('imap', 'Receipts')])
  database.replaceLabels('gmail', [{ accountId: 'gmail', id: 'INBOX', name: 'INBOX', type: 'system' }, { accountId: 'gmail', id: 'Label_1', name: 'Projects', type: 'user', color: '#4a86e8' }])
  return { database, directory }
}

describe('folder favorites', () => {
  it('keeps same-named folders from different accounts as separate favorites', () => {
    const { database } = setup()
    add(database, 'imap', 'folder:Projects')
    const result = add(database, 'gmail', 'Label_1')
    expect(result.favorites.map((item) => [item.accountId, item.labelId, item.lastKnownName, item.position])).toEqual([
      ['imap', 'folder:Projects', 'Projects', 0],
      ['gmail', 'Label_1', 'Projects', 1]
    ])
    // Adding again keeps the place.
    expect(add(database, 'imap', 'folder:Projects').favorites).toHaveLength(2)
    expect(() => add(database, 'imap', 'folder:Missing')).toThrow(/no longer exists/)
    expect(() => add(database, 'nobody', 'folder:Projects')).toThrow(/Account not found/)
  })

  it('keeps the saved order and aliases after a restart', () => {
    const { database, directory } = setup()
    add(database, 'imap', 'folder:Projects')
    add(database, 'imap', 'folder:Receipts')
    add(database, 'gmail', 'Label_1')
    run(database, { type: 'folder-preferences:reorder', payload: { order: [{ accountId: 'gmail', labelId: 'Label_1' }, { accountId: 'imap', labelId: 'folder:Projects' }] } })
    run(database, { type: 'folder-preferences:set-alias', payload: { accountId: 'imap', labelId: 'folder:Receipts', alias: 'Bills' } })
    database.close()
    const reopened = open(directory)
    const favorites = run(reopened, { type: 'folder-preferences:get' }).favorites
    expect(favorites.map((item) => [item.labelId, item.position, item.alias])).toEqual([
      ['Label_1', 0, undefined],
      ['folder:Projects', 1, undefined],
      ['folder:Receipts', 2, 'Bills']
    ])
    // The alias is display-only: the folder keeps its provider name.
    expect(reopened.listLabels(['imap']).find((label) => label.id === 'folder:Receipts')?.name).toBe('Receipts')
  })

  it('removes a favorite without touching the folder and renumbers the rest', () => {
    const { database } = setup()
    add(database, 'imap', 'folder:Projects')
    add(database, 'imap', 'folder:Receipts')
    const result = run(database, { type: 'folder-preferences:remove-favorite', payload: { accountId: 'imap', labelId: 'folder:Projects' } })
    expect(result.favorites.map((item) => [item.labelId, item.position])).toEqual([['folder:Receipts', 0]])
    expect(database.listLabels(['imap']).map((label) => label.id)).toContain('folder:Projects')
    expect(() => run(database, { type: 'folder-preferences:set-alias', payload: { accountId: 'imap', labelId: 'folder:Projects', alias: 'X' } })).toThrow(/not in Favorites/)
  })

  it('follows IMAP renames and moves made through Aerio, including subfolders', async () => {
    const { database } = setup()
    let remote = database.listLabels(['imap'])
    const imap = {
      withConnection: vi.fn(async (callback: (connection: never) => unknown) => callback({} as never)),
      listFolders: vi.fn(async () => remote.map((label) => ({ path: label.id.slice(7), name: label.name, delimiter: '/', ...(label.type === 'system' ? { specialUse: '\\Inbox' } : {}) }))),
      createFolder: vi.fn(),
      deleteFolder: vi.fn(),
      renameFolder: vi.fn(async (path: string, parent: string | undefined, name: string) => {
        const target = parent ? `${parent}/${name}` : name
        remote = remote.map((label) => label.id === `folder:${path}` || label.id.startsWith(`folder:${path}/`)
          ? { ...label, id: `folder:${target}${label.id.slice(7 + path.length)}`, name: `${target}${label.name.slice(path.length)}` } : label)
        return { path: target, delimiter: '/' }
      })
    }
    const manager = new MailFolderManager({ database, online: () => true, gmail: () => { throw new Error('unused') }, microsoft: () => { throw new Error('unused') }, imap: async () => imap as never })
    add(database, 'imap', 'folder:Projects/2026')
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Projects', icon: 'briefcase', color: '#1a73e8' } })

    await manager.update({ accountId: 'imap', labelId: 'folder:Projects', name: 'Clients' })
    expect(ids(database)).toEqual(['imap:folder:Clients/2026'])
    expect(database.folderPreferences.list().favorites[0].lastKnownName).toBe('Clients/2026')
    expect(database.folderPreferences.list().appearance).toEqual([{ accountId: 'imap', labelId: 'folder:Clients', icon: 'briefcase', color: '#1a73e8', hidden: false }])

    await manager.update({ accountId: 'imap', labelId: 'folder:Clients/2026', parentId: 'folder:Receipts' })
    expect(ids(database)).toEqual(['imap:folder:Receipts/2026'])
  })

  it('reconciles IMAP renames made in another client on the next sync', () => {
    const { database } = setup()
    add(database, 'imap', 'folder:Projects')
    add(database, 'imap', 'folder:Projects/2026')
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Projects/2026', hidden: true } })
    database.replaceLabels('imap', [folder('imap', 'INBOX', 'system'), folder('imap', 'Work'), folder('imap', 'Work/2026'), folder('imap', 'Receipts')])
    expect(ids(database)).toEqual(['imap:folder:Work', 'imap:folder:Work/2026'])
    expect(database.folderPreferences.list().favorites.map((item) => item.lastKnownName)).toEqual(['Work', 'Work/2026'])
    expect(database.folderPreferences.list().appearance[0]).toMatchObject({ labelId: 'folder:Work/2026', hidden: true })
  })

  it('keeps a favorite as unavailable when the change is ambiguous or the folder was deleted elsewhere', () => {
    const { database } = setup()
    add(database, 'imap', 'folder:Projects/2026')
    add(database, 'imap', 'folder:Receipts')
    add(database, 'gmail', 'Label_1')
    // Two folders vanished and two unrelated folders appeared: no guess.
    database.replaceLabels('imap', [folder('imap', 'INBOX', 'system'), folder('imap', 'Alpha'), folder('imap', 'Beta')])
    expect(ids(database)).toEqual(['imap:folder:Projects/2026', 'imap:folder:Receipts', 'gmail:Label_1'])
    expect(inferFolderPathRenames([folder('imap', 'Old')], [folder('imap', 'Other/New')])).toEqual({})
    // Gmail ids are stable; a label missing from a sync stays as a stale favorite and comes back with it.
    database.replaceLabels('gmail', [])
    expect(ids(database)).toContain('gmail:Label_1')
    database.replaceLabels('gmail', [{ accountId: 'gmail', id: 'Label_1', name: 'Projects renamed', type: 'user' }])
    expect(database.folderPreferences.list().favorites.find((item) => item.accountId === 'gmail')?.lastKnownName).toBe('Projects renamed')
    // A stale favorite can always be removed, and folders deleted through Aerio are forgotten.
    run(database, { type: 'folder-preferences:remove-favorite', payload: { accountId: 'imap', labelId: 'folder:Receipts' } })
    database.folderPreferences.forget('imap', ['folder:Projects/2026'])
    expect(ids(database)).toEqual(['gmail:Label_1'])
  })

  it('deletes preferences with the account', () => {
    const { database } = setup()
    add(database, 'imap', 'folder:Projects')
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Projects', icon: 'star' } })
    database.disconnectAccount('imap', 'delete')
    expect(database.folderPreferences.list()).toEqual({ favorites: [], appearance: [] })
  })
})

describe('folder appearance', () => {
  it('stores local icons and colors for non-Gmail folders and keeps Gmail colors on Gmail', () => {
    const { database } = setup()
    expect(run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Receipts', icon: 'receipt', color: '#188038' } }).appearance)
      .toEqual([{ accountId: 'imap', labelId: 'folder:Receipts', icon: 'receipt', color: '#188038', hidden: false }])
    expect(() => run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'gmail', labelId: 'Label_1', color: '#188038' } })).toThrow(/synchronized with Gmail/)
    // Icons and visibility are local for Gmail labels too; the synced Gmail color stays on the label.
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'gmail', labelId: 'Label_1', icon: 'star', hidden: true } })
    expect(database.folderPreferences.list().appearance.find((item) => item.accountId === 'gmail')).toEqual({ accountId: 'gmail', labelId: 'Label_1', icon: 'star', hidden: true })
    expect(database.listLabels(['gmail']).find((label) => label.id === 'Label_1')?.color).toBe('#4a86e8')
  })

  it('merges partial changes and drops rows that return to the default look', () => {
    const { database } = setup()
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Receipts', hidden: true } })
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Receipts', icon: 'flag' } })
    expect(database.folderPreferences.list().appearance).toEqual([{ accountId: 'imap', labelId: 'folder:Receipts', icon: 'flag', hidden: true }])
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Receipts', icon: null, hidden: false } })
    expect(database.folderPreferences.list().appearance).toEqual([])
    expect(() => run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Gone', icon: 'flag' } })).toThrow(/no longer exists/)
    expect(run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Gone', icon: null, hidden: false } }).appearance).toEqual([])
  })

  it('is included in profile backups and restored with the mail database', async () => {
    const profile = temporary('profile')
    const state = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
    state.exec(`CREATE TABLE app_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    state.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run('{"settings":{}}', '2026-10-01T00:00:00Z')
    state.close()
    const database = open(profile)
    database.upsertAccount(account('imap', 'imap'))
    database.replaceLabels('imap', [folder('imap', 'Projects'), folder('imap', 'Receipts')])
    add(database, 'imap', 'folder:Receipts')
    add(database, 'imap', 'folder:Projects')
    run(database, { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Projects', icon: 'briefcase' } })
    database.close()
    const { path } = await createProfileBackup({ userData: profile, directory: temporary('target'), layout: PROFILE_BACKUP_LAYOUT, appVersion: '0.6.0', trigger: 'manual' })
    expect((await previewProfileBackup(path, profile, PROFILE_BACKUP_LAYOUT)).counts.find((item) => item.label === 'Favorite folders')?.count).toBe(2)

    const live = open(profile)
    run(live, { type: 'folder-preferences:remove-favorite', payload: { accountId: 'imap', labelId: 'folder:Receipts' } })
    live.close()
    await stageProfileRestore({ backupPath: path, userData: profile, layout: PROFILE_BACKUP_LAYOUT })
    expect(applyPendingProfileRestore(profile)).toMatchObject({ status: 'applied' })
    const restored = open(profile)
    expect(ids(restored)).toEqual(['imap:folder:Receipts', 'imap:folder:Projects'])
    expect(restored.folderPreferences.list().appearance).toEqual([{ accountId: 'imap', labelId: 'folder:Projects', icon: 'briefcase', hidden: false }])
  })
})
