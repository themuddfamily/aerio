// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MessageToolbar from './MessageToolbar'
import type { MessageToolbarCommand } from '../lib/message-toolbar'
let listener: ((layout: MessageToolbarCommand[]) => void) | undefined
const api = { get: vi.fn(async (): Promise<MessageToolbarCommand[]> => ['reply', 'trash']), set: vi.fn(async (layout: MessageToolbarCommand[]) => layout), onChange: vi.fn((callback: typeof listener) => { listener = callback; return vi.fn() }) }
beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue(['reply', 'trash']); api.set.mockImplementation(async (layout) => layout); Object.defineProperty(window, 'aerio', { configurable: true, value: { messageToolbar: api } }) })
describe('customizable message toolbar', () => {
  it('loads visibility/order, reorders and hides commands, and saves the chosen layout', async () => {
    const reply = vi.fn()
    render(<MessageToolbar onToast={vi.fn()} commands={{ reply: <button onClick={reply}>Reply fixture</button>, trash: <button>Trash fixture</button>, archive: <button>Archive fixture</button> }} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive fixture' })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Reply fixture' })); expect(reply).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Customize message toolbar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Trash / restore up' }))
    fireEvent.click(screen.getByLabelText('Reply'))
    fireEvent.click(screen.getByLabelText('Archive / inbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save toolbar' }))
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(['trash', 'archive']))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.querySelectorAll('[data-toolbar-command]')[0]).toHaveAttribute('data-toolbar-command', 'trash')
    expect(screen.queryByRole('button', { name: 'Reply fixture' })).not.toBeInTheDocument()
  })
  it('receives changes from other readers and keeps failed edits open', async () => {
    render(<MessageToolbar onToast={vi.fn()} commands={{ reply: <button>Reply fixture</button>, trash: <button disabled>Trash fixture</button> }} />)
    await screen.findByRole('button', { name: 'Reply fixture' })
    act(() => listener?.(['trash']))
    expect(screen.getByRole('button', { name: 'Trash fixture' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Reply fixture' })).not.toBeInTheDocument()
    api.set.mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(screen.getByRole('button', { name: 'Customize message toolbar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save toolbar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
