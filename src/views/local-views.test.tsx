// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState } from '../types'
import type { SyncedContact } from '../productivity-types'
import ContactsView from './ContactsView'
import NotesView from './NotesView'
import TasksView, { toggleTaskWithRecurrence } from './TasksView'

const state = (overrides: Partial<AppState> = {}): AppState => ({
  accounts: [], events: [], contacts: [{
    id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', phone: '+44 123', company: 'Analytical Engines', title: 'Engineer', group: 'Work', notes: 'First programmer', favorite: true, color: '#6558e8'
  }, {
    id: 'grace', name: 'Grace Hopper', email: 'grace@example.test', group: 'Friends', favorite: false, color: '#438f78'
  }],
  tasks: [{
    id: 'task-1', listId: 'Today', title: 'Ship Aerio', notes: 'Run tests', due: '2026-08-08T09:00:00Z', priority: 'high', completed: false,
    subtasks: [{ id: 'sub-1', title: 'Package', completed: false }], recurrence: 'weekly'
  }, {
    id: 'task-2', listId: 'Today', title: 'Celebrate', priority: 'low', completed: true, subtasks: []
  }, {
    id: 'task-3', listId: 'Someday', title: 'Future idea', priority: 'normal', completed: false, subtasks: []
  }],
  notes: [{
    id: 'note-1', folder: 'Personal', title: 'Launch notes', content: 'Keep this local and useful.', tags: ['aerio', 'launch'], pinned: true, archived: false, updatedAt: '2026-08-08T10:00:00Z', color: '#fff0aa'
  }, {
    id: 'note-2', folder: 'Studio', title: 'Archived thought', content: '', tags: ['archive'], pinned: false, archived: true, updatedAt: '2026-08-01T10:00:00Z'
  }],
  ...overrides
})

const renderInMenu = (node: React.ReactNode) => render(<ContextMenuProvider>{node}</ContextMenuProvider>)

const noteProductivity = {
  chooseNoteAttachments: vi.fn(async () => [] as any[]),
  openNoteAttachment: vi.fn(async () => ({}))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.confirm = vi.fn(() => true)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
  noteProductivity.chooseNoteAttachments.mockResolvedValue([])
  noteProductivity.openNoteAttachment.mockResolvedValue({})
  Object.defineProperty(window, 'aerio', { configurable: true, value: { productivity: noteProductivity } })
})

