// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import IceWarpMeetingSettings from './IceWarpMeetingSettings'
import type { MeetingHostApi } from '../meeting-host-types'
it('discloses provisional provisioning and saves explicit server/token then clears the token', async () => {
  const connectIceWarp = vi.fn().mockResolvedValue({ accounts: [] }), changed = vi.fn()
  render(<IceWarpMeetingSettings account={{ provider: 'icewarp', configured: true, connected: false, secureStorage: true }} api={{ connectIceWarp } as unknown as MeetingHostApi} changed={changed} />)
  expect(screen.getByText(/It does not join, record or invite conference participants/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('IceWarp meetings server HTTPS URL'), { target: { value: 'https://icewarp.example.test' } })
  fireEvent.change(screen.getByLabelText('IceWarp conference API token'), { target: { value: 'private-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect IceWarp meetings' }))
  await waitFor(() => expect(connectIceWarp).toHaveBeenCalledWith({ server: 'https://icewarp.example.test', token: 'private-token' }))
  await waitFor(() => expect(screen.getByLabelText('IceWarp conference API token')).toHaveValue(''))
  expect(changed).toHaveBeenCalledWith({ accounts: [] })
})
it('disconnects explicitly while retaining existing meetings and disables insecure credential entry', async () => {
  const disconnectIceWarp = vi.fn().mockResolvedValue({ accounts: [] })
  const view = render(<IceWarpMeetingSettings account={{ provider: 'icewarp', configured: true, connected: true, secureStorage: true, email: 'me@example.test' }} api={{ disconnectIceWarp } as unknown as MeetingHostApi} changed={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect IceWarp meetings' }))
  await waitFor(() => expect(disconnectIceWarp).toHaveBeenCalled())
  view.unmount()
  render(<IceWarpMeetingSettings account={{ provider: 'icewarp', configured: true, connected: false, secureStorage: false }} api={{} as MeetingHostApi} changed={vi.fn()} />)
  expect(screen.getByLabelText('IceWarp conference API token')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Connect IceWarp meetings' })).toBeDisabled()
})
