// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState, CalendarEvent } from '../types'
import CalendarView from './CalendarView'

const series = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'series', calendarId: 'local', title: 'Standup', start: '2026-08-03T09:00:00.000Z', end: '2026-08-03T09:30:00.000Z',
  color: '#2f7d6d', attendees: [], reminderMinutes: 0, recurrence: 'weekly', recurrenceRule: 'FREQ=WEEKLY', timeZone: 'UTC', ...overrides
})
const state = (events: CalendarEvent[]): AppState => ({
  accounts: [
    { id: 'local', name: 'On this PC', email: 'local', initials: 'L', color: '#2f7d6d', provider: 'local' },
    { id: 'google', name: 'Work', email: 'work@example.test', initials: 'W', color: '#6558e8', provider: 'gmail' }
  ],
  events, contacts: [], tasks: [], notes: []
})
const monthEvent = (index: number) => document.querySelectorAll<HTMLElement>('.month-grid .calendar-event')[index]
const renderCalendar = (events: CalendarEvent[]) => {
  const props = {
    onToast: vi.fn(), onSync: vi.fn(), onEnableEditing: vi.fn(),
    onSaveProviderEvent: vi.fn(async () => undefined), onDeleteProviderEvent: vi.fn(async () => undefined)
  }
  render(<ContextMenuProvider><CalendarView state={state(events)} query="" writableCalendarIds={new Set(['local', 'google'])} {...props} /></ContextMenuProvider>)
  return props
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-08T08:00:00Z'))
})

afterEach(() => vi.useRealTimers())