describe('ContactsView', () => {
  it('creates, edits, and deletes local contacts', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    const local = { id: 'local', name: 'Local Person', email: 'local@example.test', group: 'Personal', favorite: false, color: '#4d8f78', source: 'local' as const }
    const { rerender } = renderInMenu(<ContactsView state={state({ contacts: [local] })} query="" onCompose={vi.fn()} onToast={onToast} onSync={vi.fn()} onLocalContactsChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'New contact' }))
    await user.type(screen.getByLabelText('Name'), 'New Person')
    await user.type(screen.getByLabelText('Email'), 'new@example.test')
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'New Person', source: 'local' })]))

    rerender(<ContextMenuProvider><ContactsView state={state({ contacts: [local] })} query="" onCompose={vi.fn()} onToast={onToast} onSync={vi.fn()} onLocalContactsChange={onChange} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Local Person/ }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'Updated Person')
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'local', name: 'Updated Person' })])

    rerender(<ContextMenuProvider><ContactsView state={state({ contacts: [local] })} query="" onCompose={vi.fn()} onToast={onToast} onSync={vi.fn()} onLocalContactsChange={onChange} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Local Person/ }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(onToast).toHaveBeenLastCalledWith('Contact deleted')
  })

  it('syncs, filters groups and search, selects contacts, emails, and handles missing phone numbers', async () => {
    const user = userEvent.setup(), onCompose = vi.fn(), onToast = vi.fn(), onSync = vi.fn(async () => undefined)
    const { rerender } = renderInMenu(<ContactsView state={state()} query="" onCompose={onCompose} onToast={onToast} onSync={onSync} sourceMessage="Google contacts" />)
    expect(screen.getByText('Google contacts')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Sync now/ })); expect(onSync).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Favourites/ })); expect(screen.getByText('1 people')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /All contacts/ }))
    await user.click(screen.getByRole('button', { name: /Grace Hopper/ }))
    await user.click(screen.getByRole('button', { name: 'Email' })); expect(onCompose).toHaveBeenCalledWith('grace@example.test')
    await user.click(screen.getByRole('button', { name: 'Call' })); expect(onToast).toHaveBeenCalledWith('No phone number saved')
    rerender(<ContextMenuProvider><ContactsView state={state()} query="analytical" onCompose={onCompose} onToast={onToast} onSync={onSync} syncing /></ContextMenuProvider>)
    expect(screen.getByRole('button', { name: /Syncing/ })).toBeDisabled()
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0); expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument()
  })

  it('offers contact and group context actions including copied details', async () => {
    const user = userEvent.setup(), onCompose = vi.fn()
    renderInMenu(<ContactsView state={state()} query="" onCompose={onCompose} onToast={vi.fn()} onSync={vi.fn()} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /Ada Lovelace/ }), { clientX: 20, clientY: 20 })
    await user.click(screen.getByRole('menuitem', { name: 'Copy email address' }))
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Copy email address' })).not.toBeInTheDocument())
    fireEvent.contextMenu(screen.getByRole('button', { name: /Work/ }), { clientX: 20, clientY: 20 })
    await user.click(screen.getByRole('menuitem', { name: 'Open Work' }))
    expect(screen.getByRole('heading', { name: 'Work' })).toBeInTheDocument()
  })

  it('runs contact-card and detail-field actions and renders an empty selection', async () => {
    const user = userEvent.setup(), onCompose = vi.fn(), onToast = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { rerender } = renderInMenu(<ContactsView state={state()} query="" onCompose={onCompose} onToast={onToast} onSync={vi.fn()} />)
    const contact = screen.getByRole('button', { name: /Ada Lovelace/ })
    const contactAction = async (name: string) => {
      fireEvent.contextMenu(contact)
      await user.click(screen.getByRole('menuitem', { name }))
    }
    await contactAction('Email')
    expect(onCompose).toHaveBeenCalledWith('ada@example.test')
    await contactAction('Copy email address')
    await contactAction('Copy phone number')
    expect(writeText).toHaveBeenCalledWith('+44 123')

    const details = within(document.querySelector('.contact-detail-grid')!)
    const detailAction = async (text: string, name: string) => {
      fireEvent.contextMenu(details.getByText(text).closest('div')!)
      await user.click(screen.getByRole('menuitem', { name }))
    }
    await detailAction('ada@example.test', 'Email contact')
    await detailAction('+44 123', 'Call Ada Lovelace')
    expect(onToast).toHaveBeenCalledWith('Call +44 123')
    await detailAction('Analytical Engines', 'Copy company')
    await detailAction('Work', 'Copy group')
    fireEvent.contextMenu(screen.getByText('First programmer').closest('section')!)
    await user.click(screen.getByRole('menuitem', { name: 'Copy notes' }))
    expect(writeText).toHaveBeenCalledWith('First programmer')

    rerender(<ContextMenuProvider><ContactsView state={state({ contacts: [] })} query="" onCompose={onCompose} onToast={onToast} onSync={vi.fn()} /></ContextMenuProvider>)
    expect(screen.getByText('Select a contact')).toBeInTheDocument()
  })

  it('enables, creates, updates, and deletes provider contacts', async () => {
    const user = userEvent.setup()
    const onEnableEditing = vi.fn(async () => undefined)
    const onSaveProviderContact = vi.fn(async (_accountId: string, contact: any) => ({ ...contact, remoteId: 'people/1', accountId: 'google', provider: 'gmail', readOnly: false }))
    const onDeleteProviderContact = vi.fn(async () => undefined)
    const provider = {
      id: 'google:google-contact:people/1', remoteId: 'people/1', accountId: 'google', provider: 'gmail', readOnly: true,
      name: 'Provider Person', email: 'provider@example.test', group: 'Google', favorite: false, color: '#4d8f78'
    } satisfies SyncedContact
    const props = {
      query: '', onCompose: vi.fn(), onToast: vi.fn(), onSync: vi.fn(), onEnableEditing, onSaveProviderContact, onDeleteProviderContact,
      providerAccounts: [{ id: 'google', email: 'google@example.test', provider: 'gmail' as const }]
    }
    const { rerender } = renderInMenu(<ContactsView state={state({ contacts: [provider] })} {...props} />)
    await user.click(screen.getByRole('button', { name: 'Enable editing' }))
    expect(onEnableEditing).toHaveBeenCalled()

    const writable = { ...provider, readOnly: false }
    rerender(<ContextMenuProvider><ContactsView state={state({ contacts: [writable] })} {...props} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'Updated Provider')
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    await waitFor(() => expect(onSaveProviderContact).toHaveBeenCalledWith('google', expect.objectContaining({ id: writable.id, name: 'Updated Provider' }), true))

    await user.click(screen.getByRole('button', { name: 'New contact' }))
    await user.selectOptions(screen.getByLabelText('Save to'), 'google')
    await user.type(screen.getByLabelText('Name'), 'New Provider')
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    await waitFor(() => expect(onSaveProviderContact).toHaveBeenLastCalledWith('google', expect.objectContaining({ name: 'New Provider' }), false))

    rerender(<ContextMenuProvider><ContactsView state={state({ contacts: [writable] })} {...props} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDeleteProviderContact).toHaveBeenCalledWith(writable.id))
  })
})

