// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState, CalendarEvent } from '../types'
import CalendarView, { type ConferenceCalendar } from './CalendarView'

const meet = { provider: 'googleMeet' as const, status: 'ready' as const, joinUrl: 'https://meet.google.com/abc-defg-hij' }
const calendarEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event-1', calendarId: 'google', title: 'Planning session', start: '2026-08-08T10:00:00Z', end: '2026-08-08T11:00:00Z',
  color: '#6558e8', attendees: [], reminderMinutes: 15, recurrence: 'none', ...overrides
})
const state = (events: CalendarEvent[]): AppState => ({
  accounts: [{ id: 'google', name: 'Work Calendar', email: 'work@example.test', initials: 'WC', color: '#6558e8', provider: 'gmail' }],
  events, contacts: [], tasks: [], notes: []
})
const conferenceCalendars: ConferenceCalendar[] = [{ id: 'google', provider: 'gmail', canWrite: true, conferences: { allowed: ['hangoutsMeet'], creatable: ['googleMeet'], canRemove: true } }]
const renderCalendar = (events: CalendarEvent[]) => {
  const props = {
    onToast: vi.fn(), onSync: vi.fn(async () => undefined), onEnableEditing: vi.fn(async () => undefined),
    onSaveProviderEvent: vi.fn(async (_event: CalendarEvent, _exists: boolean) => undefined), onDeleteProviderEvent: vi.fn(async () => undefined)
  }
  render(<ContextMenuProvider><CalendarView state={state(events)} query="" writableCalendarIds={new Set(['google'])} conferenceCalendars={conferenceCalendars} {...props} /></ContextMenuProvider>)
  return props
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-08T08:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('calendar online meetings', () => {
  it('adds Google Meet to a new event as a pending request', async () => {
    const user = userEvent.setup(), props = renderCalendar([])
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(screen.getByLabelText('Event title'), 'Design review')
    await user.click(screen.getByRole('button', { name: 'Add Google Meet' }))
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Design review', conference: { provider: 'googleMeet', status: 'pending', requestId: expect.stringMatching(/^[0-9a-f]{32}$/) }
    }), false))
  })

  it('keeps an existing meeting through unrelated edits and joins it', async () => {
    const user = userEvent.setup(), props = renderCalendar([calendarEvent({ conference: meet })])
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await user.click(screen.getAllByText('Planning session')[0])
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(open).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij', '_blank', 'noopener')
    await user.clear(screen.getByLabelText('Event title')); await user.type(screen.getByLabelText('Event title'), 'Renamed')
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Renamed', conference: meet }), true))
  })

  it('hides the meeting row for calendars without online meeting support data and no meeting', async () => {
    const user = userEvent.setup()
    render(<ContextMenuProvider><CalendarView state={state([calendarEvent()])} query="" writableCalendarIds={new Set(['google'])} onToast={vi.fn()} onSync={vi.fn()} onEnableEditing={vi.fn()} onSaveProviderEvent={vi.fn(async () => undefined)} onDeleteProviderEvent={vi.fn(async () => undefined)} /></ContextMenuProvider>)
    await user.click(screen.getAllByText('Planning session')[0])
    expect(screen.queryByLabelText('Online meeting')).not.toBeInTheDocument()
  })
})
