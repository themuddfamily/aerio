import { CalendarDays, Download, Globe2, RefreshCw, Repeat2, Trash2, Upload } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../types'
import type { CalendarImportPreview, InterchangeCalendar, InterchangeDesktopApi, InterchangeSnapshot } from '../interchange-types'
import { planEventImport, type EventDuplicateStrategy } from '../lib/interchange-plan'
import Modal from './Modal'

export interface InterchangeTargetCalendar {
  id: string
  name: string
  color: string
  writable: boolean
}

interface CalendarInterchangePanelProps {
  api: InterchangeDesktopApi
  snapshot: InterchangeSnapshot
  calendars: InterchangeTargetCalendar[]
  events: CalendarEvent[]
  onSnapshot(snapshot: InterchangeSnapshot): void
  onSaveProviderEvent(event: CalendarEvent, exists: boolean): Promise<void>
  onToast(message: string): void
}

const REFRESH_LABELS: Record<number, string> = { 15: 'Every 15 minutes', 30: 'Every 30 minutes', 60: 'Every hour', 180: 'Every 3 hours', 360: 'Every 6 hours', 720: 'Every 12 hours', 1440: 'Once a day' }
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

// Provider APIs receive timed values; all-day dates become local-midnight instants.
export function providerEventFrom(event: CalendarEvent): CalendarEvent {
  const instant = (value: string) => {
    if (!DATE_ONLY.test(value)) return value
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day).toISOString()
  }
  return { ...event, start: instant(event.start), end: instant(event.end) }
}

export function subscriptionStatus(calendar: InterchangeCalendar) {
  const updated = calendar.lastRefreshedAt ? `updated ${format(parseISO(calendar.lastRefreshedAt), 'd MMM, HH:mm')}` : 'not yet loaded'
  return calendar.error ? `Refresh failed: ${calendar.error}. Showing the copy ${updated}.` : `Read-only, ${updated}`
}

export default function CalendarInterchangePanel({ api, snapshot, calendars, events, onSnapshot, onSaveProviderEvent, onToast }: CalendarInterchangePanelProps) {
  const [preview, setPreview] = useState<CalendarImportPreview>()
  const [dialog, setDialog] = useState<'export' | 'subscribe'>()
  const [busy, setBusy] = useState<string>()
  const subscriptions = snapshot.calendars.filter((calendar) => calendar.kind === 'subscription')
  const localCalendars = snapshot.calendars.filter((calendar) => calendar.kind === 'local')

  const run = async (key: string, work: () => Promise<void>, fallback: string) => {
    setBusy(key)
    try { await work() }
    catch (error) { onToast(errorMessage(error, fallback)) }
    finally { setBusy(undefined) }
  }

  const chooseFile = () => run('import', async () => {
    const next = await api.chooseCalendarFile()
    if (next && !next.events.length) onToast('That calendar file has no events to import')
    else if (next) setPreview(next)
  }, 'That calendar file could not be read')

  const remove = (calendar: InterchangeCalendar) => {
    const prompt = calendar.kind === 'subscription'
      ? `Unsubscribe from “${calendar.name}”? Its events will be removed from Aerio.`
      : `Delete the local calendar “${calendar.name}” and all of its events?`
    if (!window.confirm(prompt)) return
    void run(`remove:${calendar.id}`, async () => {
      onSnapshot(await api.removeCalendar(calendar.id))
      onToast(calendar.kind === 'subscription' ? 'Unsubscribed' : 'Local calendar deleted')
    }, 'The calendar could not be removed')
  }

  return (
    <div className="sidebar-group interchange-group">
      <span className="sidebar-label">Import and subscribe</span>
      <div className="interchange-actions">
        <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void chooseFile()}><Upload size={14} /> {busy === 'import' ? 'Reading…' : 'Import .ics'}</button>
        <button className="button ghost small" disabled={Boolean(busy) || !calendars.length} onClick={() => setDialog('export')}><Download size={14} /> Export</button>
        <button className="button ghost small" disabled={Boolean(busy)} onClick={() => setDialog('subscribe')}><Globe2 size={14} /> Subscribe</button>
      </div>
      {[...localCalendars, ...subscriptions].map((calendar) => (
        <div className={`interchange-calendar ${calendar.error ? 'has-error' : ''}`} key={calendar.id}>
          <span className="event-dot" style={{ background: calendar.color }} />
          <span className="interchange-calendar-text">
            <strong>{calendar.name}</strong>
            <small role={calendar.error ? 'status' : undefined}>{calendar.kind === 'subscription' ? subscriptionStatus(calendar) : 'Local calendar on this PC'}</small>
          </span>
          {calendar.kind === 'subscription' && <button className="icon-button" aria-label={`Refresh ${calendar.name}`} title="Refresh now" disabled={Boolean(busy)} onClick={() => void run(`refresh:${calendar.id}`, async () => {
            const next = await api.refresh(calendar.id)
            onSnapshot(next)
            const error = next.calendars.find((item) => item.id === calendar.id)?.error
            onToast(error ? `${calendar.name} could not be refreshed; the last copy is kept` : `${calendar.name} refreshed`)
          }, 'The calendar could not be refreshed')}><RefreshCw className={busy === `refresh:${calendar.id}` ? 'spin' : undefined} size={13} /></button>}
          <button className="icon-button" aria-label={`${calendar.kind === 'subscription' ? 'Unsubscribe from' : 'Delete'} ${calendar.name}`} title={calendar.kind === 'subscription' ? 'Unsubscribe' : 'Delete calendar'} disabled={Boolean(busy)} onClick={() => remove(calendar)}><Trash2 size={13} /></button>
        </div>
      ))}
      {preview && <CalendarImportModal
        preview={preview}
        localCalendars={localCalendars}
        calendars={calendars}
        events={events}
        api={api}
        onSnapshot={onSnapshot}
        onSaveProviderEvent={onSaveProviderEvent}
        onToast={onToast}
        onClose={() => setPreview(undefined)}
      />}
      {dialog === 'export' && <CalendarExportModal calendars={calendars} onClose={() => setDialog(undefined)} onExport={async (ids) => {
        try {
          const result = await api.exportCalendar(ids)
          if (result.savedPath) onToast(`Exported ${result.count ?? 0} event${result.count === 1 ? '' : 's'}`)
          setDialog(undefined)
        } catch (error) {
          onToast(errorMessage(error, 'The calendar could not be exported'))
        }
      }} />}
      {dialog === 'subscribe' && <SubscribeModal onClose={() => setDialog(undefined)} onSubscribe={async (input) => {
        try {
          onSnapshot(await api.subscribe(input))
          onToast('Subscribed to the internet calendar')
          setDialog(undefined)
        } catch (error) {
          onToast(errorMessage(error, 'That calendar could not be subscribed'))
        }
      }} />}
    </div>
  )
}

