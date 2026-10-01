// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider, useContextMenu } from './ContextMenu'
import ThreadMessageAccordion from './ThreadMessageAccordion'
import { useMailMessageTools } from './MailMessageTools'
import { useThreadExpansion } from '../lib/use-thread-expansion'
import type { MailAccountSummary, MailMessageDetail, MailThreadDetail } from '../mail-types'

vi.mock('./Modal', () => ({ default: ({ title, children, onClose }: any) => <div role="dialog" aria-label={title}>{children}<button onClick={onClose}>Close dialog</button></div> }))
vi.mock('./SenderAvatar', () => ({ default: () => <span /> }))
const account = { id: 'a', provider: 'gmail', email: 'me@example.test', archived: false } as MailAccountSummary
const message: MailMessageDetail = { accountId: 'a', id: 'm1', threadId: 't', fromName: 'Ada', fromEmail: 'ada@example.test', to: ['me@example.test'], cc: [], subject: 'Launch', date: '2026-10-01T09:00:00Z', text: 'Original text', html: '<p>Formatted email</p>', sanitizedHtml: '<p>Formatted email</p>', messageIdHeader: '<launch@example.test>', labelIds: ['INBOX'], attachments: [{ id: 'file', messageId: 'm1', filename: 'file.txt', size: 10, mimeType: 'text/plain' }] }
const ref = { accountId: 'a', threadId: 't', messageId: 'm1' }
const onToast = vi.fn()
const tools = { updateLocal: vi.fn(), save: vi.fn(), saveAttachments: vi.fn(), copy: vi.fn(), print: vi.fn(), createTask: vi.fn(), addNote: vi.fn(), notes: vi.fn(), translate: vi.fn() }
const rules = { list: vi.fn(), save: vi.fn() }
const productivity = { snapshot: vi.fn(), createEvent: vi.fn() }

function Harness() {
  const [thread, setThread] = useState<MailThreadDetail>({ accountId: 'a', id: 't', subject: 'Launch', messages: [message, { ...message, id: 'm2', text: 'Second text', sanitizedHtml: '' }] })
  const [selected, select] = useState<string | undefined>('m1')
  const expansion = useThreadExpansion(thread, selected, select)
  const menu = useContextMenu()
  const actions = useMailMessageTools({ accounts: [account], onToast, collapseAll: expansion.collapseAll, expandAll: expansion.expandAll, onUpdated: (item, local) => setThread((current) => ({ ...current, messages: current.messages.map((entry) => entry.id === item.id ? { ...entry, local } : entry) })) })
  return <>{thread.messages.map((item) => <ThreadMessageAccordion key={item.id} message={item} expanded={expansion.isExpanded(item.id)} onToggle={() => expansion.toggle(item.id)} onReply={() => {}} onMoreActions={(event) => menu.showContextMenu(event, actions.items(item), 'Message options')} />)}{actions.dialog}</>
}
const renderTools = () => render(<ContextMenuProvider><Harness /></ContextMenuProvider>)
async function choose(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getAllByRole('button', { name: 'Message options' })[0])
  await user.click(screen.getByRole('menuitem', { name }))
  return user
}
beforeEach(() => {
  vi.clearAllMocks()
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })
  tools.updateLocal.mockImplementation(async (_ref, update) => ({ categories: [], format: 'auto', fontSize: 14, noteIds: [], taskIds: [], ...update }))
  tools.save.mockResolvedValue({ savedPath: 'email.eml' })
  tools.saveAttachments.mockResolvedValue({ count: 1, savedPath: 'attachments' })
  tools.copy.mockResolvedValue(undefined)
  tools.print.mockResolvedValue(undefined)
  tools.createTask.mockResolvedValue(undefined)
  tools.addNote.mockResolvedValue(undefined)
  tools.notes.mockResolvedValue([{ id: 'note', title: 'Existing note', content: 'Existing context' }])
  tools.translate.mockResolvedValue('Bonjour')
  rules.list.mockResolvedValue([])
  rules.save.mockImplementation(async (input) => ({ ...input, id: 'rule', matchCount: 0 }))
  productivity.snapshot.mockResolvedValue({ calendars: [{ id: 'cal', name: 'Work', accountId: 'a', canWrite: true, color: '#123456' }] })
  productivity.createEvent.mockResolvedValue({})
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { messageTools: tools, rules, mail: { labels: vi.fn(async () => [{ accountId: 'a', id: 'work', type: 'user', name: 'Work' }]) } }, productivity } })
})

