// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftResult } from '../mail-types'
import type { MailTemplate } from '../mail-template-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import { insertHtmlAtRange } from './MailTemplatePicker'

const accounts: MailAccountSummary[] = [{
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}]
const snippet: MailTemplate = {
  id: 'snippet', kind: 'snippet', name: 'Thanks', subject: '', html: '<b>Thanks!</b>', text: 'Thanks!', attachments: [],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z'
}
const template: MailTemplate = {
  id: 'template', kind: 'template', name: 'Weekly report', subject: 'Weekly status', html: '<p>Highlights</p>', text: 'Highlights',
  attachments: [{ id: 'file', name: 'report.pdf', size: 2048, mime: 'pdf', path: 'C:\\aerio\\template-attachments\\file.pdf' }],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z'
}
const draftResult: MailDraftResult = { id: 'draft', status: 'synced', updatedAt: '2026-10-01T10:00:00Z' }
const api = {
  chooseAttachments: vi.fn(async () => [{ id: 'f', name: 'extra.txt', size: 3, path: 'C:\\files\\extra.txt', mime: 'txt' }]),
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: { save: vi.fn(async () => draftResult), stageMessageAttachments: vi.fn(async () => []) },
    templates: {
      list: vi.fn(async (query?: string) => [snippet, template].filter((item) => !query || item.name.toLowerCase().includes(query.toLowerCase()))),
      save: vi.fn(async (input: { name: string }) => ({ ...snippet, id: 'new', name: input.name })),
      delete: vi.fn(async () => undefined),
      use: vi.fn(async (id: string) => ({ ...(id === snippet.id ? snippet : template), lastUsedAt: '2026-10-02T00:00:00Z' })),
      exportBackup: vi.fn(async () => ({ savedPath: 'C:\\backup.json' })),
      importBackup: vi.fn(async () => ({ restored: 2 }))
    }
  }
}

const editor = () => document.querySelector<HTMLDivElement>('.compose-rich-body')!
const subjectInput = () => Array.from(document.querySelectorAll<HTMLElement>('.compose-row')).find((row) => row.querySelector('label')?.textContent === 'Subject')!.querySelector('input')!
const renderCompose = () => {
  const callbacks = { onClose: vi.fn(), onSent: vi.fn(), onToast: vi.fn() }
  render(<ContextMenuProvider><MailComposeModal accounts={accounts} initialTo="reader@example.test" {...callbacks} /></ContextMenuProvider>)
  return callbacks
}
const placeCaret = (node: Node, offset: number) => {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  window.confirm = vi.fn(() => true)
  // jsdom has neither layout-aware innerText nor editing commands, so the picker's direct range insertion path runs.
  Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return (this as HTMLElement).textContent ?? '' } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
})

describe('insertHtmlAtRange', () => {
  it('replaces the saved selection and leaves the caret after the inserted content', () => {
    const host = document.createElement('div')
    host.contentEditable = 'true'
    host.innerHTML = 'Hello NAME, welcome'
    document.body.append(host)
    const range = document.createRange()
    range.setStart(host.firstChild!, 6)
    range.setEnd(host.firstChild!, 10)
    const after = insertHtmlAtRange(host, '<b>Ada</b>', range)
    expect(host.innerHTML).toBe('Hello <b>Ada</b>, welcome')
    insertHtmlAtRange(host, '!', after)
    expect(host.innerHTML).toBe('Hello <b>Ada</b>!, welcome')
    insertHtmlAtRange(host, ' End')
    expect(host.textContent).toBe('Hello Ada!, welcome End')
    host.remove()
  })
})

