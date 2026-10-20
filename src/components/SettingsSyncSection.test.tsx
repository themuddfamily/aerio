// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsSyncSection from './SettingsSyncSection'
import type { SettingsSyncStatus } from '../settings-sync-types'
const base: SettingsSyncStatus = { configured: false, enabled: false, url: '', username: '', deviceName: 'Desktop', intervalMinutes: 15, phase: 'disabled' }
const api = { status: vi.fn(async () => base), configure: vi.fn(async () => ({ ...base, configured: true, enabled: true, phase: 'idle' as const })), sync: vi.fn(async () => base), resolve: vi.fn(async (_choice: string) => base), disconnect: vi.fn(async () => base) }
beforeEach(() => { vi.clearAllMocks(); api.status.mockResolvedValue(base); Object.defineProperty(window, 'aerio', { configurable: true, value: { settingsSync: api } }) })
describe('settings sync controls', () => {
  it('configures opt-in sync and clears secrets from the form after saving', async () => {
    render(<SettingsSyncSection beforeSync={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Sync device name')).toHaveValue('Desktop'))
    fireEvent.change(screen.getByLabelText('WebDAV file URL'), { target: { value: 'https://example.com/settings.json' } })
    fireEvent.change(screen.getByLabelText('WebDAV user name'), { target: { value: 'person' } })
    fireEvent.change(screen.getByLabelText('WebDAV app password'), { target: { value: 'app password' } })
    fireEvent.change(screen.getByLabelText('Sync encryption passphrase'), { target: { value: 'a shared sync passphrase' } })
    fireEvent.click(screen.getByLabelText('Enable scheduled settings synchronization'))
    fireEvent.click(screen.getByRole('button', { name: 'Save sync connection' }))
    await waitFor(() => expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, username: 'person', password: 'app password', passphrase: 'a shared sync passphrase' })))
    await waitFor(() => expect(screen.getByLabelText('WebDAV app password')).toHaveValue(''))
    expect(screen.getByLabelText('Sync encryption passphrase')).toHaveValue('')
  })
  it('shows version differences and requires an explicit choice after flushing current preferences', async () => {
    api.status.mockResolvedValueOnce({ ...base, enabled: true, configured: true, phase: 'review', review: { localDigest: 'one', remoteDigest: 'two', etag: '"2"', remoteDevice: 'Laptop', updatedAt: '2026-10-20T10:00:00Z', differences: ['Preference: theme', 'Template: Reply (shared only)'], local: { signatures: 1, templates: 0, snippets: 2 }, remote: { signatures: 2, templates: 1, snippets: 2 } } })
    const prepare = vi.fn(async () => {})
    render(<SettingsSyncSection beforeSync={prepare} />)
    await screen.findByText('Preference: theme')
    expect(screen.getByText(/Shared version: Laptop/)).toBeInTheDocument()
    expect(api.resolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use shared settings' }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith('remote'))
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(api.resolve.mock.invocationCallOrder[0])
  })
  it('disconnects only after confirming saved credentials will be forgotten', async () => {
    api.status.mockResolvedValueOnce({ ...base, enabled: true, configured: true })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<SettingsSyncSection beforeSync={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect settings sync' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect settings sync' })); expect(api.disconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect settings sync' })); await waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce())
    confirm.mockRestore()
  })
})
