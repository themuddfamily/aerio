// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPreferences, AppUpdateStatus } from '../types'
import SettingsModal from './SettingsModal'

const preferences: AppPreferences = {
  schemaVersion: 1,
  settings: { theme: 'system', density: 'comfortable', closeToTray: true, notifications: true, startModule: 'mail' }
}

const health = {
  generatedAt: '2026-08-08T10:00:00Z', integrity: 'ok' as const, integrityMessage: 'ok',
  accounts: [{ accountId: 'one', provider: 'gmail' as const, status: 'ready' as const, messages: 12, threads: 8, pendingDownloads: 0, failedDownloads: 0, queuedOperations: 0, failedOperations: 0, editableDrafts: 0, failedDrafts: 0 }],
  orphanedMessages: 0, orphanedAttachments: 0, missingRawFiles: 0
}

let emitStatus: ((status: AppUpdateStatus) => void) | undefined
const api = {
  updates: {
    status: vi.fn(async () => ({ phase: 'idle', currentVersion: '0.4.0', message: 'Ready' })),
    check: vi.fn(async () => ({ phase: 'current', currentVersion: '0.4.0' })),
    download: vi.fn(async () => ({ phase: 'ready', currentVersion: '0.4.0', availableVersion: '0.5.0' })),
    install: vi.fn(async () => undefined),
    onStatus: vi.fn((callback: (status: AppUpdateStatus) => void) => { emitStatus = callback; return vi.fn() })
  },
  productivity: {
    exportLocalData: vi.fn(async (): Promise<{ savedPath?: string }> => ({ savedPath: 'backup.json' })),
    importLocalData: vi.fn(async () => ({ tasks: [{ id: 'task' }], notes: [{ id: 'note' }], contacts: [{ id: 'contact' }] }))
  },
  mail: { diagnostics: { health: vi.fn(async () => health), export: vi.fn(async (): Promise<{ savedPath?: string }> => ({ savedPath: 'diagnostics.json' })) } }
}

beforeEach(() => {
  vi.clearAllMocks()
  emitStatus = undefined
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  api.updates.status.mockResolvedValue({ phase: 'idle', currentVersion: '0.4.0', message: 'Ready' })
  api.mail.diagnostics.health.mockResolvedValue(health)
  api.mail.diagnostics.export.mockResolvedValue({ savedPath: 'diagnostics.json' })
  api.productivity.exportLocalData.mockResolvedValue({ savedPath: 'backup.json' })
  api.productivity.importLocalData.mockResolvedValue({ tasks: [{ id: 'task' }], notes: [{ id: 'note' }], contacts: [{ id: 'contact' }] })
  window.confirm = vi.fn(() => true)
})