describe('MailTemplatePicker in the composer', () => {
  it('inserts a searched snippet at the preserved caret even after focus moves to the search box', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    editor().innerHTML = 'Hello world'
    fireEvent.input(editor())
    placeCaret(editor().firstChild!, 6)
    await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
    const search = await screen.findByLabelText('Search templates')
    await user.type(search, 'thanks')
    await waitFor(() => expect(api.mail.templates.list).toHaveBeenLastCalledWith('thanks'))
    await waitFor(() => expect(screen.queryByText('Weekly report')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^Thanks/ }))
    await waitFor(() => expect(editor().innerHTML).toBe('Hello <b>Thanks!</b>world'))
    expect(api.mail.templates.use).toHaveBeenCalledWith('snippet')
    expect(callbacks.onToast).toHaveBeenCalledWith('Inserted “Thanks”')
    expect(screen.queryByRole('dialog', { name: 'Templates and snippets' })).not.toBeInTheDocument()
  })

  it('applies a whole-message template and carries it through draft autosave', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      renderCompose()
      await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
      await user.click(await screen.findByRole('button', { name: /^Weekly report/ }))
      await waitFor(() => expect(subjectInput()).toHaveValue('Weekly status'))
      expect(editor().innerHTML).toContain('<p>Highlights</p>')
      expect(screen.getByText('report.pdf')).toBeInTheDocument()
      await act(async () => { vi.advanceTimersByTime(1_500) })
      await waitFor(() => expect(api.mail.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Weekly status', text: expect.stringContaining('Highlights'), html: expect.stringContaining('<p>Highlights</p>'),
        attachmentPaths: ['C:\\aerio\\template-attachments\\file.pdf']
      })))
    } finally { vi.useRealTimers() }
  })

  it('saves the current selection as a new snippet and the message as a template', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    editor().innerHTML = 'Keep <i>this part</i> only'
    fireEvent.input(editor())
    const range = document.createRange()
    range.selectNode(editor().querySelector('i')!)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
    await user.click(await screen.findByRole('button', { name: /Snippet from selection/ }))
    expect(screen.getByLabelText('Template body').innerHTML).toBe('<i>this part</i>')
    await user.type(screen.getByLabelText('Name'), 'Part')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.mail.templates.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'snippet', name: 'Part', html: '<i>this part</i>', attachments: [] })))
    expect(callbacks.onToast).toHaveBeenCalledWith('Saved “Part”')

    await user.type(subjectInput(), 'Quarterly')
    await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
    await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
    await user.click(await screen.findByRole('button', { name: /Template from message/ }))
    expect(screen.getAllByDisplayValue('Quarterly')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /Add files/ }))
    await user.type(screen.getByLabelText('Name'), 'Quarterly')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.mail.templates.save).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'template', subject: 'Quarterly', html: 'Keep <i>this part</i> only', attachments: [{ name: 'extra.txt', size: 3, path: 'C:\\files\\extra.txt' }]
    })))
  })

  it('edits, deletes, exports, and restores templates and closes on Escape without closing the composer', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
    await user.click(await screen.findByRole('button', { name: 'Edit Weekly report' }))
    expect(screen.getByLabelText('Template body').innerHTML).toBe('<p>Highlights</p>')
    await user.click(screen.getByRole('button', { name: 'Remove report.pdf from template' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.mail.templates.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'template', expectedUpdatedAt: template.updatedAt, attachments: [] })))

    await user.click(await screen.findByRole('button', { name: 'Delete Thanks' }))
    await waitFor(() => expect(api.mail.templates.delete).toHaveBeenCalledWith('snippet'))
    await user.click(screen.getByRole('button', { name: 'Export templates' }))
    await waitFor(() => expect(callbacks.onToast).toHaveBeenCalledWith('Templates exported'))
    await user.click(screen.getByRole('button', { name: 'Restore templates' }))
    await waitFor(() => expect(callbacks.onToast).toHaveBeenCalledWith('Restored 2 templates'))

    await user.click(screen.getByLabelText('Search templates'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Templates and snippets' })).not.toBeInTheDocument()
    expect(callbacks.onClose).not.toHaveBeenCalled()
  })

  it('reports provider errors without inserting anything', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    api.mail.templates.use.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:templates:use': Error: The template attachment “report.pdf” is no longer available"))
    await user.click(screen.getByRole('button', { name: 'Templates and snippets' }))
    await user.click(await screen.findByRole('button', { name: /^Weekly report/ }))
    await waitFor(() => expect(callbacks.onToast).toHaveBeenCalledWith('The template attachment “report.pdf” is no longer available'))
    expect(subjectInput()).toHaveValue('')
  })
})
