// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventConferenceField } from './EventConferenceField'
import { conferenceCapabilities } from '../lib/online-meetings'

const googleCapabilities = conferenceCapabilities({ provider: 'gmail', canWrite: true, conferences: { allowed: ['hangoutsMeet'], creatable: ['googleMeet'], canRemove: true } })
const meet = { provider: 'googleMeet' as const, status: 'ready' as const, joinUrl: 'https://meet.google.com/abc-defg-hij', phone: '+1 555-0100', pin: '123' }

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as { aerio?: unknown }).aerio
})

describe('EventConferenceField', () => {
  it('requests a provider meeting with a stable request id', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EventConferenceField capabilities={googleCapabilities} canRemove onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Add Google Meet' }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'googleMeet', status: 'pending', requestId: expect.stringMatching(/^[0-9a-f]{32}$/) })
  })

  it('explains why a meeting cannot be added', () => {
    render(<EventConferenceField capabilities={conferenceCapabilities({ provider: 'microsoft', canWrite: true, conferences: { allowed: ['skypeForConsumer'], creatable: [], canRemove: false } })} canRemove={false} onChange={vi.fn()} />)
    expect(screen.getByText(/Personal Microsoft accounts offer only Skype/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows a pending request that can be withdrawn before saving', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EventConferenceField value={{ provider: 'googleMeet', status: 'pending', requestId: 'abcdef0123456789' }} capabilities={googleCapabilities} canRemove onChange={onChange} />)
    expect(screen.getByText('A Google Meet link is created when you save.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Don’t add/ }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('joins trusted meeting hosts directly through the external-link handler', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<EventConferenceField value={meet} original={meet} capabilities={googleCapabilities} canRemove onChange={vi.fn()} />)
    expect(screen.getByText('meet.google.com')).toBeInTheDocument()
    expect(screen.getByText('Dial-in +1 555-0100 · PIN 123')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(open).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij', '_blank', 'noopener')
  })

  it('asks before opening links on other hosts and refuses insecure links', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const addOn = { provider: 'other' as const, status: 'ready' as const, joinUrl: 'https://meet.example.org/room' }
    const { rerender } = render(<EventConferenceField value={addOn} original={addOn} capabilities={googleCapabilities} canRemove={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('meet.example.org')
    await user.click(screen.getByRole('button', { name: 'Open anyway' }))
    expect(open).toHaveBeenCalledWith('https://meet.example.org/room', '_blank', 'noopener')
    const insecure = { ...addOn, joinUrl: 'http://example.com/meet' }
    rerender(<EventConferenceField value={insecure} original={insecure} capabilities={googleCapabilities} canRemove={false} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
  })

  it('removes only where the provider allows it, with undo', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<EventConferenceField value={meet} original={meet} capabilities={googleCapabilities} canRemove onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /Remove/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...meet, status: 'removed' })
    rerender(<EventConferenceField value={{ ...meet, status: 'removed' }} original={meet} capabilities={googleCapabilities} canRemove onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /Undo/ }))
    expect(onChange).toHaveBeenLastCalledWith(meet)
    const teams = { provider: 'teams' as const, status: 'ready' as const, joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' }
    rerender(<EventConferenceField value={teams} original={teams} capabilities={[]} canRemove={false} onChange={onChange} />)
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
    rerender(<EventConferenceField value={teams} original={teams} capabilities={[]} canRemove disabled onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
  })

  it('lets a Zoom meeting created by Aerio be kept or cancelled when its event is deleted', async () => {
    const user = userEvent.setup()
    const meetingHosts = {
      meetingOptions: vi.fn(async () => ({ provider: 'zoom', cancelOnDelete: true, meetingId: '1' })),
      setCancelOnDelete: vi.fn(async (_id: string, cancel: boolean) => ({ provider: 'zoom', cancelOnDelete: cancel, meetingId: '1' }))
    }
    ;(window as { aerio?: unknown }).aerio = { meetingHosts }
    const zoom = { provider: 'zoom' as const, status: 'ready' as const, requestId: '0123456789abcdef0123456789abcdef', joinUrl: 'https://us02web.zoom.us/j/1', phone: '+1 646 558 8656', pin: '123456' }
    const onChange = vi.fn()
    render(<EventConferenceField value={zoom} original={zoom} capabilities={googleCapabilities} canRemove onChange={onChange} />)
    const option = await screen.findByRole('checkbox', { name: 'Cancel the Zoom meeting if this event is deleted' })
    expect(option).toBeChecked()
    await user.click(option)
    expect(meetingHosts.setCancelOnDelete).toHaveBeenCalledWith(zoom.requestId, false)
    expect(option).not.toBeChecked()
    // zoom.us is a known meeting host: Join opens without a prompt.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await user.click(screen.getByRole('button', { name: 'Join' }))
    expect(open).toHaveBeenCalledWith('https://us02web.zoom.us/j/1', '_blank', 'noopener')
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onChange).toHaveBeenCalledWith({ ...zoom, status: 'removed' })
  })

  it('explains that a shared Meetn room remains available when an event is deleted', async () => {
    ;(window as { aerio?: unknown }).aerio = { meetingHosts: { meetingOptions: vi.fn(async () => ({ provider: 'meetn', cancelOnDelete: true, meetingId: 'team' })) } }
    const meeting = { provider: 'meetn' as const, status: 'ready' as const, requestId: '0123456789abcdef', joinUrl: 'https://meetn.com/team' }
    render(<EventConferenceField value={meeting} original={meeting} capabilities={googleCapabilities} canRemove onChange={vi.fn()} />)
    expect(await screen.findByText(/your shared Meetn room remains available/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Cancel.*Meetn/ })).not.toBeInTheDocument()
  })

  it('offers a connected Zoom account next to the calendar’s own meetings', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const capabilities = conferenceCapabilities({ provider: 'gmail', canWrite: true, conferences: { allowed: ['hangoutsMeet'], creatable: ['googleMeet'], canRemove: true } },
      [{ provider: 'zoom', configured: true, connected: true, redirectUri: '', scopes: [] }])
    render(<EventConferenceField capabilities={capabilities} canRemove onChange={onChange} />)
    expect(screen.queryByRole('button', { name: 'Add Webex' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add Zoom' }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'zoom', status: 'pending', requestId: expect.stringMatching(/^[0-9a-f]{32}$/) })
  })
})
