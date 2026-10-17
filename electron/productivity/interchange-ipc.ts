import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { CalendarEvent, Contact } from '../../src/types'
import type {
  CalendarImportPreview, ContactExportFormat, ContactImportPreview, InterchangeCalendar, InterchangeSnapshot, LocalCalendarTarget
} from '../../src/interchange-types'
import { icsEventToCalendarEvent, parseIcs, serializeIcs } from '../../src/lib/ics'
import { parseVCards, serializeVCards } from '../../src/lib/vcard'
import { parseCsv, serializeContactsCsv } from '../../src/lib/contact-csv'
import { validInterchangeEvent } from '../../src/lib/interchange-validation'
import type { ProductivityStore } from './store'
import type { InterchangeStore } from './interchange-store'
import { createSubscription, dueSubscriptions, fetchCalendarFeed, refreshSubscription } from './calendar-subscriptions'

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024
const MAX_IMPORT_EVENTS = 20_000
const REFRESH_CHECK_MS = 5 * 60_000
const INITIAL_REFRESH_DELAY_MS = 20_000

export interface InterchangeOptions {
  productivity(): ProductivityStore
  interchange(): InterchangeStore
  fetchFeed?: typeof fetchCalendarFeed
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; message?: string; details?: Record<string, unknown> }): void
}

const safeFilename = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'Aerio'

function readImportFile(path: string) {
  const file = statSync(path)
  if (!file.isFile() || file.size > IMPORT_MAX_BYTES) throw new Error('Choose a file no larger than 20 MB')
  return readFileSync(path, 'utf8')
}

export function calendarPreview(path: string, text: string): CalendarImportPreview {
  const parsed = parseIcs(text)
  return {
    fileName: basename(path),
    ...(parsed.calendarName ? { calendarName: parsed.calendarName } : {}),
    events: parsed.events.map((event) => icsEventToCalendarEvent(event, '', '', `event-${randomUUID()}`)),
    warnings: parsed.warnings
  }
}

export function contactsPreview(path: string, text: string): ContactImportPreview {
  const isVCard = /\.(vcf|vcard)$/i.test(path) || /^﻿?\s*BEGIN:VCARD/i.test(text)
  if (isVCard) {
    const parsed = parseVCards(text, { idFactory: () => `contact-${randomUUID()}` })
    return { fileName: basename(path), format: 'vcard', contacts: parsed.contacts, warnings: parsed.warnings }
  }
  if (!/\.(csv|txt|tsv)$/i.test(path)) throw new Error('Choose a vCard (.vcf) or CSV (.csv) file')
  return { fileName: basename(path), format: 'csv', table: parseCsv(text), warnings: [] }
}

export function serializeContacts(contacts: Contact[], format: ContactExportFormat) {
  return format === 'csv' ? serializeContactsCsv(contacts) : serializeVCards(contacts, format === 'vcard4' ? '4.0' : '3.0')
}

function validIds(value: unknown, max = 100_000): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 500)
}

