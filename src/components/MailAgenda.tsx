import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import type { Account, CalendarEvent } from '../types'
import { expandCalendarEvents, isAllDayEvent } from '../lib/recurrence'

export function eventsForAgendaDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const from = startOfDay(day), to = addDays(from, 1)
  const date = format(day, 'yyyy-MM-dd')
  return expandCalendarEvents(events, from, to, { expand: (event) => !('remoteId' in event) || ('provider' in event && event.provider === 'dav') })
    .filter((event) => {
      if (isAllDayEvent(event)) return event.start.slice(0, 10) <= date && date < event.end.slice(0, 10)
      const start = Date.parse(event.start), end = Date.parse(event.end)
      return Number.isFinite(start) && Number.isFinite(end) && start < to.getTime() && (end > from.getTime() || end === start && start >= from.getTime())
    })
    .sort((a, b) => Number(isAllDayEvent(b)) - Number(isAllDayEvent(a)) || Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title))
}

export default function MailAgenda({ events, calendars, syncing, status, onSync, onClose, onOpen }: {
  events: CalendarEvent[]; calendars: Account[]; syncing: boolean; status?: string
  onSync(): void; onClose(): void; onOpen(day: Date, event?: CalendarEvent): void
}) {
  const [now, setNow] = useState(() => new Date())
  const [offset, setOffset] = useState(0)
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer) }, [])
  const day = addDays(startOfDay(now), offset)
  const dateKey = format(day, 'yyyy-MM-dd')
  const daily = useMemo(() => eventsForAgendaDay(events, parseISO(dateKey)), [events, dateKey])
  return <aside className="mail-daily-agenda" aria-label="Daily agenda">
    <header><h2><CalendarDays size={16} />Daily agenda</h2><button className="icon-button" aria-label="Hide daily agenda" title="Hide daily agenda" onClick={onClose}><X size={15} /></button></header>
    <div className="mail-agenda-navigation"><button className="icon-button" aria-label="Previous agenda day" onClick={() => setOffset((value) => value - 1)}><ChevronLeft size={16} /></button><button className="button ghost" onClick={() => setOffset(0)}>Today</button><button className="icon-button" aria-label="Next agenda day" onClick={() => setOffset((value) => value + 1)}><ChevronRight size={16} /></button><button className="icon-button" aria-label="Refresh agenda" title="Refresh agenda" disabled={syncing} onClick={onSync}><RefreshCw size={15} /></button></div>
    <label className="mail-agenda-date">{format(day, 'EEEE')}<input type="date" aria-label="Agenda date" value={dateKey} onChange={(event) => { const value = parseISO(event.target.value); if (Number.isFinite(value.getTime())) setOffset(differenceInCalendarDays(value, now)) }} /></label>
    <div className="mail-agenda-events" aria-live="polite">
      {daily.length === 0 && <p className="mail-agenda-empty">No events for {offset === 0 ? 'today' : 'this day'}.</p>}
      {daily.map((event) => {
        const allDay = isAllDayEvent(event)
        const ongoing = !allDay && Date.parse(event.start) <= now.getTime() && Date.parse(event.end) > now.getTime()
        const calendar = calendars.find((item) => item.id === event.calendarId)
        return <button key={`${event.calendarId}:${event.id}:${event.start}`} className={`mail-agenda-event${ongoing ? ' ongoing' : ''}`} style={{ borderLeftColor: event.color }} onClick={() => onOpen(day, event)} aria-label={`Open ${event.title} in Calendar`}>
          <span className="mail-agenda-time">{allDay ? 'All day' : `${format(parseISO(event.start), 'HH:mm')} – ${format(parseISO(event.end), 'HH:mm')}`}{ongoing && <strong>Now</strong>}</span>
          <strong>{event.title || 'Untitled event'}</strong>
          {event.location && <span>{event.location}</span>}
          <small>{calendar?.name ?? 'Calendar'}</small>
        </button>
      })}
    </div>
    <footer><button className="button ghost" onClick={() => onOpen(day)}>Open day in Calendar</button><small aria-live="polite">{syncing ? 'Synchronizing calendars…' : status}</small></footer>
  </aside>
}
