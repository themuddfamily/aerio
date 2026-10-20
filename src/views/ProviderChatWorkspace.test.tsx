// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ProviderChatWorkspace from './ProviderChatWorkspace'
import type { ProviderChatApi, ProviderChatSnapshot } from '../provider-chat-types'
const snapshot: ProviderChatSnapshot = { available: true, providers: [
  { id: 'teams', name: 'Microsoft Teams', available: true, detail: 'Work or school account', fields: [{ key: 'channels', label: 'Include channels', type: 'checkbox' }] },
  { id: 'slack', name: 'Slack', available: true, detail: 'Workspace token', fields: [{ key: 'token', label: 'User token', type: 'password', required: true }] }
], accounts: [{ id: 'a', provider: 'teams', remoteUserId: 'user', name: 'Alice', status: 'ready', notificationPreviews: false }], rooms: [{ accountId: 'a', id: 'r', name: 'Team room', kind: 'channel', unread: 1, canReadReceipt: true, canSend: true, threaded: true, resource: {} }] }
function setup() {
  const api: ProviderChatApi = { snapshot: vi.fn(async () => snapshot), connect: vi.fn(async () => snapshot.accounts[0]), remove: vi.fn(async () => {}), refresh: vi.fn(async () => {}), messages: vi.fn(async () => ({ items: [{ id: 'm', senderId: 'bob', sender: 'Bob', timestamp: '2026-01-01T00:00:00Z', body: '<script>plain text</script>', own: false }] })), send: vi.fn(async () => ({ id: 'sent', senderId: 'user', sender: 'Alice', timestamp: '', body: 'hello', own: true })), markRead: vi.fn(async () => {}), preferences: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) }
  const onToast = vi.fn()
  render(<ProviderChatWorkspace api={api} snapshot={snapshot} matrixDetail="Matrix gate requires setup" onToast={onToast} />)
  return { api, user: userEvent.setup(), onToast }
}
it('offers available Teams and Slack connections independently of Matrix gate', async () => {
  const f = setup()
  expect(screen.queryByRole('button', { name: 'Matrix' })).not.toBeInTheDocument()
  expect(screen.getByText('Matrix: Matrix gate requires setup')).toBeInTheDocument()
  await f.user.click(screen.getByLabelText('Include channels')); await f.user.click(screen.getByRole('button', { name: 'Connect account' }))
  await waitFor(() => expect(f.api.connect).toHaveBeenCalledWith('teams', { channels: true }, undefined))
  await f.user.selectOptions(screen.getByLabelText('Provider'), 'slack')
  await f.user.type(screen.getByLabelText('User token'), 'xoxp-example')
  await f.user.click(screen.getByRole('button', { name: 'Connect account' }))
  await waitFor(() => expect(f.api.connect).toHaveBeenLastCalledWith('slack', { token: 'xoxp-example' }, undefined))
})
it('reads plain messages, sends explicit channel replies and sets server read state', async () => {
  const f = setup(); await f.user.click(screen.getByRole('button', { name: /Team room/ }))
  expect(await screen.findByText('<script>plain text</script>')).toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
  await f.user.click(screen.getByRole('button', { name: 'Mark read on server' })); expect(f.api.markRead).toHaveBeenCalledWith('a', 'r')
  await f.user.click(screen.getByRole('button', { name: 'Open replies' }))
  await waitFor(() => expect(f.api.messages).toHaveBeenLastCalledWith('a', 'r', { threadId: 'm' }))
  await f.user.type(screen.getByLabelText('Reply'), 'hello'); await f.user.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith('a', 'r', 'hello', 'm'))
})
it('retains draft after unconfirmed sends and surfaces the error', async () => {
  const f = setup(); vi.mocked(f.api.send).mockRejectedValue(new Error('Check Teams before resending'))
  await f.user.click(screen.getByRole('button', { name: /Team room/ })); await f.user.type(screen.getByLabelText('Message'), 'keep draft')
  await f.user.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Check Teams before resending')
  expect(screen.getByLabelText('Message')).toHaveValue('keep draft')
})
