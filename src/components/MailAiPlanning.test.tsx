// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import MailAiPlanning from './MailAiPlanning'
import { notifyAiSettingsChanged } from '../lib/use-ai-assistant'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { MailMessageDetail } from '../mail-types'
const status: AiAssistantStatus = { enabled: true, automaticPlanning: false, provider: 'anthropic', model: 'test', baseUrl: '', hasApiKey: true, secureStorage: true, includeSenderDetails: false, features: { summarize: true, compose: true, replies: true, rules: true, search: true, planning: true } }
const message = { accountId: 'a', threadId: 't', id: 'm', subject: 'Plan', text: 'Review by Friday', fromEmail: 'you@example.test', to: [], cc: [], date: '2026-10-20T09:00:00Z', labelIds: ['INBOX'], attachments: [] } as unknown as MailMessageDetail
const detect = vi.fn(), create = vi.fn(), cancel = vi.fn()
beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: vi.fn() } })
  vi.clearAllMocks(); detect.mockResolvedValue([{ kind: 'task', title: 'Review figures', notes: 'Check report', due: '2026-10-23' }]); create.mockResolvedValue({}); cancel.mockResolvedValue(true)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai: { status: vi.fn().mockResolvedValue(status), detectPlanning: detect, cancel }, mail: { accounts: { list: vi.fn().mockResolvedValue([{ id: 'a', email: 'me@example.test' }]) }, messageTools: { createTask: create } } } })
})
it('requires separate opt-in and lets the user review/edit before explicit creation', async () => {
  const user = userEvent.setup()
  render(<MailAiPlanning message={message} onToast={vi.fn()} />)
  await act(async () => { await Promise.resolve() })
  expect(detect).not.toHaveBeenCalled()
  act(() => notifyAiSettingsChanged({ ...status, automaticPlanning: true }))
  await user.click(await screen.findByRole('button', { name: 'Review task' }))
  expect(create).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Title')).toHaveValue('Review figures')
  expect(screen.getByLabelText('Due date')).toHaveValue('2026-10-23')
  await user.clear(screen.getByLabelText('Title')); await user.type(screen.getByLabelText('Title'), 'Review edited figures')
  await user.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith({ accountId: 'a', threadId: 't', messageId: 'm' }, expect.objectContaining({ title: 'Review edited figures' })))
})
it('cancels a pending request on close and drops late suggestions', async () => {
  let resolve!: (value: unknown[]) => void
  detect.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const view = render(<MailAiPlanning message={message} onToast={vi.fn()} />)
  act(() => notifyAiSettingsChanged({ ...status, automaticPlanning: true }))
  // Wait for status loading before enabling again, so the initial read cannot overwrite it.
  await act(async () => { await Promise.resolve() })
  act(() => notifyAiSettingsChanged({ ...status, automaticPlanning: true }))
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(1))
  view.unmount()
  expect(cancel).toHaveBeenCalledWith(detect.mock.calls[0][0])
  await act(async () => resolve([{ kind: 'task', title: 'Late', notes: '' }]))
  expect(create).not.toHaveBeenCalled()
})

it('does not let a late settings read re-enable disabled automatic analysis', async () => {
  let resolve!: (value: AiAssistantStatus) => void
  window.aerio.ai.status = vi.fn(() => new Promise<AiAssistantStatus>((done) => { resolve = done }))
  render(<MailAiPlanning message={message} onToast={vi.fn()} />)
  act(() => notifyAiSettingsChanged({ ...status, automaticPlanning: false }))
  await act(async () => resolve({ ...status, automaticPlanning: true }))
  await new Promise((done) => setTimeout(done, 450))
  expect(detect).not.toHaveBeenCalled()
})
