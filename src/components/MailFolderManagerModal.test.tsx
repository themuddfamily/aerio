// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import MailFolderManagerModal from './MailFolderManagerModal'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'a', provider: 'imap', email: 'person@example.test', displayName: 'Person', color: '#123456',
  status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})

const imapLabels: MailLabel[] = [
  { accountId: 'a', id: 'folder:INBOX', name: 'INBOX', type: 'system' },
  { accountId: 'a', id: 'folder:Work', name: 'Work', type: 'user' },
  { accountId: 'a', id: 'folder:Work/Acme', name: 'Work/Acme', type: 'user', parentId: 'folder:Work' }
]

describe('MailFolderManagerModal', () => {
  let api: Record<'create' | 'update' | 'delete' | 'deletePreview', ReturnType<typeof vi.fn>>

  beforeEach(() => {
    api = {
      create: vi.fn().mockResolvedValue({ labels: [...imapLabels, { accountId: 'a', id: 'folder:Work/Beta', name: 'Work/Beta', type: 'user', parentId: 'folder:Work' }], renamed: {} }),
      update: vi.fn().mockResolvedValue({ labels: imapLabels, renamed: { 'folder:Work/Acme': 'folder:Acme' } }),
      delete: vi.fn().mockResolvedValue({ labels: imapLabels.slice(0, 2), renamed: {}, deletedId: 'folder:Work/Acme' }),
      deletePreview: vi.fn().mockResolvedValue({ labelId: 'folder:Work/Acme', messages: 4, threads: 2, childFolders: 0, pendingOperations: 0, deleteKeepsMessages: false, messagesMoveTo: 'Trash' })
    }
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { folders: api } } })
  })

  it('shows nested folders, locks system folders and creates a nested folder', async () => {
    const onChanged = vi.fn()
    render(<MailFolderManagerModal accounts={[account()]} labels={imapLabels} onChanged={onChanged} onToast={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('System folder')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit INBOX' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /New folder/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Projects'), { target: { value: 'acme' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'folder:Work' } })
    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
    expect(screen.getByRole('button', { name: /Create folder/ })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('e.g. Projects'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: /Create folder/ }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ accountId: 'a', name: 'Beta', parentId: 'folder:Work' }))
    expect(onChanged).toHaveBeenCalledWith('a', expect.objectContaining({ renamed: {} }))
    expect(await screen.findByText('Beta')).toBeInTheDocument()
  })

  it('renames a folder and reports path changes to the caller', async () => {
    const onChanged = vi.fn()
    render(<MailFolderManagerModal accounts={[account()]} labels={imapLabels} onChanged={onChanged} onToast={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Acme' }))
    // A folder cannot be nested inside itself.
    expect(screen.queryByRole('option', { name: /Acme/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ accountId: 'a', labelId: 'folder:Work/Acme', parentId: null }))
    expect(onChanged).toHaveBeenCalledWith('a', expect.objectContaining({ renamed: { 'folder:Work/Acme': 'folder:Acme' } }))
  })

  it('requires explicit confirmation to delete a non-empty folder', async () => {
    const onToast = vi.fn()
    render(<MailFolderManagerModal accounts={[account()]} labels={imapLabels} onChanged={vi.fn()} onToast={onToast} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Acme' }))
    expect(await screen.findByText(/4 messages in 2 conversations/)).toHaveTextContent('moved to Trash')
    const remove = screen.getByRole('button', { name: 'Delete folder' })
    expect(remove).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(remove)
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith({ accountId: 'a', labelId: 'folder:Work/Acme', confirmNonEmpty: true }))
    expect(onToast).toHaveBeenCalledWith('Folder deleted')
  })

  it('asks again when the server holds messages the cache did not know about', async () => {
    api.deletePreview.mockResolvedValueOnce({ labelId: 'folder:Work/Acme', messages: 0, threads: 0, childFolders: 0, pendingOperations: 0, deleteKeepsMessages: false, messagesMoveTo: 'Trash' })
    api.delete.mockRejectedValueOnce(new Error('This folder contains 7 messages on the server. Confirm deletion to continue.'))
    const onToast = vi.fn()
    render(<MailFolderManagerModal accounts={[account()]} labels={imapLabels} onChanged={vi.fn()} onToast={onToast} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Acme' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete folder' }))
    expect(await screen.findByText(/7 messages/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete folder' })).toBeDisabled()
    expect(api.delete).toHaveBeenCalledWith(expect.objectContaining({ confirmNonEmpty: false }))
  })

  it('blocks deletion while subfolders or pending changes depend on the folder', async () => {
    api.deletePreview.mockResolvedValueOnce({ labelId: 'folder:Work', messages: 0, threads: 0, childFolders: 1, pendingOperations: 0, deleteKeepsMessages: false })
    render(<MailFolderManagerModal accounts={[account()]} labels={imapLabels} onChanged={vi.fn()} onToast={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Work' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('1 subfolder first')
    expect(screen.getByRole('button', { name: 'Delete folder' })).toBeDisabled()
  })

  it('offers Gmail palette colors and hides Gmail system labels', async () => {
    const labels: MailLabel[] = [
      { accountId: 'g', id: 'INBOX', name: 'INBOX', type: 'system' },
      { accountId: 'g', id: 'L1', name: 'Receipts', type: 'user', color: '#fb4c2f' }
    ]
    api.update.mockResolvedValueOnce({ labels, renamed: {} })
    render(<MailFolderManagerModal accounts={[account({ id: 'g', provider: 'gmail' })]} labels={labels} onChanged={vi.fn()} onToast={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByText('INBOX')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Receipts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith({ accountId: 'g', labelId: 'L1', color: '#4a86e8' }))
  })
})
