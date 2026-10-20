import CalendarWeatherPanel from '../components/CalendarWeatherPanel'
import { EventRemindersField } from '../components/EventRemindersField'
import { eventReminders, validEventReminders } from '../lib/event-reminders'
import {
  CalendarDays, CalendarPlus2, Check, ChevronLeft, ChevronRight, Clock3, Copy, Eye, EyeOff,
  MapPin, Pencil, Plus, RefreshCw, Repeat2, Trash2, Users
} from 'lucide-react'
import {
  addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, parseISO, startOfDay, startOfMonth, startOfWeek, subDays, subMonths, subWeeks
} from 'date-fns'
import { memo, useEffect, useMemo, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, CalendarEvent, RecurrenceEditScope } from '../types'
import Modal from '../components/Modal'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import { preserveEventInterchangeFields } from '../lib/interchange-plan'
import { SchedulingAssistantButton } from '../components/SchedulingAssistant'
import {
  addDaysIso, eventRecurrenceRule, expandCalendarEvents, formatRecurrenceRule, isAllDayEvent,
  isRecurringEvent, parseRecurrenceRule, simpleRecurrenceFor
} from '../lib/recurrence'
import { isIanaTimeZone, localTimeZone, resolveTimeZoneName, timeZoneOffsetLabel, timeZoneOptions, wallTimeInZone, wallTimeToUtc } from '../lib/time-zones'
import { RecurrenceScopeChooser, RepeatField } from './RecurrenceFields'
import EventAttendeesField, { applyAttendeeSelection, attendeeFieldText, attendeeFieldValues, attendeesFromFields } from './EventAttendeesField'
import { withAttendees } from '../lib/event-attendees'
import { EventConferenceField } from '../components/EventConferenceField'
import { conferenceCapabilities, isHostedConferenceProvider } from '../lib/online-meetings'
import { useMeetingHosts } from '../lib/use-meeting-hosts'
import type { SyncedCalendar } from '../productivity-types'

// Provider calendar details the event editor needs for online meetings (E25).
export type ConferenceCalendar = Pick<SyncedCalendar, 'id' | 'provider' | 'canWrite' | 'conferences'>

type CalendarMode = 'month' | 'week' | 'day' | 'agenda'

interface CalendarViewProps {
  openRequest?: { id: number; day: Date; event?: CalendarEvent }
  state: AppState
  query: string
  onToast(message: string): void
  writableCalendarIds: ReadonlySet<string>
  onSync(): Promise<void> | void
  onEnableEditing(): Promise<void> | void
  onSaveProviderEvent(event: CalendarEvent, exists: boolean, scope?: RecurrenceEditScope): Promise<void>
  onDeleteProviderEvent(event: CalendarEvent, scope?: RecurrenceEditScope): Promise<void>
  syncing?: boolean
  sourceMessage?: string
  interchangePanel?: React.ReactNode
  conferenceCalendars?: readonly ConferenceCalendar[]
}

// Agenda and "Up next" expand repeating events this many days ahead.
const AGENDA_DAYS = 90
const SECONDARY_ZONE_KEY = 'aerio.calendar.secondaryTimeZone'

const byStart = (a: CalendarEvent, b: CalendarEvent) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title)

const eventOnDay = (event: CalendarEvent, date: Date) => {
  if (!isAllDayEvent(event)) return isSameDay(parseISO(event.start), date)
  const day = format(date, 'yyyy-MM-dd')
  const start = event.start.slice(0, 10)
  return start === day || (start <= day && day < event.end.slice(0, 10))
}

const timeLabel = (event: CalendarEvent) => isAllDayEvent(event) ? 'All day' : format(parseISO(event.start), 'HH:mm')
const timeRangeLabel = (event: CalendarEvent) => isAllDayEvent(event) ? 'All day' : `${format(parseISO(event.start), 'HH:mm')} – ${format(parseISO(event.end), 'HH:mm')}`

// Synced provider events arrive already expanded (Google singleEvents, Microsoft calendarView), so only
// local and imported events are expanded here.
const expandsLocally = (event: CalendarEvent) => !('remoteId' in event)

