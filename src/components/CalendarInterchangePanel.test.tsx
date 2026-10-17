// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../types'
import type { InterchangeDesktopApi, InterchangeSnapshot } from '../interchange-types'
import CalendarInterchangePanel, { providerEventFrom, subscriptionStatus } from './CalendarInterchangePanel'

const imported = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'preview-1', calendarId: '', title: 'Board meeting', start: '2026-03-10T13:00:00.000Z', end: '2026-03-10T14:00:00.000Z',
  color: '', attendees: [], reminderMinutes: 0, recurrence: 'weekly', recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU', timeZone: 'America/New_York', sourceUid: 'uid-1', ...overrides
})
const emptySnapshot: InterchangeSnapshot = { calendars: [], events: [] }

const api = (overrides: Partial<InterchangeDesktopApi> = {}): InterchangeDesktopApi => ({
  snapshot: vi.fn(async () => emptySnapshot),
  onChanged: vi.fn(() => () => undefined),
  chooseCalendarFile: vi.fn(async () => ({ fileName: 'team.ics', calendarName: 'Team', events: [imported(), imported({ id: 'preview-2', title: 'Holiday', start: '2026-07-04', end: '2026-07-05', allDay: true, sourceUid: 'uid-2', recurrenceRule: undefined, timeZone: undefined })], warnings: ['1 malformed line was skipped'] })),
  chooseContactsFile: vi.fn(async () => undefined),
  exportCalendar: vi.fn(async () => ({ savedPath: 'C:\\out.ics', count: 2 })),
  exportContacts: vi.fn(async () => ({})),
  saveLocalEvents: vi.fn(async () => ({ calendars: [{ id: 'local-1', kind: 'local' as const, name: 'Team', color: '#2f7d6d' }], events: [] })),
  saveLocalEvent: vi.fn(async () => emptySnapshot),
  deleteLocalEvent: vi.fn(async () => emptySnapshot),
  subscribe: vi.fn(async () => emptySnapshot),
  refresh: vi.fn(async () => emptySnapshot),
  removeCalendar: vi.fn(async () => emptySnapshot),
  ...overrides
})

