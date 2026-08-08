// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState, CalendarEvent } from '../types'
import CalendarView from './CalendarView'

const calendarEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event-1', calendarId: 'google', title: 'Planning session', start: '2026-08-08T10:00:00Z', end: '2026-08-08T11:00:00Z',
  location: 'Studio', description: 'Plan the release', color: '#6558e8', attendees: ['ada@example.test'], reminderMinutes: 15, recurrence: 'weekly', ...overrides
})
const state = (events: CalendarEvent[] = [calendarEvent()]): AppState => ({
  accounts: [
    { id: 'google', name: 'Work Calendar', email: 'work@example.test', initials: 'WC', color: '#6558e8', provider: 'gmail' },
    { id: 'microsoft', name: 'Personal Calendar', email: 'home@example.test', initials: 'PC', color: '#438f78', provider: 'microsoft' }
  ], events, contacts: [], tasks: [], notes: []
})
const callbacks = () => ({
  onToast: vi.fn(), onSync: vi.fn(async () => undefined), onEnableEditing: vi.fn(async () => undefined),
  onSaveProviderEvent: vi.fn(async () => undefined), onDeleteProviderEvent: vi.fn(async () => undefined)
})
const renderCalendar = (writable: ReadonlySet<string>, props = callbacks(), calendarState = state(), query = '') => {
  render(<ContextMenuProvider><CalendarView state={calendarState} query={query} writableCalendarIds={writable} {...props} sourceMessage="Google Calendar is editable" /></ContextMenuProvider>)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
})

