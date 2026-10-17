import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalModuleSnapshot } from '../../src/productivity-types'
import type { Note } from '../../src/types'
import { DavClient } from './dav-client'
import { DavFixtureServer, ICS, VJOURNAL } from './dav-fixture-server'
import { DavNotesAdapter } from './dav-notes'
import { ServerNotesService } from './server-notes-service'
import { prepareRestoredServerNotesDatabase, RESTORED_SERVER_NOTES_WRITE_MESSAGE, ServerNotesStore } from './server-notes-store'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082', 'hex')
const ACCOUNT = { id: 'dav-1', provider: 'dav' as const, name: 'Fastmail' }
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function harness() {
  const server = await new DavFixtureServer().start()
  const journal = server.addCollection({ slug: 'journal', kind: 'calendar', name: 'Journal', components: ['VJOURNAL'] })
  const mixed = server.addCollection({ slug: 'mixed', kind: 'calendar', name: 'Everything', components: ['VEVENT', 'VTODO', 'VJOURNAL'] })
  const team = server.addCollection({ slug: 'team', kind: 'calendar', name: 'Team notes', components: ['VJOURNAL'], readOnly: true })
  server.addCollection({ slug: 'events', kind: 'calendar', name: 'Events', components: ['VEVENT'] })
  const directory = mkdtempSync(join(tmpdir(), 'aerio-server-notes-'))
  const attachments = join(directory, 'note-attachments')
  let store = new ServerNotesStore(join(directory, 'server-notes.sqlite'))
  const state = { online: true, now: new Date('2026-10-17T12:00:00Z'), local: { tasks: [], notes: [], contacts: [] } as LocalModuleSnapshot }
  const make = () => new ServerNotesService({
    store, accounts: () => [ACCOUNT], attachmentsDirectory: attachments, localSnapshot: () => state.local, online: () => state.online, now: () => state.now, flushDelayMs: -1,
    adapter: () => new DavNotesAdapter(new DavClient({ username: 'ada@example.com', password: 'app-password' }, { sleep: async () => undefined }), { calendarHomeUrl: new URL(server.calendarHome, server.url).toString() }, () => state.now)
  })
  let service = make()
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => { service.dispose(); store.close() })
  const folder = (name: string) => service.snapshot().folders.find((item) => item.name === name)!
  const note = (title: string) => service.snapshot().notes.find((item) => item.title === title)
  const localFile = (name: string, bytes: Buffer) => {
    mkdirSync(attachments, { recursive: true })
    const path = join(attachments, name)
    writeFileSync(path, bytes)
    return path
  }
  return {
    server, journal, mixed, team, directory, attachments, state, folder, note, localFile,
    get service() { return service },
    get store() { return store },
    /** Simulates an app restart; `between` runs on the closed database file (for example a profile restore). */
    restart(between?: (path: string) => void) {
      service.dispose()
      store.close()
      between?.(join(directory, 'server-notes.sqlite'))
      store = new ServerNotesStore(join(directory, 'server-notes.sqlite'))
      service = make()
      return service
    },
    puts: () => server.requests.filter((request) => request.method === 'PUT'),
    sync: () => service.sync(ACCOUNT.id),
    flush: () => service.flushAccount(ACCOUNT.id)
  }
}

const localNote = (overrides: Partial<Note> = {}): Note => ({ id: 'local-1', folder: 'Personal', title: 'Local note', content: 'Local body', tags: [], pinned: false, archived: false, updatedAt: '2026-10-01T00:00:00Z', ...overrides })

