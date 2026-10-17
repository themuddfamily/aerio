// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileBackupPreview, ProfileBackupStatus } from '../profile-backup-types'
import ProfileBackupSection from './ProfileBackupSection'

const backup = { path: 'C:\\Backups\\aerio-profile-2026-10-01', createdAt: '2026-10-01T10:00:00.000Z', trigger: 'scheduled' as const, appVersion: '0.6.0', totalBytes: 5 * 1024 * 1024, fileCount: 42 }
const baseStatus = (): ProfileBackupStatus => ({ schedule: { enabled: false, intervalHours: 24, keep: 7, directory: 'C:\\Backups' }, running: false, backups: [backup] })
const preview: ProfileBackupPreview = {
  ...backup, schemaVersion: 1, heldSends: 2, heldTaskWrites: 0, accountsToReauthorize: 1, differentProfile: false,
  counts: [{ label: 'Cached messages', count: 1200 }, { label: 'Outgoing or scheduled sends', count: 2 }, { label: 'Mail rules', count: 0 }],
  warnings: ['2 outgoing or scheduled messages will be held for review instead of sending.']
}

const api = {
  status: vi.fn(async () => baseStatus()),
  saveSchedule: vi.fn(async (schedule: ProfileBackupStatus['schedule']) => ({ ...baseStatus(), schedule })),
  chooseDirectory: vi.fn(async (): Promise<string | undefined> => 'D:\\Elsewhere'),
  backupNow: vi.fn(async () => backup),
  preview: vi.fn(async (): Promise<ProfileBackupPreview | undefined> => preview),
  restore: vi.fn(async () => ({ restarting: true as const })),
  dismissRestoreOutcome: vi.fn(async () => undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { profileBackup: api } })
})

describe('ProfileBackupSection', () => {
  it('saves the schedule, retention, and folder', async () => {
    const user = userEvent.setup()
    render(<ProfileBackupSection />)
    const toggle = await screen.findByRole('checkbox', { name: /Back up automatically/ })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(api.saveSchedule).toHaveBeenLastCalledWith({ enabled: true, intervalHours: 24, keep: 7, directory: 'C:\\Backups' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Frequency' }), '168')
    expect(api.saveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ intervalHours: 168 }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Backups to keep' }), '14')
    expect(api.saveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ keep: 14 }))
    await user.click(screen.getByRole('button', { name: /Change folder/ }))
    await waitFor(() => expect(api.saveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ directory: 'D:\\Elsewhere' })))
  })

  it('backs up now and reports failures', async () => {
    const user = userEvent.setup()
    render(<ProfileBackupSection />)
    await user.click(await screen.findByRole('button', { name: /Back up now/ }))
    expect(await screen.findByText('Profile backup created (42 files, 5.0 MB).')).toBeInTheDocument()
    api.backupNow.mockRejectedValueOnce(new Error('The backup folder is full'))
    await user.click(screen.getByRole('button', { name: /Back up now/ }))
    expect(await screen.findByText('The backup folder is full')).toBeInTheDocument()
  })

  it('previews a listed backup before restoring and restarting', async () => {
    const user = userEvent.setup()
    render(<ProfileBackupSection />)
    const list = await screen.findByRole('list', { name: 'Profile backups' })
    await user.click(within(list).getByRole('button', { name: 'Preview restore' }))
    expect(api.preview).toHaveBeenCalledWith(backup.path)
    const region = await screen.findByRole('region', { name: 'Restore preview' })
    expect(within(region).getByText('Cached messages: 1,200')).toBeInTheDocument()
    expect(within(region).queryByText(/Mail rules/)).not.toBeInTheDocument()
    expect(within(region).getByText(/will be held for review/)).toBeInTheDocument()
    expect(api.restore).not.toHaveBeenCalled()
    await user.click(within(region).getByRole('button', { name: 'Restore and restart' }))
    expect(api.restore).toHaveBeenCalledWith(backup.path)
    expect(await screen.findByText(/Aerio is restarting/)).toBeInTheDocument()
  })

  it('shows verification errors and cancels a preview without restoring', async () => {
    const user = userEvent.setup()
    render(<ProfileBackupSection />)
    api.preview.mockRejectedValueOnce(new Error('This profile backup is corrupted: mail/a.eml does not match its checksum'))
    await user.click(await screen.findByRole('button', { name: /Restore from folder/ }))
    expect(api.preview).toHaveBeenCalledWith(undefined)
    expect(await screen.findByText(/does not match its checksum/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Restore from folder/ }))
    await user.click(within(await screen.findByRole('region', { name: 'Restore preview' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('region', { name: 'Restore preview' })).not.toBeInTheDocument()
    expect(api.restore).not.toHaveBeenCalled()
  })

  it('reports the last restore outcome with held sends and reauthorization', async () => {
    const user = userEvent.setup()
    api.status.mockResolvedValueOnce({ ...baseStatus(), lastRestore: { status: 'applied', backupCreatedAt: backup.createdAt, completedAt: backup.createdAt, report: { heldSends: 1, heldTaskWrites: 2, accountsToReauthorize: 1, rebasedPaths: false } } })
    render(<ProfileBackupSection />)
    const outcome = await screen.findByRole('status')
    expect(outcome).toHaveTextContent('1 outgoing message is held in Drafts for review.')
    expect(outcome).toHaveTextContent('2 connected task changes are waiting for review.')
    expect(outcome).toHaveTextContent('need to be reconnected')
    await user.click(within(outcome).getByRole('button', { name: 'Dismiss' }))
    expect(api.dismissRestoreOutcome).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })
})