describe('CalendarView', () => {
  it('prompts for editing permission, synchronizes, and exposes the source state', async () => {
    const user = userEvent.setup(), props = renderCalendar(new Set())
    expect(screen.getByText(/Reconnect Google or Microsoft once/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Enable event editing/ })); expect(props.onEnableEditing).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Sync now/ })); expect(props.onSync).toHaveBeenCalled()
    fireEvent.contextMenu(document.querySelector('.month-day')!)
    await user.click(screen.getByRole('menuitem', { name: 'Enable event editing' }))
    expect(props.onEnableEditing).toHaveBeenCalledTimes(2)
  })

  it('moves through month, week, day, and agenda views and toggles calendars', async () => {
    const user = userEvent.setup()
    renderCalendar(new Set(['google']))
    const initialTitle = screen.getByRole('heading', { level: 1 }).textContent
    await user.click(screen.getByRole('button', { name: 'Next period' })); expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe(initialTitle)
    await user.click(screen.getByRole('button', { name: 'Previous period' }))
    await user.click(screen.getByRole('button', { name: 'week' })); expect(document.querySelector('.time-grid')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next period' }))
    await user.click(screen.getByRole('button', { name: 'day' })); expect(document.querySelectorAll('.time-grid-header div')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'agenda' })); expect(document.querySelector('.agenda-list')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Today' }))
    await user.click(screen.getByRole('button', { name: 'Work Calendar' })); expect(screen.queryByText('Planning session')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Work Calendar' })); expect(screen.getByText('Planning session')).toBeInTheDocument()
  })

  it('creates a provider event with all editor fields', async () => {
    const user = userEvent.setup(), props = renderCalendar(new Set(['google']))
    await user.click(screen.getByRole('button', { name: 'New event' }))
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Event title'), 'Release review')
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-08-10T09:00' } })
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-08-10T10:30' } })
    await user.selectOptions(screen.getByLabelText('Calendar'), 'google')
    await user.selectOptions(screen.getByLabelText('Repeat'), 'monthly')
    await user.selectOptions(screen.getByLabelText('Reminder'), '60')
    await user.type(screen.getByLabelText(/Location/), 'Meeting room')
    await user.type(screen.getByLabelText(/Attendees/), 'ada@example.test, bob@example.test')
    await user.type(screen.getByLabelText('Notes'), 'Discuss the launch')
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Release review', calendarId: 'google', location: 'Meeting room', recurrence: 'monthly', reminderMinutes: 60, attendees: ['ada@example.test', 'bob@example.test']
    }), false))
    expect(props.onToast).toHaveBeenCalledWith('Event created')
  })

  it('edits and deletes writable events and renders provider events read-only', async () => {
    const user = userEvent.setup(), props = renderCalendar(new Set(['google']))
    await user.click(screen.getAllByText('Planning session')[0])
    expect(screen.getByRole('dialog', { name: 'Edit event' })).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Event title')); await user.type(screen.getByLabelText('Event title'), 'Updated planning')
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1', title: 'Updated planning' }), true))
    expect(props.onToast).toHaveBeenCalledWith('Event updated')

    await user.click(screen.getAllByText('Planning session')[0])
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(props.onDeleteProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1' })))
    expect(props.onToast).toHaveBeenCalledWith('Event deleted')

    const readOnly = { ...calendarEvent({ id: 'readonly', calendarId: 'microsoft', title: 'Provider meeting' }), readOnly: true } as CalendarEvent
    renderCalendar(new Set(['google']), callbacks(), state([readOnly]))
    await user.click(screen.getAllByText('Provider meeting')[0])
    expect(screen.getByRole('dialog', { name: 'Event details' })).toBeInTheDocument()
    expect(screen.getByLabelText('Event title')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Save event/ })).not.toBeInTheDocument()
  })

  it('duplicates and deletes events through context actions and reports provider failures', async () => {
    const user = userEvent.setup(), props = callbacks()
    props.onSaveProviderEvent.mockRejectedValueOnce(new Error('duplicate failed'))
    props.onDeleteProviderEvent.mockRejectedValueOnce(new Error('delete failed'))
    renderCalendar(new Set(['google']), props)
    const event = document.querySelector('.calendar-event')!
    fireEvent.contextMenu(event); await user.click(screen.getByRole('menuitem', { name: 'Duplicate event' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('duplicate failed'))
    fireEvent.contextMenu(event); await user.click(screen.getByRole('menuitem', { name: 'Delete event' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('delete failed'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Work Calendar' })); await user.click(screen.getByRole('menuitem', { name: 'Show only this calendar' }))
    expect(screen.getAllByText('Planning session').length).toBeGreaterThan(0)
  })

  it('validates editor times and filters calendar search results', async () => {
    const user = userEvent.setup()
    renderCalendar(new Set(['google']), callbacks(), state(), 'missing')
    expect(screen.queryByText('Planning session')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(screen.getByLabelText('Event title'), 'Invalid time')
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-08-10T11:00' } })
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-08-10T10:00' } })
    expect(screen.getByRole('button', { name: /Save event/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Save event/ })).toHaveAttribute('title', expect.stringContaining('end time after'))
  })

  it('keeps the editor open and explains provider save and delete failures', async () => {
    const user = userEvent.setup(), props = callbacks()
    props.onSaveProviderEvent.mockRejectedValueOnce(new Error('save was rejected'))
    props.onDeleteProviderEvent.mockRejectedValueOnce('offline')
    renderCalendar(new Set(['google']), props)

    await user.click(screen.getByRole('button', { name: 'New event' }))
    await user.type(screen.getByLabelText('Event title'), 'Provider failure')
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('save was rejected'))
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getAllByText('Planning session')[0])
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('Event could not be deleted'))
    expect(screen.getByRole('dialog', { name: 'Edit event' })).toBeInTheDocument()
  })

  it('uses date and calendar context actions and handles creation without permission', async () => {
    const user = userEvent.setup(), props = renderCalendar(new Set())
    fireEvent.doubleClick(document.querySelector('.month-day')!)
    expect(props.onToast).toHaveBeenCalledWith('Enable Calendar editing once, then double-click again')

    const day = document.querySelector('.month-day')!
    fireEvent.contextMenu(day)
    await user.click(screen.getByRole('menuitem', { name: 'Open day view' }))
    expect(document.querySelectorAll('.time-grid-header div')).toHaveLength(1)

    const account = screen.getByRole('button', { name: 'Work Calendar' })
    fireEvent.contextMenu(account)
    await user.click(screen.getByText('Hide calendar'))
    fireEvent.contextMenu(account)
    await user.click(screen.getByText('Show calendar'))
    fireEvent.contextMenu(account)
    await user.click(screen.getByRole('menuitem', { name: 'Show all calendars' }))
  })

  it('navigates day periods, shows crowded days, and creates from writable menus', async () => {
    const user = userEvent.setup(), props = callbacks()
    const events = [0, 1, 2, 3].map((index) => calendarEvent({ id: `event-${index}`, title: `Meeting ${index}` }))
    renderCalendar(new Set(['google']), props, state(events))
    expect(screen.getByText('+1 more')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'day' }))
    const title = screen.getByRole('heading', { level: 1 }).textContent
    await user.click(screen.getByRole('button', { name: 'Previous period' }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe(title)
    await user.click(screen.getByRole('button', { name: 'Next period' }))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Work Calendar' }))
    await user.click(screen.getByRole('menuitem', { name: 'New event in Work Calendar' }))
    expect(screen.getByRole('dialog', { name: 'New event' })).toBeInTheDocument()
    expect(screen.getByLabelText('Calendar')).toHaveValue('google')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('copies date, calendar, and event details with and without locations', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_value: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderCalendar(new Set(['google']), callbacks(), state([
      calendarEvent(), calendarEvent({ id: 'without-place', title: 'Remote planning', location: undefined })
    ]))
    fireEvent.contextMenu(document.querySelector('.month-day')!)
    await user.click(screen.getByRole('menuitem', { name: 'Copy date' }))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Work Calendar' }))
    await user.click(screen.getByRole('menuitem', { name: 'Copy calendar address' }))
    const remote = screen.getAllByText('Remote planning')[0].closest('.calendar-event')!
    fireEvent.contextMenu(remote)
    await user.click(screen.getByRole('menuitem', { name: 'Copy event details' }))
    expect(writeText).toHaveBeenCalledWith('work@example.test')
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('Studio')
  })

  it('renders active synchronization and friendly context-action fallbacks', async () => {
    const user = userEvent.setup(), props = callbacks()
    props.onSaveProviderEvent.mockRejectedValueOnce('offline')
    props.onDeleteProviderEvent.mockRejectedValueOnce('offline')
    render(<ContextMenuProvider><CalendarView state={state()} query="" writableCalendarIds={new Set(['google'])} {...props} syncing /></ContextMenuProvider>)
    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled()
    const event = document.querySelector('.calendar-event')!
    fireEvent.contextMenu(event)
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate event' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('Event could not be duplicated'))
    fireEvent.contextMenu(event)
    await user.click(screen.getByRole('menuitem', { name: 'Delete event' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('Event could not be deleted'))
  })
})
