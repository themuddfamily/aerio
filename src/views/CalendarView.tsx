import {
  CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, MapPin, Plus, Repeat2, Users
} from 'lucide-react'
import {
  addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, parseISO, startOfMonth, startOfWeek, subDays, subMonths, subWeeks
} from 'date-fns'
import { useMemo, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, CalendarEvent } from '../types'
import Modal from '../components/Modal'

type CalendarMode = 'month' | 'week' | 'day' | 'agenda'

interface CalendarViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onToast(message: string): void
}

const eventOnDay = (event: CalendarEvent, date: Date) => isSameDay(parseISO(event.start), date)

export default function CalendarView({ state, query, onChange, onToast }: CalendarViewProps) {
  const [mode, setMode] = useState<CalendarMode>('month')
  const [cursor, setCursor] = useState(new Date())
  const [activeCalendars, setActiveCalendars] = useState(() => new Set(state.accounts.map((account) => account.id)))
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null)
  const [newDate, setNewDate] = useState<Date>(new Date())

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

  const createOn = (date: Date) => {
    setNewDate(date)
    setEditing('new')
  }

  const title = mode === 'month'
    ? format(cursor, 'MMMM yyyy')
    : mode === 'week'
      ? `${format(startOfWeek(cursor, { weekStartsOn: 1 }), 'd MMM')} – ${format(endOfWeek(cursor, { weekStartsOn: 1 }), 'd MMM yyyy')}`
      : format(cursor, 'EEEE, d MMMM yyyy')

  return (
    <div className="workspace">
      <aside className="context-sidebar calendar-sidebar">
        <button className="compose-button" onClick={() => createOn(new Date())}><Plus size={18} /> New event</button>
        <MiniCalendar cursor={cursor} selected={cursor} onSelect={setCursor} />
        <div className="sidebar-group">
          <span className="sidebar-label">My calendars</span>
          {state.accounts.map((account) => (
            <button className="calendar-toggle" key={account.id} onClick={() => {
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
            <button key={event.id} onClick={() => setEditing(event)}>
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
        {mode === 'month' && <MonthGrid cursor={cursor} events={filtered} onSelectEvent={setEditing} onCreate={createOn} />}
        {mode === 'week' && <TimeGrid dates={eachDayOfInterval({ start: startOfWeek(cursor, { weekStartsOn: 1 }), end: endOfWeek(cursor, { weekStartsOn: 1 }) })} events={filtered} onSelectEvent={setEditing} onCreate={createOn} />}
        {mode === 'day' && <TimeGrid dates={[cursor]} events={filtered} onSelectEvent={setEditing} onCreate={createOn} />}
        {mode === 'agenda' && <Agenda events={filtered} onSelect={setEditing} />}
      </section>
      {editing && (
        <EventEditor
          event={editing === 'new' ? undefined : editing}
          date={newDate}
          state={state}
          onClose={() => setEditing(null)}
          onSave={(event) => {
            const exists = state.events.some((item) => item.id === event.id)
            onChange({ ...state, events: exists ? state.events.map((item) => item.id === event.id ? event : item) : [event, ...state.events] })
            onToast(exists ? 'Event updated' : 'Event created')
            setEditing(null)
          }}
          onDelete={editing === 'new' ? undefined : () => {
            onChange({ ...state, events: state.events.filter((event) => event.id !== editing.id) })
            onToast('Event deleted')
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function MiniCalendar({ cursor, selected, onSelect }: { cursor: Date; selected: Date; onSelect(date: Date): void }) {
  const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start, end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) })
  return (
    <div className="mini-calendar">
      <header><strong>{format(cursor, 'MMMM yyyy')}</strong></header>
      <div className="mini-weekdays">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
      <div className="mini-days">
        {days.map((day) => (
          <button key={day.toISOString()} className={`${!isSameMonth(day, cursor) ? 'muted' : ''} ${isSameDay(day, selected) ? 'selected' : ''} ${isSameDay(day, new Date()) ? 'today' : ''}`} onClick={() => onSelect(day)}>{format(day, 'd')}</button>
        ))}
      </div>
    </div>
  )
}

function MonthGrid({ cursor, events, onSelectEvent, onCreate }: { cursor: Date; events: CalendarEvent[]; onSelectEvent(event: CalendarEvent): void; onCreate(date: Date): void }) {
  const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 })
  const days = eachDayOfInterval({ start, end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) })
  return (
    <div className="month-grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div className="weekday-heading" key={day}>{day}</div>)}
      {days.map((day) => {
        const dayEvents = events.filter((event) => eventOnDay(event, day))
        return (
          <div className={`month-day ${!isSameMonth(day, cursor) ? 'outside' : ''}`} key={day.toISOString()} onDoubleClick={() => onCreate(day)}>
            <button className={`day-number ${isSameDay(day, new Date()) ? 'today' : ''}`} onClick={() => onCreate(day)}>{format(day, 'd')}</button>
            {dayEvents.slice(0, 3).map((event) => (
              <button className="calendar-event" key={event.id} style={{ '--event-color': event.color } as React.CSSProperties} onClick={() => onSelectEvent(event)}>
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

function TimeGrid({ dates, events, onSelectEvent, onCreate }: { dates: Date[]; events: CalendarEvent[]; onSelectEvent(event: CalendarEvent): void; onCreate(date: Date): void }) {
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
              return <div className="time-slot" key={date.toISOString()} onDoubleClick={() => { const next = new Date(date); next.setHours(hour); onCreate(next) }}>
                {slotEvents.map((event) => <button key={event.id} className="time-event" style={{ '--event-color': event.color } as React.CSSProperties} onClick={() => onSelectEvent(event)}><strong>{event.title}</strong><span>{format(parseISO(event.start), 'HH:mm')} – {format(parseISO(event.end), 'HH:mm')}</span></button>)}
              </div>
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function Agenda({ events, onSelect }: { events: CalendarEvent[]; onSelect(event: CalendarEvent): void }) {
  const future = events.filter((event) => new Date(event.end) >= subDays(new Date(), 1))
  return (
    <div className="agenda-list">
      {future.map((event) => (
        <button className="agenda-row" key={event.id} onClick={() => onSelect(event)}>
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

function EventEditor({ event, date, state, onClose, onSave, onDelete }: { event?: CalendarEvent; date: Date; state: AppState; onClose(): void; onSave(event: CalendarEvent): void; onDelete?(): void }) {
  const initialStart = event ? parseISO(event.start) : new Date(date)
  if (!event) initialStart.setHours(initialStart.getHours() || 10, 0, 0, 0)
  const initialEnd = event ? parseISO(event.end) : new Date(initialStart.getTime() + 60 * 60 * 1000)
  const [title, setTitle] = useState(event?.title ?? '')
  const [start, setStart] = useState(format(initialStart, "yyyy-MM-dd'T'HH:mm"))
  const [end, setEnd] = useState(format(initialEnd, "yyyy-MM-dd'T'HH:mm"))
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? state.accounts[0].id)
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [attendees, setAttendees] = useState(event?.attendees.join(', ') ?? '')
  const [recurrence, setRecurrence] = useState<CalendarEvent['recurrence']>(event?.recurrence ?? 'none')
  const color = state.accounts.find((account) => account.id === calendarId)?.color ?? '#6659e8'
  const startTime = Date.parse(start)
  const endTime = Date.parse(end)
  const canSave = Boolean(title.trim()) && Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime

  return (
    <Modal title={event ? 'Edit event' : 'New event'} subtitle="Keep time intentional." onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Event title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a title" /></label>
        <div className="form-grid-2">
          <label className="field-label">Starts<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field-label">Ends<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <div className="form-grid-2">
          <label className="field-label">Calendar<select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>{state.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
          <label className="field-label">Repeat<select value={recurrence} onChange={(e) => setRecurrence(e.target.value as CalendarEvent['recurrence'])}><option value="none">Doesn’t repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        </div>
        <label className="field-label"><MapPin size={14} /> Location<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add a place or video link" /></label>
        <label className="field-label"><Users size={14} /> Attendees<input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Separate email addresses with commas" /></label>
        <label className="field-label">Notes<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <footer className="modal-footer">
          {onDelete && <button className="button danger-subtle" onClick={onDelete}>Delete</button>}
          <span className="spacer" />
          <button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!canSave} title={!canSave ? 'Add a title and choose an end time after the start' : undefined} onClick={() => onSave({
            id: event?.id ?? uid('event'), calendarId, title: title.trim(),
            start: new Date(start).toISOString(), end: new Date(end).toISOString(), location, description, color,
            attendees: attendees.split(',').map((value) => value.trim()).filter(Boolean), reminderMinutes: event?.reminderMinutes ?? 15, recurrence
          })}><CalendarDays size={16} /> Save event</button>
        </footer>
      </div>
    </Modal>
  )
}
