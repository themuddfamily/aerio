// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AppProfileSwitcher from './AppProfileSwitcher'
const snapshot = { currentId: 'default', profiles: [{ id: 'default', name: 'Personal', createdAt: '2026-10-20T00:00:00Z' }, { id: 'work', name: 'Work', createdAt: '2026-10-20T00:00:00Z' }] }
const api = { list: vi.fn(async () => snapshot), create: vi.fn(async (_name: string) => snapshot), rename: vi.fn(async (_id: string, _name: string) => snapshot), switch: vi.fn(async (_id: string) => {}) }
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(window, 'aerio', { configurable: true, value: { appProfiles: api } }) })
describe('application profile switcher', () => {
  it('loads profiles, creates empty profiles and renames without changing identity', async () => {
    render(<AppProfileSwitcher onPrepareSwitch={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch application profile' }))
    await screen.findByText('Personal')
    expect(screen.getByRole('button', { name: 'Switch to Personal' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('New profile name'), { target: { value: 'Family' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create separate profile' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('Family'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename Work' }))
    fireEvent.change(screen.getByLabelText('Rename profile'), { target: { value: 'Office' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile name' }))
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('work', 'Office'))
    expect(api.switch).not.toHaveBeenCalled()
  })
  it('flushes the current workspace before restarting and shows preparation failures', async () => {
    const prepare = vi.fn(async () => { throw new Error('Local data could not be saved') })
    render(<AppProfileSwitcher onPrepareSwitch={prepare} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch application profile' }))
    await screen.findByText('Work')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Work' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Local data could not be saved')
    expect(api.switch).not.toHaveBeenCalled()
    prepare.mockResolvedValueOnce(undefined as never)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Work' }))
    await waitFor(() => expect(api.switch).toHaveBeenCalledWith('work'))
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})