describe('SettingsModal', () => {
  it('exports and restores local Tasks, Notes, and Contacts', async () => {
    const user = userEvent.setup(), onRestored = vi.fn()
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} onLocalDataRestored={onRestored} />)
    await user.click(screen.getByRole('button', { name: 'Export backup' }))
    expect(await screen.findByText('Tasks, Notes, and Contacts backup exported.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore backup' }))
    expect(window.confirm).toHaveBeenCalled()
    expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ contacts: [expect.objectContaining({ id: 'contact' })] }))
    expect(await screen.findByText(/Restored 1 task, 1 note, and 1 contact/)).toBeInTheDocument()
  })

  it('edits appearance, startup, tray, and notification preferences', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SettingsModal preferences={preferences} onChange={onChange} onClose={vi.fn()} />)
    await screen.findByText(/Version 0.4.0/)
    await user.click(screen.getByRole('button', { name: 'dark' }))
    await user.click(screen.getByRole('button', { name: 'compact' }))
    await user.click(screen.getByLabelText(/Keep scheduling active/))
    await user.click(screen.getByLabelText(/Start Aerio when you sign in/))
    await user.click(screen.getByLabelText(/Desktop notifications/))
    await user.selectOptions(screen.getByRole('combobox'), 'notes')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ theme: 'dark' }) }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ density: 'compact' }) }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ closeToTray: false }) }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ launchAtLogin: true }) }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ notifications: false }) }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ startModule: 'notes' }) }))
  })

  it('checks, downloads, and installs application updates from live status events', async () => {
    const user = userEvent.setup()
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText(/Version 0.4.0/)
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(api.updates.check).toHaveBeenCalled()
    emitStatus?.({ phase: 'available', currentVersion: '0.4.0', availableVersion: '0.5.0', message: 'Available' })
    await user.click(await screen.findByRole('button', { name: 'Download update' }))
    expect(api.updates.download).toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Restart and install' }))
    expect(api.updates.install).toHaveBeenCalled()
  })

  it('shows healthy and unhealthy diagnostic summaries and exports a redacted report', async () => {
    const user = userEvent.setup()
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Check mail storage/ }))
    expect(await screen.findByText('Mail storage is healthy.')).toBeInTheDocument()
    expect(screen.getByText(/12 messages · 1 account/)).toBeInTheDocument()
    api.mail.diagnostics.health.mockResolvedValueOnce({ ...health, integrity: 'error', failedDownloads: 0, accounts: [{ ...health.accounts[0], failedDownloads: 1 }], orphanedMessages: 1 } as any)
    await user.click(screen.getByRole('button', { name: /Check mail storage/ }))
    expect(await screen.findByText('3 items need attention.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Export diagnostics/ }))
    expect(await screen.findByText(/Diagnostics exported/)).toBeInTheDocument()
  })

  it('surfaces update and diagnostic failures without rejecting UI actions', async () => {
    api.updates.status.mockRejectedValueOnce(new Error('updates offline'))
    api.mail.diagnostics.health.mockRejectedValueOnce(new Error('database busy'))
    api.mail.diagnostics.export.mockRejectedValueOnce(new Error('folder denied'))
    const user = userEvent.setup()
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText(/updates offline/)).toBeInTheDocument()
    api.updates.check.mockRejectedValueOnce(new Error('check failed'))
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText(/check failed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Check mail storage/ }))
    expect(await screen.findByText('database busy')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Export diagnostics/ }))
    expect(await screen.findByText('folder denied')).toBeInTheDocument()
  })

  it('disables update actions during unsupported, checking, and downloading phases', async () => {
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} />)
    await waitFor(() => expect(emitStatus).toBeDefined())
    for (const status of [
      { phase: 'unsupported', currentVersion: '0.4.0' },
      { phase: 'checking', currentVersion: '0.4.0' },
      { phase: 'downloading', currentVersion: '0.4.0', progress: 42 }
    ] as AppUpdateStatus[]) {
      emitStatus?.(status)
      await waitFor(() => expect(screen.getAllByRole('button').find((button) => /update|Checking|Downloading/.test(button.textContent ?? ''))).toBeDisabled())
    }
    expect(screen.getByRole('progressbar')).toHaveValue(42)
  })

  it('uses friendly fallbacks for non-Error update and diagnostic failures', async () => {
    api.updates.status.mockRejectedValueOnce('offline')
    api.mail.diagnostics.health.mockRejectedValueOnce('busy')
    api.mail.diagnostics.export.mockRejectedValueOnce('denied')
    const user = userEvent.setup()
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText(/Update status is unavailable/)).toBeInTheDocument()
    api.updates.check.mockRejectedValueOnce('failed')
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText(/The update action failed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Check mail storage/ }))
    expect(await screen.findByText('The health check failed.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Export diagnostics/ }))
    expect(await screen.findByText('Diagnostics could not be exported.')).toBeInTheDocument()
  })

  it('renders singular problems, plural accounts, and cancelled diagnostic exports', async () => {
    api.mail.diagnostics.health.mockResolvedValueOnce({
      ...health, integrity: 'ok', accounts: [health.accounts[0], { ...health.accounts[0], accountId: 'two', messages: 3 }], orphanedMessages: 1
    })
    api.mail.diagnostics.export.mockResolvedValueOnce({ savedPath: undefined })
    const user = userEvent.setup()
    render(<SettingsModal preferences={preferences} onChange={vi.fn()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Check mail storage/ }))
    expect(await screen.findByText('1 item need attention.')).toBeInTheDocument()
    expect(screen.getByText(/15 messages · 2 accounts/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Export diagnostics/ }))
    expect(screen.queryByText(/Diagnostics exported/)).not.toBeInTheDocument()
  })
})
