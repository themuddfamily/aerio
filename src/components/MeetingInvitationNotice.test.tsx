// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvitationRespondInput, MeetingInvitation } from '../invitation-types'
import MeetingInvitationNotice, { invitationHeadline } from './MeetingInvitationNotice'

const invitations = {
  inspect: vi.fn<(accountId: string, messageId: string) => Promise<MeetingInvitation | undefined>>(),
  respond: vi.fn<(input: InvitationRespondInput) => Promise<MeetingInvitation>>(),
  applyCancellation: vi.fn<(accountId: string, messageId: string) => Promise<MeetingInvitation>>()
}

const invitation = (overrides: Partial<MeetingInvitation> = {}): MeetingInvitation => ({
  accountId: 'account', messageId: 'message', method: 'REQUEST', status: 'new', uid: 'u1', sequence: 1, title: 'Design review',
  start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z', allDay: false, location: 'Room 4',
  organizer: { email: 'ada@example.test', name: 'Ada' },
  attendees: [
    { email: 'ada@example.test', role: 'chair', response: 'accepted' },
    { email: 'me@example.test', response: 'needs-action' },
    { email: 'room@example.test', kind: 'room', role: 'non-participant' }
  ],
  self: { email: 'me@example.test' }, organizerIsSelf: false, channel: 'mail', canRespond: true, canProposeTime: true, warnings: [],
  ...overrides
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { productivity: { invitations } } })
})

describe('MeetingInvitationNotice', () => {
  it('summarizes the meeting and sends a response with a comment', async () => {
    const user = userEvent.setup()
    invitations.inspect.mockResolvedValue(invitation())
    invitations.respond.mockResolvedValue(invitation({ status: 'current', response: 'accepted', respondedAt: '2026-09-04T10:00:00.000Z' }))
    render(<MeetingInvitationNotice accountId="account" messageId="message" />)
    expect(await screen.findByText('Invitation: Design review')).toBeInTheDocument()
    expect(screen.getByText(/Organizer: Ada/)).toHaveTextContent('2 guests (1 accepted) · 1 room or resource')
    expect(screen.getByText(/sent by email to the organizer/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show guests' }))
    expect(screen.getByText('Room · Awaiting reply')).toBeInTheDocument()
    expect(screen.getByText('Chair · Accepted')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add a comment' }))
    await user.type(screen.getByLabelText('Comment to the organizer'), 'See you there')
    await user.click(within(screen.getByRole('group', { name: 'Respond to invitation' })).getByRole('button', { name: 'Accept' }))
    expect(invitations.respond).toHaveBeenCalledWith({ accountId: 'account', messageId: 'message', response: 'accepted', comment: 'See you there' })
    expect(await screen.findByText(/You responded: Accepted/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('proposes a new time and shows provider errors', async () => {
    const user = userEvent.setup()
    invitations.inspect.mockResolvedValue(invitation({ channel: 'microsoft', proposeTimeNote: 'Microsoft sends a proposed time with a Tentative or Decline response.' }))
    invitations.respond.mockRejectedValueOnce(new Error("Error invoking remote method 'invitations:respond': Error: The organizer does not allow new time proposals"))
    render(<MeetingInvitationNotice accountId="account" messageId="message" />)
    await user.click(await screen.findByRole('button', { name: 'Propose new time' }))
    expect((screen.getByLabelText('Proposed start') as HTMLInputElement).value).toMatch(/^2026-10-05T\d{2}:00$/)
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Tentative' }))
    expect(invitations.respond).toHaveBeenCalledWith(expect.objectContaining({ response: 'tentative', proposed: { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z' } }))
    expect(await screen.findByText('The organizer does not allow new time proposals')).toBeInTheDocument()
  })

  it('explains stale and duplicate messages and hides actions that do not apply', async () => {
    invitations.inspect.mockResolvedValue(invitation({ status: 'stale', canRespond: false, canProposeTime: false, explanation: 'This invitation is out of date: a newer version was already received.' }))
    const { unmount } = render(<MeetingInvitationNotice accountId="account" messageId="message" />)
    expect(await screen.findByText(/out of date/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    unmount()
    invitations.inspect.mockResolvedValue(invitation({ channel: 'google', canProposeTime: false, proposeTimeNote: 'Google Calendar’s API cannot propose a new time.' }))
    render(<MeetingInvitationNotice accountId="account" messageId="other" />)
    expect(await screen.findByText(/cannot propose a new time/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Propose new time' })).not.toBeInTheDocument()
    expect(screen.getByText(/through Google Calendar/)).toBeInTheDocument()
  })

  it('removes a cancelled meeting from the Invitations calendar', async () => {
    const user = userEvent.setup()
    invitations.inspect.mockResolvedValue(invitation({ method: 'CANCEL', status: 'cancelled', canRespond: false, localCopyId: 'invitation-1', channel: 'none' }))
    invitations.applyCancellation.mockResolvedValue(invitation({ method: 'CANCEL', status: 'cancelled', canRespond: false, channel: 'none' }))
    render(<MeetingInvitationNotice accountId="account" messageId="message" />)
    expect(await screen.findByText('Cancelled: Design review')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove from calendar' }))
    expect(invitations.applyCancellation).toHaveBeenCalledWith('account', 'message')
    expect(screen.queryByRole('button', { name: 'Remove from calendar' })).not.toBeInTheDocument()
  })

  it('renders nothing for messages without an invitation and words replies and counters', async () => {
    invitations.inspect.mockResolvedValue(undefined)
    const { container } = render(<MeetingInvitationNotice accountId="account" messageId="message" />)
    await vi.waitFor(() => expect(invitations.inspect).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(invitationHeadline(invitation({ method: 'REPLY', status: 'reply', replyFrom: { email: 'g@example.test', name: 'Grace', response: 'tentative' } }))).toBe('Grace tentatively accepted “Design review”')
    expect(invitationHeadline(invitation({ method: 'COUNTER', status: 'counter', replyFrom: { email: 'g@example.test' } }))).toBe('g@example.test proposed a new time for “Design review”')
    expect(invitationHeadline(invitation({ status: 'update' }))).toBe('Updated invitation: Design review')
  })
})
