// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAccountSummary, ChatRoomSummary, ChatSnapshot, ChatTimelinePage } from '../chat-types'
import ChatView from './ChatView'

const account: ChatAccountSummary = {
  id: 'acct', transport: 'matrix', homeserver: 'https://matrix.example.org', userId: '@alice:example.org', deviceId: 'AERIODEV', status: 'ready',
  trust: 'unverified', recovery: 'not-set-up', createdAt: '2026-10-01T00:00:00Z',
  preferences: { retention: { historyDays: 30, mediaCacheMiB: 250 }, notificationPreviews: false, sendWhileLocked: false, typingNotifications: false, readReceipts: false }
}
const room: ChatRoomSummary = { accountId: 'acct', roomId: '!team:example.org', name: 'Team', encrypted: true, membership: 'join', isDirect: false, unread: 2, muted: false, previews: false }
const invite: ChatRoomSummary = { ...room, roomId: '!invite:example.org', name: 'Planning', membership: 'invite', inviter: '@bob:example.org', unread: 0 }
const plain: ChatRoomSummary = { ...room, roomId: '!plain:example.org', name: 'Lobby', encrypted: false, unread: 0 }
const gate = { enabled: true, preview: false, checks: [], sdkVersion: 'matrix-js-sdk 43.0.0', message: 'Chat is available.' }
const page: ChatTimelinePage = {
  accountId: 'acct', roomId: room.roomId, encrypted: true, gapBefore: true,
  items: [
    { id: '$1', eventId: '$1', sender: '@bob:example.org', timestamp: '2026-10-01T09:00:00Z', kind: 'text', body: 'Morning!', edited: false, encrypted: true, reactions: [{ key: '👍', count: 2, mine: true }], own: false },
    { id: '$2', eventId: '$2', sender: '@bob:example.org', timestamp: '2026-10-01T09:01:00Z', kind: 'undecryptable', decryptionError: 'The sender has not shared the key', edited: false, encrypted: true, reactions: [], own: false },
    { id: '$3', eventId: '$3', sender: '@bob:example.org', timestamp: '2026-10-01T09:02:00Z', kind: 'media', edited: false, encrypted: true, reactions: [], own: false, media: { mediaId: 'm1', name: 'plan.pdf', size: 2 * 1024 * 1024, mime: 'application/pdf', encrypted: true } },
    { id: 'o1', outboxId: 'o1', sender: '@alice:example.org', timestamp: '2026-10-01T09:03:00Z', kind: 'text', body: 'Did it send?', edited: false, encrypted: true, reactions: [], own: true, delivery: 'review' },
    { id: '$4', eventId: '$4', sender: '@alice:example.org', timestamp: '2026-10-01T09:04:00Z', kind: 'text', body: 'Mine', edited: true, encrypted: true, reactions: [], own: true, delivery: 'sent' }
  ]
}

let listener: ((event: any) => void) | undefined
const chat = {
  snapshot: vi.fn(), discover: vi.fn(), login: vi.fn(), removeAccount: vi.fn(), clearHistory: vi.fn(), updatePreferences: vi.fn(),
  timeline: vi.fn(), loadOlder: vi.fn(), search: vi.fn(), send: vi.fn(), edit: vi.fn(), redact: vi.fn(), react: vi.fn(),
  cancelOutgoing: vi.fn(), retryOutgoing: vi.fn(), attach: vi.fn(), saveMedia: vi.fn(), markRead: vi.fn(), roomAction: vi.fn(),
  devices: vi.fn(), verifyOwnDevice: vi.fn(), verificationAction: vi.fn(), restoreFromRecoveryKey: vi.fn(), setupRecovery: vi.fn(),
  onEvent: vi.fn((callback: (event: any) => void) => { listener = callback; return () => { listener = undefined } })
}
const toast = vi.fn()
const snapshot = (overrides: Partial<ChatSnapshot> = {}): ChatSnapshot => ({ gate, accounts: [account], rooms: [room, invite, plain], verifications: [], ...overrides })
const view = (value: ChatSnapshot, openRequest?: { id: number; accountId: string; roomId: string }) => render(<ChatView chat={chat as never} snapshot={value} openRequest={openRequest} onToast={toast} />)

