// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudAttachmentStatus, CloudSharedLink, CloudStorageAccount, CloudStorageSnapshot, CloudUploadResult } from '../cloud-attachment-types'
import type { MailAccountSummary, MailDraftResult } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'

const account = (provider: MailAccountSummary['provider']): MailAccountSummary => ({
  id: 'account', provider, email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
})
const result = (status: MailDraftResult['status'] = 'synced'): MailDraftResult => ({ id: 'draft', status, updatedAt: '2026-10-17T10:00:00Z' })
const status = (overrides: Partial<CloudAttachmentStatus> = {}): CloudAttachmentStatus => ({
  accountId: 'account', mailProvider: 'gmail', provider: 'google-drive', supported: true, connected: true, requiredScope: 'drive.file',
  audiences: ['anyone', 'recipients'], attachmentLimitBytes: 25 * 1024 * 1024, ...overrides
})
const link = (overrides: Partial<CloudSharedLink> = {}): CloudSharedLink => ({
  provider: 'google-drive', accountId: 'account', fileId: 'f1', name: 'video.mp4', size: 30 * 1024 * 1024, url: 'https://drive.example.test/f1',
  share: { audience: 'anyone', role: 'view' }, scopeLabel: 'Anyone with the link can view', ...overrides
})

let progressListener: ((value: unknown) => void) | undefined
const cloud = {
  status: vi.fn(async () => status()),
  connect: vi.fn(async () => status()),
  upload: vi.fn(async (uploadId: string): Promise<CloudUploadResult> => ({ status: 'shared', uploadId, link: link() })),
  cancel: vi.fn(async () => undefined),
  pending: vi.fn(async () => [] as Awaited<ReturnType<typeof window.aerio.mail.cloudAttachments.pending>>),
  resume: vi.fn(async (uploadId: string): Promise<CloudUploadResult> => ({ status: 'shared', uploadId, link: link({ name: 'resumed.zip' }) })),
  discard: vi.fn(async () => undefined),
  verify: vi.fn(async () => [] as Awaited<ReturnType<typeof window.aerio.mail.cloudAttachments.verify>>),
  onProgress: vi.fn((callback: (value: unknown) => void) => { progressListener = callback; return () => { progressListener = undefined } }),
  storage: { snapshot: vi.fn(async (): Promise<CloudStorageSnapshot> => ({ accounts: [], dropboxConfigured: false, dropboxBuiltIn: false })) }
}
const nextcloud = (overrides: Partial<CloudStorageAccount> = {}): CloudStorageAccount => ({
  id: 'nextcloud-1', provider: 'nextcloud', name: 'Nextcloud · Ada', username: 'ada', serverUrl: 'https://cloud.example.test/', status: 'ready', connectedAt: '2026-10-01T00:00:00Z',
  capabilities: { audiences: ['anyone'], password: 'enforced', expiry: 'enforced', maxExpiryDays: 7, edit: 'unavailable', resumableUpload: true, notes: ['The server requires a password on every public link.'] },
  ...overrides
})
const api = {
  chooseAttachments: vi.fn(async () => [{ id: 'file', name: 'video.mp4', size: 30 * 1024 * 1024, path: 'C:\\files\\video.mp4', mime: 'mp4' }]),
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: { save: vi.fn(async () => result()), send: vi.fn(async () => result('send-pending')), schedule: vi.fn(), delete: vi.fn(), stageMessageAttachments: vi.fn(async () => []) },
    cloudAttachments: cloud
  }
}

const renderCompose = (provider: MailAccountSummary['provider'] = 'gmail') => {
  const callbacks = { onClose: vi.fn(), onSent: vi.fn(), onToast: vi.fn() }
  render(<ContextMenuProvider><MailComposeModal accounts={[account(provider)]} {...callbacks} /></ContextMenuProvider>)
  return callbacks
}
const editor = () => document.querySelector<HTMLDivElement>('.compose-rich-body')!

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  window.confirm = vi.fn(() => true)
  // Force the range-insertion fallback, which jsdom implements.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
  cloud.status.mockResolvedValue(status())
  cloud.pending.mockResolvedValue([])
  cloud.verify.mockResolvedValue([])
  cloud.storage.snapshot.mockResolvedValue({ accounts: [], dropboxConfigured: false, dropboxBuiltIn: false })
})