describe('NotesView', () => {
  it('edits every note field, pins, archives, and deletes the selected note', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    renderInMenu(<NotesView state={state()} query="" onChange={onChange} onToast={onToast} />)
    await user.clear(screen.getByLabelText('Note title')); await user.type(screen.getByLabelText('Note title'), 'Updated note')
    await user.selectOptions(screen.getByLabelText('Note folder'), 'Studio')
    const tags = screen.getByPlaceholderText('Add tags, separated by commas'); await user.clear(tags); await user.type(tags, 'one, two')
    const content = screen.getByPlaceholderText('Start writing…'); await user.clear(content); await user.type(content, 'Three useful words')
    await user.click(screen.getByTitle('Pin note'))
    expect(onChange).toHaveBeenCalled()
    await user.click(screen.getByTitle('Archive')); expect(onToast).toHaveBeenCalledWith('Note archived')
    await user.click(Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-item')).find((button) => button.querySelector('span')?.textContent === 'Archive')!)
    await user.click(screen.getByRole('button', { name: /Archived thought/ }))
    await user.click(screen.getByTitle('Delete')); expect(onToast).toHaveBeenCalledWith('Note deleted')
  })

  it('adds, opens, removes, and searches managed attachments', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    const attachment = { id: 'attachment-1', name: 'project-brief.pdf', size: 2048, path: 'C:/aerio/note-attachments/brief.pdf', mime: 'pdf' }
    noteProductivity.chooseNoteAttachments.mockResolvedValueOnce([attachment])
    const { rerender } = renderInMenu(<NotesView state={state()} query="" onChange={onChange} onToast={onToast} />)

    await user.click(screen.getByTitle('Attach files'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ notes: expect.arrayContaining([
      expect.objectContaining({ id: 'note-1', attachments: [attachment] })
    ]) })))
    expect(onToast).toHaveBeenCalledWith('1 attachment added')

    const attachedState = state({ notes: [{ ...state().notes[0], attachments: [attachment] }, state().notes[1]] })
    rerender(<ContextMenuProvider><NotesView state={attachedState} query="project-brief" onChange={onChange} onToast={onToast} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /^project-brief\.pdf/ }))
    expect(noteProductivity.openNoteAttachment).toHaveBeenCalledWith(attachment.path)
    await user.click(screen.getByRole('button', { name: 'Remove project-brief.pdf' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.arrayContaining([
      expect.objectContaining({ id: 'note-1', attachments: [] })
    ]) }))
  })

  it('creates notes, switches layouts, filters folders and tags, and renders empty searches', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    const { rerender } = renderInMenu(<NotesView state={state()} query="" onChange={onChange} onToast={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /New note/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ notes: expect.arrayContaining([expect.objectContaining({ title: 'Untitled note' })]) }))
    await user.click(screen.getByRole('button', { name: 'Grid view' })); expect(document.querySelector('.notes-grid')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'aerio' })); expect(screen.getByRole('heading', { name: '#aerio' })).toBeInTheDocument()
    await user.click(Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-item')).find((button) => button.querySelector('span')?.textContent === 'Archive')!); expect(screen.getByText('Archived thought')).toBeInTheDocument()
    rerender(<ContextMenuProvider><NotesView state={state()} query="no matching note" onChange={onChange} onToast={vi.fn()} /></ContextMenuProvider>)
    expect(screen.getByText('No notes here')).toBeInTheDocument()
  })

  it('duplicates, archives, restores, and deletes notes from context menus', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    renderInMenu(<NotesView state={state()} query="" onChange={onChange} onToast={onToast} />)
    const card = screen.getByRole('button', { name: /Launch notes/ })
    fireEvent.contextMenu(card); await user.click(screen.getByRole('menuitem', { name: 'Duplicate note' }))
    expect(onToast).toHaveBeenCalledWith('Note duplicated')
    fireEvent.contextMenu(card); await user.click(screen.getByRole('menuitem', { name: 'Archive note' }))
    expect(onToast).toHaveBeenCalledWith('Note archived')
    fireEvent.contextMenu(card); await user.click(screen.getByRole('menuitem', { name: 'Delete note' }))
    expect(window.confirm).toHaveBeenCalled(); expect(onToast).toHaveBeenCalledWith('Note deleted')
  })

  it('creates notes from folder and tag menus and runs the remaining note actions', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderInMenu(<NotesView state={state()} query="" onChange={onChange} onToast={onToast} />)

    const sidebarButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-item'))
      .find((button) => button.querySelector('span')?.textContent === label)!
    const choose = async (target: Element, label: string) => {
      fireEvent.contextMenu(target)
      await user.click(within(screen.getByRole('menu')).getByText(label))
    }

    await choose(sidebarButton('Pinned'), 'New note')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.arrayContaining([
      expect.objectContaining({ title: 'Untitled note', folder: 'Personal', pinned: true })
    ]) }))
    await choose(sidebarButton('Studio'), 'New note in Studio')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.arrayContaining([
      expect.objectContaining({ folder: 'Studio' })
    ]) }))

    await choose(sidebarButton('aerio'), 'New note tagged #aerio')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.arrayContaining([
      expect.objectContaining({ tags: ['aerio'] })
    ]) }))
    await choose(sidebarButton('aerio'), 'Copy tag')
    expect(writeText).toHaveBeenCalledWith('aerio')

    const card = screen.getByRole('button', { name: /Launch notes/ })
    await choose(card, 'Unpin note')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.arrayContaining([
      expect.objectContaining({ id: 'note-1', pinned: false })
    ]) }))
    await choose(card, 'Copy note text')
    expect(writeText).toHaveBeenCalledWith('Launch notes\n\nKeep this local and useful.')

    await choose(document.querySelector('.notes-list')!, 'Switch to grid view')
    expect(document.querySelector('.notes-grid')).toBeInTheDocument()
    await choose(document.querySelector('.notes-grid')!, 'Switch to list view')
    expect(document.querySelector('.notes-list')).toBeInTheDocument()

    await user.click(sidebarButton('Archive'))
    await choose(screen.getByRole('button', { name: /Archived thought/ }), 'Restore from Archive')
    expect(onToast).toHaveBeenLastCalledWith('Note restored')
  })
})

