// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import type { MailArchiveJob, MailArchiveStatus } from '../mail-archive-types'
import { defaultMailArchivePolicy } from '../lib/mail-archive'
import { LOCAL_FOLDERS_ACCOUNT_ID } from '../lib/local-folders'
import MailArchivingSection from './MailArchivingSection'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'acct', provider: 'gmail', email: 'person@gmail.com', displayName: 'Person', color: '#1d7a62', status: 'ready',
  archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})
const job = (overrides: Partial<MailArchiveJob> = {}): MailArchiveJob => ({
  id: 'job-1', accountId: 'acct', trigger: 'schedule', status: 'completed', cutoff: '2025-10-17T00:00:00Z', removal: 'trash',
  total: 3, pending: 0, copied: 0, removalQueued: 0, done: 2, failed: 1, skipped: 0, bytes: 2048,
  createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:05:00Z', ...overrides
})
const labels: Record<string, MailLabel[]> = {
  acct: [
    { accountId: 'acct', id: 'INBOX', name: 'INBOX', type: 'system' },
    { accountId: 'acct', id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { accountId: 'acct', id: 'Label_1', name: 'Projects', type: 'user' }
  ],
  [LOCAL_FOLDERS_ACCOUNT_ID]: [{ accountId: LOCAL_FOLDERS_ACCOUNT_ID, id: 'folder:local-archive', name: 'Archive', type: 'user' }]
}
const savedPolicy = { ...defaultMailArchivePolicy('acct'), enabled: true, destinationLabelId: 'folder:local-archive', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastRunAt: '2026-10-17T10:00:00Z', lastRunStatus: 'completed' as const, nextRunAt: '2026-10-24T10:00:00Z' }
const status = (overrides: Partial<MailArchiveStatus> = {}): MailArchiveStatus => ({ accountId: 'acct', policy: savedPolicy, jobs: [job()], deleteUnavailable: 'Gmail permanent deletion needs full mailbox access.', ...overrides })

const archiving = { get: vi.fn(), save: vi.fn(), preview: vi.fn(), runNow: vi.fn(), resume: vi.fn(), cancel: vi.fn(), items: vi.fn() }
const api = {
  mail: {
    archiving,
    mail: { labels: vi.fn(async (ids: string[]) => labels[ids[0]] ?? []) },
    folders: { create: vi.fn() },
    imports: { ensureLocalFolders: vi.fn(async () => undefined) },
    onEvent: vi.fn(() => () => undefined)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  archiving.get.mockResolvedValue(status())
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('MailArchivingSection', () => {
  it('loads the saved policy, explains local-only storage, and shows schedule and history', async () => {
    render(<MailArchivingSection account={account()} onToast={vi.fn()} />)
    expect(await screen.findByText(/Next run/)).toBeInTheDocument()
    expect(screen.getByText(/only on this computer/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Archive automatically/ })).toBeChecked()
    expect(screen.getByLabelText('Local Folders destination')).toHaveValue('folder:local-archive')
    expect(screen.getByText(/2 of 3 archived · 1 failed/)).toBeInTheDocument()
    // Gmail cannot delete permanently with Aerio's grant.
    expect(screen.getByRole('option', { name: /Delete the server copy permanently/ })).toBeDisabled()
    expect(screen.getByText(/Gmail permanent deletion/)).toBeInTheDocument()
  })

  it('previews and saves the edited policy with scope and exclusions', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    archiving.preview.mockResolvedValue({
      accountId: 'acct', cutoff: '2026-04-17T00:00:00Z', count: 120, bytes: 5 * 1024 * 1024,
      sample: [{ messageId: 'm1', threadId: 't1', subject: 'Old invoice', from: 'Billing', receivedAt: '2024-01-02T00:00:00Z', size: 900, folder: 'Projects', destination: 'Local Folders/Archive/person@gmail.com/2024' }],
      excluded: { starred: 3, unread: 0, pinned: 1, drafts: 0, sent: 0, folders: 0, notDownloaded: 0, inOtherJob: 0 }
    })
    archiving.save.mockImplementation(async (input) => status({ policy: { ...savedPolicy, ...input } }))
    render(<MailArchivingSection account={account()} onToast={onToast} />)
    await screen.findByText(/Next run/)
    await user.selectOptions(screen.getByLabelText('What to archive'), 'folders')
    const folders = screen.getByRole('group', { name: 'Folders to archive' })
    expect(within(folders).queryByText('UNREAD')).not.toBeInTheDocument()
    await user.click(within(folders).getByRole('checkbox', { name: /Projects/ }))
    await user.click(screen.getByRole('checkbox', { name: /Sent mail/ }))
    const age = screen.getByLabelText('Archive mail received more than')
    await user.clear(age)
    await user.type(age, '6')
    await user.click(screen.getByRole('button', { name: /Preview/ }))
    const preview = await screen.findByRole('region', { name: 'Archive preview' })
    expect(within(preview).getByText('120 messages')).toBeInTheDocument()
    expect(within(preview).getByText(/3 starred, 1 pinned/)).toBeInTheDocument()
    expect(within(preview).getByText('Local Folders/Archive/person@gmail.com/2024')).toBeInTheDocument()
    expect(archiving.preview).toHaveBeenCalledWith(expect.objectContaining({ scope: 'folders', folderIds: ['Label_1'], olderThan: 6, exclude: expect.objectContaining({ sent: true }) }))
    await user.click(screen.getByRole('button', { name: /Save archive policy/ }))
    await waitFor(() => expect(archiving.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct', scope: 'folders', olderThan: 6, enabled: true })))
    expect(onToast).toHaveBeenCalledWith('Automatic archiving is on')
  })

  it('resumes a paused run, shows per-message details, and starts a run now', async () => {
    const user = userEvent.setup()
    archiving.get.mockResolvedValue(status({ jobs: [job({ status: 'paused', pending: 2, done: 1, failed: 0, error: 'There is not enough free disk space to save archived mail.' })] }))
    archiving.resume.mockResolvedValue(job({ status: 'running' }))
    archiving.items.mockResolvedValue([{ jobId: 'job-1', messageId: 'm1', threadId: 't1', subject: 'Old report', from: 'Ada', receivedAt: '2024-01-01T00:00:00Z', size: 10, state: 'failed', reason: 'The copy could not be verified. The server copy was kept.' }])
    archiving.runNow.mockResolvedValue(job({ status: 'running' }))
    render(<MailArchivingSection account={account()} onToast={vi.fn()} />)
    expect(await screen.findByText(/not enough free disk space/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Resume/ }))
    expect(archiving.resume).toHaveBeenCalledWith('job-1')
    await user.click(screen.getByRole('button', { name: /Details/ }))
    expect(await screen.findByText(/Failed — The copy could not be verified/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Run now/ }))
    await waitFor(() => expect(archiving.runNow).toHaveBeenCalledWith('acct'))
  })

  it('creates an Archive folder in Local Folders when none exists', async () => {
    const user = userEvent.setup()
    archiving.get.mockResolvedValue(status({ policy: undefined, jobs: [] }))
    api.mail.mail.labels.mockImplementation(async (ids: string[]) => ids[0] === LOCAL_FOLDERS_ACCOUNT_ID ? (api.mail.folders.create.mock.calls.length ? labels[LOCAL_FOLDERS_ACCOUNT_ID] : []) : labels.acct)
    api.mail.folders.create.mockResolvedValue({ label: labels[LOCAL_FOLDERS_ACCOUNT_ID][0], labels: labels[LOCAL_FOLDERS_ACCOUNT_ID], renamed: {} })
    render(<MailArchivingSection account={account()} onToast={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Create “Archive” folder/ }))
    await waitFor(() => expect(screen.getByLabelText('Local Folders destination')).toHaveValue('folder:local-archive'))
    expect(api.mail.imports.ensureLocalFolders).toHaveBeenCalled()
    expect(api.mail.folders.create).toHaveBeenCalledWith({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Archive' })
    expect(screen.getByRole('button', { name: /Run now/ })).toBeDisabled()
  })

  it('is hidden for Local Folders and disconnected accounts', () => {
    const { container, rerender } = render(<MailArchivingSection account={account({ provider: 'local' })} onToast={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<MailArchivingSection account={account({ archived: true })} onToast={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
