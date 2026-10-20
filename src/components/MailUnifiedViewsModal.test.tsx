// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import MailUnifiedViewsModal from './MailUnifiedViewsModal'

const accounts = ['a', 'b'].map((id): MailAccountSummary => ({ id, provider: 'gmail', email: `${id}@example.test`, displayName: id, color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }))
describe('unified account view configuration', () => {
  it('saves named account membership and a deliberately empty folder override', async () => {
    const save = vi.fn(async () => {})
    render(<MailUnifiedViewsModal accounts={accounts} views={[]} onSave={save} onRemove={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Save view' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Work' } })
    const base = within(screen.getByRole('group', { name: 'Included accounts' }))
    fireEvent.click(base.getByLabelText('a@example.test')); fireEvent.click(base.getByLabelText('b@example.test'))
    fireEvent.click(screen.getByLabelText('Customize accounts for this folder'))
    const folder = within(screen.getByRole('group', { name: 'Folder membership' }))
    fireEvent.click(folder.getByLabelText('a@example.test')); fireEvent.click(folder.getByLabelText('b@example.test'))
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ id: undefined, name: 'Work', accountIds: ['a', 'b'], folderAccountIds: { inbox: [] } }))
  })

  it('edits saved views and removes accounts from overrides when base membership changes', async () => {
    const save = vi.fn(async () => {}), remove = vi.fn(async () => {})
    const view = { id: 'work', name: 'Work', accountIds: ['a', 'b'], folderAccountIds: { inbox: ['a', 'b'] } }
    render(<MailUnifiedViewsModal accounts={accounts} views={[view]} onSave={save} onRemove={remove} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: 'work' } })
    fireEvent.click(within(screen.getByRole('group', { name: 'Included accounts' })).getByLabelText('b@example.test'))
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ id: 'work', name: 'Work', accountIds: ['a'], folderAccountIds: { inbox: ['a'] } }))
    fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete view' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('work'))
  })
})
