import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OwnerProductivityFolder } from '../mail/mailbox-owner-worker'
import { ProductivityStore } from '../productivity/store'
import { EwsClient } from './ews-client'
import { calendarProps, EwsFixtureServer } from './ews-fixture-server'
import { ExchangeProductivityService } from './exchange-productivity'
import { ExchangeStore } from './exchange-store'

const ACCOUNT = 'exchange-1'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

describe('Exchange Calendar for shared mailboxes and public folders (E40)', () => {
  it('adds delegated calendars with their rights and public calendars read-only through the routing headers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-ews-shared-prod-'))
    const server = await new EwsFixtureServer({ auth: 'basic', username: 'ada@contoso.test', password: 'Pa55w0rd!' }).start()
    const productivity = new ProductivityStore(join(directory, 'productivity.sqlite'))
    const store = new ExchangeStore(join(directory, 'exchange.sqlite'))
    const clients: EwsClient[] = []
    let shared: OwnerProductivityFolder[] = []
    const service = new ExchangeProductivityService({
      store, productivity: () => productivity, sharedFolders: async () => shared,
      client: () => { const client = new EwsClient({ url: server.url, credentials: { auth: 'basic', username: 'ada@contoso.test', password: 'Pa55w0rd!' }, sleep: async () => undefined }); clients.push(client); return client }
    })
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => productivity.close(), () => store.close(), () => { for (const client of clients) client.close() })
    service.addAccount(ACCOUNT)

    server.addMailbox('grace@contoso.test', { access: 'write' })
    server.addMailbox('team@contoso.test', { access: 'read' })
    server.addItem(server.mailboxFolder('grace@contoso.test', 'calendar').id, 'calendar', calendarProps({ subject: 'Board meeting', start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z' }))
    server.addItem(server.mailboxFolder('team@contoso.test', 'calendar').id, 'calendar', calendarProps({ subject: 'Team standup', start: '2026-10-20T08:00:00Z', end: '2026-10-20T08:15:00Z' }))
    server.enablePublicFolders('pf@contoso.test')
    const holidays = server.addPublicFolder('Holidays', 'IPF.Appointment')
    server.addItem(holidays.id, 'calendar', calendarProps({ subject: 'Company holiday', start: '2026-12-24T00:00:00Z', end: '2026-12-25T00:00:00Z' }))
    shared = [
      { ref: { id: 'calendar', mailbox: 'grace@contoso.test' }, name: 'Grace – Calendar', kind: 'calendar' },
      { ref: { id: 'calendar', mailbox: 'team@contoso.test' }, name: 'Team – Calendar', kind: 'calendar', readOnly: true },
      { ref: { id: 'calendar', mailbox: 'gone@contoso.test' }, name: 'Gone – Calendar', kind: 'calendar' },
      { ref: { id: holidays.id, distinguished: false }, name: 'Holidays (Public Folders)', kind: 'calendar', headers: { 'X-AnchorMailbox': 'pf@contoso.test', 'X-PublicFolderMailbox': 'pf@contoso.test' }, readOnly: true }
    ]
    await service.sync(ACCOUNT)

    const calendars = productivity.snapshot().calendars.filter((calendar) => calendar.provider === 'exchange')
    expect(calendars.find((calendar) => calendar.name === 'Grace – Calendar')).toMatchObject({ canWrite: true })
    expect(calendars.find((calendar) => calendar.name === 'Team – Calendar')).toMatchObject({ canWrite: false })
    expect(calendars.find((calendar) => calendar.name === 'Holidays (Public Folders)')).toMatchObject({ canWrite: false })
    expect(calendars.some((calendar) => calendar.name.startsWith('Gone'))).toBe(false)
    const titles = productivity.snapshot().events.map((event) => event.title)
    expect(titles).toEqual(expect.arrayContaining(['Board meeting', 'Team standup', 'Company holiday']))
    const publicSync = server.log.find((entry) => entry.operation === 'FindItem' && entry.body.includes(holidays.id))!
    expect(publicSync.headers['x-publicfoldermailbox']).toBe('pf@contoso.test')
  })
})
