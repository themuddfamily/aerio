import {
  CalendarDays, CalendarPlus2, Check, ChevronLeft, ChevronRight, Clock3, Copy, Eye, EyeOff,
  MapPin, Pencil, Plus, RefreshCw, Repeat2, Trash2, Users
} from 'lucide-react'
import {
  addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, parseISO, startOfMonth, startOfWeek, subDays, subMonths, subWeeks
} from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, CalendarEvent } from '../types'
import Modal from '../components/Modal'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'

type CalendarMode = 'month' | 'week' | 'day' | 'agenda'

interface CalendarViewProps {
  state: AppState
  query: string
  onToast(message: string): void
  writableCalendarIds: ReadonlySet<string>
  onSync(): Promise<void> | void
  onEnableEditing(): Promise<void> | void
  onSaveProviderEvent(event: CalendarEvent, exists: boolean): Promise<void>
  onDeleteProviderEvent(event: CalendarEvent): Promise<void>
  syncing?: boolean
  sourceMessage?: string
}

const eventOnDay = (event: CalendarEvent, date: Date) => isSameDay(parseISO(event.start), date)

export default function CalendarView({
  state, query, onToast, writableCalendarIds,
  onSync, onEnableEditing, onSaveProviderEvent, onDeleteProviderEvent, syncing = false, sourceMessage
}: CalendarViewProps) {
  const { showContextMenu } = useContextMenu()
  const [mode, setMode] = useState<CalendarMode>('month')
  const [cursor, setCursor] = useState(new Date())
  const [activeCalendars, setActiveCalendars] = useState(() => new Set(state.accounts.map((account) => account.id)))
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null)
  const [newDate, setNewDate] = useState<Date>(new Date())
  const [newCalendarId, setNewCalendarId] = useState<string>()
  const calendarIds = state.accounts.map((account) => account.id).join('\n')
  const hasWritableCalendar = writableCalendarIds.size > 0
  const canWriteCalendar = (calendarId: string) => writableCalendarIds.has(calendarId)
  const canEditEvent = (event: CalendarEvent) => canWriteCalendar(event.calendarId) && !('readOnly' in event && event.readOnly)

  useEffect(() => {
    setActiveCalendars((current) => new Set([...current, ...state.accounts.map((account) => account.id)]))
  }, [calendarIds])

  const filtered = useMemo(() => state.events
    .filter((event) => activeCalendars.has(event.calendarId))
    .filter((event) => !query || `${event.title} ${event.location ?? ''} ${event.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.start.localeCompare(b.start)),
  [activeCalendars, query, state.events])

  const move = (direction: -1 | 1) => {
    if (mode === 'month') setCursor((date) => direction > 0 ? addMonths(date, 1) : subMonths(date, 1))
    else if (mode === 'week') setCursor((date) => direction > 0 ? addWeeks(date, 1) : subWeeks(date, 1))
    else setCursor((date) => direction > 0 ? addDays(date, 1) : subDays(date, 1))
  }

  const createOn = (date: Date, calendarId?: string) => {
    const targetCalendarId = calendarId && canWriteCalendar(calendarId)
      ? calendarId
      : state.accounts.find((account) => canWriteCalendar(account.id))?.id
    if (!targetCalendarId) {
      onToast('Enable Calendar editing once, then double-click again')
      return
    }
    setNewDate(date)
    setNewCalendarId(targetCalendarId)
    setEditing('new')
  }

  const deleteEvent = async (event: CalendarEvent) => {
    await onDeleteProviderEvent(event)
    onToast('Event deleted')
  }

  const duplicateEvent = async (event: CalendarEvent) => {
    const duplicate = { ...event, id: uid('event'), title: `${event.title} (copy)` }
    await onSaveProviderEvent(duplicate, false)
    onToast('Event duplicated')
  }

  const eventMenu = (event: CalendarEvent): ContextMenuItem[] => [
    { label: 'Open event', icon: Pencil, action: () => setEditing(event) },
    ...(canEditEvent(event) ? [{ label: 'Duplicate event', icon: Copy, separatorBefore: true, action: async () => {
      try { await duplicateEvent(event) }
      catch (error) { onToast(error instanceof Error ? error.message : 'Event could not be duplicated') }
    } }] satisfies ContextMenuItem[] : []),
    { label: 'Copy event details', icon: Copy, action: () => copyText(`${event.title}\n${format(parseISO(event.start), 'PPpp')} – ${format(parseISO(event.end), 'PPpp')}${event.location ? `\n${event.location}` : ''}`) },
    ...(canEditEvent(event) ? [{ label: 'Delete event', icon: Trash2, separatorBefore: true, danger: true, action: async () => {
      try { await deleteEvent(event) }
      catch (error) { onToast(error instanceof Error ? error.message : 'Event could not be deleted') }
    } }] satisfies ContextMenuItem[] : [])
  ]

  const showEventMenu = (contextEvent: React.MouseEvent, event: CalendarEvent) => showContextMenu(contextEvent, eventMenu(event), event.title)

  const showDateMenu = (contextEvent: React.MouseEvent, date: Date) => showContextMenu(contextEvent, [
    ...(hasWritableCalendar
      ? [{ label: 'New event', icon: CalendarPlus2, action: () => createOn(date) }] satisfies ContextMenuItem[]
      : [{ label: 'Enable event editing', icon: CalendarPlus2, action: () => onEnableEditing() }] satisfies ContextMenuItem[]),
    { label: 'Open day view', icon: CalendarDays, action: () => { setCursor(date); setMode('day') } },
    { label: 'Copy date', icon: Copy, separatorBefore: true, action: () => copyText(format(date, 'PPPP')) }
  ], format(date, 'PPPP'))

  const showCalendarMenu = (event: React.MouseEvent, account: AppState['accounts'][number]) => {
    const active = activeCalendars.has(account.id)
    showContextMenu(event, [
      { label: active ? 'Hide calendar' : 'Show calendar', icon: active ? EyeOff : Eye, checked: active, action: () => setActiveCalendars((current) => {
        const next = new Set(current)
        if (next.has(account.id)) next.delete(account.id)
        else next.add(account.id)
        return next
      }) },
      { label: 'Show only this calendar', icon: Eye, action: () => setActiveCalendars(new Set([account.id])) },
      { label: 'Show all calendars', icon: CalendarDays, action: () => setActiveCalendars(new Set(state.accounts.map((item) => item.id))) },
      ...(canWriteCalendar(account.id) ? [{ label: `New event in ${account.name}`, icon: CalendarPlus2, separatorBefore: true, action: () => createOn(new Date(), account.id) }] satisfies ContextMenuItem[] : []),
      { label: 'Copy calendar address', icon: Copy, separatorBefore: true, action: () => copyText(account.email) }
    ], account.name)
  }

  const title = mode === 'month'
    ? format(cursor, 'MMMM yyyy')
    : mode === 'week'
      ? `${format(startOfWeek(cursor, { weekStartsOn: 1 }), 'd MMM')} – ${format(endOfWeek(cursor, { weekStartsOn: 1 }), 'd MMM yyyy')}`
      : format(cursor, 'EEEE, d MMMM yyyy')

  return (
    <div className="workspace">
      <aside className="context-sidebar calendar-sidebar">
        <button
          className="compose-button"
          disabled={syncing}
          onClick={() => void (hasWritableCalendar ? createOn(new Date()) : onEnableEditing())}
        >
          {hasWritableCalendar ? <Plus size={18} /> : <CalendarPlus2 size={18} />}
          {hasWritableCalendar ? 'New event' : 'Enable event editing'}
        </button>
        <>
          <button className="button ghost small provider-sync-button" disabled={syncing} onClick={() => void onSync()}><RefreshCw className={syncing ? 'spin' : undefined} size={14} /> {syncing ? 'Syncing…' : 'Sync now'}</button>
          <p className="provider-source-note" aria-live="polite">{hasWritableCalendar ? sourceMessage : 'Reconnect Google or Microsoft once to grant Calendar editing. Existing events remain available.'}</p>
        </>
        <MiniCalendar cursor={cursor} selected={cursor} onSelect={setCursor} onCreate={createOn} onContextDate={showDateMenu} />
        <div className="sidebar-group">
          <span className="sidebar-label">My calendars</span>
          {state.accounts.map((account) => (
            <button className="calendar-toggle" key={account.id} onContextMenu={(event) => showCalendarMenu(event, account)} onClick={() => {
              setActiveCalendars((current) => {
                const next = new Set(current)
                if (next.has(account.id)) next.delete(account.id)
                else next.add(account.id)
                return next
              })
            }}>
              <span className="calendar-check" style={{ background: activeCalendars.has(account.id) ? account.color : 'transparent', borderColor: account.color }}>
                {activeCalendars.has(account.id) && <Check size={11} />}
              </span>
              <span>{account.name}</span>
            </button>
          ))}
        </div>
        <div className="up-next-card">
          <span className="eyebrow">Up next</span>
          {filtered.filter((event) => new Date(event.end) >= new Date()).slice(0, 2).map((event) => (
            <button key={event.id} onClick={() => setEditing(event)} onContextMenu={(contextEvent) => showEventMenu(contextEvent, event)}>
              <span className="event-dot" style={{ background: event.color }} />
              <span><strong>{event.title}</strong><small>{format(parseISO(event.start), 'EEE · HH:mm')}</small></span>
            </button>
          ))}
        </div>
      </aside>
      <section className="module-panel calendar-panel">
        <header className="module-header">
          <div className="calendar-title-actions">
            <button className="button ghost small" onClick={() => setCursor(new Date())}>Today</button>
            <button className="icon-button" aria-label="Previous period" title="Previous period" onClick={() => move(-1)}><ChevronLeft size={18} /></button>
            <button className="icon-button" aria-label="Next period" title="Next period" onClick={() => move(1)}><ChevronRight size={18} /></button>
            <h1>{title}</h1>
          </div>
          <div className="segmented">
            {(['month', 'week', 'day', 'agenda'] as CalendarMode[]).map((item) => (
              <button className={mode === item ? 'active' : ''} key={item} onClick={() => setMode(item)}>{item}</button>
            ))}
          </div>
        </header>
        {mode === 'month' && <MonthGrid cursor={cursor} events={filtered} onSelectEvent={setEditing} onCreate={createOn} onContextEvent={showEventMenu} onContextDate={showDateMenu} />}
        {mode === 'week' && <TimeGrid dates={eachDayOfInterval({ start: startOfWeek(cursor, { weekStartsOn: 1 }), end: endOfWeek(cursor, { weekStartsOn: 1 }) })} events={filtered} onSelectEvent={setEditing} onCreate={createOn} onContextEvent={showEventMenu} onContextDate={showDateMenu} />}
        {mode === 'day' && <TimeGrid dates={[cursor]} events={filtered} onSelectEvent={setEditing} onCreate={createOn} onContextEvent={showEventMenu} onContextDate={showDateMenu} />}
        {mode === 'agenda' && <Agenda events={filtered} onSelect={setEditing} onContextEvent={showEventMenu} />}
      </section>
      {editing && (
        <EventEditor
          event={editing === 'new' ? undefined : editing}
          date={newDate}
          defaultCalendarId={newCalendarId}
          state={state}
          readOnly={editing === 'new' ? false : !canEditEvent(editing)}
          writableCalendarIds={writableCalendarIds}
          onClose={() => setEditing(null)}
          onSave={async (event) => {
            const exists = state.events.some((item) => item.id === event.id)
            try {
              await onSaveProviderEvent(event, exists)
              onToast(exists ? 'Event updated' : 'Event created')
              setEditing(null)
            } catch (error) {
              onToast(error instanceof Error ? error.message : 'Event could not be saved')
            }
          }}
          onDelete={editing === 'new' || !canEditEvent(editing) ? undefined : async () => {
            try {
              await deleteEvent(editing)
              setEditing(null)
            } catch (error) {
              onToast(error instanceof Error ? error.message : 'Event could not be deleted')
            }
          }}
        />
      )}
    </div>
  )
}

function MiniCalendar({ cursor, selected, onSelect, onCreate, onContextDate }: { cursor: Date; selected: Date; onSelect(date: Date): void; onCreate(date: Date): void; onContextDate(event: React.MouseEvent, date: Date): void }) {
  const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start, end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) })
  return (
    <div className="mini-calendar">
      <header><strong>{format(cursor, 'MMMM yyyy')}</strong></header>
      <div className="mini-weekdays">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
      <div className="mini-days">
        {days.map((day) => (
          <button key={day.toISOString()} className={`${!isSameMonth(day, cursor) ? 'muted' : ''} ${isSameDay(day, selected) ? 'selected' : ''} ${isSameDay(day, new Date()) ? 'today' : ''}`} onClick={() => onSelect(day)} onDoubleClick={() => onCreate(day)} onContextMenu={(event) => onContextDate(event, day)}>{format(day, 'd')}</button>
        ))}
      </div>
    </div>
  )
}

function MonthGrid({ cursor, events, onSelectEvent, onCreate, onContextEvent, onContextDate }: { cursor: Date; events: CalendarEvent[]; onSelectEvent(event: CalendarEvent): void; onCreate(date: Date): void; onContextEvent(contextEvent: React.MouseEvent, event: CalendarEvent): void; onContextDate(event: React.MouseEvent, date: Date): void }) {
  const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start, end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) })
  return (
    <div className="month-grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div className="weekday-heading" key={day}>{day}</div>)}
      {days.map((day) => {
        const dayEvents = events.filter((event) => eventOnDay(event, day))
        return (
          <div className={`month-day ${!isSameMonth(day, cursor) ? 'outside' : ''}`} key={day.toISOString()} onDoubleClick={() => onCreate(day)} onContextMenu={(event) => onContextDate(event, day)}>
            <button className={`day-number ${isSameDay(day, new Date()) ? 'today' : ''}`} onClick={() => onCreate(day)} onContextMenu={(event) => onContextDate(event, day)}>{format(day, 'd')}</button>
            {dayEvents.slice(0, 3).map((event) => (
              <button className="calendar-event" key={event.id} style={{ '--event-color': event.color } as React.CSSProperties} onClick={() => onSelectEvent(event)} onDoubleClick={(doubleClickEvent) => doubleClickEvent.stopPropagation()} onContextMenu={(contextEvent) => onContextEvent(contextEvent, event)}>
                <span>{format(parseISO(event.start), 'HH:mm')}</span>{event.title}
              </button>
            ))}
            {dayEvents.length > 3 && <span className="more-events">+{dayEvents.length - 3} more</span>}
          </div>
        )
      })}
    </div>
  )
}

function TimeGrid({ dates, events, onSelectEvent, onCreate, onContextEvent, onContextDate }: { dates: Date[]; events: CalendarEvent[]; onSelectEvent(event: CalendarEvent): void; onCreate(date: Date): void; onContextEvent(contextEvent: React.MouseEvent, event: CalendarEvent): void; onContextDate(event: React.MouseEvent, date: Date): void }) {
  const hours = Array.from({ length: 13 }, (_, index) => index + 7)
  return (
    <div className="time-grid-wrap">
      <div className="time-grid-header">
        <span />
        {dates.map((date) => <div key={date.toISOString()} className={isSameDay(date, new Date()) ? 'today' : ''}><strong>{format(date, 'EEE')}</strong><span>{format(date, 'd')}</span></div>)}
      </div>
      <div className="time-grid">
        {hours.map((hour) => (
          <div className="time-row" key={hour}>
            <time>{`${hour.toString().padStart(2, '0')}:00`}</time>
            {dates.map((date) => {
              const slotEvents = events.filter((event) => eventOnDay(event, date) && parseISO(event.start).getHours() === hour)
              const slotDate = new Date(date); slotDate.setHours(hour)
              return <div className="time-slot" key={date.toISOString()} onDoubleClick={() => onCreate(slotDate)} onContextMenu={(event) => onContextDate(event, slotDate)}>
                {slotEvents.map((event) => <button key={event.id} className="time-event" style={{ '--event-color': event.color } as React.CSSProperties} onClick={() => onSelectEvent(event)} onDoubleClick={(doubleClickEvent) => doubleClickEvent.stopPropagation()} onContextMenu={(contextEvent) => onContextEvent(contextEvent, event)}><strong>{event.title}</strong><span>{format(parseISO(event.start), 'HH:mm')} – {format(parseISO(event.end), 'HH:mm')}</span></button>)}
              </div>
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function Agenda({ events, onSelect, onContextEvent }: { events: CalendarEvent[]; onSelect(event: CalendarEvent): void; onContextEvent(contextEvent: React.MouseEvent, event: CalendarEvent): void }) {
  const future = events.filter((event) => new Date(event.end) >= subDays(new Date(), 1))
  return (
    <div className="agenda-list">
      {future.map((event) => (
        <button className="agenda-row" key={event.id} onClick={() => onSelect(event)} onContextMenu={(contextEvent) => onContextEvent(contextEvent, event)}>
          <div className="agenda-date"><strong>{format(parseISO(event.start), 'd')}</strong><span>{format(parseISO(event.start), 'MMM')}</span></div>
          <span className="event-line" style={{ background: event.color }} />
          <div><h3>{event.title}</h3><p><Clock3 size={14} /> {format(parseISO(event.start), 'HH:mm')} – {format(parseISO(event.end), 'HH:mm')} {event.location && <><MapPin size={14} /> {event.location}</>}</p></div>
          <span className="spacer" />
          <span className="attendee-count"><Users size={15} /> {event.attendees.length}</span>
        </button>
      ))}
    </div>
  )
}

function EventEditor({ event, date, defaultCalendarId, state, readOnly = false, writableCalendarIds, onClose, onSave, onDelete }: { event?: CalendarEvent; date: Date; defaultCalendarId?: string; state: AppState; readOnly?: boolean; writableCalendarIds: ReadonlySet<string>; onClose(): void; onSave(event: CalendarEvent): Promise<void> | void; onDelete?(): Promise<void> | void }) {
  const initialStart = event ? parseISO(event.start) : new Date(date)
  if (!event) initialStart.setHours(initialStart.getHours() || 10, 0, 0, 0)
  const initialEnd = event ? parseISO(event.end) : new Date(initialStart.getTime() + 60 * 60 * 1000)
  const [title, setTitle] = useState(event?.title ?? '')
  const [start, setStart] = useState(format(initialStart, "yyyy-MM-dd'T'HH:mm"))
  const [end, setEnd] = useState(format(initialEnd, "yyyy-MM-dd'T'HH:mm"))
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? defaultCalendarId ?? state.accounts[0].id)
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [attendees, setAttendees] = useState(event?.attendees.join(', ') ?? '')
  const [recurrence, setRecurrence] = useState<CalendarEvent['recurrence']>(event?.recurrence ?? 'none')
  const [reminderMinutes, setReminderMinutes] = useState(event?.reminderMinutes ?? 15)
  const [busy, setBusy] = useState<'save' | 'delete'>()
  const color = state.accounts.find((account) => account.id === calendarId)?.color ?? '#6659e8'
  const startTime = Date.parse(start)
  const endTime = Date.parse(end)
  const canSave = Boolean(title.trim()) && Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime

  return (
    <Modal title={readOnly ? 'Event details' : event ? 'Edit event' : 'New event'} subtitle={readOnly ? 'Synchronized from your provider.' : 'Keep time intentional.'} closeEnabled={!busy} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Event title<input autoFocus value={title} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} placeholder="Add a title" /></label>
        <div className="form-grid-2">
          <label className="field-label">Starts<input type="datetime-local" value={start} disabled={readOnly} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field-label">Ends<input type="datetime-local" value={end} disabled={readOnly} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <div className="form-grid-2">
          <label className="field-label">Calendar<select value={calendarId} disabled={readOnly || Boolean(event)} onChange={(e) => setCalendarId(e.target.value)}>{state.accounts.filter((account) => writableCalendarIds.has(account.id) || account.id === event?.calendarId).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
          <label className="field-label">Repeat<select value={recurrence} disabled={readOnly} onChange={(e) => setRecurrence(e.target.value as CalendarEvent['recurrence'])}><option value="none">Doesn’t repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        </div>
        <label className="field-label">Reminder<select value={reminderMinutes} disabled={readOnly} onChange={(e) => setReminderMinutes(Number(e.target.value))}><option value={0}>At event time</option><option value={5}>5 minutes before</option><option value={10}>10 minutes before</option><option value={15}>15 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option><option value={1440}>1 day before</option></select></label>
        <label className="field-label"><MapPin size={14} /> Location<input value={location} disabled={readOnly} onChange={(e) => setLocation(e.target.value)} placeholder="Add a place or video link" /></label>
        <label className="field-label"><Users size={14} /> Attendees<input value={attendees} disabled={readOnly} onChange={(e) => setAttendees(e.target.value)} placeholder="Separate email addresses with commas" /></label>
        <label className="field-label">Notes<textarea value={description} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} /></label>
        <footer className="modal-footer">
          {onDelete && <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => { setBusy('delete'); void Promise.resolve(onDelete()).finally(() => setBusy(undefined)) }}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>}
          <span className="spacer" />
          <button className="button ghost" disabled={Boolean(busy)} onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && <button className="button primary" disabled={!canSave || Boolean(busy)} title={!canSave ? 'Add a title and choose an end time after the start' : undefined} onClick={() => {
            const next = {
            id: event?.id ?? uid('event'), calendarId, title: title.trim(),
            start: new Date(start).toISOString(), end: new Date(end).toISOString(), location, description, color,
            attendees: attendees.split(',').map((value) => value.trim()).filter(Boolean), reminderMinutes, recurrence
            }
            setBusy('save')
            void Promise.resolve(onSave(next)).finally(() => setBusy(undefined))
          }}><CalendarDays size={16} /> {busy === 'save' ? 'Saving…' : 'Save event'}</button>}
        </footer>
      </div>
    </Modal>
  )
}
