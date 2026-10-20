// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { MeetingHostApi } from '../meeting-host-types'
import MeetnRoomSettings from './MeetnRoomSettings'
it('saves a visible room selection and disconnects without suggesting room deletion', async () => {
  const api = { setMeetnRoom: vi.fn(async () => ({ accounts: [] })) } as unknown as MeetingHostApi, changed = vi.fn(), user = userEvent.setup()
  render(<ul><MeetnRoomSettings account={{ provider: 'meetn', configured: true, connected: true, room: 'team', joinUrl: 'https://meetn.com/team' }} api={api} changed={changed} /></ul>)
  expect(screen.getByText(/All events using this room share the same link/)).toBeInTheDocument()
  const field = screen.getByRole('textbox', { name: 'Meetn room name or link' }); await user.clear(field); await user.type(field, 'new-room')
  await user.click(screen.getByRole('button', { name: 'Save Meetn room' })); expect(api.setMeetnRoom).toHaveBeenCalledWith('new-room'); expect(changed).toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Disconnect Meetn room' })); expect(api.setMeetnRoom).toHaveBeenCalledWith('')
})
