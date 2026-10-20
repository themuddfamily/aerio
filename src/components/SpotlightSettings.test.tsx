// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import SpotlightSettings from './SpotlightSettings'
import type { SpotlightSettings as Settings, SpotlightStatus } from '../spotlight-types'
function setup(supported = true) {
  let state: SpotlightStatus = { platformSupported: supported, available: supported, settings: { enabled: false, accountIds: [], includePreview: false }, indexed: 0, limit: 10_000, syncing: false }
  const api = { status: vi.fn(async () => state), save: vi.fn(async (settings: Settings) => { state = { ...state, settings }; return state }), refresh: vi.fn(async () => state), onChanged: vi.fn(() => () => {}) }
  const accounts = vi.fn(async () => [{ id: 'one', email: 'one@example.test', displayName: 'One', archived: false }, { id: 'archived', email: 'archived@example.test', displayName: 'Old', archived: true }])
  Object.defineProperty(window, 'aerio', { configurable: true, value: { spotlight: api, mail: { accounts: { list: accounts } } } })
  render(<SpotlightSettings />); return { api, accounts, user: userEvent.setup() }
}
it('hides unsupported platforms and does not read accounts there', async () => {
  const f = setup(false); await waitFor(() => expect(f.api.status).toHaveBeenCalled()); expect(screen.queryByText('macOS Spotlight')).not.toBeInTheDocument(); expect(f.accounts).not.toHaveBeenCalled()
})
it('requires explicit account and indexing selection, keeps preview opt-in separate and explains OS exposure', async () => {
  const f = setup()
  await screen.findByText('Choose accounts to index')
  const selected = await screen.findByLabelText('One (one@example.test)')
  expect(selected).not.toBeChecked(); expect(screen.queryByLabelText('Old (archived@example.test)')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Index selected mail in Spotlight')).not.toBeChecked()
  expect(screen.getByLabelText('Include message previews in the system index')).not.toBeChecked()
  expect(screen.getByText(/outside Aerio/)).toBeInTheDocument()
  await f.user.click(selected); expect(f.api.save).toHaveBeenLastCalledWith({ enabled: false, accountIds: ['one'], includePreview: false })
  await f.user.click(screen.getByLabelText('Index selected mail in Spotlight')); expect(f.api.save).toHaveBeenLastCalledWith({ enabled: true, accountIds: ['one'], includePreview: false })
  await f.user.click(screen.getByLabelText('Include message previews in the system index')); expect(f.api.save).toHaveBeenLastCalledWith({ enabled: true, accountIds: ['one'], includePreview: true })
})