beforeEach(() => {
  vi.clearAllMocks()
  chat.timeline.mockResolvedValue(page)
  chat.loadOlder.mockResolvedValue({ ...page, gapBefore: false })
  chat.markRead.mockResolvedValue(undefined)
  chat.devices.mockResolvedValue([{ deviceId: 'AERIODEV', verified: false, current: true }, { deviceId: 'PHONE', displayName: 'Phone', verified: true, current: false }])
  chat.send.mockResolvedValue({ id: 'o2' })
  chat.edit.mockResolvedValue(undefined)
  chat.roomAction.mockResolvedValue(undefined)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('ChatView', () => {
  it('signs in with a password only after showing the validated homeserver origin', async () => {
    chat.discover.mockResolvedValueOnce({ homeserver: 'https://matrix.example.org', versions: ['v1.11'], password: false, sso: true, unsupported: [] })
      .mockResolvedValueOnce({ homeserver: 'https://matrix.example.org', versions: ['v1.11'], password: true, sso: false, unsupported: [] })
    chat.login.mockRejectedValueOnce(new Error("Error invoking remote method 'chat:login': Error: Invalid password")).mockResolvedValueOnce(account)
    const user = userEvent.setup()
    view(snapshot({ accounts: [], rooms: [] }))
    const form = screen.getByRole('form', { name: 'Add Matrix account' })
    await user.type(within(form).getByLabelText('Homeserver or Matrix ID'), 'example.org')
    await user.click(screen.getByRole('button', { name: 'Check server' }))
    expect(await screen.findByText(/does not offer password sign-in; single sign-on is not supported/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Homeserver or Matrix ID'), ' ')
    await user.click(screen.getByRole('button', { name: 'Check server' }))
    expect(await screen.findByRole('status')).toHaveTextContent('You will sign in to https://matrix.example.org (Matrix v1.11)')
    await user.type(screen.getByLabelText('User name'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(toast).toHaveBeenCalledWith('Invalid password')
    // The password field is cleared after every attempt.
    expect(screen.getByLabelText('Password')).toHaveValue('')
    await user.type(screen.getByLabelText('Password'), 'right')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(chat.login).toHaveBeenLastCalledWith({ homeserver: 'https://matrix.example.org', user: 'alice', password: 'right' })
    expect(toast).toHaveBeenCalledWith('Matrix account connected')
  })

  it('lists rooms with unread counts, encryption state and invitations', async () => {
    view(snapshot({ gate: { ...gate, preview: true } }))
    expect(screen.getByRole('note')).toHaveTextContent('hosted two-device interoperability is unverified')
    expect(screen.getByRole('button', { name: 'Team, 2 unread' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Planning, invitation' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument()
    expect(screen.getByText('End-to-end encrypted')).toBeInTheDocument()
    await waitFor(() => expect(chat.markRead).toHaveBeenCalledWith('acct', room.roomId))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Lobby' }))
    expect(screen.getByText(/Not encrypted — the server can read these messages/)).toBeInTheDocument()
  })

  it('renders the timeline honestly and sends, replies, edits, retries and saves media', async () => {
    const user = userEvent.setup()
    view(snapshot())
    const timeline = await screen.findByRole('list', { name: 'Messages in Team' })
    expect(within(timeline).getByText('Morning!')).toBeInTheDocument()
    expect(within(timeline).getByText(/could not be decrypted: The sender has not shared the key.*no text is guessed/)).toBeInTheDocument()
    expect(within(timeline).getByText('plan.pdf')).toBeInTheDocument()
    expect(within(timeline).getByText('2.0 MiB · encrypted')).toBeInTheDocument()
    expect(within(timeline).getByText(/Needs review — may already have been delivered/)).toBeInTheDocument()
    expect(within(timeline).getByText('(edited)')).toBeInTheDocument()
    await user.click(within(timeline).getByRole('button', { name: 'Send anyway' }))
    expect(chat.retryOutgoing).toHaveBeenCalledWith('o1')
    chat.saveMedia.mockResolvedValueOnce(true)
    await user.click(within(timeline).getByRole('button', { name: /Save/ }))
    expect(chat.saveMedia).toHaveBeenCalledWith('acct', 'm1')
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Attachment saved'))
    await user.click(within(timeline).getByRole('button', { name: 'Load older messages' }))
    expect(chat.loadOlder).toHaveBeenCalledWith('acct', room.roomId)
    await waitFor(() => expect(within(timeline).queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument())

    await user.click(within(timeline).getAllByRole('button', { name: 'Reply' })[0])
    expect(screen.getByText(/Replying to/)).toHaveTextContent('@bob:example.org')
    await user.type(screen.getByLabelText('Message'), 'Hello team{Enter}')
    expect(chat.send).toHaveBeenCalledWith('acct', room.roomId, 'Hello team', '$1')
    expect(screen.getByLabelText('Message')).toHaveValue('')
    await user.click(within(timeline).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Message')).toHaveValue('Mine')
    await user.type(screen.getByLabelText('Message'), ' (fixed)')
    await user.click(screen.getByRole('button', { name: 'Save edit' }))
    expect(chat.edit).toHaveBeenCalledWith('acct', room.roomId, '$4', 'Mine (fixed)')
    await user.click(screen.getByRole('button', { name: /Attach a file \(up to 25 MiB\)/ }))
    expect(chat.attach).toHaveBeenCalledWith('acct', room.roomId)
    // A pushed timeline change for this room reloads it.
    chat.timeline.mockClear()
    act(() => listener?.({ type: 'timeline', accountId: 'acct', roomId: room.roomId }))
    expect(chat.timeline).toHaveBeenCalledWith('acct', room.roomId)
  })

  it('accepts invitations showing the full inviter ID and opens notification targets', async () => {
    const user = userEvent.setup()
    const { rerender } = view(snapshot(), { id: 1, accountId: 'acct', roomId: invite.roomId })
    const card = await screen.findByRole('region', { name: 'Invitation' })
    expect(card).toHaveTextContent('Invited by @bob:example.org')
    expect(chat.timeline).not.toHaveBeenCalledWith('acct', invite.roomId)
    await user.click(within(card).getByRole('button', { name: 'Accept' }))
    expect(chat.roomAction).toHaveBeenCalledWith('acct', invite.roomId, 'accept')
    rerender(<ChatView chat={chat as never} snapshot={snapshot()} openRequest={{ id: 2, accountId: 'acct', roomId: plain.roomId }} onToast={toast} />)
    expect(await screen.findByRole('heading', { name: 'Lobby' })).toBeInTheDocument()
  })

  it('walks through emoji verification and never confirms without emoji', async () => {
    const user = userEvent.setup()
    const base = { requestId: 'req', accountId: 'acct', otherUserId: '@alice:example.org', otherDeviceId: 'PHONE', selfVerification: true, initiatedByMe: false }
    const { rerender } = view(snapshot({ verifications: [{ ...base, phase: 'requested' }] }))
    await user.click(screen.getByRole('button', { name: 'Accept' }))
    expect(chat.verificationAction).toHaveBeenCalledWith('acct', 'req', 'accept')
    rerender(<ChatView chat={chat as never} snapshot={snapshot({ verifications: [{ ...base, phase: 'ready' }] })} onToast={toast} />)
    await user.click(screen.getByRole('button', { name: 'Compare emoji' }))
    expect(chat.verificationAction).toHaveBeenCalledWith('acct', 'req', 'start-sas')
    const emoji = Array.from({ length: 7 }, (_, index) => ({ symbol: '🐶', name: `Dog ${index}` }))
    rerender(<ChatView chat={chat as never} snapshot={snapshot({ verifications: [{ ...base, phase: 'show-sas', emoji }] })} onToast={toast} />)
    expect(within(screen.getByRole('list', { name: 'Verification emoji' })).getAllByRole('listitem')).toHaveLength(7)
    await user.click(screen.getByRole('button', { name: 'They match' }))
    expect(chat.verificationAction).toHaveBeenCalledWith('acct', 'req', 'confirm')
    // After a lock the emoji are cleared and confirmation is impossible.
    rerender(<ChatView chat={chat as never} snapshot={snapshot({ verifications: [{ ...base, phase: 'show-sas' }] })} onToast={toast} />)
    expect(screen.getByRole('button', { name: 'They match' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'They don’t match' }))
    expect(chat.verificationAction).toHaveBeenCalledWith('acct', 'req', 'mismatch')
  })

  it('sets up recovery once, restores from a recovery key and lists device trust', async () => {
    const user = userEvent.setup()
    chat.setupRecovery.mockResolvedValueOnce({ recoveryKey: 'EsTc 1234 abcd', backupComplete: false })
    const { rerender } = view(snapshot({ rooms: [] }))
    const devices = await screen.findByRole('region', { name: 'Devices' })
    expect(await within(devices).findByText('Phone')).toBeInTheDocument()
    expect(within(devices).getByText('AERIODEV · this device')).toBeInTheDocument()
    expect(within(devices).getByText('Verified')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /This device is not verified/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify with another session' }))
    expect(chat.verifyOwnDevice).toHaveBeenCalledWith('acct')
    await user.click(screen.getByRole('button', { name: 'Set up recovery' }))
    expect(await screen.findByLabelText('Recovery key')).toHaveTextContent('EsTc 1234 abcd')
    expect(screen.getByText(/still uploading/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I have saved it' }))
    expect(screen.queryByText('EsTc 1234 abcd')).not.toBeInTheDocument()

    chat.restoreFromRecoveryKey.mockResolvedValueOnce({ imported: 3, total: 4 })
    rerender(<ChatView chat={chat as never} snapshot={snapshot({ rooms: [], accounts: [{ ...account, recovery: 'needs-key' }] })} onToast={toast} />)
    await user.type(screen.getByRole('textbox', { name: 'Recovery key' }), 'EsTc 1234 abcd')
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(chat.restoreFromRecoveryKey).toHaveBeenCalledWith('acct', 'EsTc 1234 abcd')
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Restored 3 of 4 backed-up message keys'))
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toHaveValue('')
  })

  it('updates preferences and retention, clears history and removes the account', async () => {
    const user = userEvent.setup()
    chat.removeAccount.mockResolvedValueOnce({ remoteLogout: 'failed', message: 'The server could not be reached.' })
    view(snapshot({ rooms: [] }))
    await user.click(screen.getByRole('button', { name: 'Account settings' }))
    await user.click(screen.getByRole('checkbox', { name: /Message previews in notifications/ }))
    expect(chat.updatePreferences).toHaveBeenCalledWith('acct', { notificationPreviews: true })
    await user.clear(screen.getByLabelText('Days of history'))
    await user.type(screen.getByLabelText('Days of history'), '7')
    await user.click(within(screen.getByRole('form', { name: 'Local retention' })).getByRole('button', { name: 'Save' }))
    expect(chat.updatePreferences).toHaveBeenCalledWith('acct', { retention: { historyDays: 7, mediaCacheMiB: 250 } })
    await user.click(screen.getByRole('button', { name: /Clear local history/ }))
    expect(chat.clearHistory).toHaveBeenCalledWith('acct')
    await user.click(screen.getByRole('button', { name: /Remove account/ }))
    expect(chat.removeAccount).toHaveBeenCalledWith('acct')
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Account removed from this PC. The server could not be reached.'))
  })
})