// Occurrences generated here, local overrides, and synced provider instances all belong to a series.
export const isSeriesMember = (event: CalendarEvent) => Boolean(event.occurrenceOf || event.seriesId || (event.recurrenceId && event.sourceUid))

function zoneTime(ms: number, zone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(ms)
  } catch {
    return ''
  }
}

// Several hundred zone options are rendered once per list rather than on every keystroke in the editor.
const ZoneOptions = memo(function ZoneOptions({ zones }: { zones: string[] }) {
  return <>{zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}</>
})

function readSecondaryZone() {
  try {
    const value = localStorage.getItem(SECONDARY_ZONE_KEY) ?? ''
    return isIanaTimeZone(value) ? value : ''
  } catch {
    return ''
  }
}

export default function CalendarView({
  state, query, onToast, writableCalendarIds, openRequest,
  onSync, onEnableEditing, onSaveProviderEvent, onDeleteProviderEvent, syncing = false, sourceMessage, interchangePanel, conferenceCalendars
}: CalendarViewProps) {
  const { showContextMenu } = useContextMenu()
  const [mode, setMode] = useState<CalendarMode>('month')
  const [cursor, setCursor] = useState(new Date())
  const [activeCalendars, setActiveCalendars] = useState(() => new Set(state.accounts.map((account) => account.id)))
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null)
  const [newDate, setNewDate] = useState<Date>(new Date())
  const [newCalendarId, setNewCalendarId] = useState<string>()
  useEffect(() => {
    if (!openRequest) return
    setCursor(openRequest.day)
    setMode('day')
    if (openRequest.event) setEditing(openRequest.event)
  }, [openRequest])
  const calendarIds = state.accounts.map((account) => account.id).join('\n')
  const hasWritableCalendar = writableCalendarIds.size > 0
  const canWriteCalendar = (calendarId: string) => writableCalendarIds.has(calendarId)
  const canEditEvent = (event: CalendarEvent) => canWriteCalendar(event.calendarId) && !('readOnly' in event && event.readOnly)

  useEffect(() => {
    setActiveCalendars((current) => new Set([...current, ...state.accounts.map((account) => account.id)]))
  }, [calendarIds])

  const [secondaryZone, setSecondaryZoneState] = useState(readSecondaryZone)
  const secondaryZones = useMemo(() => timeZoneOptions(secondaryZone || undefined), [secondaryZone])
  const setSecondaryZone = (zone: string) => {
    setSecondaryZoneState(zone)
    try {
      if (zone) localStorage.setItem(SECONDARY_ZONE_KEY, zone)
      else localStorage.removeItem(SECONDARY_ZONE_KEY)
    } catch {
      // The choice still applies for this session.
    }
  }

  const filtered = useMemo(() => state.events
    .filter((event) => activeCalendars.has(event.calendarId))
    .filter((event) => !query || `${event.title} ${event.location ?? ''} ${event.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.start.localeCompare(b.start)),
  [activeCalendars, query, state.events])

  const today = startOfDay(new Date()).getTime()
  const range = useMemo(() => {
    if (mode === 'month') return { start: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), end: startOfDay(addDays(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), 1)) }
    if (mode === 'week') return { start: startOfWeek(cursor, { weekStartsOn: 1 }), end: startOfDay(addDays(endOfWeek(cursor, { weekStartsOn: 1 }), 1)) }
    if (mode === 'day') return { start: startOfDay(cursor), end: startOfDay(addDays(cursor, 1)) }
    return { start: subDays(today, 1), end: addDays(today, AGENDA_DAYS) }
  }, [mode, cursor, today])
  const visible = useMemo(() => expandCalendarEvents(filtered, range.start, range.end, { expand: expandsLocally }).sort(byStart), [filtered, range])
  const upcoming = useMemo(() => expandCalendarEvents(filtered, subDays(today, 1), addDays(today, AGENDA_DAYS), { expand: expandsLocally }).sort(byStart), [filtered, today])

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

  const deleteSeriesEvent = async (event: CalendarEvent, scope: RecurrenceEditScope) => {
    await onDeleteProviderEvent(event, scope)
    onToast(scope === 'occurrence' ? 'Event deleted' : scope === 'following' ? 'This and following events deleted' : 'Series deleted')
  }

  const duplicateEvent = async (event: CalendarEvent) => {
    // A copy of one occurrence is a single event at that time; a copy of a series keeps its rule.
    const { occurrenceOf: _occurrenceOf, seriesId: _seriesId, originalStart: _originalStart, recurrenceId: _recurrenceId, sourceUid: _sourceUid, ...rest } = event
    const duplicate: CalendarEvent = { ...rest, id: uid('event'), title: `${event.title} (copy)` }
    if (isSeriesMember(event)) {
      duplicate.recurrence = 'none'
      delete duplicate.recurrenceRule
      delete duplicate.recurrenceExceptions
    }
    await onSaveProviderEvent(duplicate, false)
    onToast('Event duplicated')
  }

  const deleteItems = (event: CalendarEvent): ContextMenuItem[] => {
    const run = (action: () => Promise<void>) => async () => {
      try { await action() }
      catch (error) { onToast(error instanceof Error ? error.message : 'Event could not be deleted') }
    }
    if (!isSeriesMember(event)) return [{ label: 'Delete event', icon: Trash2, separatorBefore: true, danger: true, action: run(() => deleteEvent(event)) }]
    return [
      { label: 'Delete this event', icon: Trash2, separatorBefore: true, danger: true, action: run(() => deleteSeriesEvent(event, 'occurrence')) },
      { label: 'Delete this and following events', icon: Trash2, danger: true, action: run(() => deleteSeriesEvent(event, 'following')) },
      { label: 'Delete all events in the series', icon: Trash2, danger: true, action: run(() => deleteSeriesEvent(event, 'series')) }
    ]
  }

  const eventMenu = (event: CalendarEvent): ContextMenuItem[] => [
    { label: 'Open event', icon: Pencil, action: () => setEditing(event) },
    ...(canEditEvent(event) ? [{ label: 'Duplicate event', icon: Copy, separatorBefore: true, action: async () => {
      try { await duplicateEvent(event) }
      catch (error) { onToast(error instanceof Error ? error.message : 'Event could not be duplicated') }
    } }] satisfies ContextMenuItem[] : []),
    { label: 'Copy event details', icon: Copy, action: () => copyText(`${event.title}\n${format(parseISO(event.start), 'PPpp')} – ${format(parseISO(event.end), 'PPpp')}${event.location ? `\n${event.location}` : ''}`) },
    ...(canEditEvent(event) ? deleteItems(event) : [])
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
        {interchangePanel}
        <div className="up-next-card">
          <span className="eyebrow">Up next</span>
          {upcoming.filter((event) => new Date(event.end) >= new Date()).slice(0, 2).map((event) => (
            <button key={event.id} onClick={() => setEditing(event)} onContextMenu={(contextEvent) => showEventMenu(contextEvent, event)}>
              <span className="event-dot" style={{ background: event.color }} />
              <span><strong>{event.title}</strong><small>{format(parseISO(event.start), 'EEE')} · {timeLabel(event)}</small></span>
            </button>
          ))}
        </div>
        <CalendarWeatherPanel selectedDay={format(cursor, 'yyyy-MM-dd')} />
        <div className="sidebar-group calendar-zone-group">
          <label className="sidebar-label" htmlFor="calendar-secondary-zone">Secondary time zone</label>
          <select id="calendar-secondary-zone" value={secondaryZone} onChange={(event) => setSecondaryZone(event.target.value)}>
            <option value="">None</option>
            <ZoneOptions zones={secondaryZones} />
          </select>
          <small className="provider-source-note">Shown beside the hours in week and day views. Your zone: {localTimeZone().replace(/_/g, ' ')}</small>
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
        {mode === 'month' && <MonthGrid cursor={cursor} events={visible} onSelectEvent={setEditing} onCreate={createOn} onContextEvent={showEventMenu} onContextDate={showDateMenu} />}
        {mode === 'week' && <TimeGrid dates={eachDayOfInterval({ start: startOfWeek(cursor, { weekStartsOn: 1 }), end: endOfWeek(cursor, { weekStartsOn: 1 }) })} events={visible} secondaryZone={secondaryZone} onSelectEvent={setEditing} onCreate={createOn} onContextEvent={showEventMenu} onContextDate={showDateMenu} />}
        {mode === 'day' && <TimeGrid dates={[cursor]} events={visible} secondaryZone={secondaryZone} onSelectEvent={setEditing} onCreate={createOn} onContextEvent={showEventMenu} onContextDate={showDateMenu} />}
        {mode === 'agenda' && <Agenda events={visible} onSelect={setEditing} onContextEvent={showEventMenu} />}
      </section>
      {editing && (
        <EventEditor
          event={editing === 'new' ? undefined : editing}
          date={newDate}
          defaultCalendarId={newCalendarId}
          state={state}
          readOnly={editing === 'new' ? false : !canEditEvent(editing)}
          writableCalendarIds={writableCalendarIds}
          conferenceCalendars={conferenceCalendars}
          onClose={() => setEditing(null)}
          onSave={async (event, scope) => {
            const exists = Boolean(scope) || state.events.some((item) => item.id === event.id)
            try {
              if (scope) await onSaveProviderEvent(event, exists, scope)
              else await onSaveProviderEvent(event, exists)
              onToast(scope === 'following' ? 'This and following events updated' : scope === 'series' ? 'Series updated' : exists ? 'Event updated' : 'Event created')
              setEditing(null)
            } catch (error) {
              onToast(error instanceof Error ? error.message : 'Event could not be saved')
            }
          }}
          onDelete={editing === 'new' || !canEditEvent(editing) ? undefined : async (scope) => {
            try {
              if (scope) await deleteSeriesEvent(editing, scope)
              else await deleteEvent(editing)
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
                <span>{timeLabel(event)}</span>{isSeriesMember(event) || isRecurringEvent(event) ? <Repeat2 className="repeat-icon" size={9} aria-label="Repeats" /> : null}{event.title}
              </button>
            ))}
            {dayEvents.length > 3 && <span className="more-events">+{dayEvents.length - 3} more</span>}
          </div>
        )
      })}
    </div>
  )
}

function TimeGrid({ dates, events, secondaryZone, onSelectEvent, onCreate, onContextEvent, onContextDate }: { dates: Date[]; events: CalendarEvent[]; secondaryZone?: string; onSelectEvent(event: CalendarEvent): void; onCreate(date: Date): void; onContextEvent(contextEvent: React.MouseEvent, event: CalendarEvent): void; onContextDate(event: React.MouseEvent, date: Date): void }) {
  const hours = Array.from({ length: 13 }, (_, index) => index + 7)
  const allDay = events.filter(isAllDayEvent)
  const timed = events.filter((event) => !isAllDayEvent(event))
  const localZone = localTimeZone()
  const hourMs = (hour: number) => {
    const value = new Date(dates[0])
    value.setHours(hour, 0, 0, 0)
    return value.getTime()
  }
  const showAllDay = allDay.some((event) => dates.some((date) => eventOnDay(event, date)))
  const eventButton = (event: CalendarEvent, className: string, label: string) => (
    <button key={event.id} className={className} style={{ '--event-color': event.color } as React.CSSProperties} onClick={() => onSelectEvent(event)} onDoubleClick={(doubleClickEvent) => doubleClickEvent.stopPropagation()} onContextMenu={(contextEvent) => onContextEvent(contextEvent, event)}><strong>{event.title}</strong><span>{label}</span></button>
  )
  return (
    <div className="time-grid-wrap">
      <div className="time-grid-header">
        <span className="time-zone-labels">{secondaryZone && <><small title={localZone}>{timeZoneOffsetLabel(hourMs(12), localZone)}</small><small title={secondaryZone}>{timeZoneOffsetLabel(hourMs(12), secondaryZone)}</small></>}</span>
        {dates.map((date) => <div key={date.toISOString()} className={isSameDay(date, new Date()) ? 'today' : ''}><strong>{format(date, 'EEE')}</strong><span>{format(date, 'd')}</span></div>)}
      </div>
      <div className="time-grid">
        {showAllDay && (
          <div className="time-row all-day-row">
            <time>All day</time>
            {dates.map((date) => <div className="time-slot" key={date.toISOString()} onContextMenu={(event) => onContextDate(event, date)}>
              {allDay.filter((event) => eventOnDay(event, date)).map((event) => eventButton(event, 'time-event all-day-event', 'All day'))}
            </div>)}
          </div>
        )}
        {hours.map((hour) => (
          <div className="time-row" key={hour}>
            <time>{`${hour.toString().padStart(2, '0')}:00`}{secondaryZone && <small className="secondary-time">{zoneTime(hourMs(hour), secondaryZone)}</small>}</time>
            {dates.map((date) => {
              const slotEvents = timed.filter((event) => eventOnDay(event, date) && parseISO(event.start).getHours() === hour)
              const slotDate = new Date(date); slotDate.setHours(hour)
              return <div className="time-slot" key={date.toISOString()} onDoubleClick={() => onCreate(slotDate)} onContextMenu={(event) => onContextDate(event, slotDate)}>
                {slotEvents.map((event) => eventButton(event, 'time-event', timeRangeLabel(event)))}
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
          <div><h3>{event.title}</h3><p><Clock3 size={14} /> {timeRangeLabel(event)} {event.location && <><MapPin size={14} /> {event.location}</>}</p></div>
          <span className="spacer" />
          <span className="attendee-count"><Users size={15} /> {event.attendees.length}</span>
        </button>
      ))}
    </div>
  )
}

const pad2 = (value: number) => String(value).padStart(2, '0')

function wallInput(ms: number, zone: string) {
  const wall = wallTimeInZone(ms, zone)
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}T${pad2(wall.hour)}:${pad2(wall.minute)}`
}

function parseWallInput(value: string, zone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return Number.NaN
  return wallTimeToUtc({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: 0 }, zone)
}

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/

function initialTimes(event: CalendarEvent | undefined, date: Date, zone: string) {
  if (event && isAllDayEvent(event)) {
    const start = event.start.slice(0, 10)
    const lastDay = addDaysIso(event.end.slice(0, 10), -1)
    return { start, end: lastDay < start ? start : lastDay }
  }
  if (event) return { start: wallInput(Date.parse(event.start), zone), end: wallInput(Date.parse(event.end), zone) }
  const start = new Date(date)
  start.setHours(start.getHours() || 10, 0, 0, 0)
  return { start: format(start, "yyyy-MM-dd'T'HH:mm"), end: format(new Date(start.getTime() + 60 * 60 * 1000), "yyyy-MM-dd'T'HH:mm") }
}

function EventEditor({ event, date, defaultCalendarId, state, readOnly = false, writableCalendarIds, conferenceCalendars, onClose, onSave, onDelete }: { event?: CalendarEvent; date: Date; defaultCalendarId?: string; state: AppState; readOnly?: boolean; writableCalendarIds: ReadonlySet<string>; conferenceCalendars?: readonly ConferenceCalendar[]; onClose(): void; onSave(event: CalendarEvent, scope?: RecurrenceEditScope): Promise<void> | void; onDelete?(scope?: RecurrenceEditScope): Promise<void> | void }) {
  const localZone = localTimeZone()
  const [zone, setZone] = useState(() => resolveTimeZoneName(event?.timeZone) ?? localZone)
  const [allDay, setAllDay] = useState(() => Boolean(event && isAllDayEvent(event)))
  const [times] = useState(() => initialTimes(event, date, resolveTimeZoneName(event?.timeZone) ?? localZone))
  const [initialRule] = useState(() => {
    const rule = event ? eventRecurrenceRule(event) : undefined
    return rule ? formatRecurrenceRule(rule) : undefined
  })
  const [title, setTitle] = useState(event?.title ?? '')
  const [start, setStart] = useState(times.start)
  const [end, setEnd] = useState(times.end)
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? defaultCalendarId ?? state.accounts[0].id)
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [attendees, setAttendees] = useState(() => attendeeFieldValues(event))
  const [rule, setRule] = useState<string | undefined>(initialRule)
  const [reminders, setReminders] = useState(() => event ? eventReminders(event) : [15])
  const reminderProvider = state.accounts.find((account) => account.id === calendarId)?.provider
  const reminderLimit = reminderProvider === 'microsoft' || reminderProvider === 'outlook' || reminderProvider === 'exchange' ? 1 : 5
  const [conference, setConference] = useState(event?.conference)
  const conferenceCalendar = conferenceCalendars?.find((item) => item.id === calendarId)
  const meetingHosts = useMeetingHosts()
  const [busy, setBusy] = useState<'save' | 'delete'>()
  const [pendingScope, setPendingScope] = useState<'save' | 'delete'>()
  const color = state.accounts.find((account) => account.id === calendarId)?.color ?? '#6659e8'
  const providerInstance = Boolean(event && 'remoteId' in event && event.seriesId)
  const seriesMember = Boolean(event && isSeriesMember(event))
  const providerName = state.accounts.find((account) => account.id === event?.calendarId)?.provider === 'microsoft' ? 'Microsoft' : 'Google'
  const startTime = allDay ? (DATE_INPUT.test(start) ? Date.parse(start) : Number.NaN) : parseWallInput(start, zone)
  const endTime = allDay ? (DATE_INPUT.test(end) ? Date.parse(end) : Number.NaN) : parseWallInput(end, zone)
  const canSave = validEventReminders(reminders) && reminders.length <= reminderLimit && Boolean(title.trim()) && Number.isFinite(startTime) && Number.isFinite(endTime) && (allDay ? endTime >= startTime : endTime > startTime)
  const zones = useMemo(() => timeZoneOptions(zone, localZone), [zone, localZone])

  const toggleAllDay = (checked: boolean) => {
    setAllDay(checked)
    if (checked) {
      const startDay = start.slice(0, 10)
      setStart(startDay)
      setEnd(end.slice(0, 10) < startDay ? startDay : end.slice(0, 10))
    } else {
      setStart(`${start.slice(0, 10)}T09:00`)
      setEnd(`${end.slice(0, 10)}T10:00`)
    }
  }

  const build = (): CalendarEvent => {
    const guests: CalendarEvent = withAttendees<CalendarEvent>({
      id: event?.id ?? uid('event'), calendarId, title: title.trim(),
      start: allDay ? start : new Date(startTime).toISOString(),
      end: allDay ? addDaysIso(end, 1) : new Date(endTime).toISOString(),
      location, description, color,
      attendees: [], reminderMinutes: reminders[0] ?? 0, reminders,
      allDay: allDay || undefined,
      timeZone: allDay ? undefined : zone,
      recurrence: 'none',
      ...(conference ? { conference } : {})
    }, attendeesFromFields(attendees, event))
    // attendeeDetails is always set explicitly so a cleared role is not restored from the original event.
    const base: CalendarEvent = { ...guests, attendeeDetails: guests.attendeeDetails }
    // Synced occurrences never carry a rule; the provider keeps the series pattern.
    if (providerInstance) return preserveEventInterchangeFields(event, base)
    const parsed = parseRecurrenceRule(rule)
    return preserveEventInterchangeFields(event, { ...base, recurrence: simpleRecurrenceFor(parsed), recurrenceRule: parsed ? rule : undefined })
  }
  const save = (scope?: RecurrenceEditScope) => {
    setBusy('save')
    void Promise.resolve(scope ? onSave(build(), scope) : onSave(build())).finally(() => setBusy(undefined))
  }
  const remove = (scope?: RecurrenceEditScope) => {
    if (!onDelete) return
    setBusy('delete')
    void Promise.resolve(scope ? onDelete(scope) : onDelete()).finally(() => setBusy(undefined))
  }
  const localHint = !allDay && zone !== localZone && Number.isFinite(startTime) && Number.isFinite(endTime)
    ? `${format(startTime, 'EEE d MMM, HH:mm')} – ${format(endTime, isSameDay(startTime, endTime) ? 'HH:mm' : 'EEE d MMM, HH:mm')} in your time zone (${localZone.replace(/_/g, ' ')})`
    : undefined

  return (
    <Modal title={readOnly ? 'Event details' : event ? 'Edit event' : 'New event'} subtitle={readOnly ? 'Synchronized from your provider.' : 'Keep time intentional.'} closeEnabled={!busy} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Event title<input autoFocus value={title} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} placeholder="Add a title" /></label>
        <div className="form-grid-2">
          <label className="field-label">Starts<input type={allDay ? 'date' : 'datetime-local'} value={start} disabled={readOnly} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field-label">Ends<input type={allDay ? 'date' : 'datetime-local'} value={end} disabled={readOnly} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <div className="form-grid-2">
          <label className="check-label event-all-day"><input type="checkbox" checked={allDay} disabled={readOnly} onChange={(e) => toggleAllDay(e.target.checked)} /> All day</label>
          {!allDay && <label className="field-label">Time zone<select value={zone} disabled={readOnly} onChange={(e) => setZone(e.target.value)}><ZoneOptions zones={zones} /></select></label>}
        </div>
        {localHint && <p className="recurrence-note event-zone-hint">{localHint}</p>}
        <div className="form-grid-2">
          <label className="field-label">Calendar<select value={calendarId} disabled={readOnly || Boolean(event)} onChange={(e) => { setCalendarId(e.target.value); if (conference?.status === 'pending') setConference(undefined) }}>{state.accounts.filter((account) => writableCalendarIds.has(account.id) || account.id === event?.calendarId).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>

        </div>
        <EventRemindersField value={reminders} onChange={setReminders} disabled={readOnly} limit={reminderLimit} />
        {!validEventReminders(reminders) && <p role="alert">Use different whole minute offsets between 0 and 40320.</p>}
        <RepeatField
          value={rule}
          startDate={start.slice(0, 10)}
          disabled={readOnly}
          managedNote={providerInstance ? `Part of a repeating series managed by ${providerName}. Changes can apply to this event, this and following events, or all events; the repeat pattern itself is kept.` : undefined}
          onChange={setRule}
        />
        {(conferenceCalendar || conference) && (
          <EventConferenceField
            value={conference}
            original={event?.conference}
            capabilities={conferenceCapabilities(conferenceCalendar, meetingHosts)}
            // Aerio's own Zoom and Webex meetings can always be removed; Teams cannot (see canRemove).
            canRemove={Boolean(conferenceCalendar?.conferences?.canRemove) || (isHostedConferenceProvider(conference?.provider) && Boolean(conference?.requestId))}
            disabled={readOnly}
            onChange={setConference}
          />
        )}
        <label className="field-label"><MapPin size={14} /> Location<input value={location} disabled={readOnly} onChange={(e) => setLocation(e.target.value)} placeholder="Add a place or video link" /></label>
        <EventAttendeesField value={attendees} event={event} disabled={readOnly} onChange={setAttendees} />
        {!readOnly && !allDay && <SchedulingAssistantButton calendarId={calendarId} organizerEmail={state.accounts.find((account) => account.id === calendarId)?.email} start={start} end={end} inputTimeZone={zone} attendees={attendeeFieldText(attendees)}
          onApply={(selection) => { setStart(selection.start); setEnd(selection.end); setAttendees(applyAttendeeSelection(attendees, selection.attendees)) }} />}
        <label className="field-label">Notes<textarea value={description} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} /></label>
        {pendingScope ? (
          <footer className="modal-footer">
            <RecurrenceScopeChooser
              action={pendingScope}
              allowOccurrence={pendingScope === 'delete' || rule === initialRule}
              busy={Boolean(busy)}
              onChoose={(scope) => pendingScope === 'save' ? save(scope) : remove(scope)}
              onCancel={() => setPendingScope(undefined)}
            />
          </footer>
        ) : (
          <footer className="modal-footer">
            {onDelete && <button className="button danger-subtle" disabled={Boolean(busy)} onClick={() => seriesMember ? setPendingScope('delete') : remove()}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>}
            <span className="spacer" />
            <button className="button ghost" disabled={Boolean(busy)} onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
            {!readOnly && <button className="button primary" disabled={!canSave || Boolean(busy)} title={!canSave ? 'Add a title and choose an end time after the start' : undefined} onClick={() => seriesMember ? setPendingScope('save') : save()}><CalendarDays size={16} /> {busy === 'save' ? 'Saving…' : 'Save event'}</button>}
          </footer>
        )}
      </div>
    </Modal>
  )
}
