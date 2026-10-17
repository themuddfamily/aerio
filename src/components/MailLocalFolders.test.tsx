// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailImportJob, MailLabel, MailWorkerEvent } from '../mail-types'
import { LocalFoldersSidebar, MailImportModal, MailLocalTransferModal } from './MailLocalFolders'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'gmail', provider: 'gmail', email: 'person@example.test', displayName: 'Person', color: '#123456',
  status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})
const local = account({ id: 'local-folders', provider: 'local', email: 'Local Folders', syncEnabled: false })
const labels: MailLabel[] = [
  { accountId: 'local-folders', id: 'folder:local-1', name: 'Archive', type: 'user' },
  { accountId: 'local-folders', id: 'folder:local-2', name: 'Archive/2024', type: 'user', parentId: 'folder:local-1' }
]
const job = (overrides: Partial<MailImportJob> = {}): MailImportJob => ({
  id: 'job-1', accountId: 'local-folders', status: 'running', label: 'Inbox.mbox', sources: 1, imported: 3, duplicates: 2, failed: 0, skipped: 1,
  pendingReview: 2, processedBytes: 50, totalBytes: 100, currentSource: 'C:\\mail\\Inbox.mbox', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z', ...overrides
})

let api: Record<string, ReturnType<typeof vi.fn>>
let listener: ((event: MailWorkerEvent) => void) | undefined

beforeEach(() => {
  listener = undefined
  api = {
    ensureLocalFolders: vi.fn().mockResolvedValue(local),
    choose: vi.fn().mockResolvedValue({ paths: ['C:\\mail\\Inbox.mbox'], unsupported: [{ path: 'C:\\mail\\Outlook.pst', reason: 'Outlook data files (.pst/.ost) cannot be imported yet.' }] }),
    start: vi.fn().mockResolvedValue(job({ status: 'queued', imported: 0, duplicates: 0, pendingReview: 0, skipped: 0 })),
    list: vi.fn().mockResolvedValue([]),
    pause: vi.fn().mockResolvedValue(job({ status: 'paused' })),
    resume: vi.fn().mockResolvedValue(job()),
    cancel: vi.fn().mockResolvedValue(job({ status: 'cancelled' })),
    dismiss: vi.fn().mockResolvedValue(undefined),
    items: vi.fn().mockResolvedValue([
      { key: '0:0', jobId: 'job-1', status: 'duplicate', reason: 'An identical copy is already in Local Folders', source: 'C:\\mail\\Inbox.mbox', subject: 'Alpha', from: 'Ada', size: 1200, duplicateOf: { messageId: 'm1', subject: 'Alpha' } },
      { key: '0:99', jobId: 'job-1', status: 'duplicate', reason: 'A message with the same Message-ID but different content is already in Local Folders', source: 'C:\\mail\\Inbox.mbox', subject: 'Beta', from: 'Bob', size: 900 }
    ]),
    resolve: vi.fn().mockResolvedValue(job({ status: 'completed', pendingReview: 0 })),
    transfer: vi.fn().mockResolvedValue({ copied: 2, skipped: 1, missing: 1 })
  }
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { imports: api, onEvent: (callback: typeof listener) => { listener = callback; return () => undefined } } } })
})

