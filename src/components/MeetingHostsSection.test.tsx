// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingHostAccount, MeetingHostSnapshot } from '../meeting-host-types'
import MeetingHostsSection from './MeetingHostsSection'

const zoom = (extra: Partial<MeetingHostAccount> = {}): MeetingHostAccount => ({
  provider: 'zoom', configured: true, configSource: 'built-in', clientIdHint: 'zoom…1234', redirectUri: 'http://localhost:47817/oauth/zoom',
  scopes: ['meeting:write:meeting', 'user:read:user'], connected: false, ...extra
})
const webex = (extra: Partial<MeetingHostAccount> = {}): MeetingHostAccount => ({
  provider: 'webex', configured: false, redirectUri: 'http://localhost:47818/oauth/webex', scopes: ['meeting:schedules_write', 'meeting:schedules_read'], connected: false, ...extra
})
const snapshot = (...accounts: MeetingHostAccount[]): MeetingHostSnapshot => ({ accounts })

const listeners: ((value: MeetingHostSnapshot) => void)[] = []
const api = {
  status: vi.fn(async () => snapshot(zoom(), webex())),
  configure: vi.fn(async () => snapshot(zoom(), webex({ configured: true, configSource: 'user', clientIdHint: 'webe…t123' }))),
  connect: vi.fn(async () => snapshot(zoom({ connected: true, email: 'host@example.test' }), webex())),
  disconnect: vi.fn(async () => snapshot(zoom(), webex())),
  meetingOptions: vi.fn(),
  setCancelOnDelete: vi.fn(),
  onChanged: vi.fn((callback: (value: MeetingHostSnapshot) => void) => { listeners.push(callback); return () => undefined })
}

beforeEach(() => {
  vi.clearAllMocks()
  listeners.length = 0
  Object.defineProperty(window, 'aerio', { configurable: true, value: { meetingHosts: api } })
})

describe('MeetingHostsSection', () => {
  it('renders nothing without the bridge', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: {} })
    const { container } = render(<MeetingHostsSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it('connects and disconnects Zoom', async () => {
    const user = userEvent.setup()
    render(<MeetingHostsSection />)
    const list = await screen.findByRole('list', { name: 'Online meeting accounts' })
    expect(await within(list).findByText(/Not connected · sign in to add Zoom meetings/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect Zoom' }))
    expect(api.connect).toHaveBeenCalledWith('zoom')
    expect(await screen.findByText(/Connected as host@example.test/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Disconnect Zoom' }))
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(api.disconnect).toHaveBeenCalledWith('zoom')
    expect(await screen.findByRole('status')).toHaveTextContent('Zoom disconnected. Existing meetings were not cancelled.')
  })

  it('saves a Webex app registration and shows the redirect URL and scopes it needs', async () => {
    const user = userEvent.setup()
    render(<MeetingHostsSection />)
    const group = await screen.findByRole('group', { name: 'Webex app registration' })
    expect(group).toHaveTextContent('http://localhost:47818/oauth/webex')
    expect(group).toHaveTextContent('meeting:schedules_write, meeting:schedules_read')
    const save = within(group).getByRole('button', { name: 'Save registration' })
    expect(save).toBeDisabled()
    await user.type(within(group).getByLabelText('Client ID'), 'webexClientId123')
    await user.type(within(group).getByLabelText('Client secret'), 'webexClientSecret456')
    await user.click(save)
    expect(api.configure).toHaveBeenCalledWith('webex', 'webexClientId123', 'webexClientSecret456')
    expect(await screen.findByRole('button', { name: 'Connect Webex' })).toBeInTheDocument()
    // A built-in registration cannot be replaced from Settings.
    expect(screen.queryByRole('group', { name: 'Zoom app registration' })).not.toBeInTheDocument()
  })

  it('asks to reconnect after the provider revoked access and shows why', async () => {
    const user = userEvent.setup()
    render(<MeetingHostsSection />)
    await screen.findByRole('button', { name: 'Connect Zoom' })
    act(() => listeners[0](snapshot(zoom({ connected: true, email: 'host@example.test', needsReconnect: true, error: 'Zoom refused Aerio’s access: Invalid Token!' }), webex())))
    expect(screen.getByText(/Access revoked or expired/)).toBeInTheDocument()
    expect(screen.getByText('Zoom refused Aerio’s access: Invalid Token!')).toBeInTheDocument()
    api.connect.mockRejectedValueOnce(new Error("Error invoking remote method 'meeting-hosts:connect': Error: Zoom sign-in failed: access_denied"))
    await user.click(screen.getByRole('button', { name: 'Reconnect Zoom' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Zoom sign-in failed: access_denied')
  })
})
