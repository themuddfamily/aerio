// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import { noteHtmlToText } from '../lib/note-rich-text'
import type { AppState, Attachment, Note } from '../types'
import NotesView from './NotesView'

const pictureUrl = 'data:image/png;base64,iVBORw0KGgoAAAAN'
const picture: Attachment = { id: 'pic-1', name: 'Diagram.png', size: 12, mime: 'image/png', path: 'C:/aerio/note-attachments/pic.png', inline: true }
const file: Attachment = { id: 'file-1', name: 'brief.pdf', size: 2048, mime: 'pdf', path: 'C:/aerio/note-attachments/brief.pdf' }

const plainNote: Note = { id: 'plain', folder: 'Personal', title: 'Plain note', content: 'First line\n  indented & <kept>\n\nlast', tags: ['old'], pinned: false, archived: false, updatedAt: '2026-10-02T10:00:00Z' }
const richNote: Note = {
  id: 'rich', folder: 'Ideas', title: 'Rich note', tags: ['plan'], pinned: true, archived: false, color: '#fff0aa', updatedAt: '2026-10-03T10:00:00Z',
  html: '<h1>Quarterly plan</h1><ul><li>Ship editor</li></ul><table><tbody><tr><td>Owner</td><td>Ada</td></tr></tbody></table><div><img data-aerio-note-image="pic-1" alt="Diagram"></div>',
  content: 'Quarterly plan\nShip editor\nOwner\tAda', attachments: [picture, file]
}
const state = (notes: Note[]): AppState => ({ accounts: [], events: [], contacts: [], tasks: [], notes })

const productivity = {
  chooseNoteAttachments: vi.fn(async () => [] as Attachment[]),
  openNoteAttachment: vi.fn(async () => ({})),
  readNoteImage: vi.fn(async () => pictureUrl),
  saveNoteImage: vi.fn(async (input: { name: string; dataUrl: string }): Promise<Attachment> => ({ id: 'pic-new', name: `${input.name}.png`, size: 12, mime: 'image/png', path: 'C:/aerio/note-attachments/new.png', inline: true }))
}

const renderNotes = (notes: Note[], query = '', onChange = vi.fn()) => ({
  onChange,
  ...render(<ContextMenuProvider><NotesView state={state(notes)} query={query} onChange={onChange} onToast={vi.fn()} /></ContextMenuProvider>)
})
const body = () => screen.getByRole('textbox', { name: 'Note body' })
const lastNote = (onChange: ReturnType<typeof vi.fn>, id: string) => (onChange.mock.lastCall![0] as AppState).notes.find((note) => note.id === id)!

describe('rich Notes editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'aerio', { configurable: true, value: { productivity } })
  })

  it('shows an existing plain-text note unchanged and does not rewrite it until edited', () => {
    const { onChange } = renderNotes([plainNote])
    expect(noteHtmlToText(body().innerHTML)).toBe(plainNote.content)
    expect(body().innerHTML).toBe('<div>First line</div><div>  indented &amp; &lt;kept&gt;</div><div><br></div><div>last</div>')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('toolbar', { name: 'Note formatting' })).toBeInTheDocument()
    expect(screen.getByLabelText('Paragraph style')).toBeInTheDocument()
  })

  it('migrates a plain note on its first edit while keeping folders, tags, pinning, and archive state', () => {
    const { onChange } = renderNotes([plainNote])
    body().innerHTML += '<h2>Added heading</h2>'
    fireEvent.input(body())
    expect(lastNote(onChange, 'plain')).toMatchObject({
      folder: 'Personal', tags: ['old'], pinned: false, archived: false,
      html: '<div>First line</div><div>  indented &amp; &lt;kept&gt;</div><div><br></div><div>last</div><h2>Added heading</h2>',
      content: `${plainNote.content}\nAdded heading`
    })
  })

  it('renders headings, lists, tables, and managed pictures without listing pictures as files', async () => {
    renderNotes([richNote])
    expect(within(body()).getByRole('heading', { name: 'Quarterly plan' })).toBeInTheDocument()
    expect(within(body()).getByText('Ship editor').tagName).toBe('LI')
    expect(within(body()).getByText('Ada').tagName).toBe('TD')
    expect(productivity.readNoteImage).toHaveBeenCalledWith(picture.path)
    await waitFor(() => expect(body().querySelector('img')).toHaveAttribute('src', pictureUrl))
    const files = screen.getByRole('region', { name: 'Note attachments' })
    expect(within(files).getByText('brief.pdf')).toBeInTheDocument()
    expect(within(files).queryByText('Diagram.png')).not.toBeInTheDocument()
  })

  it('searches the text of rich notes, not their markup', () => {
    const { unmount } = renderNotes([richNote, plainNote], 'ship editor')
    expect(screen.getByRole('button', { name: /Rich note/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Plain note/ })).not.toBeInTheDocument()
    unmount()
    renderNotes([richNote], 'data-aerio-note-image')
    expect(screen.getByText('No notes here')).toBeInTheDocument()
  })

  it('sanitizes pasted HTML and stores pasted pictures as managed attachments', async () => {
    const { onChange } = renderNotes([richNote])
    await waitFor(() => expect(body().querySelector('img')).toHaveAttribute('src', pictureUrl))
    const html = '<!--StartFragment--><p onclick="steal()">Pasted <a href="javascript:steal()">link</a> <a href="https://example.test">safe</a></p>' +
      '<script>steal()</script><img src="https://tracker.example/pixel.gif" alt="Remote"><img src="data:image/png;base64,iVBORw0KGgo=" alt="Shot" onerror="steal()"><!--EndFragment-->'
    await act(async () => {
      fireEvent.paste(body(), { clipboardData: { files: [], getData: (type: string) => type === 'text/html' ? html : 'Pasted link safe' } })
    })
    expect(body().innerHTML).not.toMatch(/script|onclick|onerror|tracker\.example|javascript:/)
    await waitFor(() => expect(productivity.saveNoteImage).toHaveBeenCalledWith({ name: 'Shot', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }))
    await waitFor(() => expect(lastNote(onChange, 'rich').attachments).toEqual([picture, file, expect.objectContaining({ id: 'pic-new', inline: true })]))
    const saved = lastNote(onChange, 'rich')
    expect(saved.html).toContain('<img alt="Shot" data-aerio-note-image="pic-new">')
    expect(saved.html).toContain('<a>link</a> <a href="https://example.test">safe</a>')
    expect(saved.html).not.toMatch(/src=|data:|script|steal/)
    expect(saved.content).toContain('Pasted link safe')
  })

  it('removes a picture’s managed attachment when it is deleted from the body', () => {
    const { onChange } = renderNotes([richNote])
    body().querySelector('img')!.remove()
    fireEvent.input(body())
    expect(lastNote(onChange, 'rich')).toMatchObject({ attachments: [file], content: 'Quarterly plan\nShip editor\nOwner\tAda' })
    expect(lastNote(onChange, 'rich').html).not.toContain('<img')
  })

  it('reloads the body when the note changes outside the editor', () => {
    const { rerender } = renderNotes([richNote])
    const restored = { ...richNote, html: '<h2>Restored</h2>', content: 'Restored', attachments: [file] }
    rerender(<ContextMenuProvider><NotesView state={state([restored])} query="" onChange={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    expect(body().innerHTML).toBe('<h2>Restored</h2>')
  })
})