describe('MailImportModal', () => {
  it('creates Local Folders, explains unsupported PST files and starts an import with the chosen options', async () => {
    const onToast = vi.fn()
    const onChanged = vi.fn()
    render(<MailImportModal accounts={[account()]} labels={[]} onClose={vi.fn()} onToast={onToast} onLocalFoldersChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Local Folders' }))
    await waitFor(() => expect(api.ensureLocalFolders).toHaveBeenCalled())
    expect(onToast).toHaveBeenCalledWith('Local Folders created')

    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Choose MBOX or EML files/ }))
    expect(await screen.findByText('Inbox.mbox')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Outlook.pst — Outlook data files (.pst/.ost) cannot be imported yet.')
    fireEvent.change(screen.getByLabelText('Duplicates'), { target: { value: 'import' } })
    fireEvent.change(screen.getByLabelText('MBOX format'), { target: { value: 'mboxo' } })
    fireEvent.click(screen.getByRole('button', { name: /^Import$/ }))
    await waitFor(() => expect(api.start).toHaveBeenCalledWith({ paths: ['C:\\mail\\Inbox.mbox'], duplicates: 'import', mboxVariant: 'mboxo' }))
    expect(onToast).toHaveBeenCalledWith('Importing Inbox.mbox')
    expect(await screen.findByLabelText('Import Inbox.mbox')).toHaveTextContent('Waiting to start')
  })

  it('shows live progress, pauses, resumes, cancels and dismisses jobs', async () => {
    api.list.mockResolvedValue([job()])
    const onToast = vi.fn()
    render(<MailImportModal accounts={[account(), local]} labels={labels} onClose={vi.fn()} onToast={onToast} onLocalFoldersChanged={vi.fn()} />)
    const row = await screen.findByLabelText('Import Inbox.mbox')
    expect(row).toHaveTextContent('Importing · Inbox.mbox')
    expect(row).toHaveTextContent('3 messages imported · 2 duplicates · 1 deleted in the source, skipped')
    expect(screen.getByLabelText('Import into')).toHaveTextContent('2024')
    fireEvent.click(screen.getByRole('button', { name: 'Pause import' }))
    await waitFor(() => expect(api.pause).toHaveBeenCalledWith('job-1'))
    expect(await screen.findByText('Paused')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resume import' }))
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith('job-1'))
    act(() => listener?.({ type: 'import-progress', payload: job({ status: 'interrupted', error: 'Aerio closed while this import was running.' }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('Aerio closed while this import was running.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Import cancelled. 3 messages already imported stay in Local Folders.'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from list' }))
    await waitFor(() => expect(screen.queryByLabelText('Import Inbox.mbox')).not.toBeInTheDocument())
    expect(api.dismiss).toHaveBeenCalledWith('job-1')
  })

  it('reviews held duplicates and imports or discards the selection', async () => {
    api.list.mockResolvedValue([job({ status: 'completed' })])
    const onToast = vi.fn()
    render(<MailImportModal accounts={[local]} labels={labels} onClose={vi.fn()} onToast={onToast} onLocalFoldersChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Review 2/ }))
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText(/existing: “Alpha”/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select Beta'))
    fireEvent.click(screen.getByRole('button', { name: /Import selected/ }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith('job-1', ['0:0'], 'import'))
    expect(onToast).toHaveBeenCalledWith('Imported 1 message')
    fireEvent.click(screen.getByRole('button', { name: /Discard selected/ }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith('job-1', ['0:0', '0:99'], 'discard'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: /Choose a folder/ })).toBeInTheDocument()
  })

  it('explains when import is unavailable', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { onEvent: () => () => undefined } } })
    render(<MailImportModal accounts={[]} labels={[]} onClose={vi.fn()} onToast={vi.fn()} onLocalFoldersChanged={vi.fn()} />)
    expect(screen.getByText('Mail import is not available in this version of Aerio.')).toBeInTheDocument()
  })
})

describe('MailLocalTransferModal', () => {
  it('copies or moves conversations from other accounts into a Local Folders folder', async () => {
    const onToast = vi.fn()
    const onDone = vi.fn()
    render(<MailLocalTransferModal items={[{ accountId: 'gmail', id: 't1' }, { accountId: 'gmail', id: 't2' }, { accountId: 'local-folders', id: 't3' }]} accounts={[account(), local]} labels={labels} onClose={vi.fn()} onToast={onToast} onDone={onDone} />)
    expect(screen.getByText('2 conversations')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'folder:local-2' } })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'move' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))
    await waitFor(() => expect(api.transfer).toHaveBeenCalledWith({ sourceAccountId: 'gmail', threadIds: ['t1', 't2'], destinationLabelId: 'folder:local-2', mode: 'move' }))
    expect(onToast).toHaveBeenCalledWith('Moved 2 messages to Local Folders · 1 already there · 1 not downloaded, so those conversations were left in place')
    expect(onDone).toHaveBeenCalled()
  })

  it('asks for a folder first and blocks moving out of offline archives', () => {
    const { unmount } = render(<MailLocalTransferModal items={[{ accountId: 'gmail', id: 't1' }]} accounts={[account(), local]} labels={[]} onClose={vi.fn()} onToast={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByText('Create a folder in Local Folders first.')).toBeInTheDocument()
    unmount()
    render(<MailLocalTransferModal items={[{ accountId: 'gmail', id: 't1' }]} accounts={[account({ archived: true }), local]} labels={labels} onClose={vi.fn()} onToast={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByRole('option', { name: /Move — copy/ })).toBeDisabled()
  })
})

describe('LocalFoldersSidebar', () => {
  it('renders the nested folder tree and import entry', () => {
    const onOpen = vi.fn()
    const onImport = vi.fn()
    render(<LocalFoldersSidebar account={local} labels={labels} selectedAccountId="local-folders" selectedLabelId="folder:local-2" onOpen={onOpen} onContextMenu={vi.fn()} onManage={vi.fn()} onImport={onImport} />)
    expect(screen.getByRole('button', { name: '2024' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(onOpen).toHaveBeenCalledWith(labels[0])
    fireEvent.click(screen.getByRole('button', { name: /Import mail/ }))
    expect(onImport).toHaveBeenCalled()
  })
})
