// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvailabilityRequest, AvailabilityResult } from '../scheduling-types'
import { msToLocalInput } from '../lib/scheduling'
import SchedulingAssistant, { SchedulingAssistantButton } from './SchedulingAssistant'

const at = (iso: string) => Date.parse(iso)
const result = (overrides: Partial<AvailabilityResult> = {}): AvailabilityResult => ({
  calendarId: 'g:cal', accountId: 'g', provider: 'gmail', needsReconnect: false, missingScopes: [], fetchedAt: '2026-10-19T12:00:00Z',
  attendees: [
    { email: 'me@company.com', known: true, busy: [{ start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z', status: 'busy' }] },
    { email: 'ann@company.com', known: true, busy: [{ start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:00:00Z', status: 'busy' }] },
    { email: 'partner@other.org', known: false, reason: 'external', message: 'Availability isn’t shared outside this person’s organization', busy: [] }
  ],
  ...overrides
})

const api = {
  availability: vi.fn(async (_request: AvailabilityRequest) => result()),
  reconnect: vi.fn(async () => undefined)
}

const props = () => ({
  calendarId: 'g:cal',
  organizerEmail: 'me@company.com',
  start: msToLocalInput(at('2026-10-20T09:00:00Z')),
  end: msToLocalInput(at('2026-10-20T10:00:00Z')),
  attendees: 'ann@company.com, partner@other.org',
  api,
  timeZone: 'UTC',
  now: () => at('2026-10-19T12:00:00Z'),
  onApply: vi.fn(),
  onClose: vi.fn()
})

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) }
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.clear()
  vi.stubGlobal('localStorage', localStorageStub)
  Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageStub })
  api.availability.mockImplementation(async () => result())
})

describe('SchedulingAssistant', () => {
  it('looks up the organizer and attendees and marks unknown availability distinctly from free time', async () => {
    render(<SchedulingAssistant {...props()} />)
    await waitFor(() => expect(api.availability).toHaveBeenCalled())
    expect(api.availability).toHaveBeenCalledWith({
      calendarId: 'g:cal', attendees: ['me@company.com', 'ann@company.com', 'partner@other.org'],
      start: '2026-10-20T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z'
    })
    const partner = await screen.findByTestId('availability-partner@other.org')
    expect(within(partner).getByText(/isn’t shared outside/)).toBeInTheDocument()
    expect(partner.querySelectorAll('td.status-unknown')).toHaveLength(48)
    const me = screen.getByTestId('availability-me@company.com')
    expect(me.querySelectorAll('td.status-busy')).toHaveLength(2)
    expect(me.querySelectorAll('td.status-unknown')).toHaveLength(0)
    expect(screen.getByText(/Not checked for partner@other.org/)).toBeInTheDocument()
  })

  it('suggests a slot where required attendees are free and applies it with the attendee list', async () => {
    const user = userEvent.setup()
    const input = props()
    render(<SchedulingAssistant {...input} />)
    const suggestion = await screen.findByRole('button', { name: /Tue 20 Oct, 11:00–12:00/ })
    await user.click(suggestion)
    await user.click(screen.getByRole('button', { name: /Use this time/ }))
    expect(input.onApply).toHaveBeenCalledWith({
      start: msToLocalInput(at('2026-10-20T11:00:00Z')),
      end: msToLocalInput(at('2026-10-20T12:00:00Z')),
      attendees: ['ann@company.com', 'partner@other.org']
    })
  })

  it('treats optional attendees as non-blocking and refetches when someone is added', async () => {
    const user = userEvent.setup()
    render(<SchedulingAssistant {...props()} />)
    await screen.findByTestId('availability-ann@company.com')
    await user.selectOptions(screen.getByLabelText('Role for ann@company.com'), 'optional')
    // With Ann optional, 10:00 is free for every required attendee.
    expect(await screen.findByRole('button', { name: /Tue 20 Oct, 10:00–11:00.*1 optional unavailable/ })).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Add attendee or resource/), 'room@company.com')
    await user.selectOptions(screen.getByLabelText('As'), 'resource')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(api.availability).toHaveBeenLastCalledWith(expect.objectContaining({
      attendees: ['me@company.com', 'ann@company.com', 'partner@other.org', 'room@company.com']
    })))
    expect(screen.getByLabelText('Role for room@company.com')).toHaveValue('resource')
  })

  it('offers a reconnect when the account lacks the free/busy permission', async () => {
    const user = userEvent.setup()
    api.availability.mockResolvedValueOnce(result({
      needsReconnect: true, missingScopes: ['https://www.googleapis.com/auth/calendar.freebusy'], message: 'Aerio needs the calendar.freebusy permission.',
      attendees: [{ email: 'me@company.com', known: false, reason: 'permission', busy: [] }]
    }))
    render(<SchedulingAssistant {...props()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('calendar.freebusy')
    await user.click(screen.getByRole('button', { name: 'Reconnect account' }))
    expect(api.reconnect).toHaveBeenCalledWith('g')
    await waitFor(() => expect(api.availability).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconnect account' })).not.toBeInTheDocument())
  })

  it('shows provider failures and a rejected lookup', async () => {
    api.availability.mockResolvedValueOnce(result({ message: 'Microsoft couldn’t return availability: Server busy', attendees: [] }))
    const { unmount } = render(<SchedulingAssistant {...props()} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Server busy')
    unmount()
    api.availability.mockRejectedValueOnce(new Error('Choose up to 100 attendees'))
    render(<SchedulingAssistant {...props()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose up to 100 attendees')
  })

  it('adds a secondary time zone row and remembers it', async () => {
    const user = userEvent.setup()
    render(<SchedulingAssistant {...props()} />)
    await screen.findByTestId('availability-me@company.com')
    await user.selectOptions(screen.getByLabelText('Second time zone'), 'Asia/Tokyo')
    expect(screen.getAllByText('09:00').length).toBeGreaterThan(1)
    expect(storage.get('aerio:scheduling-secondary-zone:v1')).toBe('Asia/Tokyo')
  })

  it('opens from the editor button', async () => {
    const user = userEvent.setup()
    const { onClose: _onClose, ...rest } = props()
    render(<SchedulingAssistantButton {...rest} />)
    await user.click(screen.getByRole('button', { name: /Scheduling assistant/ }))
    expect(await screen.findByRole('table', { name: 'Attendee availability' })).toBeInTheDocument()
  })
})