describe('email dropdown tools', () => {
  it('offers every requested action and supports expanding after collapsing all messages', async () => {
    const user = userEvent.setup()
    renderTools()
    await user.click(screen.getAllByRole('button', { name: 'Message options' })[0])
    for (const name of ['Collapse all messages', 'Expand all messages', 'Edit categories…', 'Save email as…', 'Save all attachments…', 'Copy to folder…', 'Print email…', 'Create meeting from email…', 'Create task from email…', 'Create rule from email…', 'Add note…', 'Translate…', 'Message format…', 'Message properties']) expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Collapse all messages' }))
    expect(document.querySelectorAll('.thread-message.expanded')).toHaveLength(0)
    await choose('Expand all messages')
    expect(document.querySelectorAll('.thread-message.expanded')).toHaveLength(2)
  })
  it('edits categories and applies the selected display format to the email', async () => {
    renderTools()
    let user = await choose('Edit categories…')
    await user.type(screen.getByLabelText('Categories'), 'Work, Urgent')
    await user.click(screen.getByRole('button', { name: 'Save categories' }))
    await waitFor(() => expect(document.querySelector('.message-category')).toHaveTextContent('Work'))
    expect(tools.updateLocal).toHaveBeenCalledWith(ref, { categories: ['Work', ' Urgent'] })
    user = await choose('Message format…')
    await user.selectOptions(screen.getByLabelText('Display format'), 'plain')
    await user.selectOptions(screen.getByLabelText('Text size'), '18')
    await user.click(screen.getByRole('button', { name: 'Save format' }))
    await waitFor(() => expect(document.querySelector('.thread-message.expanded .mail-text')).toHaveTextContent('Original text'))
    expect(document.querySelector('.thread-message.expanded .mail-html')).toBeNull()
    expect(document.querySelector('.message-custom-format')).toHaveStyle({ '--message-font-size': '18px' })
  })
  it('saves, prints, and copies the chosen email through the desktop API', async () => {
    renderTools()
    await choose('Save email as…')
    expect(tools.save).toHaveBeenCalledWith(ref)
    await choose('Save all attachments…')
    expect(tools.saveAttachments).toHaveBeenCalledWith(ref)
    await choose('Print email…')
    expect(tools.print).toHaveBeenCalledWith(ref, 'auto')
    const user = await choose('Copy to folder…')
    await screen.findByRole('option', { name: 'Work' })
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(tools.copy).toHaveBeenCalledWith(ref, 'work'))
  })
  it('creates a task using the email content and attaches a note while showing existing notes', async () => {
    renderTools()
    let user = await choose('Create task from email…')
    expect(screen.getByLabelText('Title')).toHaveValue('Launch')
    expect(screen.getByLabelText('Description')).toHaveValue('Original text')
    await user.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(tools.createTask).toHaveBeenCalledWith(ref, { title: 'Launch', notes: 'Original text', due: undefined }))
    user = await choose('Add note…')
    expect(await screen.findByText('Existing context')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Note'), 'Follow this up')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    await waitFor(() => expect(tools.addNote).toHaveBeenCalledWith(ref, { title: 'Launch', content: 'Follow this up' }))
  })
  it('creates a meeting with prefilled email participants and editable dates', async () => {
    renderTools()
    const user = await choose('Create meeting from email…')
    await screen.findByRole('option', { name: 'Work' })
    expect(screen.getByLabelText('Attendees')).toHaveValue('ada@example.test')
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-10-05T10:00' } })
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-10-05T11:00' } })
    await user.click(screen.getByRole('button', { name: 'Create meeting' }))
    await waitFor(() => expect(productivity.createEvent).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'cal', title: 'Launch', attendees: ['ada@example.test'], description: expect.stringContaining('<launch@example.test>') })))
  })
  it('prefills a real rule editor from the sender and saves an editable rule', async () => {
    renderTools()
    const user = await choose('Create rule from email…')
    await screen.findByRole('dialog', { name: 'Mail rules' })
    expect(screen.getByLabelText('Condition 1 value')).toHaveValue('ada@example.test')
    await user.selectOptions(screen.getByLabelText('Action 1'), 'read')
    await user.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(rules.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a', conditions: [{ field: 'from', operator: 'equals', value: 'ada@example.test' }], actions: [{ action: 'read' }] })))
  })
  it('translates through the configured service and displays properties for the selected email', async () => {
    renderTools()
    let user = await choose('Translate…')
    await user.clear(screen.getByLabelText('Target language code'))
    await user.type(screen.getByLabelText('Target language code'), 'fr')
    await user.click(screen.getByRole('button', { name: 'Translate' }))
    expect(await screen.findByText('Bonjour')).toBeInTheDocument()
    expect(tools.translate).toHaveBeenCalledWith(ref, expect.objectContaining({ target: 'fr', source: 'auto' }))
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    user = await choose('Message properties')
    const properties = within(screen.getByRole('dialog', { name: 'Message properties' }))
    expect(properties.getByText('<launch@example.test>')).toBeInTheDocument()
    expect(properties.getByText('file.txt (10 bytes, text/plain)')).toBeInTheDocument()
  })
  it('keeps forms open and reports failures without claiming success', async () => {
    tools.createTask.mockRejectedValueOnce(new Error('Storage unavailable'))
    renderTools()
    const user = await choose('Create task from email…')
    await user.click(screen.getByRole('button', { name: 'Create task' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable')
    expect(onToast).not.toHaveBeenCalledWith('Task created from email')
  })
})
