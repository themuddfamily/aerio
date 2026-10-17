// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudStorageAccount, CloudStorageLink, CloudStorageSnapshot } from '../cloud-attachment-types'
import CloudStorageAccountsSection from './CloudStorageAccountsSection'

const nextcloud: CloudStorageAccount = {
  id: 'nextcloud-1', provider: 'nextcloud', name: 'Nextcloud · Ada', username: 'ada', serverUrl: 'https://cloud.example.test/', status: 'ready', connectedAt: '2026-10-01T00:00:00Z',
  capabilities: { audiences: ['anyone'], password: 'enforced', expiry: 'available', edit: 'unavailable', resumableUpload: true, notes: ['The server requires a password on every public link.'] }
}
const dropbox: CloudStorageAccount = {
  id: 'dropbox-1', provider: 'dropbox', name: 'Dropbox · ada@example.test', username: 'ada@example.test', status: 'needs-auth', error: 'Dropbox signed Aerio out. Connect Dropbox again.', connectedAt: '2026-10-01T00:00:00Z',
  capabilities: { audiences: ['anyone', 'members'], password: 'unavailable', expiry: 'unavailable', edit: 'unavailable', resumableUpload: true, notes: [] }
}
const empty: CloudStorageSnapshot = { accounts: [], dropboxConfigured: false, dropboxBuiltIn: false }
const link: CloudStorageLink = { url: 'https://cloud.example.test/s/abc', name: 'report.pdf', storageAccountId: 'nextcloud-1', scopeLabel: 'Anyone with the link can view, with a password' }

const storage = {
  snapshot: vi.fn(async () => empty),
  configureDropbox: vi.fn(async () => ({ ...empty, dropboxConfigured: true })),
  connectDropbox: vi.fn(async () => ({ accounts: [dropbox], dropboxConfigured: true, dropboxBuiltIn: false })),
  connectServer: vi.fn(async () => ({ ...empty, accounts: [nextcloud] })),
  refresh: vi.fn(async () => ({ ...empty, accounts: [nextcloud] })),
  disconnect: vi.fn(async () => empty),
  links: vi.fn(async () => [link]),
  revoke: vi.fn(async () => [] as CloudStorageLink[])
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.snapshot.mockResolvedValue(empty)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { cloudAttachments: { storage } } } })
})

describe('CloudStorageAccountsSection', () => {
  it('renders nothing without the bridge', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: {} })
    const { container } = render(<CloudStorageAccountsSection />)
    expect(container.innerHTML).toBe('')
  })

  it('saves a Dropbox app key before offering the Dropbox sign-in', async () => {
    const user = userEvent.setup()
    render(<CloudStorageAccountsSection />)
    const group = await screen.findByRole('group', { name: 'Connect Dropbox' })
    expect(within(group).getByRole('button', { name: /Connect Dropbox/ })).toBeDisabled()
    await user.type(within(group).getByLabelText('Dropbox app key'), 'appkey1234')
    await user.click(within(group).getByRole('button', { name: 'Save app key' }))
    expect(storage.configureDropbox).toHaveBeenCalledWith('appkey1234')
    await user.click(within(group).getByRole('button', { name: /Connect Dropbox/ }))
    expect(storage.connectDropbox).toHaveBeenCalled()
    expect(await screen.findByText('Dropbox signed Aerio out. Connect Dropbox again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sign in again/ })).toBeInTheDocument()
  })

  it('connects Nextcloud with an app password and shows what the server enforces', async () => {
    const user = userEvent.setup()
    render(<CloudStorageAccountsSection />)
    const group = await screen.findByRole('group', { name: 'Connect ownCloud or Nextcloud' })
    await user.type(within(group).getByLabelText('Server address'), 'https://cloud.example.test')
    await user.type(within(group).getByLabelText('Nextcloud user name'), 'ada')
    await user.type(within(group).getByLabelText('App password'), 'secret')
    await user.click(within(group).getByRole('button', { name: /Connect Nextcloud/ }))
    expect(storage.connectServer).toHaveBeenCalledWith({ provider: 'nextcloud', serverUrl: 'https://cloud.example.test', username: 'ada', password: 'secret' })
    const capabilities = await screen.findByLabelText('Nextcloud · Ada sharing capabilities')
    expect(capabilities.textContent).toContain('Link passwordRequired')
    expect(capabilities.textContent).toContain('Expiry dateOptional')
    expect(capabilities.textContent).toContain('EditingView only')
    expect(capabilities.textContent).toContain('Large uploadsChunked, resumable')
    expect(screen.getByText('The server requires a password on every public link.')).toBeInTheDocument()
    expect((within(group).getByLabelText('App password') as HTMLInputElement).value).toBe('')
  })

  it('lists and revokes links, then disconnects after confirmation', async () => {
    storage.snapshot.mockResolvedValue({ ...empty, accounts: [nextcloud] })
    const user = userEvent.setup()
    render(<CloudStorageAccountsSection />)
    await user.click(await screen.findByRole('button', { name: 'Links' }))
    const links = await screen.findByRole('list', { name: 'Links shared from Nextcloud · Ada' })
    expect(links.textContent).toContain('report.pdf')
    await user.click(within(links).getByRole('button', { name: /Turn off link/ }))
    expect(storage.revoke).toHaveBeenCalledWith(link.url)
    expect(await screen.findByText('The link to report.pdf no longer opens.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Disconnect Nextcloud · Ada' }))
    expect(storage.disconnect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(storage.disconnect).toHaveBeenCalledWith('nextcloud-1')
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Cloud storage accounts' })).toBeNull())
    expect(screen.getByRole('status').textContent).toMatch(/forgot the credentials and interrupted uploads/)
  })
})