const renderPanel = (desktop: InterchangeDesktopApi, snapshot = emptySnapshot, events: CalendarEvent[] = []) => {
  const props = { onSnapshot: vi.fn(), onSaveProviderEvent: vi.fn(async () => undefined), onToast: vi.fn() }
  render(<CalendarInterchangePanel
    api={desktop}
    snapshot={snapshot}
    calendars={[
      { id: 'google', name: 'Work', color: '#123', writable: true },
      { id: 'readonly', name: 'Shared', color: '#456', writable: false },
      ...snapshot.calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, color: calendar.color, writable: calendar.kind === 'local' }))
    ]}
    events={events}
    {...props}
  />)
  return props
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('CalendarInterchangePanel', () => {
  it('previews an ICS import with warnings and imports into a new local calendar', async () => {
    const user = userEvent.setup(), desktop = api(), props = renderPanel(desktop)
    await user.click(screen.getByRole('button', { name: /Import .ics/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Import calendar' })
    expect(dialog).toHaveTextContent('2 new · 0 to update · 0 skipped')
    expect(dialog).toHaveTextContent('1 malformed line was skipped')
    expect(dialog).toHaveTextContent('America/New_York')
    expect(dialog).toHaveTextContent('all day')
    expect(screen.getByLabelText('Calendar name')).toHaveValue('Team')
    expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Shared' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Import 2 events/ }))
    await waitFor(() => expect(desktop.saveLocalEvents).toHaveBeenCalledWith({ newCalendarName: 'Team' }, [
      expect.objectContaining({ title: 'Board meeting', recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU' }),
      expect.objectContaining({ title: 'Holiday', allDay: true })
    ]))
    expect(props.onSnapshot).toHaveBeenCalled()
    expect(props.onToast).toHaveBeenCalledWith('Imported 2 events')
  })

  it('updates or skips duplicates in a provider calendar and converts all-day dates for the provider', async () => {
    const user = userEvent.setup(), desktop = api()
    const existing = imported({ id: 'google-event', calendarId: 'google', color: '#123' })
    const props = renderPanel(desktop, emptySnapshot, [existing])
    await user.click(screen.getByRole('button', { name: /Import .ics/ }))
    await user.selectOptions(await screen.findByLabelText('Import into'), 'google')
    expect(screen.getByRole('dialog')).toHaveTextContent('1 new · 1 to update · 0 skipped')
    await user.selectOptions(screen.getByLabelText('Events already in the calendar'), 'skip')
    expect(screen.getByRole('dialog')).toHaveTextContent('1 new · 0 to update · 1 skipped')
    await user.selectOptions(screen.getByLabelText('Events already in the calendar'), 'update')
    await user.click(screen.getByRole('button', { name: /Import 2 events/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledTimes(2))
    expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-event', calendarId: 'google' }), true)
    const holiday = (props.onSaveProviderEvent.mock.calls as unknown as [CalendarEvent, boolean][]).find(([event]) => event.title === 'Holiday')![0]
    expect(holiday.start).toBe(new Date(2026, 6, 4).toISOString())
    expect(desktop.saveLocalEvents).not.toHaveBeenCalled()
  })

  it('subscribes, refreshes with a kept last copy, exports, and unsubscribes', async () => {
    const user = userEvent.setup()
    const subscription = { id: 'sub-1', kind: 'subscription' as const, name: 'Holidays', color: '#c06a3a', url: 'https://example.test/h.ics', refreshMinutes: 60, lastRefreshedAt: '2026-10-01T09:00:00.000Z' }
    const failed = { calendars: [{ ...subscription, error: 'The calendar server responded with 500' }], events: [] }
    const desktop = api({ refresh: vi.fn(async () => failed) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const props = renderPanel(desktop, { calendars: [subscription], events: [] })
    expect(screen.getByText(/Read-only, updated/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Subscribe/ }))
    const subscribe = within(screen.getByRole('dialog')).getByRole('button', { name: /^Subscribe$/ })
    expect(subscribe).toBeDisabled()
    await user.type(screen.getByLabelText('Calendar address'), 'webcal://example.test/team.ics')
    await user.selectOptions(screen.getByLabelText('Refresh'), '360')
    await user.click(subscribe)
    await waitFor(() => expect(desktop.subscribe).toHaveBeenCalledWith({ url: 'webcal://example.test/team.ics', refreshMinutes: 360 }))

    await user.click(screen.getByRole('button', { name: 'Refresh Holidays' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('Holidays could not be refreshed; the last copy is kept'))

    await user.click(screen.getByRole('button', { name: /Export/ }))
    await user.selectOptions(screen.getByLabelText('Calendar'), 'google')
    await user.click(screen.getByRole('button', { name: /Export .ics/ }))
    await waitFor(() => expect(desktop.exportCalendar).toHaveBeenCalledWith(['google']))
    expect(props.onToast).toHaveBeenCalledWith('Exported 2 events')

    await user.click(screen.getByRole('button', { name: 'Unsubscribe from Holidays' }))
    await waitFor(() => expect(desktop.removeCalendar).toHaveBeenCalledWith('sub-1'))
  })

  it('shows import errors and subscription status text', async () => {
    const user = userEvent.setup()
    const desktop = api({ chooseCalendarFile: vi.fn(async () => { throw new Error("Error invoking remote method 'interchange:calendar-file-choose': Error: This is not an iCalendar (.ics) file") }) })
    const props = renderPanel(desktop)
    await user.click(screen.getByRole('button', { name: /Import .ics/ }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('This is not an iCalendar (.ics) file'))
    expect(subscriptionStatus({ id: 's', kind: 'subscription', name: 'S', color: '#000', error: 'offline' })).toBe('Refresh failed: offline. Showing the copy not yet loaded.')
    expect(providerEventFrom(imported())).toMatchObject({ start: '2026-03-10T13:00:00.000Z' })
  })
})
