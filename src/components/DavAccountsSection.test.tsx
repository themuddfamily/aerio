// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DavSnapshot } from '../dav-types'
import DavAccountsSection from './DavAccountsSection'

const connected = (): DavSnapshot => ({
  accounts: [{ id: 'dav-1', preset: 'fastmail', name: 'Fastmail · ada', username: 'ada@example.com', serverUrl: 'https://caldav.fastmail.com/', status: 'needs-auth', error: 'Enter the app password again', pendingWrites: 2 }],
  collections: [
    { id: 'c-work', accountId: 'dav-1', kind: 'calendar', name: 'Work', color: '#aa3300', url: 'https://x/work/', readOnly: false, shared: false, components: ['VEVENT'], enabled: true, syncMode: 'sync-collection' },
    { id: 'c-hol', accountId: 'dav-1', kind: 'calendar', name: 'Holidays', color: '#3f74c9', url: 'https://x/hol/', readOnly: true, shared: true, components: ['VEVENT'], enabled: true, syncMode: 'ctag' },
    { id: 'c-tasks', accountId: 'dav-1', kind: 'calendar', name: 'Reminders', color: '#2f7d6d', url: 'https://x/tasks/', readOnly: false, shared: false, components: ['VTODO'], enabled: true, syncMode: 'ctag' }
  ],
  review: [{ id: 'op-1', accountId: 'dav-1', collectionId: 'c-work', kind: 'event', action: 'update', status: 'conflict', title: 'My edit', error: 'Changed on the server since you edited it', serverDeleted: false, serverTitle: 'Their edit', updatedAt: '2026-10-17T10:00:00Z' }]
})

const listeners: ((snapshot: DavSnapshot) => void)[] = []
const api = {
  snapshot: vi.fn(async (): Promise<DavSnapshot> => ({ accounts: [], collections: [], review: [] })),
  onChanged: vi.fn((callback: (snapshot: DavSnapshot) => void) => { listeners.push(callback); return () => undefined }),
  addAccount: vi.fn(async () => connected()),
  updatePassword: vi.fn(async () => connected()),
  removeAccount: vi.fn(async () => ({ accounts: [], collections: [], review: [] })),
  sync: vi.fn(async () => connected()),
  syncAll: vi.fn(async () => connected()),
  setCollectionEnabled: vi.fn(async () => connected()),
  resolve: vi.fn(async () => ({ ...connected(), review: [] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  listeners.length = 0
  Object.defineProperty(window, 'aerio', { configurable: true, value: { dav: api } })
})

describe('DavAccountsSection', () => {
  it('renders nothing when the bridge is unavailable', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: {} })
    const { container } = render(<DavAccountsSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it('connects a Nextcloud account with a server address and clears the password', async () => {
    const user = userEvent.setup()
    render(<DavAccountsSection />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Service' }), 'nextcloud')
    const connect = screen.getByRole('button', { name: /Connect account/ })
    expect(connect).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Server address' }), 'https://cloud.example.com')
    await user.type(screen.getByRole('textbox', { name: 'Nextcloud user name' }), 'ada')
    await user.type(screen.getByLabelText('App password'), 'abcd-efgh')
    await user.click(connect)
    expect(api.addAccount).toHaveBeenCalledWith({ preset: 'nextcloud', serverUrl: 'https://cloud.example.com', username: 'ada', password: 'abcd-efgh' })
    expect(await screen.findByRole('status')).toHaveTextContent(/Account connected/)
    expect(screen.getAllByLabelText('App password').every((input) => (input as HTMLInputElement).value === '')).toBe(true)
  })

  it('shows connection errors and keeps the user name', async () => {
    api.addAccount.mockRejectedValueOnce(new Error("Error invoking remote method 'dav:account-add': Error: The server rejected the user name or app password"))
    const user = userEvent.setup()
    render(<DavAccountsSection />)
    await user.type(screen.getByRole('textbox', { name: 'Apple Account email' }), 'ada@icloud.com')
    await user.type(screen.getByLabelText('App password'), 'wrong')
    await user.click(screen.getByRole('button', { name: /Connect account/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('The server rejected the user name or app password')
    expect(screen.getByRole('textbox', { name: 'Apple Account email' })).toHaveValue('ada@icloud.com')
  })

  it('lists collections with capabilities, conflicts, and account actions', async () => {
    api.snapshot.mockResolvedValue(connected())
    const user = userEvent.setup()
    render(<DavAccountsSection />)
    const collections = await screen.findByRole('list', { name: /calendars and address books/ })
    expect(within(collections).getByText(/Read-only · Shared/)).toBeInTheDocument()
    expect(within(collections).getByRole('checkbox', { name: 'Show Reminders' })).toBeEnabled()
    expect(within(collections).getByText(/Tasks only \(shown in Tasks\)/)).toBeInTheDocument()
    expect(screen.getByText(/2 changes waiting to send/)).toBeInTheDocument()

    const review = screen.getByRole('region', { name: /changes to review/ })
    expect(within(review).getByText(/The server now has “Their edit”/)).toBeInTheDocument()
    await user.click(within(review).getByRole('button', { name: 'Keep my version' }))
    expect(api.resolve).toHaveBeenCalledWith('op-1', 'keep-local')
    await waitFor(() => expect(screen.queryByRole('region', { name: /changes to review/ })).not.toBeInTheDocument())

    await user.click(within(collections).getByRole('checkbox', { name: 'Show Holidays' }))
    expect(api.setCollectionEnabled).toHaveBeenCalledWith('c-hol', false)

    await user.type(screen.getAllByLabelText('App password')[0], 'new-password')
    await user.click(screen.getByRole('button', { name: /Save password/ }))
    expect(api.updatePassword).toHaveBeenCalledWith('dav-1', 'new-password')

    await user.click(screen.getByRole('button', { name: /Sync now/ }))
    expect(api.sync).toHaveBeenCalledWith('dav-1')

    await user.click(screen.getByRole('button', { name: 'Remove Fastmail · ada' }))
    await user.click(screen.getByRole('button', { name: /discard 2 unsent changes/ }))
    expect(api.removeAccount).toHaveBeenCalledWith('dav-1')
  })

  it('offers send-again and discard for writes held after a restore', async () => {
    api.snapshot.mockResolvedValue({ ...connected(), review: [{ ...connected().review[0], status: 'held', error: 'Held after restoring' }] })
    const user = userEvent.setup()
    render(<DavAccountsSection />)
    const review = await screen.findByRole('region', { name: /changes to review/ })
    expect(within(review).getByText(/restored from a backup/)).toBeInTheDocument()
    await user.click(within(review).getByRole('button', { name: 'Discard my change' }))
    expect(api.resolve).toHaveBeenCalledWith('op-1', 'keep-server')
    listeners.forEach((listener) => listener({ accounts: [], collections: [], review: [] }))
    await waitFor(() => expect(screen.queryByRole('list', { name: /Calendar and contacts accounts/ })).not.toBeInTheDocument())
  })
})
