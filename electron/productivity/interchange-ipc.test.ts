import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openPaths: [] as string[],
  savePaths: [] as string[],
  sent: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  dialog: {
    showOpenDialog: async () => ({ canceled: !mocks.openPaths.length, filePaths: mocks.openPaths.splice(0, 1) }),
    showSaveDialog: async () => {
      const filePath = mocks.savePaths.shift()
      return { canceled: !filePath, filePath }
    }
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [{ webContents: { send: (_channel: string, value: unknown) => mocks.sent.push(value) } }]
  }
}))

import { ProductivityStore } from './store'
import { InterchangeStore } from './interchange-store'
import { registerCalendarContactInterchange } from './interchange-ipc'
import type { FeedResult } from './calendar-subscriptions'
import type { InterchangeSnapshot } from '../../src/interchange-types'

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART;TZID=Europe/Paris:20260601T090000\r\nDTEND;TZID=Europe/Paris:20260601T100000\r\nSUMMARY:Sync\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
const invoke = async <T>(channel: string, ...args: unknown[]) => await mocks.handlers.get(channel)!({ sender: {} }, ...args) as T

let directory: string
let productivity: ProductivityStore
let interchange: InterchangeStore
let service: ReturnType<typeof registerCalendarContactInterchange>
let feeds: FeedResult[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-interchange-'))
  productivity = new ProductivityStore(':memory:')
  interchange = new InterchangeStore(':memory:')
  feeds = []
  mocks.handlers.clear()
  mocks.sent.length = 0
  service = registerCalendarContactInterchange({
    productivity: () => productivity,
    interchange: () => interchange,
    fetchFeed: async () => {
      const next = feeds.shift()
      if (!next) throw new Error('offline')
      return next
    }
  })
})