function CalendarImportModal({ preview, localCalendars, calendars, events, api, onSnapshot, onSaveProviderEvent, onToast, onClose }: {
  preview: CalendarImportPreview
  localCalendars: InterchangeCalendar[]
  calendars: InterchangeTargetCalendar[]
  events: CalendarEvent[]
  api: InterchangeDesktopApi
  onSnapshot(snapshot: InterchangeSnapshot): void
  onSaveProviderEvent(event: CalendarEvent, exists: boolean): Promise<void>
  onToast(message: string): void
  onClose(): void
}) {
  const localIds = new Set(localCalendars.map((calendar) => calendar.id))
  const providerTargets = calendars.filter((calendar) => calendar.writable && !localIds.has(calendar.id))
  const [destination, setDestination] = useState('new')
  const [name, setName] = useState(preview.calendarName ?? preview.fileName.replace(/\.[^.]+$/, ''))
  const [strategy, setStrategy] = useState<EventDuplicateStrategy>('update')
  const [progress, setProgress] = useState<string>()
  const target = calendars.find((calendar) => calendar.id === destination)
  const plan = useMemo(() => planEventImport(
    preview.events.map((event) => ({ ...event, calendarId: destination === 'new' ? '' : destination, color: target?.color ?? '#2f7d6d' })),
    destination === 'new' ? [] : events.filter((event) => event.calendarId === destination),
    strategy
  ), [destination, events, preview.events, strategy, target?.color])
  const counts = { create: 0, update: 0, skip: 0 }
  for (const item of plan) counts[item.action]++
  const writes = plan.filter((item) => item.action !== 'skip')

  const importEvents = async () => {
    if (!writes.length) {
      onToast('Nothing to import: every event is already in that calendar')
      onClose()
      return
    }
    setProgress('Importing…')
    try {
      if (destination === 'new' || localIds.has(destination)) {
        onSnapshot(await api.saveLocalEvents(destination === 'new' ? { newCalendarName: name.trim() } : { calendarId: destination }, writes.map((item) => item.event)))
        onToast(`Imported ${writes.length} event${writes.length === 1 ? '' : 's'}`)
        onClose()
        return
      }
      // Provider calendars are written one event at a time through the existing provider APIs.
      let failed = 0
      for (const [index, item] of writes.entries()) {
        setProgress(`Importing ${index + 1} of ${writes.length}…`)
        try { await onSaveProviderEvent(providerEventFrom(item.event), item.action === 'update') }
        catch { failed++ }
      }
      onToast(failed ? `Imported ${writes.length - failed} of ${writes.length} events; ${failed} could not be saved` : `Imported ${writes.length} event${writes.length === 1 ? '' : 's'} to ${target?.name ?? 'the calendar'}`)
      onClose()
    } catch (error) {
      onToast(errorMessage(error, 'The events could not be imported'))
      setProgress(undefined)
    }
  }

  return (
    <Modal title="Import calendar" subtitle={`${preview.fileName} · ${preview.events.length} event${preview.events.length === 1 ? '' : 's'}`} width="medium" closeEnabled={!progress} onClose={onClose}>
      <div className="form-stack">
        <div className="form-grid-2">
          <label className="field-label">Import into
            <select value={destination} disabled={Boolean(progress)} onChange={(event) => setDestination(event.target.value)}>
              <option value="new">New local calendar</option>
              {localCalendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name} · on this PC</option>)}
              {providerTargets.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
            </select>
          </label>
          <label className="field-label">Events already in the calendar
            <select value={strategy} disabled={Boolean(progress)} onChange={(event) => setStrategy(event.target.value as EventDuplicateStrategy)}>
              <option value="update">Update them</option>
              <option value="skip">Skip them</option>
              <option value="create">Import as copies</option>
            </select>
          </label>
        </div>
        {destination === 'new' && <label className="field-label">Calendar name<input value={name} maxLength={200} disabled={Boolean(progress)} onChange={(event) => setName(event.target.value)} /></label>}
        {target && !localIds.has(destination) && <small>Provider calendars receive each event’s title, times, place, notes, attendees, reminder, and simple repeat. Time zones and detailed repeat rules are kept in local calendars.</small>}
        <p className="interchange-summary" aria-live="polite">{counts.create} new · {counts.update} to update · {counts.skip} skipped</p>
        {preview.warnings.length > 0 && <ul className="interchange-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        <ul className="interchange-preview" aria-label="Events to import">
          {plan.slice(0, 100).map((item, index) => (
            <li key={`${item.event.id}-${index}`} className={item.action === 'skip' ? 'muted' : undefined}>
              <CalendarDays size={14} />
              <span><strong>{item.event.title}</strong><small>{describeTime(item.event)}</small></span>
              {item.event.recurrenceRule && <span title={item.event.recurrenceRule}><Repeat2 size={13} aria-label="Repeats" /></span>}
              <em>{item.action === 'create' ? 'New' : item.action === 'update' ? 'Update' : 'Skip'}</em>
            </li>
          ))}
          {plan.length > 100 && <li className="muted">…and {plan.length - 100} more</li>}
        </ul>
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="button ghost" disabled={Boolean(progress)} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={Boolean(progress) || (destination === 'new' && !name.trim())} onClick={() => void importEvents()}><Upload size={16} /> {progress ?? `Import ${writes.length} event${writes.length === 1 ? '' : 's'}`}</button>
        </footer>
      </div>
    </Modal>
  )
}

