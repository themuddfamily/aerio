// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { ServerNote, ServerNotesSnapshot, VNotePreview } from '../server-notes-types'
import type { AppState, Note } from '../types'
import { confirmServerNotesRemoval } from '../lib/server-notes-removal'
import NotesView from './NotesView'

const owner = { provider: 'dav' as const, accountId: 'dav-1', folderId: 'journal' }
const serverNote = (overrides: Partial<ServerNote> = {}): ServerNote => ({
  id: 'srv-1', folder: 'Journal', title: 'Server plan', content: 'Synced body', tags: ['work'], pinned: false, archived: false, updatedAt: '2026-10-10T10:00:00Z',
  owner, readOnly: false, sync: 'synced', ...overrides
})
const localNote: Note = { id: 'local-1', folder: 'Personal', title: 'Local idea', content: 'Only here', tags: [], pinned: false, archived: false, updatedAt: '2026-10-09T10:00:00Z' }
const snapshot: ServerNotesSnapshot = {
  accounts: [{ id: 'dav-1', provider: 'dav', name: 'Fastmail', status: 'ready', pendingWrites: 0 }],
  folders: [
    { id: 'journal', accountId: 'dav-1', provider: 'dav', name: 'Journal', readOnly: false },
    { id: 'team', accountId: 'dav-1', provider: 'dav', name: 'Team notes', readOnly: true }
  ],
  notes: [serverNote(), serverNote({ id: 'srv-2', folder: 'Team notes', title: 'Team charter', content: 'Read only', readOnly: true, owner: { ...owner, folderId: 'team' } })],
  review: [{ id: 'op-1', noteId: 'srv-3', accountId: 'dav-1', folderId: 'journal', action: 'update', status: 'conflict', title: 'Contested', serverTitle: 'Contested', serverExcerpt: 'theirs', mineExcerpt: 'mine', error: 'Changed on the server since you edited it', serverDeleted: false, canKeepBoth: true, updatedAt: '2026-10-10T10:00:00Z' }]
}

const serverNotes = {
  snapshot: vi.fn(async () => snapshot),
  onChanged: vi.fn(() => () => undefined),
  sync: vi.fn(async () => snapshot),
  create: vi.fn(async (_folderId: string, note: Note) => serverNote({ ...note, id: 'srv-new', owner })),
  update: vi.fn(async (note: Note) => ({ ...serverNote(), ...note, sync: 'pending' as const })),
  remove: vi.fn(async () => snapshot),
  resolve: vi.fn(async () => ({ localNotes: [] as Note[] })),
  transfer: vi.fn(async () => ({ localNotes: [{ ...localNote, id: 'copied', title: 'Server plan', folder: 'Personal' }], removeLocalIds: [], copied: 1, pendingMoves: 0, errors: [] })),
  chooseVNoteFile: vi.fn(async (): Promise<VNotePreview> => ({
    token: 'tok', fileName: 'notes.vnt', count: 2, valid: 1, duplicates: 1, errors: [],
    entries: [{ index: 1, title: 'Local idea', excerpt: 'Only here', duplicate: { noteId: 'local-1', title: 'Local idea', reason: 'luid' } }, { index: 2, title: 'Untitled note', excerpt: '', error: 'This note has no BODY' }]
  })),
  previewVNote: vi.fn(),
  importVNote: vi.fn(async () => ({ localNotes: [], replacedLocal: [{ ...localNote, content: 'Replaced body' }], imported: 0, replaced: 1, skipped: 0, failed: 1, errors: ['Note 2: This note has no BODY'] })),
  accountSummary: vi.fn(async () => ({ accountId: 'dav-1', notes: 3, pendingWrites: 1, review: 0 })),
  copyAccountToLocal: vi.fn(async () => ({ copied: 3 }))
}
const productivity = {
  chooseNoteAttachments: vi.fn(async () => []), openNoteAttachment: vi.fn(async () => ({})), readNoteImage: vi.fn(async () => ''), saveNoteImage: vi.fn()
}

const state = (notes: Note[]): AppState => ({ accounts: [], events: [], contacts: [], tasks: [], notes })
const renderNotes = (onChange = vi.fn(), onToast = vi.fn()) => ({ onChange, onToast, ...render(<ContextMenuProvider><NotesView state={state([localNote])} query="" onChange={onChange} onToast={onToast} /></ContextMenuProvider>) })
const sidebarItem = (name: RegExp) => screen.getAllByRole('button').find((button) => button.classList.contains('sidebar-item') && name.test(button.textContent ?? ''))!