export function registerCalendarContactInterchange(options: InterchangeOptions) {
  const store = options.interchange
  const fetchFeed = options.fetchFeed ?? fetchCalendarFeed
  const broadcast = (snapshot: InterchangeSnapshot = store().snapshot()) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('interchange:changed', snapshot)
    return snapshot
  }
  const ownerOf = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)
  const openFile = async (event: Electron.IpcMainInvokeEvent, settings: Electron.OpenDialogOptions) => {
    const owner = ownerOf(event)
    const result = owner ? await dialog.showOpenDialog(owner, settings) : await dialog.showOpenDialog(settings)
    return result.canceled ? undefined : result.filePaths[0]
  }
  const saveFile = async (event: Electron.IpcMainInvokeEvent, settings: Electron.SaveDialogOptions) => {
    const owner = ownerOf(event)
    const result = owner ? await dialog.showSaveDialog(owner, settings) : await dialog.showSaveDialog(settings)
    return result.canceled ? undefined : result.filePath
  }
  const localCalendar = (calendarId: string) => {
    const calendar = store().calendar(calendarId)
    if (!calendar) throw new Error('That calendar is no longer available')
    if (calendar.kind !== 'local') throw new Error('Subscribed internet calendars are read-only')
    return calendar
  }

  ipcMain.handle('interchange:snapshot', () => store().snapshot())

  ipcMain.handle('interchange:calendar-file-choose', async (event) => {
    const path = await openFile(event, { title: 'Import calendar', filters: [{ name: 'iCalendar', extensions: ['ics', 'ical', 'ifb', 'icalendar'] }], properties: ['openFile'] })
    if (!path) return undefined
    return calendarPreview(path, readImportFile(path))
  })

  ipcMain.handle('interchange:contacts-file-choose', async (event) => {
    const path = await openFile(event, {
      title: 'Import contacts',
      filters: [{ name: 'Contacts', extensions: ['vcf', 'vcard', 'csv'] }, { name: 'vCard', extensions: ['vcf', 'vcard'] }, { name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    })
    if (!path) return undefined
    return contactsPreview(path, readImportFile(path))
  })

  ipcMain.handle('interchange:calendar-export', async (event, calendarIds: unknown) => {
    if (!validIds(calendarIds, 1_000) || !calendarIds.length) throw new Error('Choose a calendar to export')
    const ids = new Set(calendarIds)
    const provider = options.productivity().snapshot()
    const local = store().snapshot()
    const names = [...provider.calendars, ...local.calendars].filter((calendar) => ids.has(calendar.id)).map((calendar) => calendar.name)
    const events: CalendarEvent[] = [...provider.events, ...local.events].filter((item) => ids.has(item.calendarId))
    const name = names.length === 1 ? names[0] : 'Aerio calendars'
    const path = await saveFile(event, { title: 'Export calendar', defaultPath: `${safeFilename(name)}.ics`, filters: [{ name: 'iCalendar', extensions: ['ics'] }] })
    if (!path) return {}
    writeFileSync(path, serializeIcs(events, { calendarName: name }), { encoding: 'utf8', mode: 0o600 })
    options.diagnostic?.({ level: 'info', event: 'calendar-exported', details: { calendars: names.length, events: events.length } })
    return { savedPath: path, count: events.length }
  })

  ipcMain.handle('interchange:contacts-export', async (event, contactIds: unknown, format: unknown) => {
    if (!validIds(contactIds) || !contactIds.length) throw new Error('Choose contacts to export')
    if (format !== 'vcard3' && format !== 'vcard4' && format !== 'csv') throw new Error('Choose an export format')
    const ids = new Set(contactIds)
    const all: Contact[] = [...(options.productivity().localSnapshot().contacts ?? []), ...options.productivity().snapshot().contacts]
    const contacts = all.filter((contact) => ids.has(contact.id))
    const extension = format === 'csv' ? 'csv' : 'vcf'
    const path = await saveFile(event, {
      title: 'Export contacts',
      defaultPath: `Aerio-contacts-${new Date().toISOString().slice(0, 10)}.${extension}`,
      filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'vCard', extensions: ['vcf'] }]
    })
    if (!path) return {}
    const target = extname(path) ? path : `${path}.${extension}`
    writeFileSync(target, serializeContacts(contacts, format), { encoding: 'utf8', mode: 0o600 })
    options.diagnostic?.({ level: 'info', event: 'contacts-exported', details: { contacts: contacts.length, format } })
    return { savedPath: target, count: contacts.length }
  })

  ipcMain.handle('interchange:local-events-save', (_event, target: unknown, events: unknown) => {
    if (!Array.isArray(events) || events.length > MAX_IMPORT_EVENTS) throw new Error(`Import no more than ${MAX_IMPORT_EVENTS.toLocaleString('en-US')} events at once`)
    if (!events.every(validInterchangeEvent)) throw new Error('One or more imported events are invalid')
    if (new Set(events.map((item) => item.id)).size !== events.length) throw new Error('Imported events must have unique ids')
    const destination = target as Partial<{ calendarId: string; newCalendarName: string }> | undefined
    let calendar: InterchangeCalendar
    if (destination && typeof destination.newCalendarName === 'string') {
      const name = destination.newCalendarName.trim().slice(0, 200)
      if (!name) throw new Error('Name the new local calendar')
      calendar = { id: `local-calendar-${randomUUID()}`, kind: 'local', name, color: store().nextColor() }
      store().saveCalendar(calendar)
    } else if (destination && typeof destination.calendarId === 'string') {
      calendar = localCalendar(destination.calendarId)
    } else throw new Error('Choose where to import the events')
    // Events already stored elsewhere cannot be moved by id into this calendar.
    for (const item of events) {
      const existing = store().event(item.id)
      if (existing && existing.calendarId !== calendar.id) throw new Error('An imported event conflicts with an event in another calendar')
    }
    store().saveEvents(calendar.id, events)
    options.diagnostic?.({ level: 'info', event: 'calendar-imported', details: { events: events.length } })
    return broadcast()
  })

  ipcMain.handle('interchange:local-event-save', (_event, input: unknown) => {
    if (!validInterchangeEvent(input)) throw new Error('Enter valid event details')
    const existing = store().event(input.id)
    if (existing && existing.calendarId !== input.calendarId) throw new Error('Moving an existing event to another calendar is not supported yet')
    store().saveEvents(localCalendar(input.calendarId).id, [input])
    return broadcast()
  })

  ipcMain.handle('interchange:local-event-delete', (_event, eventId: unknown) => {
    if (typeof eventId !== 'string' || !eventId || eventId.length > 500) throw new Error('Choose a valid event')
    const existing = store().event(eventId)
    if (!existing) throw new Error('That event is no longer available')
    localCalendar(existing.calendarId)
    store().deleteEvent(eventId)
    return broadcast()
  })

  ipcMain.handle('interchange:subscribe', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Enter a calendar address')
    const calendar = await createSubscription(store(), input as Parameters<typeof createSubscription>[1], fetchFeed)
    options.diagnostic?.({ level: 'info', event: 'calendar-subscribed', details: { host: new URL(calendar.url!).hostname } })
    return broadcast()
  })

  ipcMain.handle('interchange:refresh', async (_event, calendarId: unknown) => {
    if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 500) throw new Error('Choose a calendar subscription')
    await refreshSubscription(store(), calendarId, fetchFeed)
    return broadcast()
  })

  ipcMain.handle('interchange:calendar-remove', (_event, calendarId: unknown) => {
    if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 500 || !store().calendar(calendarId)) throw new Error('That calendar is no longer available')
    store().removeCalendar(calendarId)
    return broadcast()
  })

  // Background refresh: subscriptions are checked every few minutes and fetched one at a time when due.
  let running = false
  const refreshDue = async () => {
    if (running) return
    running = true
    try {
      const due = dueSubscriptions(store().calendars())
      for (const calendar of due) {
        const next = await refreshSubscription(store(), calendar.id, fetchFeed)
        if (next?.error) options.diagnostic?.({ level: 'warn', event: 'calendar-subscription-refresh-failed', message: next.error, details: { host: next.url ? new URL(next.url).hostname : undefined } })
      }
      if (due.length) broadcast()
    } catch {
      // Storage can close during shutdown; the next interval retries.
    } finally {
      running = false
    }
  }
  const initial = setTimeout(() => void refreshDue(), INITIAL_REFRESH_DELAY_MS)
  const interval = setInterval(() => void refreshDue(), REFRESH_CHECK_MS)
  return {
    refreshDue,
    dispose() {
      clearTimeout(initial)
      clearInterval(interval)
    }
  }
}
