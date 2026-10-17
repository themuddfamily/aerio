import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { PROFILE_BACKUP_LAYOUT } from '../profile-backup-layout'
import { rebaseProfilePaths } from '../profile-backup'
import { RESTORED_SERVER_NOTES_MESSAGE, RESTORED_SERVER_NOTES_WRITE_MESSAGE, ServerNotesStore } from './server-notes-store'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('server notes store in profile backups', () => {
  it('is part of the full-profile backup; restores hold queued writes, ask for sign-in, and rebase file paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-server-notes-store-'))
    directories.push(directory)
    const path = join(directory, 'server-notes.sqlite')
    const store = new ServerNotesStore(path)
    store.saveAccount({ id: 'dav-1', provider: 'dav', name: 'Fastmail', status: 'ready' })
    store.saveFolder({ id: 'f', accountId: 'dav-1', provider: 'dav', remoteId: 'https://dav.example.com/journal/', name: 'Journal', readOnly: false })
    const attachment = { id: 'a', name: 'a.png', mime: 'image/png', size: 1, inline: true, sha256: 'x', path: 'C:\\Users\\old\\AppData\\Aerio\\note-attachments\\a.png' }
    store.saveNote({ id: 'n', folderId: 'f', accountId: 'dav-1', remoteId: 'https://dav.example.com/journal/n.ics', revision: '"1"', raw: 'BEGIN:VCALENDAR', fields: { title: 'T', content: 'C', tags: [], attachments: [attachment] }, updatedAt: '2026-10-01T00:00:00Z' })
    store.saveIgnored('e', 'f', 'dav-1', 'https://dav.example.com/journal/e.ics', '"2"')
    store.saveOperation({ id: 'op', accountId: 'dav-1', folderId: 'f', noteId: 'n', action: 'update', draft: { title: 'T2', content: 'C', tags: [], attachments: [attachment] }, status: 'queued', attempts: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
    store.close()

    const spec = PROFILE_BACKUP_LAYOUT.databases.find((database) => database.file === 'server-notes.sqlite')!
    expect(spec).toBeDefined()
    expect(PROFILE_BACKUP_LAYOUT.directories.some((entry) => entry.name === 'note-attachments')).toBe(true)
    spec.prepareRestore!(path, { userData: directory, livePath: join(directory, 'live.sqlite'), report: { heldSends: 0, heldTaskWrites: 0, accountsToReauthorize: 0, rebasedPaths: false } })
    const db = new DatabaseSync(path)
    expect(spec.summarize!(db)).toEqual([{ label: 'Server-synchronized notes', count: 1 }, { label: 'Pending note changes', count: 1 }])
    expect(rebaseProfilePaths(db, 'C:\\Users\\old\\AppData\\Aerio', 'D:\\Profiles\\Aerio')).toBeGreaterThan(0)
    db.close()

    const restored = new ServerNotesStore(path)
    expect(restored.account('dav-1')).toMatchObject({ status: 'needs-auth', error: RESTORED_SERVER_NOTES_MESSAGE })
    expect(restored.operation('op')).toMatchObject({ status: 'held', error: RESTORED_SERVER_NOTES_WRITE_MESSAGE })
    expect(restored.note('n')!.fields.attachments[0].path).toBe('D:\\Profiles\\Aerio\\note-attachments\\a.png')
    expect(restored.operation('op')!.draft!.attachments[0].path).toBe('D:\\Profiles\\Aerio\\note-attachments\\a.png')
    restored.close()
  })
})
