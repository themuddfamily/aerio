// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DelegateTaskButton, DelegationDetails, TaskDelegationMessage, TaskDelegationPanel } from './TaskDelegation'
import type { DelegatedTask } from '../task-delegation-types'
const task = (overrides: Partial<DelegatedTask> = {}): DelegatedTask => ({ id: 'assignment', accountId: 'account', uid: 'uid', role: 'assignee', organizer: 'sender@example.test', assignee: 'me@example.test', title: 'Review request', notes: 'Read draft', sequence: 0, stamp: '20261020T120000Z', participation: 'NEEDS-ACTION', status: 'NEEDS-ACTION', percent: 0, updatedAt: 'revision', deliveries: [], ...overrides })
const api = { list: vi.fn(), assign: vi.fn(), update: vi.fn(), respond: vi.fn(), inspect: vi.fn(), retry: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  api.list.mockResolvedValue([]); api.assign.mockResolvedValue(task()); api.respond.mockResolvedValue(task({ participation: 'ACCEPTED' }))
  Object.defineProperty(window, 'aerio', { configurable: true, value: { taskDelegations: api, mail: { accounts: { list: vi.fn(async () => [{ id: 'account', email: 'me@example.test', provider: 'imap', archived: false }]) } } } })
})
describe('task delegation UI', () => {
  it('creates a mail request only when Send is clicked and includes the original task link', async () => {
    const user = userEvent.setup()
    render(<DelegateTaskButton title="Source title" notes="Source notes" due="2026-12-01T10:00:00Z" source={{ kind: 'provider', id: 'provider-id' }} />)
    await user.click(screen.getByRole('button', { name: 'Delegate Source title' }))
    expect(api.assign).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Assign to'), 'recipient@example.test')
    await user.click(screen.getByRole('button', { name: 'Send task request' }))
    await waitFor(() => expect(api.assign).toHaveBeenCalledWith({ accountId: 'account', assignee: 'recipient@example.test', title: 'Source title', notes: 'Source notes', due: '2026-12-01', source: { kind: 'provider', id: 'provider-id' } }))
  })
  it('recognizes received task requests and sends explicit acceptance with a comment', async () => {
    api.inspect.mockResolvedValue(task())
    const user = userEvent.setup()
    render(<TaskDelegationMessage accountId="account" messageId="message" />)
    await screen.findByRole('heading', { name: 'Review request' })
    expect(api.inspect).toHaveBeenCalledWith('account', 'message')
    expect(api.respond).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Reply comment'), 'I will do it')
    await user.click(screen.getByRole('button', { name: 'Accept and send reply' }))
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith(expect.objectContaining({ id: 'assignment', expectedUpdatedAt: 'revision', response: 'accept', comment: 'I will do it' })))
    expect(await screen.findByRole('button', { name: 'Send progress' })).toBeInTheDocument()
  })
  it('sends progress and completed replies from accepted tasks', async () => {
    const changed = vi.fn(), user = userEvent.setup()
    render(<DelegationDetails task={task({ participation: 'ACCEPTED' })} onChanged={changed} />)
    fireEvent.change(screen.getByLabelText('Progress (%)'), { target: { value: '70' } })
    await user.click(screen.getByRole('button', { name: 'Send progress' }))
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith(expect.objectContaining({ response: 'progress', percent: 70 })))
    await user.click(screen.getByRole('button', { name: 'Complete and send reply' }))
    expect(api.respond).toHaveBeenLastCalledWith(expect.objectContaining({ response: 'complete' }))
  })
  it('opens the linked original task and sends organizer updates with optimistic version checks', async () => {
    api.update.mockResolvedValue(task({ role: 'organizer' }))
    const open = vi.fn(), user = userEvent.setup()
    render(<DelegationDetails task={task({ role: 'organizer', source: { kind: 'local', id: 'task' } })} onChanged={vi.fn()} onOpenSource={open} />)
    await user.click(screen.getByRole('button', { name: 'Open original task' }))
    expect(open).toHaveBeenCalledWith({ kind: 'local', id: 'task' })
    await user.click(screen.getByRole('button', { name: 'Update request' }))
    await user.clear(screen.getByLabelText('Task title')); await user.type(screen.getByLabelText('Task title'), 'Updated title')
    await user.click(screen.getByRole('button', { name: 'Send updated request' }))
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: 'revision', title: 'Updated title' }))
  })
  it('shows queued and failed delivery state and explains provider limitations', async () => {
    api.list.mockResolvedValue([task({ deliveries: [{ id: 'draft', method: 'REQUEST', status: 'send-pending' }] })])
    render(<TaskDelegationPanel onOpenSource={vi.fn()} />)
    expect(await screen.findByText('REQUEST: Waiting in Outbox')).toBeInTheDocument()
    expect(screen.getByText(/Google Tasks and Microsoft To Do do not expose native assignment APIs/)).toBeInTheDocument()
  })
})
