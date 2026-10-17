// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState, CalendarEvent, Contact } from '../types'
import CalendarView from './CalendarView'
import ContactsView from './ContactsView'

const imported: CalendarEvent = {
  id: 'event-1', calendarId: 'local-1', title: 'Offsite', start: '2026-08-10T07:00:00.000Z', end: '2026-08-10T08:00:00.000Z',
  color: '#2f7d6d', attendees: [], reminderMinutes: 0, recurrence: 'weekly', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE', timeZone: 'Europe/Paris',
  recurrenceExceptions: ['2026-08-17T07:00:00.000Z'], sourceUid: 'uid-1@example.test'
}
const state = (events: CalendarEvent[], contacts: Contact[] = []): AppState => ({
  accounts: [{ id: 'local-1', name: 'Imported', email: 'On this PC', initials: 'I', color: '#2f7d6d', provider: 'local' }],
  events, contacts, tasks: [], notes: []
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-08T08:00:00Z'))
})

afterEach(() => vi.useRealTimers())

describe('interchange in the Calendar and Contacts views', () => {
  it('renders the interchange panel and keeps time zone, repeat rule, and source identity when editing a local event', async () => {
    const user = userEvent.setup()
    const onSaveProviderEvent = vi.fn(async () => undefined)
    render(<ContextMenuProvider><CalendarView
      state={state([imported])} query="" writableCalendarIds={new Set(['local-1'])} onToast={vi.fn()} onSync={vi.fn()} onEnableEditing={vi.fn()}
      onSaveProviderEvent={onSaveProviderEvent} onDeleteProviderEvent={vi.fn(async () => undefined)} interchangePanel={<div>Interchange panel</div>}
    /></ContextMenuProvider>)
    expect(screen.getByText('Interchange panel')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'agenda' }))
    await user.click(screen.getAllByRole('button', { name: /Offsite/ })[0])
    await user.clear(screen.getByLabelText('Event title'))
    await user.type(screen.getByLabelText('Event title'), 'Team offsite')
    await user.click(screen.getByRole('button', { name: /Save event/ }))
    await waitFor(() => expect(onSaveProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Team offsite', timeZone: 'Europe/Paris', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE', recurrenceExceptions: ['2026-08-17T07:00:00.000Z'], sourceUid: 'uid-1@example.test'
    }), true))
  })

  it('shows additional imported contact fields and keeps them when a local contact is edited', async () => {
    const user = userEvent.setup()
    const onLocalContactsChange = vi.fn()
    const contact: Contact = {
      id: 'local-ada', name: 'Ada Lovelace', email: 'ada@home.test', phone: '+44 1', group: 'Friends', favorite: false, color: '#000', source: 'local',
      emails: [{ value: 'ada@home.test', type: 'home' }, { value: 'ada@work.test', type: 'work' }], phones: [{ value: '+44 1', type: 'cell' }],
      addresses: [{ value: '1 Lane, London', type: 'home' }], birthday: '1815-12-10', sourceUid: 'urn:ada'
    }
    render(<ContextMenuProvider><ContactsView
      state={state([], [contact])} query="" onCompose={vi.fn()} onToast={vi.fn()} onSync={vi.fn()} onLocalContactsChange={onLocalContactsChange}
      interchangePanel={<div>Contact interchange</div>}
    /></ContextMenuProvider>)
    expect(screen.getByText('Contact interchange')).toBeInTheDocument()
    expect(screen.getByText('ada@work.test')).toBeInTheDocument()
    expect(screen.getByText('1 Lane, London')).toBeInTheDocument()
    expect(screen.getByText('1815-12-10')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Edit$/ }))
    await user.clear(screen.getByLabelText('Email'))
    await user.type(screen.getByLabelText('Email'), 'ada@new.test')
    await user.click(screen.getByRole('button', { name: /Save contact/ }))
    expect(onLocalContactsChange).toHaveBeenCalledWith([expect.objectContaining({
      email: 'ada@new.test', sourceUid: 'urn:ada', birthday: '1815-12-10',
      emails: [{ value: 'ada@new.test', type: 'home' }, { value: 'ada@work.test', type: 'work' }], addresses: [{ value: '1 Lane, London', type: 'home' }]
    })])
  })
})