describe('Calendar recurrence', () => {
  it('shows every occurrence in the visible month and skips exceptions', () => {
    renderCalendar([series({ recurrenceExceptions: ['2026-08-17T09:00:00.000Z'] })])
    // August 2026 grid runs from 27 July to 6 September: Mondays 3, 10, 24, 31 Aug (17th excluded).
    expect([...document.querySelectorAll('.month-grid .calendar-event')].map((item) => item.closest('.month-day')?.querySelector('.day-number')?.textContent)).toEqual(['3', '10', '24', '31'])
  })

  it('asks whether to change one occurrence, following occurrences, or the series', async () => {
    const user = userEvent.setup(), props = renderCalendar([series()])
    await user.click(monthEvent(1))
    expect(screen.getByLabelText('Repeat')).toHaveValue('weekly')
    await user.clear(screen.getByLabelText('Event title'))
    await user.type(screen.getByLabelText('Event title'), 'Moved standup')
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    const chooser = screen.getByRole('group', { name: 'Save repeating event' })
    await user.click(within(chooser).getByRole('button', { name: 'Save this event' }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Moved standup', occurrenceOf: 'series', originalStart: '2026-08-10T09:00:00.000Z', start: '2026-08-10T09:00:00.000Z'
    }), true, 'occurrence'))
    expect(props.onToast).toHaveBeenCalledWith('Event updated')
  })

  it('offers scoped deletes in the editor and the context menu', async () => {
    const user = userEvent.setup(), props = renderCalendar([series()])
    fireEvent.contextMenu(monthEvent(2))
    await user.click(screen.getByRole('menuitem', { name: 'Delete this and following events' }))
    await waitFor(() => expect(props.onDeleteProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ occurrenceOf: 'series' }), 'following'))
    expect(props.onToast).toHaveBeenCalledWith('This and following events deleted')
    await user.click(monthEvent(0))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Delete all events' }))
    await waitFor(() => expect(props.onDeleteProviderEvent).toHaveBeenLastCalledWith(expect.objectContaining({ id: expect.stringContaining('series::') }), 'series'))
  })

  it('represents yearly and custom rules honestly and preserves rules it cannot edit', async () => {
    const user = userEvent.setup()
    renderCalendar([
      series({ id: 'birthday', title: 'Birthday', recurrence: 'none', recurrenceRule: 'FREQ=YEARLY' }),
      series({ id: 'review', title: 'Review', start: '2026-08-04T12:00:00.000Z', end: '2026-08-04T13:00:00.000Z', recurrence: 'none', recurrenceRule: 'FREQ=MONTHLY;BYDAY=1TU' }),
      series({ id: 'hourly', title: 'Pulse', start: '2026-08-05T12:00:00.000Z', end: '2026-08-05T12:10:00.000Z', recurrence: 'none', recurrenceRule: 'FREQ=DAILY;BYHOUR=12,18' })
    ])
    await user.click(screen.getByText('Birthday'))
    expect(screen.getByLabelText('Repeat')).toHaveValue('yearly')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getAllByText('Review')[0])
    expect(screen.getByLabelText('Repeat')).toHaveValue('custom')
    expect(screen.getByText('Every month on the first Tuesday')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // The BYHOUR rule cannot be expanded, so the stored event shows once and its rule is kept read-only.
    expect(screen.getAllByText('Pulse')).toHaveLength(1)
    await user.click(screen.getByText('Pulse'))
    expect(screen.getByLabelText('Repeat')).toHaveValue('preserved')
    expect(screen.getByRole('note')).toHaveTextContent('kept exactly as it is')
  })

  it('builds custom rules, all-day events, and named time zones in the editor', async () => {
    const user = userEvent.setup(), props = renderCalendar([])
    await user.click(screen.getByRole('button', { name: 'New event' }))
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Tokyo sync' } })
    await user.selectOptions(screen.getByLabelText('Time zone'), 'Asia/Tokyo')
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-08-10T09:00' } })
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-08-10T10:00' } })
    await user.selectOptions(screen.getByLabelText('Repeat'), 'custom')
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } })
    await user.click(screen.getByRole('button', { name: 'Thursday' }))
    await user.selectOptions(screen.getByLabelText('Repeat ends'), 'count')
    fireEvent.change(screen.getByLabelText('Occurrences'), { target: { value: '5' } })
    expect(screen.getByText('Every 2 weeks on Mon and Thu, 5 times')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Tokyo sync', timeZone: 'Asia/Tokyo', start: '2026-08-10T00:00:00.000Z', end: '2026-08-10T01:00:00.000Z',
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=MO,TH', recurrence: 'none'
    }), false))

    await user.click(screen.getByRole('button', { name: 'New event' }))
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Conference' } })
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-08-12T09:00' } })
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-08-14T17:00' } })
    await user.click(screen.getByLabelText('All day'))
    expect(screen.queryByLabelText('Time zone')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Conference', allDay: true, start: '2026-08-12', end: '2026-08-15', timeZone: undefined
    }), false))
  })

  it('treats synced provider instances as series members without re-expanding them', async () => {
    const user = userEvent.setup()
    const instance = { ...series({ id: 'google-1', calendarId: 'google', recurrence: 'none', recurrenceRule: undefined, seriesId: 'remote-series', originalStart: '2026-08-03T09:00:00.000Z' }), remoteId: 'remote-series_1', readOnly: false } as CalendarEvent
    const props = renderCalendar([instance])
    expect(screen.getAllByText('Standup')).toHaveLength(1)
    await user.click(screen.getByText('Standup'))
    expect(screen.getByText(/managed by Google/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await user.click(screen.getByRole('button', { name: 'Save this and following events' }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-1', seriesId: 'remote-series' }), true, 'following'))
    const saved = (props.onSaveProviderEvent.mock.calls[0] as unknown as [CalendarEvent])[0]
    expect(saved.recurrenceRule).toBeUndefined()
  })

  it('shows all-day events in a separate row and a secondary time zone beside the hours', async () => {
    const user = userEvent.setup()
    renderCalendar([series({ id: 'trip', title: 'Trip', allDay: true, start: '2026-08-07', end: '2026-08-09', recurrence: 'none', recurrenceRule: undefined })])
    await user.selectOptions(screen.getByLabelText('Secondary time zone'), 'Asia/Tokyo')
    await user.click(screen.getByRole('button', { name: 'week' }))
    expect(document.querySelector('.all-day-row')).toHaveTextContent('Trip')
    expect(document.querySelectorAll('.all-day-row .time-event')).toHaveLength(2)
    expect(document.querySelectorAll('.secondary-time')).toHaveLength(13)
    expect(document.querySelector('.time-zone-labels')).toHaveTextContent('GMT+9')
  })
})