function describeTime(event: CalendarEvent) {
  if (DATE_ONLY.test(event.start)) return `${format(parseISO(event.start), 'EEE d MMM yyyy')} · all day`
  const zone = event.timeZone ? ` · ${event.timeZone}` : ''
  return `${format(parseISO(event.start), 'EEE d MMM yyyy, HH:mm')} – ${format(parseISO(event.end), 'HH:mm')}${zone}`
}

function CalendarExportModal({ calendars, onClose, onExport }: { calendars: InterchangeTargetCalendar[]; onClose(): void; onExport(ids: string[]): Promise<void> }) {
  const [selected, setSelected] = useState('all')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Export calendar" subtitle="Save events as an iCalendar (.ics) file." width="small" closeEnabled={!busy} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Calendar
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="all">All calendars</option>
            {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
        </label>
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy} onClick={() => {
            setBusy(true)
            void onExport(selected === 'all' ? calendars.map((calendar) => calendar.id) : [selected]).finally(() => setBusy(false))
          }}><Download size={16} /> {busy ? 'Exporting…' : 'Export .ics'}</button>
        </footer>
      </div>
    </Modal>
  )
}

function SubscribeModal({ onClose, onSubscribe }: { onClose(): void; onSubscribe(input: { url: string; name?: string; refreshMinutes: number }): Promise<void> }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [refreshMinutes, setRefreshMinutes] = useState(60)
  const [busy, setBusy] = useState(false)
  const valid = /^(https|webcals?):\/\/\S+$/i.test(url.trim())
  return (
    <Modal title="Subscribe to an internet calendar" subtitle="Subscribed calendars are read-only and refresh automatically." width="small" closeEnabled={!busy} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Calendar address<input autoFocus value={url} placeholder="https:// or webcal://" disabled={busy} onChange={(event) => setUrl(event.target.value)} /></label>
        <label className="field-label">Name (optional)<input value={name} maxLength={200} placeholder="Uses the calendar’s own name" disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field-label">Refresh
          <select value={refreshMinutes} disabled={busy} onChange={(event) => setRefreshMinutes(Number(event.target.value))}>
            {Object.entries(REFRESH_LABELS).map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}
          </select>
        </label>
        <small>If a later refresh fails, Aerio keeps showing the last copy it downloaded.</small>
        <footer className="modal-footer">
          <span className="spacer" />
          <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || !valid} title={!valid ? 'Enter an https:// or webcal:// address' : undefined} onClick={() => {
            setBusy(true)
            void onSubscribe({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}), refreshMinutes }).finally(() => setBusy(false))
          }}><Globe2 size={16} /> {busy ? 'Subscribing…' : 'Subscribe'}</button>
        </footer>
      </div>
    </Modal>
  )
}