describe('MailCloudAttachments in the composer', () => {
  it('points IMAP accounts without storage to Settings', async () => {
    cloud.status.mockResolvedValue(status({ mailProvider: 'imap', provider: undefined, supported: false, connected: false, audiences: [], message: 'This account has no storage of its own.' }))
    const user = userEvent.setup()
    renderCompose('imap')
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    expect(await screen.findByText(/no storage of its own\. Connect one in Settings → Cloud storage accounts/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Upload and insert link' })).toBeNull()
  })

  it('shares from a connected Nextcloud account with the password and expiry the server enforces', async () => {
    cloud.status.mockResolvedValue(status({ mailProvider: 'imap', provider: undefined, supported: false, connected: false, audiences: [] }))
    cloud.storage.snapshot.mockResolvedValue({ accounts: [nextcloud()], dropboxConfigured: false, dropboxBuiltIn: false })
    const user = userEvent.setup()
    renderCompose('imap')
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    expect(await screen.findByText('Share from Nextcloud · Ada')).toBeInTheDocument()
    const capabilities = screen.getByLabelText('Nextcloud · Ada sharing capabilities')
    expect(capabilities.textContent).toContain('Link passwordRequired')
    expect(capabilities.textContent).toContain('Expiry dateRequired (at most 7 days)')
    expect(capabilities.textContent).toContain('EditingView only')
    expect(screen.queryByRole('option', { name: 'Can edit' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Choose file…' }))
    expect(screen.getByText('Nextcloud · Ada requires a link password.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload and insert link' })).toBeDisabled()
    await user.type(screen.getByLabelText(/Link password/), 's3cret')
    expect(screen.getByText('Nextcloud · Ada requires an expiry date.')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Expires on/), '2099-01-02')
    expect(screen.getByText(/Anyone with the link can view, with a password until 2099-01-02/)).toBeInTheDocument()
    cloud.upload.mockImplementationOnce(async (uploadId) => ({ status: 'shared', uploadId, link: link({ provider: 'nextcloud', storageAccountId: 'nextcloud-1', url: 'https://cloud.example.test/s/abc', scopeLabel: 'Anyone with the link can view, with a password until 2099-01-02' }) }))
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    expect(cloud.upload).toHaveBeenCalledWith(expect.any(String), 'account', 'C:\\files\\video.mp4', { audience: 'anyone', role: 'view', password: 's3cret', expiresOn: '2099-01-02' }, 'nextcloud-1')
    await waitFor(() => expect(editor().textContent).toContain('(Nextcloud, 30.0 MB · Anyone with the link can view, with a password until 2099-01-02)'))
  })

  it('lets Gmail accounts choose between Google Drive and a connected Dropbox', async () => {
    const dropbox = nextcloud({ id: 'dropbox-1', provider: 'dropbox', name: 'Dropbox · ada@example.test', serverUrl: undefined,
      capabilities: { audiences: ['anyone', 'members'], password: 'unavailable', expiry: 'unavailable', edit: 'unavailable', resumableUpload: true, notes: [] } })
    cloud.storage.snapshot.mockResolvedValue({ accounts: [dropbox], dropboxConfigured: true, dropboxBuiltIn: true })
    const user = userEvent.setup()
    renderCompose()
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    expect(await screen.findByLabelText('Only the message recipients')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Store in'), 'dropbox-1')
    expect(screen.queryByLabelText('Only the message recipients')).toBeNull()
    expect(screen.getByLabelText('Only people who already have access')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Link password/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Choose file…' }))
    await user.click(screen.getByLabelText('Only people who already have access'))
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    expect(cloud.upload).toHaveBeenCalledWith(expect.any(String), 'account', 'C:\\files\\video.mp4', { audience: 'members', role: 'view' }, 'dropbox-1')
  })

  it('asks for the storage permission only after the user opts in', async () => {
    cloud.status.mockResolvedValue(status({ connected: false, message: 'Aerio needs permission to create and share the files it uploads to Google Drive (drive.file).' }))
    const user = userEvent.setup()
    renderCompose()
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    expect(await screen.findByText(/drive\.file/)).toBeInTheDocument()
    expect(screen.getByText(/adds only this permission; your mail access is unchanged/)).toBeInTheDocument()
    expect(cloud.connect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }))
    expect(cloud.connect).toHaveBeenCalledWith('account')
    expect(await screen.findByRole('group', { name: 'Who can open it' })).toBeInTheDocument()
  })

  it('shows the sharing scope before upload, shares with recipients, and inserts a plain link', async () => {
    const user = userEvent.setup()
    renderCompose()
    await user.type(document.querySelector<HTMLInputElement>('.compose-row input')!, 'Ada <ada@example.test>')
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    await user.click(await screen.findByRole('button', { name: 'Choose file…' }))
    expect(screen.getByText('Anyone with the link can view. Anyone the link is forwarded to can open it.')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Only the message recipients'))
    await user.selectOptions(screen.getByLabelText('Access level'), 'edit')
    expect(screen.getByText(/Only ada@example\.test can edit after signing in to a Google account/)).toBeInTheDocument()
    cloud.upload.mockImplementationOnce(async (uploadId) => ({ status: 'shared', uploadId, link: link({ name: 'video.mp4', scopeLabel: 'Only ada@example.test can edit after signing in to a Google account' }) }))
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    expect(cloud.upload).toHaveBeenCalledWith(expect.any(String), 'account', 'C:\\files\\video.mp4', { audience: 'recipients', role: 'edit', recipients: ['ada@example.test'] })
    const anchor = await waitFor(() => {
      const value = editor().querySelector<HTMLAnchorElement>('a[data-aerio-cloud-link]')
      expect(value).not.toBeNull()
      return value!
    })
    expect(anchor.getAttribute('href')).toBe('https://drive.example.test/f1')
    expect(editor().textContent).toContain('video.mp4 (Google Drive, 30.0 MB · Only ada@example.test can edit')
    expect(screen.queryByRole('region', { name: 'Cloud attachment' })).toBeNull()
    // Picking a file for a link never adds it as an ordinary attachment.
    expect(document.querySelector('.mail-compose-files')).toBeNull()
  })

  it('offers a cloud link for attachments over the provider limit and replaces the attachment once shared', async () => {
    const user = userEvent.setup()
    renderCompose()
    await user.click(screen.getByTitle('Attach files'))
    expect(await screen.findByText(/more than Gmail usually accepts/)).toBeInTheDocument()
    expect(document.querySelector('.mail-compose-files')?.textContent).toContain('video.mp4')
    await user.click(screen.getByRole('button', { name: 'video.mp4' }))
    expect(screen.getByText('The file stays attached until the link is inserted.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    await waitFor(() => expect(document.querySelector('.mail-compose-files')).toBeNull())
    expect(editor().querySelector('a[data-aerio-cloud-link]')).not.toBeNull()
  })

  it('shows progress and cancels a running upload without inserting anything', async () => {
    let finish!: (value: CloudUploadResult) => void
    cloud.upload.mockImplementationOnce((uploadId) => new Promise((resolve) => { finish = resolve; void uploadId }))
    const user = userEvent.setup()
    const callbacks = renderCompose()
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    await user.click(await screen.findByRole('button', { name: 'Choose file…' }))
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    const uploadId = cloud.upload.mock.calls[0][0]
    progressListener?.({ uploadId, name: 'video.mp4', sentBytes: 15 * 1024 * 1024, totalBytes: 30 * 1024 * 1024 })
    expect(await screen.findByText('15.0 MB of 30.0 MB')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }))
    expect(cloud.cancel).toHaveBeenCalledWith(uploadId)
    finish({ status: 'cancelled', uploadId })
    await waitFor(() => expect(callbacks.onToast).toHaveBeenCalledWith('Upload cancelled; nothing was shared'))
    expect(editor().querySelector('a[data-aerio-cloud-link]')).toBeNull()
  })

  it('resumes or discards uploads interrupted by a restart', async () => {
    cloud.pending.mockResolvedValue([{ uploadId: 'old-upload', accountId: 'account', provider: 'google-drive', name: 'resumed.zip', path: 'C:\\resumed.zip', totalBytes: 2048, share: { audience: 'anyone', role: 'view' }, createdAt: '2026-10-16T10:00:00Z' }])
    const user = userEvent.setup()
    renderCompose()
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    expect(await screen.findByText('resumed.zip')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(cloud.resume).toHaveBeenCalledWith('old-upload')
    await waitFor(() => expect(editor().textContent).toContain('resumed.zip'))
  })

  it('reports provider errors in the panel', async () => {
    cloud.upload.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:cloud:upload': Error: OneDrive does not allow links that work without signing in for this account."))
    const user = userEvent.setup()
    renderCompose()
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    await user.click(await screen.findByRole('button', { name: 'Choose file…' }))
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^OneDrive does not allow links/)
  })

  it('re-checks inserted links before sending and lets the user stop', async () => {
    cloud.verify.mockResolvedValue([{ url: 'https://drive.example.test/f1', name: 'video.mp4', problem: 'revoked', message: 'Sharing for video.mp4 was turned off in Google Drive, so recipients cannot open it.' }])
    window.confirm = vi.fn(() => false)
    const user = userEvent.setup()
    renderCompose()
    await user.type(document.querySelector<HTMLInputElement>('.compose-row input')!, 'ada@example.test')
    await user.click(screen.getByTitle('Share a file as a cloud link'))
    await user.click(await screen.findByRole('button', { name: 'Choose file…' }))
    await user.click(screen.getByRole('button', { name: 'Upload and insert link' }))
    await waitFor(() => expect(editor().querySelector('a[data-aerio-cloud-link]')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: /Send/ }))
    expect(cloud.verify).toHaveBeenCalledWith('account', ['https://drive.example.test/f1'])
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/turned off in Google Drive[\s\S]*Send anyway\?/))
    expect(api.mail.drafts.send).not.toHaveBeenCalled()
  })
})
