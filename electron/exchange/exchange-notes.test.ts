import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Note } from '../../src/types'
import { ServerNotesService } from '../productivity/server-notes-service'
import { ServerNotesStore } from '../productivity/server-notes-store'
import { EwsClient } from './ews-client'
import { EwsFixtureServer, noteProps } from './ews-fixture-server'
import { ExchangeNotesAdapter } from './exchange-notes'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082', 'hex')
const ACCOUNT = { id: 'exchange-1', provider: 'exchange' as const, name: 'ada@contoso.test' }
const COLOR = '<t:ExtendedProperty><t:ExtendedFieldURI DistinguishedPropertySetId="Common" PropertyId="35584" PropertyType="Integer"/><t:Value>3</t:Value></t:ExtendedProperty>'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function harness() {
  const server = await new EwsFixtureServer({ auth: 'ntlm' }).start()
  const notes = server.addNotesFolder()
  const directory = mkdtempSync(join(tmpdir(), 'aerio-ews-notes-'))
  const attachments = join(directory, 'note-attachments')
  let store = new ServerNotesStore(join(directory, 'server-notes.sqlite'))
  const state = { online: true }
  const make = () => new ServerNotesService({
    store, accounts: () => [ACCOUNT], attachmentsDirectory: attachments, localSnapshot: () => ({ tasks: [], notes: [], contacts: [] }), online: () => state.online, flushDelayMs: -1,
    adapter: () => new ExchangeNotesAdapter(new EwsClient({ url: server.url, credentials: { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }, sleep: async () => undefined }))
  })
  let service = make()
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => { service.dispose(); store.close() })
  return {
    server, notes, state, attachments,
    get service() { return service },
    get store() { return store },
    restart() { service.dispose(); store.close(); store = new ServerNotesStore(join(directory, 'server-notes.sqlite')); service = make(); return service },
    note: (title: string) => service.snapshot().notes.find((note) => note.title === title),
    sync: () => service.sync(ACCOUNT.id),
    flush: () => service.flushAccount(ACCOUNT.id),
    requests: (operation: string) => server.log.filter((entry) => entry.operation === operation)
  }
}

const draft = (overrides: Partial<Note> = {}): Note => ({ id: 'draft', folder: 'Notes', title: 'New note', content: 'Body', tags: [], pinned: false, archived: false, updatedAt: '2026-10-17T00:00:00Z', ...overrides })