describe('server-synchronized Notes over CalDAV', () => {
  it('discovers notes folders, routes only VJOURNAL entries to Notes, and pulls revisions and deletions incrementally', async () => {
    const h = await harness()
    h.server.write(h.journal, 'n1.ics', VJOURNAL('n1', 'Groceries', 'Milk'))
    h.server.write(h.mixed, 'e1.ics', ICS('e1', 'Standup'))
    h.server.write(h.mixed, 'j2.ics', VJOURNAL('j2', 'Retro notes', 'Went well'))
    h.server.write(h.team, 't1.ics', VJOURNAL('t1', 'Team charter', 'Shared'))
    await h.sync()
    const snapshot = h.service.snapshot()
    expect(snapshot.folders.map((folder) => [folder.name, folder.readOnly, Boolean(folder.mixed)])).toEqual([['Journal', false, false], ['Everything', false, true], ['Team notes', true, false]])
    expect(snapshot.notes.map((note) => note.title).sort()).toEqual(['Groceries', 'Retro notes', 'Team charter'])
    expect(h.note('Team charter')).toMatchObject({ readOnly: true, sync: 'synced', folder: 'Team notes' })
    expect(snapshot.accounts[0]).toMatchObject({ id: 'dav-1', status: 'ready', pendingWrites: 0 })

    h.server.write(h.journal, 'n1.ics', VJOURNAL('n1', 'Groceries', 'Milk and bread'))
    h.server.remove(h.mixed, 'j2.ics')
    await h.sync()
    expect(h.note('Groceries')).toMatchObject({ content: 'Milk and bread' })
    expect(h.note('Retro notes')).toBeUndefined()
    // The event in the mixed collection was read once and is tracked by ETag, never shown in Notes.
    const eventReads = h.server.requests.filter((request) => request.method === 'REPORT' && request.body.includes('e1.ics')).length
    expect(eventReads).toBe(1)
    expect(h.service.snapshot().notes.some((note) => note.title === 'Standup')).toBe(false)
  })

  it('patches the server copy with If-Match and keeps unknown properties; color, pin, and archive stay local', async () => {
    const h = await harness()
    const etag = h.server.write(h.journal, 'n1.ics', VJOURNAL('n1', 'Plan', 'Body', 'X-CUSTOM-FLAG:keep\nATTACH:https://files.example.com/a.pdf'))
    await h.sync()
    const current = h.note('Plan')!
    await h.service.update({ ...current, pinned: true, color: '#ffeeaa', archived: true })
    expect(h.store.operations()).toHaveLength(0)
    expect(h.note('Plan')).toMatchObject({ pinned: true, color: '#ffeeaa', archived: true, sync: 'synced' })
    await h.service.update({ ...h.note('Plan')!, title: 'Plan v2', tags: ['Work'] })
    expect(h.note('Plan v2')).toMatchObject({ sync: 'pending', pinned: true })
    await h.flush()
    const [put] = h.puts()
    expect(put.headers['if-match']).toBe(etag)
    const stored = h.server.resource(h.journal, 'n1.ics')!.data
    expect(stored).toContain('SUMMARY:Plan v2')
    expect(stored).toContain('CATEGORIES:Work')
    expect(stored).toContain('X-CUSTOM-FLAG:keep')
    expect(stored).toContain('ATTACH:https://files.example.com/a.pdf')
    expect(stored).toContain('DESCRIPTION:Body')
    expect(h.note('Plan v2')).toMatchObject({ sync: 'synced', tags: ['Work'] })
  })

  it('keeps offline creates and edits in a durable queue across a restart and sends each once', async () => {
    const h = await harness()
    h.server.write(h.journal, 'n1.ics', VJOURNAL('n1', 'Draft', 'One'))
    await h.sync()
    h.state.online = false
    await h.service.update({ ...h.note('Draft')!, content: 'One and two', html: undefined })
    const created = await h.service.create(h.folder('Journal').id, localNote({ title: 'Written offline', content: 'Offline body' }))
    expect(created).toMatchObject({ sync: 'pending', owner: { provider: 'dav', accountId: 'dav-1' } })
    await h.flush()
    expect(h.puts()).toHaveLength(0)

    const restarted = h.restart()
    expect(restarted.snapshot().notes.filter((note) => note.sync === 'pending').map((note) => note.title).sort()).toEqual(['Draft', 'Written offline'])
    h.state.online = true
    h.server.failures = { PUT: [503] }
    await h.flush()
    const retry = h.store.operations()
    expect(retry).toHaveLength(2)
    expect(retry[0]).toMatchObject({ status: 'queued', attempts: 1 })
    h.state.now = new Date(h.state.now.getTime() + 60 * 60_000)
    await h.flush()
    expect(h.store.operations()).toHaveLength(0)
    expect([...h.journal.resources.values()].map((resource) => resource.data).filter((data) => data.includes('Written offline'))).toHaveLength(1)
    expect(h.server.resource(h.journal, 'n1.ics')!.data).toContain('DESCRIPTION:One and two')
    await h.sync()
    expect(h.service.snapshot().notes.every((note) => note.sync === 'synced')).toBe(true)
    expect(h.service.snapshot().notes.find((note) => note.title === 'Written offline')!.id).toBe(created.id)
  })

  it('sends a refused edit to review and resolves it with keep mine, keep server, or keep both', async () => {
    const h = await harness()
    for (const name of ['a', 'b', 'c']) h.server.write(h.journal, `${name}.ics`, VJOURNAL(name, `Note ${name}`, 'Original'))
    await h.sync()
    h.state.online = false
    for (const name of ['a', 'b', 'c']) await h.service.update({ ...h.note(`Note ${name}`)!, content: `Mine ${name}` })
    for (const name of ['a', 'b', 'c']) h.server.write(h.journal, `${name}.ics`, VJOURNAL(name, `Note ${name}`, `Theirs ${name}`, 'X-SERVER-ADDED:yes'))
    h.state.online = true
    await h.flush()
    const review = h.service.snapshot().review
    expect(review.map((item) => [item.title, item.status, item.serverExcerpt, item.mineExcerpt, item.canKeepBoth])).toEqual([
      ['Note a', 'conflict', 'Theirs a', 'Mine a', true], ['Note b', 'conflict', 'Theirs b', 'Mine b', true], ['Note c', 'conflict', 'Theirs c', 'Mine c', true]
    ])
    await expect(h.service.update({ ...h.note('Note a')!, content: 'again' })).rejects.toThrow(/conflict/)

    await h.service.resolve(review[0].id, 'keep-mine')
    expect(h.server.resource(h.journal, 'a.ics')!.data).toContain('DESCRIPTION:Mine a')
    expect(h.server.resource(h.journal, 'a.ics')!.data).toContain('X-SERVER-ADDED:yes')

    await h.service.resolve(review[1].id, 'keep-server')
    expect(h.note('Note b')).toMatchObject({ content: 'Theirs b', sync: 'synced' })

    await h.service.resolve(review[2].id, 'keep-both')
    await h.sync()
    expect(h.note('Note c')).toMatchObject({ content: 'Theirs c' })
    expect(h.note('Note c (my copy)')).toMatchObject({ content: 'Mine c', sync: 'synced' })
    expect(h.service.snapshot().review).toHaveLength(0)
  })

  it('reports a note deleted on the server while edited and can recreate it or save it to Local', async () => {
    const h = await harness()
    h.server.write(h.journal, 'gone.ics', VJOURNAL('gone', 'Vanishing', 'Text'))
    h.server.write(h.journal, 'gone2.ics', VJOURNAL('gone2', 'Vanishing too', 'Text'))
    await h.sync()
    h.state.online = false
    await h.service.update({ ...h.note('Vanishing')!, content: 'Edited' })
    await h.service.update({ ...h.note('Vanishing too')!, content: 'Edited too' })
    h.server.remove(h.journal, 'gone.ics')
    h.server.remove(h.journal, 'gone2.ics')
    h.state.online = true
    await h.flush()
    const [first, second] = h.service.snapshot().review
    expect(first).toMatchObject({ serverDeleted: true, canKeepBoth: false, error: 'Deleted on the server since you edited it' })
    await h.service.resolve(first.id, 'keep-mine')
    expect([...h.journal.resources.values()].some((resource) => resource.data.includes('DESCRIPTION:Edited'))).toBe(true)
    const { localNotes } = await h.service.resolve(second.id, 'copy-local')
    expect(localNotes).toEqual([expect.objectContaining({ title: 'Vanishing too', content: 'Edited too', folder: 'Journal' })])
    expect(h.note('Vanishing too')).toBeUndefined()
  })

  it('synchronizes inline pictures and file attachments and cleans up files no note uses', async () => {
    const h = await harness()
    await h.sync()
    const picture = h.localFile('picture.png', PNG)
    const document = h.localFile('notes.txt', Buffer.from('plain attachment'))
    const created = await h.service.create(h.folder('Journal').id, localNote({
      title: 'With files', content: 'Look', html: '<div>Look<img data-aerio-note-image="pic-1" alt="dot"></div>',
      attachments: [{ id: 'pic-1', name: 'dot.png', size: PNG.length, mime: 'image/png', path: picture, inline: true }, { id: 'doc-1', name: 'notes.txt', size: 16, mime: 'text/plain', path: document }]
    }))
    await h.flush()
    const [resource] = [...h.journal.resources.values()]
    const unfolded = resource.data.replace(/\r\n /g, '')
    expect(unfolded).toContain('X-ALT-DESC;FMTTYPE=text/html:<div>Look<img data-aerio-note-image="pic-1" alt="dot" /></div>'.replace('data-aerio-note-image="pic-1"', 'src="cid:pic-1"'))
    expect(unfolded).toContain(`X-AERIO-ATTACHMENT-ID=pic-1;X-AERIO-INLINE=TRUE:${PNG.toString('base64')}`)
    expect(unfolded).toContain(`X-FILENAME=notes.txt;X-AERIO-ATTACHMENT-ID=doc-1:${Buffer.from('plain attachment').toString('base64')}`)

    // Another client adds an attachment.
    const name = [...h.journal.resources.keys()][0]
    h.server.write(h.journal, name, resource.data.replace('END:VJOURNAL', `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=text/csv;FILENAME=data.csv:${Buffer.from('a,b').toString('base64')}\r\nEND:VJOURNAL`))
    await h.sync()
    const synced = h.service.snapshot().notes.find((note) => note.id === created.id)!
    expect(synced.html).toBe('<div>Look<img data-aerio-note-image="pic-1" alt="dot" /></div>')
    expect(synced.attachments!.map((attachment) => [attachment.name, Boolean(attachment.inline)])).toEqual([['dot.png', true], ['notes.txt', false], ['data.csv', false]])
    const csv = synced.attachments!.find((attachment) => attachment.name === 'data.csv')!
    expect(readFileSync(csv.path!, 'utf8')).toBe('a,b')

    await h.service.update({ ...synced, attachments: synced.attachments!.filter((attachment) => attachment.name !== 'data.csv') })
    await h.flush()
    expect(h.server.resource(h.journal, name)!.data).not.toContain('data.csv')
    expect(existsSync(csv.path!)).toBe(false)
    expect(existsSync(picture)).toBe(true)
  })

  it('refuses writes to read-only folders but keeps local display state', async () => {
    const h = await harness()
    h.server.write(h.team, 't1.ics', VJOURNAL('t1', 'Charter', 'Shared'))
    await h.sync()
    await expect(h.service.update({ ...h.note('Charter')!, title: 'Mine now' })).rejects.toThrow(/read-only/)
    await expect(h.service.create(h.folder('Team notes').id, localNote())).rejects.toThrow(/read-only/)
    await expect(h.service.remove(h.note('Charter')!.id)).rejects.toThrow(/read-only/)
    await h.service.update({ ...h.note('Charter')!, pinned: true })
    expect(h.note('Charter')).toMatchObject({ pinned: true })
  })

  it('copies and moves notes between Local and provider folders, deleting a source only after its copy exists', async () => {
    const h = await harness()
    h.server.write(h.journal, 'n1.ics', VJOURNAL('n1', 'Server note', 'From server', `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=text/plain;FILENAME=a.txt:${Buffer.from('attached').toString('base64')}`))
    await h.sync()
    const file = h.localFile('local.txt', Buffer.from('local file'))
    const local = localNote({ attachments: [{ id: 'f1', name: 'local.txt', size: 10, path: file }] })
    h.state.local = { tasks: [], notes: [local], contacts: [] }

    const moved = await h.service.transfer({ mode: 'move', target: { kind: 'server', folderId: h.folder('Everything').id }, localNotes: [local] })
    expect(moved).toMatchObject({ copied: 1, removeLocalIds: ['local-1'], pendingMoves: 0, errors: [] })
    const copy = h.note('Local note')!
    expect(copy.owner.folderId).toBe(h.folder('Everything').id)
    expect(copy.attachments![0].path).not.toBe(file)
    expect(existsSync(file)).toBe(true)

    // Offline: the copy is queued, so the Local original is kept.
    h.state.online = false
    const offline = await h.service.transfer({ mode: 'move', target: { kind: 'server', folderId: h.folder('Journal').id }, localNotes: [localNote({ id: 'local-2', title: 'Offline move' })] })
    expect(offline).toMatchObject({ copied: 1, removeLocalIds: [], pendingMoves: 1 })
    h.state.online = true

    const toLocal = await h.service.transfer({ mode: 'move', target: { kind: 'local', folder: 'Imported' }, serverNoteIds: [h.note('Server note')!.id] })
    expect(toLocal.localNotes).toEqual([expect.objectContaining({ title: 'Server note', folder: 'Imported', content: 'From server' })])
    const localCopy = toLocal.localNotes[0]
    expect(readFileSync(localCopy.attachments![0].path!, 'utf8')).toBe('attached')
    await h.flush()
    expect(h.server.resource(h.journal, 'n1.ics')).toBeDefined()
    h.service.localSaved({ tasks: [], notes: [localCopy], contacts: [] })
    await h.flush()
    expect(h.server.resource(h.journal, 'n1.ics')).toBeUndefined()
    expect(existsSync(localCopy.attachments![0].path!)).toBe(true)

    const between = await h.service.transfer({ mode: 'move', target: { kind: 'server', folderId: h.folder('Journal').id }, serverNoteIds: [h.note('Local note')!.id] })
    expect(between).toMatchObject({ copied: 1, pendingMoves: 0 })
    await h.flush()
    expect(h.mixed.resources.size).toBe(0)
    expect([...h.journal.resources.values()].filter((resource) => resource.data.includes('SUMMARY:Local note'))).toHaveLength(1)
  })

  it('imports vNote files with a preview, duplicate handling, and vNote properties kept on the server', async () => {
    const h = await harness()
    await h.sync()
    const vnt = Buffer.from([
      'BEGIN:VNOTE', 'VERSION:1.1', 'BODY;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Shopping=0D=0AEggs', 'X-IRMC-LUID:L1', 'CLASS:PRIVATE', 'X-NOTE-COLOR:yellow', 'DCREATED:20240101T000000Z', 'END:VNOTE',
      'BEGIN:VNOTE', 'VERSION:1.1', 'BODY:Second', 'END:VNOTE',
      'BEGIN:VNOTE', 'VERSION:1.1', 'END:VNOTE'
    ].join('\r\n'))
    const target = { kind: 'server' as const, folderId: h.folder('Journal').id }
    const preview = h.service.previewVNoteFile(vnt, 'notes.vnt', target)
    expect(preview).toMatchObject({ fileName: 'notes.vnt', count: 3, valid: 2, duplicates: 0 })
    expect(preview.entries.map((entry) => [entry.title, entry.excerpt, entry.error])).toEqual([['Shopping', 'Shopping Eggs', undefined], ['Second', 'Second', undefined], ['Untitled note', '', 'This note has no BODY']])
    const imported = await h.service.importVNote({ token: preview.token, target, duplicates: 'skip' })
    expect(imported).toMatchObject({ imported: 2, failed: 1, skipped: 0 })
    await h.flush()
    const shopping = [...h.journal.resources.values()].find((resource) => resource.data.includes('SUMMARY:Shopping'))!.data
    expect(shopping).toContain('CLASS:PRIVATE')
    expect(shopping).toContain('X-NOTE-COLOR:yellow')
    expect(shopping).toContain('CREATED:20240101T000000Z')

    // The same file again: the LUID and the content identify both notes.
    const again = h.service.previewVNoteFile(vnt, 'notes.vnt', target)
    expect(again.entries.map((entry) => entry.duplicate?.reason)).toEqual(['luid', 'content', undefined])
    expect((await h.service.importVNote({ token: again.token, target, duplicates: 'skip' })).skipped).toBe(2)
    const changed = Buffer.from(vnt.toString('utf8').replace('Eggs', 'Eggs and ham'))
    const replace = h.service.previewVNoteFile(changed, 'notes.vnt', target)
    expect(replace.entries[0].duplicate?.reason).toBe('luid')
    expect(await h.service.importVNote({ token: replace.token, target, duplicates: 'replace' })).toMatchObject({ replaced: 2 })
    await h.flush()
    expect(h.note('Shopping')).toMatchObject({ content: 'Shopping\nEggs and ham', sync: 'synced' })
    const copies = h.service.previewVNoteFile(vnt, 'notes.vnt', target)
    expect(await h.service.importVNote({ token: copies.token, target, duplicates: 'copy' })).toMatchObject({ imported: 2 })
    expect(h.service.snapshot().notes.filter((note) => note.title === 'Second')).toHaveLength(2)

    // Local Notes: new notes are returned for the renderer; duplicates by LUID are replaced in place.
    const toLocal = h.service.previewVNoteFile(vnt, 'notes.vnt', { kind: 'local', folder: 'Imported' })
    const local = await h.service.importVNote({ token: toLocal.token, target: { kind: 'local', folder: 'Imported' }, duplicates: 'skip' })
    expect(local.localNotes.map((note) => [note.title, note.folder, note.content])).toEqual([['Shopping', 'Imported', 'Shopping\nEggs'], ['Second', 'Imported', 'Second']])
    h.state.local = { tasks: [], notes: local.localNotes, contacts: [] }
    const localAgain = h.service.previewVNoteFile(changed, 'notes.vnt', { kind: 'local', folder: 'Imported' })
    const replaced = await h.service.importVNote({ token: localAgain.token, target: { kind: 'local', folder: 'Imported' }, duplicates: 'replace' })
    expect(replaced.replacedLocal).toEqual([expect.objectContaining({ id: local.localNotes[0].id, content: 'Shopping\nEggs and ham' }), expect.objectContaining({ id: local.localNotes[1].id })])
    expect(() => h.service.previewVNote('unknown', target)).toThrow(/again/)
  })

  it('copies an account’s notes, including unsent changes, to Local and removes its cache with the account', async () => {
    const h = await harness()
    h.server.write(h.journal, 'n1.ics', VJOURNAL('n1', 'Keep me', 'Synced', `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=text/plain;FILENAME=a.txt:${Buffer.from('file').toString('base64')}`))
    await h.sync()
    h.state.online = false
    await h.service.update({ ...h.note('Keep me')!, content: 'Unsent edit' })
    expect(h.service.accountSummary('dav-1')).toEqual({ accountId: 'dav-1', notes: 1, pendingWrites: 1, review: 0 })
    const copies = h.service.copyAccountToLocal('dav-1')
    expect(copies).toEqual([expect.objectContaining({ title: 'Keep me', content: 'Unsent edit', folder: 'Journal (Fastmail)' })])
    const serverFile = h.note('Keep me')!.attachments![0].path!
    h.state.local = { tasks: [], notes: copies, contacts: [] }
    h.service.removeAccount('dav-1')
    expect(h.service.snapshot()).toMatchObject({ folders: [], notes: [], review: [] })
    expect(h.store.operations()).toHaveLength(0)
    expect(existsSync(serverFile)).toBe(false)
    expect(readFileSync(copies[0].attachments![0].path!, 'utf8')).toBe('file')
    expect(readdirSync(h.attachments)).toHaveLength(1)
  })

  it('holds queued writes and asks for sign-in after a profile restore', async () => {
    const h = await harness()
    await h.sync()
    h.state.online = false
    await h.service.create(h.folder('Journal').id, localNote({ title: 'Queued before backup' }))
    const restored = h.restart((path) => {
      const db = new DatabaseSync(path)
      expect(prepareRestoredServerNotesDatabase(db)).toEqual({ held: 1 })
      db.close()
    })
    expect(restored.snapshot().review).toEqual([expect.objectContaining({ status: 'held', error: RESTORED_SERVER_NOTES_WRITE_MESSAGE, title: 'Queued before backup' })])
    h.state.online = true
    await h.flush()
    expect(h.puts()).toHaveLength(0)
    await restored.resolve(restored.snapshot().review[0].id, 'keep-mine')
    expect(h.puts()).toHaveLength(1)
  })
})