describe('server-synchronized Notes in the Notes view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'aerio', { configurable: true, value: { productivity, serverNotes } })
  })

  it('groups folders by owner and edits a provider note through the server queue', async () => {
    const { onChange } = renderNotes()
    await screen.findByText('Fastmail')
    expect(sidebarItem(/^Journal1$/)).toBeInTheDocument()
    expect(sidebarItem(/^Team notes1$/)).toBeInTheDocument()
    expect(sidebarItem(/^Personal1$/)).toBeInTheDocument()
    expect(sidebarItem(/^All notes3$/)).toBeInTheDocument()
    fireEvent.click(sidebarItem(/^Journal1$/))
    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument()
    expect(screen.getByText('Fastmail › Journal')).toBeInTheDocument()
    expect(screen.getByText('Synced')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Server plan v2' } })
    expect(screen.getByLabelText('Note title')).toHaveValue('Server plan v2')
    await waitFor(() => expect(serverNotes.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'srv-1', title: 'Server plan v2' })))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows read-only provider notes without editing controls', async () => {
    renderNotes()
    await screen.findByText('Fastmail')
    fireEvent.click(sidebarItem(/^Team notes1$/))
    expect(screen.getByText('Read-only on the server')).toBeInTheDocument()
    expect(screen.getByLabelText('Note title')).toHaveAttribute('readonly')
    expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute('contenteditable', 'false')
    expect(screen.queryByRole('toolbar', { name: 'Note formatting' })).not.toBeInTheDocument()
    expect(screen.getByTitle('Delete')).toBeDisabled()
    expect(screen.getByRole('button', { name: /New note/ })).toBeDisabled()
  })

  it('moves a provider note to Local through an explicit transfer', async () => {
    const { onChange, onToast } = renderNotes()
    await screen.findByText('Fastmail')
    fireEvent.click(sidebarItem(/^Journal1$/))
    fireEvent.click(screen.getByTitle('Move to another folder'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/deleted only after the copy exists/)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Move to'), { target: { value: 'local:Personal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Move$/ }))
    await waitFor(() => expect(serverNotes.transfer).toHaveBeenCalledWith({ mode: 'move', target: { kind: 'local', folder: 'Personal' }, serverNoteIds: ['srv-1'] }))
    expect((onChange.mock.lastCall![0] as AppState).notes.map((note) => note.id)).toEqual(['copied', 'local-1'])
    expect(onToast).toHaveBeenCalledWith('Moved to Local › Personal')
  })

  it('previews a vNote file and imports it with the chosen duplicate handling', async () => {
    const { onChange, onToast } = renderNotes()
    await screen.findByText('Fastmail')
    fireEvent.click(sidebarItem(/Import vNote/))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Choose .vnt file/ }))
    expect(await within(dialog).findByText('2 notes found · 1 readable · 1 duplicate in this folder')).toBeInTheDocument()
    expect(within(dialog).getByText('Duplicate of “Local idea” (same X-IRMC-LUID)')).toBeInTheDocument()
    expect(within(dialog).getByText('This note has no BODY')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Import 0 notes' })).toBeDisabled()
    fireEvent.click(within(dialog).getByLabelText('Replace the existing notes'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 note' }))
    await waitFor(() => expect(serverNotes.importVNote).toHaveBeenCalledWith({ token: 'tok', target: { kind: 'local', folder: 'Personal' }, duplicates: 'replace' }))
    expect((onChange.mock.lastCall![0] as AppState).notes).toEqual([expect.objectContaining({ id: 'local-1', content: 'Replaced body' })])
    expect(onToast).toHaveBeenCalledWith('0 notes imported into Local › Personal · 1 replaced · 1 could not be read')
  })

  it('reviews conflicts with keep mine, keep server, and keep both', async () => {
    renderNotes()
    fireEvent.click(await screen.findByRole('button', { name: /Notes to review/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Changed on the server since you edited it')).toBeInTheDocument()
    expect(within(dialog).getByText('mine')).toBeInTheDocument()
    expect(within(dialog).getByText(/theirs/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Keep both' })) })
    expect(serverNotes.resolve).toHaveBeenCalledWith('op-1', 'keep-both')
  })

  it('offers to copy an account’s notes to Local before the account is removed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(await confirmServerNotesRemoval('dav-1', 'Fastmail')).toBe(true)
    expect(confirm.mock.calls[0][0]).toContain('3 synchronized notes in Aerio, including 1 change not yet accepted by the server')
    expect(serverNotes.copyAccountToLocal).toHaveBeenCalledWith('dav-1')
    expect(await confirmServerNotesRemoval('dav-1', 'Fastmail')).toBe(true)
    expect(serverNotes.copyAccountToLocal).toHaveBeenCalledTimes(1)
    serverNotes.copyAccountToLocal.mockRejectedValueOnce(new Error('disk full'))
    confirm.mockReturnValueOnce(true)
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    expect(await confirmServerNotesRemoval('dav-1', 'Fastmail')).toBe(false)
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })
})
