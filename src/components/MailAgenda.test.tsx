// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MailAgenda, { eventsForAgendaDay } from './MailAgenda'
import type { CalendarEvent } from '../types'
const iso = (day: number, hour = 0) => new Date(2026, 7, day, hour).toISOString()
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: 'one', calendarId: 'work', title: 'Planning', start: iso(8, 9), end: iso(8, 11), color: '#6558e8', attendees: [], reminderMinutes: 15, ...overrides })
const callbacks = () => ({ onClose: vi.fn(), onOpen: vi.fn(), onSync: vi.fn() })
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 7, 8, 10)) })
afterEach(() => vi.useRealTimers())
describe('mail daily agenda', () => {
  it('includes overlapping events and local recurrence, excludes other days and exclusive all-day ends', () => {
    const events = [event(), event({ id: 'overnight', start: iso(7, 23), end: iso(8, 1) }), event({ id: 'future', start: iso(9, 10), end: iso(9, 11) }), event({ id: 'all', allDay: true, start: '2026-08-07', end: '2026-08-09' }), event({ id: 'ended', allDay: true, start: '2026-08-07', end: '2026-08-08' }), event({ id: 'repeat', start: iso(1, 12), end: iso(1, 13), recurrenceRule: 'FREQ=DAILY;COUNT=12' })]
    const daily = eventsForAgendaDay(events, new Date(2026, 7, 8))
    expect(daily.map((item) => item.id)).toEqual(['all', 'overnight', 'one', expect.stringContaining('repeat')])
    expect(daily.at(-1)?.occurrenceOf).toBe('repeat')
  })
  it('shows calendar and time details, opens events, navigates dates and refreshes', () => {
    const props = callbacks()
    render(<MailAgenda events={[event({ location: 'Studio' })]} calendars={[{ id: 'work', name: 'Work', email: '', initials: 'W', provider: 'gmail', color: '#6558e8' }]} syncing={false} {...props} />)
    expect(screen.getByText('Now')).toBeInTheDocument()
    expect(screen.getByText('Studio')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Planning in Calendar' }))
    expect(props.onOpen).toHaveBeenCalledWith(new Date(2026, 7, 8), expect.objectContaining({ id: 'one' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next agenda day' }))
    expect(screen.getByText('No events for this day.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(screen.getByRole('button', { name: 'Open Planning in Calendar' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Agenda date'), { target: { value: '2026-08-10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open day in Calendar' }))
    expect(props.onOpen).toHaveBeenLastCalledWith(new Date(2026, 7, 10))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh agenda' })); expect(props.onSync).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Hide daily agenda' })); expect(props.onClose).toHaveBeenCalledOnce()
  })
  it('expands remote DAV series and respects excluded occurrences', () => {
    const series = { ...event({ start: iso(1, 12), end: iso(1, 13), recurrenceRule: 'FREQ=DAILY;COUNT=12', recurrenceExceptions: [iso(9, 12)] }), remoteId: 'dav-series', provider: 'dav' }
    expect(eventsForAgendaDay([series], new Date(2026, 7, 8))).toHaveLength(1)
    expect(eventsForAgendaDay([series], new Date(2026, 7, 8))[0].occurrenceOf).toBe('one')
    expect(eventsForAgendaDay([series], new Date(2026, 7, 9))).toEqual([])
  })
  it('keeps provider occurrences as-is instead of expanding them again', () => {
    const instance = { ...event({ recurrenceRule: 'FREQ=DAILY;COUNT=30' }), remoteId: 'remote' }
    expect(eventsForAgendaDay([instance], new Date(2026, 7, 9))).toEqual([])
    expect(eventsForAgendaDay([instance], new Date(2026, 7, 8))).toEqual([instance])
  })
  it('shows synchronization status and disables concurrent refresh', () => {
    render(<MailAgenda events={[]} calendars={[]} syncing {...callbacks()} />)
    expect(screen.getByRole('button', { name: 'Refresh agenda' })).toBeDisabled()
    expect(screen.getByText('Synchronizing calendars…')).toHaveTextContent('Synchronizing calendars')
  })
})