describe('Exchange Notes over EWS', () => {
  it('discovers the Notes folder and other sticky-note folders with their rights and maps notes', async () => {
    const h = await harness()
    const shared = h.server.addFolder('Shared notes', 'IPF.StickyNote')
    shared.canWrite = false
    h.server.addFolder('Not notes', 'IPF.Note')
    h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Plain', body: 'Plain text\nsecond line', categories: ['Blue category'], extra: { ExtendedProperty: COLOR } }))
    h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Rich', body: '<html><head><style>p{}</style></head><body><p>Hello <b>there</b></p><script>x()</script></body></html>', html: true }))
    h.server.addItem(h.notes.id, 'note', { ItemClass: '<t:ItemClass>IPM.Note</t:ItemClass>', Subject: '<t:Subject>A mail that wandered in</t:Subject>' })
    h.server.addItem(shared.id, 'note', noteProps({ subject: 'Read only', body: 'Look only' }))
    await h.sync()
    const snapshot = h.service.snapshot()
    expect(snapshot.folders.map((folder) => [folder.name, folder.readOnly])).toEqual([['Notes', false], ['Shared notes', true]])
    expect(snapshot.notes.map((note) => note.title).sort()).toEqual(['Plain', 'Read only', 'Rich'])
    expect(h.note('Plain')).toMatchObject({ content: 'Plain text\nsecond line', tags: ['Blue category'], sync: 'synced', owner: { provider: 'exchange' } })
    expect(h.note('Plain')!.html).toBeUndefined()
    expect(h.note('Rich')).toMatchObject({ html: '<p>Hello <b>there</b></p>', content: 'Hello there' })
    expect(h.note('Read only')).toMatchObject({ readOnly: true })
  })

  it('pulls changes and deletions with the SyncState and recovers from an invalid state', async () => {
    const h = await harness()
    const first = h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'One', body: 'a' }))
    const second = h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Two', body: 'b' }))
    await h.sync()
    h.server.touch(first.id, (item) => item.props.set('Subject', '<t:Subject>One edited</t:Subject>'))
    h.server.removeItem(second.id)
    await h.sync()
    expect(h.service.snapshot().notes.map((note) => note.title)).toEqual(['One edited'])
    const syncRequests = h.requests('SyncFolderItems')
    expect(syncRequests[syncRequests.length - 1].body).toContain('<m:SyncState>')
    h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Three', body: 'c' }))
    h.server.invalidateSyncStates()
    await h.sync()
    expect(h.service.snapshot().notes.map((note) => note.title).sort()).toEqual(['One edited', 'Three'])
  })

  it('updates only the edited fields with the ChangeKey and leaves extended properties untouched', async () => {
    const h = await harness()
    const item = h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Colored', body: 'Body', extra: { ExtendedProperty: COLOR } }))
    await h.sync()
    const key = item.changeKey
    await h.service.update({ ...h.note('Colored')!, title: 'Colored and renamed' })
    await h.flush()
    const [update] = h.requests('UpdateItem')
    expect(update.body).toContain(`ChangeKey="${key}"`)
    expect(update.body).toContain('ConflictResolution="NeverOverwrite"')
    expect(update.body).toContain('FieldURI="item:Subject"')
    expect(update.body).not.toContain('item:Body')
    expect(update.body).not.toContain('ExtendedProperty')
    expect(item.props.get('ExtendedProperty')).toBe(COLOR)
    expect(item.props.get('Subject')).toContain('Colored and renamed')

    await h.service.update({ ...h.note('Colored and renamed')!, content: 'New body', tags: ['Red'] })
    await h.flush()
    expect(item.props.get('Body')).toContain('New body')
    expect(item.props.get('Categories')).toContain('Red')
    await h.service.update({ ...h.note('Colored and renamed')!, tags: [] })
    await h.flush()
    expect(item.props.has('Categories')).toBe(false)
    expect(item.props.get('ExtendedProperty')).toBe(COLOR)
  })

  it('creates sticky notes with attachments and inline pictures and reads them back with the same ids', async () => {
    const h = await harness()
    await h.sync()
    mkdirSync(h.attachments, { recursive: true })
    const picture = join(h.attachments, 'pic.png')
    writeFileSync(picture, PNG)
    const file = join(h.attachments, 'doc.txt')
    writeFileSync(file, 'attachment text')
    const folderId = h.service.snapshot().folders[0].id
    await h.service.create(folderId, draft({
      title: 'Illustrated', content: 'See', html: '<div>See <img data-aerio-note-image="pic-1" alt="dot"></div>', tags: ['Ideas'],
      attachments: [{ id: 'pic-1', name: 'dot.png', size: PNG.length, mime: 'image/png', path: picture, inline: true }, { id: 'doc-1', name: 'doc.txt', size: 15, mime: 'text/plain', path: file }]
    }))
    await h.flush()
    const created = [...h.server.items.values()].find((item) => item.kind === 'note')!
    expect(created.props.get('ItemClass')).toContain('IPM.StickyNote')
    expect(created.props.get('Body')).toContain('src=&quot;cid:pic-1&quot;')
    expect(created.attachments!.map((attachment) => [attachment.name, attachment.contentId, attachment.isInline])).toEqual([['dot.png', 'pic-1', true], ['doc.txt', 'doc-1', false]])
    await h.sync()
    const note = h.note('Illustrated')!
    expect(note).toMatchObject({ html: '<div>See <img data-aerio-note-image="pic-1" alt="dot" /></div>', tags: ['Ideas'], sync: 'synced' })
    expect(note.attachments!.map((attachment) => [attachment.id, Boolean(attachment.inline)])).toEqual([['pic-1', true], ['doc-1', false]])

    // Another client attaches a file; removing it in Aerio deletes only that attachment.
    h.server.attach(created.id, { name: 'extra.csv', contentType: 'text/csv', content: Buffer.from('x,y') })
    await h.sync()
    const withExtra = h.note('Illustrated')!
    const extra = withExtra.attachments!.find((attachment) => attachment.name === 'extra.csv')!
    expect(readFileSync(extra.path!, 'utf8')).toBe('x,y')
    await h.service.update({ ...withExtra, attachments: withExtra.attachments!.filter((attachment) => attachment.name !== 'extra.csv') })
    await h.flush()
    expect(h.requests('DeleteAttachment')).toHaveLength(1)
    expect(created.attachments!.map((attachment) => attachment.name)).toEqual(['dot.png', 'doc.txt'])
    expect(h.requests('UpdateItem')).toHaveLength(0)
  })

  it('reviews ChangeKey conflicts and deletes, and keeps queued writes across a restart', async () => {
    const h = await harness()
    const item = h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Shared', body: 'v1' }))
    const doomed = h.server.addItem(h.notes.id, 'note', noteProps({ subject: 'Doomed', body: 'x' }))
    await h.sync()
    h.state.online = false
    await h.service.update({ ...h.note('Shared')!, content: 'mine' })
    await h.service.remove(h.note('Doomed')!.id)
    h.restart()
    h.server.touch(item.id, (value) => value.props.set('Body', '<t:Body BodyType="Text">theirs</t:Body>'))
    h.server.touch(doomed.id, (value) => value.props.set('Subject', '<t:Subject>Doomed but edited</t:Subject>'))
    h.state.online = true
    await h.flush()
    const review = h.service.snapshot().review
    expect(review.map((entry) => [entry.action, entry.status, entry.serverExcerpt])).toEqual([['update', 'conflict', 'theirs'], ['delete', 'conflict', 'x']])
    await h.service.resolve(review[0].id, 'keep-mine')
    expect(item.props.get('Body')).toContain('mine')
    await h.service.resolve(review[1].id, 'keep-server')
    await h.sync()
    expect(h.note('Doomed but edited')).toBeDefined()
    await h.service.remove(h.note('Doomed but edited')!.id)
    await h.flush()
    expect(h.server.items.has(doomed.id)).toBe(false)
  })

  it('refuses writes to read-only Exchange folders', async () => {
    const h = await harness()
    h.notes.canWrite = false
    await h.sync()
    expect(h.service.snapshot().folders[0].readOnly).toBe(true)
    await expect(h.service.create(h.service.snapshot().folders[0].id, draft())).rejects.toThrow(/read-only/)
  })
})