describe('TasksView', () => {
  it('schedules the next recurring occurrence while retaining completed history', () => {
    const task = state().tasks[0]
    const [completed, next] = toggleTaskWithRecurrence(task, new Date('2026-08-08T12:00:00Z'))
    expect(completed).toMatchObject({ id: 'task-1', completed: true })
    expect(next).toMatchObject({ completed: false, due: '2026-08-15T09:00:00.000Z', recurrence: 'weekly' })
    expect(next.id).not.toBe(task.id)
    expect(next.subtasks).toEqual([expect.objectContaining({ title: 'Package', completed: false })])
  })

  it('filters lists and completed items and toggles task completion', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    const { rerender } = renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={vi.fn()} />)
    expect(screen.getByText('33%')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Complete Ship Aerio' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-1', completed: true })]) }))
    await user.click(screen.getByRole('checkbox', { name: /Show completed/ })); expect(screen.queryByText('Celebrate')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Someday/ })); expect(screen.getByText('Future idea')).toBeInTheDocument()
    rerender(<ContextMenuProvider><TasksView state={state()} query="nothing" onChange={onChange} onToast={vi.fn()} /></ContextMenuProvider>)
    expect(screen.getByText('Nothing on this list')).toBeInTheDocument()
  })

  it('creates a detailed task with due date, recurrence, priority, notes, and subtasks', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /New task/ }))
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Write more tests')
    await user.selectOptions(screen.getByLabelText('List'), 'This week')
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-08-10T12:00' } })
    await user.selectOptions(screen.getByLabelText('Priority'), 'high')
    await user.selectOptions(screen.getByLabelText('Repeat'), 'daily')
    await user.type(screen.getByLabelText('Notes'), 'Cover the view')
    await user.type(screen.getByPlaceholderText('Add a subtask'), 'Run Vitest'); await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ title: 'Write more tests', listId: 'This week', priority: 'high', recurrence: 'daily', subtasks: [expect.objectContaining({ title: 'Run Vitest' })] })]) }))
    expect(onToast).toHaveBeenCalledWith('Task created')
  })

  it('edits and deletes tasks and exposes context-menu operations', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={onToast} />)
    await user.click(document.querySelector<HTMLButtonElement>('.task-main')!)
    await user.clear(screen.getByPlaceholderText('What needs doing?')); await user.type(screen.getByPlaceholderText('What needs doing?'), 'Ship safely')
    await user.click(screen.getByRole('button', { name: 'Save task' })); expect(onToast).toHaveBeenCalledWith('Task updated')
    fireEvent.contextMenu(document.querySelector('.task-row')!); await user.click(screen.getByRole('menuitem', { name: 'Duplicate task' }))
    expect(onToast).toHaveBeenCalledWith('Task duplicated')
    fireEvent.contextMenu(document.querySelector('.task-row')!); await user.click(screen.getByRole('menuitem', { name: 'Delete task' }))
    expect(window.confirm).toHaveBeenCalled(); expect(onToast).toHaveBeenCalledWith('Task deleted')
  })

  it('reorders tasks with drag and drop and completes a list through its context menu', async () => {
    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={onToast} />)
    const rows = document.querySelectorAll('.task-row')
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '' }
    fireEvent.dragStart(rows[0], { dataTransfer }); fireEvent.dragOver(rows[1], { dataTransfer }); fireEvent.drop(rows[1], { dataTransfer })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tasks: [expect.objectContaining({ id: 'task-2' }), expect.objectContaining({ id: 'task-1' }), expect.anything()] }))
    fireEvent.contextMenu(document.querySelector('.task-list')!); await user.click(screen.getByRole('menuitem', { name: /Complete all open tasks/ }))
    expect(onToast).toHaveBeenCalledWith('Today completed')
  })

  it('runs task priorities, moves, completion, copy, and list context actions', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={vi.fn()} />)

    const row = () => Array.from(document.querySelectorAll<HTMLElement>('.task-row'))
      .find((item) => item.textContent?.includes('Ship Aerio'))!
    const choose = async (target: Element, label: string) => {
      fireEvent.contextMenu(target)
      await user.click(within(screen.getByRole('menu')).getByText(label))
    }

    await choose(row(), 'Complete task')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', completed: true })
    ]) }))
    await choose(row(), 'Low priority')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', priority: 'low' })
    ]) }))
    await choose(row(), 'Move to Someday')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', listId: 'Someday' })
    ]) }))
    await choose(row(), 'Copy task title')
    expect(writeText).toHaveBeenCalledWith('Ship Aerio')

    const thisWeek = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-item'))
      .find((button) => button.querySelector('span')?.textContent === 'This week')!
    fireEvent.contextMenu(thisWeek)
    expect(within(screen.getByRole('menu')).getByText('Complete all open tasks').closest('button')).toBeDisabled()
    await user.click(within(screen.getByRole('menu')).getByText('New task in This week'))
    expect(screen.getByLabelText('List')).toHaveValue('This week')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-item'))
      .find((button) => button.querySelector('span')?.textContent === 'Today')!)
    await choose(row(), 'Edit task')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tasks: expect.not.arrayContaining([
      expect.objectContaining({ id: 'task-1' })
    ]) }))
  })

  it('edits existing subtasks and exercises keyboard creation and guarded drops', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={vi.fn()} />)
    await user.click(document.querySelector<HTMLButtonElement>('.task-main')!)
    await user.click(screen.getByRole('checkbox', { name: /Package/ }))
    await user.click(screen.getByRole('button', { name: 'Remove Package' }))
    const subtask = screen.getByPlaceholderText('Add a subtask')
    await user.type(subtask, 'Keyboard subtask{Enter}')
    expect(screen.getByText('Keyboard subtask')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', subtasks: [expect.objectContaining({ title: 'Keyboard subtask' })] })
    ]) }))

    const first = document.querySelector<HTMLElement>('.task-row')!
    const noTask = { getData: () => 'missing' }
    fireEvent.drop(first, { dataTransfer: noTask })
    const sameTask = { getData: () => 'task-1' }
    fireEvent.drop(first, { dataTransfer: sameTask })
  })

  it('covers empty progress, completed task actions, declined deletion, and a minimal new task', async () => {
    const emptyState = { ...state(), tasks: [] }
    const empty = renderInMenu(<TasksView state={emptyState} query="" onChange={vi.fn()} onToast={vi.fn()} />)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.getByText('Nothing on this list')).toBeInTheDocument()
    empty.unmount()

    const user = userEvent.setup(), onChange = vi.fn(), onToast = vi.fn()
    renderInMenu(<TasksView state={state()} query="" onChange={onChange} onToast={onToast} />)
    const completed = Array.from(document.querySelectorAll<HTMLElement>('.task-row')).find((row) => row.textContent?.includes('Celebrate'))!
    fireEvent.contextMenu(completed)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Reopen task' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-2', completed: false })]) }))

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    fireEvent.contextMenu(completed)
    await user.click(screen.getByRole('menuitem', { name: 'Delete task' }))
    expect(onToast).not.toHaveBeenCalledWith('Task deleted')

    const allTasks = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-item')).find((button) => button.textContent?.includes('All tasks'))!
    fireEvent.contextMenu(allTasks)
    await user.click(screen.getByRole('menuitem', { name: 'New task in Today' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.keyDown(screen.getByPlaceholderText('Add a subtask'), { key: 'a' })
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'Quick task')
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ title: 'Quick task', due: undefined, completed: false })]) }))
  })
})