afterEach(() => {
  service.dispose()
  productivity.close()
  interchange.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('calendar interchange IPC', () => {
  it('previews an ICS file, imports it into a new local calendar, and exports it back', async () => {
    const path = join(directory, 'team.ics')
    writeFileSync(path, ics)
    mocks.openPaths.push(path)
    const preview = await invoke<{ fileName: string; calendarName: string; events: { id: string; timeZone: string; recurrenceRule: string }[] }>('interchange:calendar-file-choose')
    expect(preview).toMatchObject({ fileName: 'team.ics', calendarName: 'Team', events: [{ timeZone: 'Europe/Paris', recurrenceRule: 'FREQ=WEEKLY' }] })
    const snapshot = await invoke<InterchangeSnapshot>('interchange:local-events-save', { newCalendarName: 'Team' }, preview.events)
    expect(snapshot.calendars).toEqual([expect.objectContaining({ kind: 'local', name: 'Team' })])
    expect(snapshot.events[0]).toMatchObject({ calendarId: snapshot.calendars[0].id, start: '2026-06-01T07:00:00.000Z', readOnly: false, sourceUid: 'u1' })
    expect(mocks.sent).toHaveLength(1)

    const exported = join(directory, 'out.ics')
    mocks.savePaths.push(exported)
    await expect(invoke('interchange:calendar-export', [snapshot.calendars[0].id])).resolves.toEqual({ savedPath: exported, count: 1 })
    const text = readFileSync(exported, 'utf8')
    expect(text).toContain('DTSTART;TZID=Europe/Paris:20260601T090000')
    expect(text).toContain('UID:u1')
  })

  it('validates local event writes and keeps subscriptions read-only', async () => {
    await expect(invoke('interchange:local-events-save', { calendarId: 'missing' }, [])).rejects.toThrow(/no longer available/)
    await expect(invoke('interchange:local-events-save', { newCalendarName: 'X' }, [{ id: 'bad' }])).rejects.toThrow(/invalid/)
    await expect(invoke('interchange:local-events-save', undefined, [])).rejects.toThrow(/Choose where/)
    feeds.push({ status: 'ok', text: ics, finalUrl: 'https://example.test/a.ics' })
    const subscribed = await invoke<InterchangeSnapshot>('interchange:subscribe', { url: 'webcal://example.test/a.ics' })
    const subscription = subscribed.calendars[0]
    expect(subscription).toMatchObject({ kind: 'subscription', name: 'Team' })
    const event = { ...subscribed.events[0], title: 'Edited' }
    await expect(invoke('interchange:local-event-save', event)).rejects.toThrow(/read-only/)
    await expect(invoke('interchange:local-event-delete', event.id)).rejects.toThrow(/read-only/)
    // A failed manual refresh still resolves with the last good copy and the recorded error.
    const refreshed = await invoke<InterchangeSnapshot>('interchange:refresh', subscription.id)
    expect(refreshed.calendars[0].error).toBe('offline')
    expect(refreshed.events).toHaveLength(1)
    await invoke('interchange:calendar-remove', subscription.id)
    expect(interchange.snapshot()).toEqual({ calendars: [], events: [] })
  })

  it('edits and deletes local events', async () => {
    interchange.saveCalendar({ id: 'local-1', kind: 'local', name: 'Mine', color: '#111' })
    const base = { id: 'e1', calendarId: 'local-1', title: 'A', start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:00:00.000Z', color: '#111', attendees: [], reminderMinutes: 0 }
    await invoke('interchange:local-event-save', base)
    await invoke('interchange:local-event-save', { ...base, title: 'B' })
    expect(interchange.events()).toEqual([expect.objectContaining({ title: 'B' })])
    await invoke('interchange:local-event-delete', 'e1')
    expect(interchange.events()).toEqual([])
  })
})

describe('contact interchange IPC', () => {
  it('previews vCard and CSV files and refuses other formats', async () => {
    const vcf = join(directory, 'people.vcf')
    writeFileSync(vcf, 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nEMAIL:ada@test\r\nEND:VCARD\r\n')
    const csv = join(directory, 'people.csv')
    writeFileSync(csv, 'Name,Email\nGrace,grace@test\n')
    const other = join(directory, 'people.json')
    writeFileSync(other, '{}')
    mocks.openPaths.push(vcf)
    await expect(invoke('interchange:contacts-file-choose')).resolves.toMatchObject({ format: 'vcard', contacts: [{ name: 'Ada', email: 'ada@test' }] })
    mocks.openPaths.push(csv)
    await expect(invoke('interchange:contacts-file-choose')).resolves.toMatchObject({ format: 'csv', table: { headers: ['Name', 'Email'], rows: [['Grace', 'grace@test']] } })
    mocks.openPaths.push(other)
    await expect(invoke('interchange:contacts-file-choose')).rejects.toThrow(/vCard/)
    await expect(invoke('interchange:contacts-file-choose')).resolves.toBeUndefined()
  })

  it('exports selected local and provider contacts as vCard 4.0 or CSV', async () => {
    productivity.saveLocal({ tasks: [], notes: [], contacts: [
      { id: 'local-1', name: 'Ada Lovelace', email: 'ada@test', group: 'Personal', favorite: false, color: '#000', source: 'local', emails: [{ value: 'ada@test' }, { value: 'ada@work.test', type: 'work' }] },
      { id: 'local-2', name: 'Not Exported', email: 'no@test', group: 'Personal', favorite: false, color: '#000', source: 'local' }
    ] })
    const vcf = join(directory, 'out.vcf')
    mocks.savePaths.push(vcf)
    await expect(invoke('interchange:contacts-export', ['local-1'], 'vcard4')).resolves.toEqual({ savedPath: vcf, count: 1 })
    const text = readFileSync(vcf, 'utf8')
    expect(text).toContain('VERSION:4.0')
    expect(text).toContain('EMAIL;TYPE=work:ada@work.test')
    expect(text).not.toContain('Not Exported')
    const csv = join(directory, 'out')
    mocks.savePaths.push(csv)
    await expect(invoke('interchange:contacts-export', ['local-1', 'local-2'], 'csv')).resolves.toEqual({ savedPath: `${csv}.csv`, count: 2 })
    await expect(invoke('interchange:contacts-export', ['local-1'], 'xml')).rejects.toThrow(/format/)
    await expect(invoke('interchange:contacts-export', [], 'csv')).rejects.toThrow(/Choose contacts/)
  })
})
