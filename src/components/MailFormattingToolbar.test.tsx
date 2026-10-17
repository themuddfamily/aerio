// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MailFormattingToolbar, { insertImageFiles, useRichEditorInput } from './MailFormattingToolbar'

const png = () => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'chart.png', { type: 'image/png' })

function Harness({ onChange, onToast }: { onChange(): void; onToast(message: string): void }) {
  const editorRef = useRef<HTMLDivElement>(null)
  const input = useRichEditorInput({ editorRef, onEditorChange: onChange, onToast })
  return <>
    <MailFormattingToolbar editorRef={editorRef} onEditorChange={onChange} onToast={onToast}><button>Extra</button></MailFormattingToolbar>
    <div ref={editorRef} data-testid="editor" contentEditable suppressContentEditableWarning {...input} />
  </>
}

const clipboard = (data: Record<string, string>, files: File[] = []) => ({ getData: (type: string) => data[type] ?? '', files })

beforeEach(() => {
  // jsdom has no editing commands, so insertHtmlAtRange falls back to range insertion.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
  window.prompt = vi.fn(() => '2x3')
})

describe('MailFormattingToolbar', () => {
  it('applies fonts, sizes, colors, alignment, lists, and clearing through editing commands', async () => {
    const onChange = vi.fn(), user = userEvent.setup()
    render(<Harness onChange={onChange} onToast={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Font'), { target: { value: 'Georgia, \'Times New Roman\', serif' } })
    expect(document.execCommand).toHaveBeenCalledWith('styleWithCSS', false, 'true')
    expect(document.execCommand).toHaveBeenCalledWith('fontName', false, 'Georgia, \'Times New Roman\', serif')
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '5' } })
    expect(document.execCommand).toHaveBeenCalledWith('fontSize', false, '5')
    fireEvent.change(screen.getByLabelText('Text color'), { target: { value: '#112233' } })
    expect(document.execCommand).toHaveBeenCalledWith('foreColor', false, '#112233')
    fireEvent.change(screen.getByLabelText('Highlight color'), { target: { value: '#ffee00' } })
    expect(document.execCommand).toHaveBeenCalledWith('hiliteColor', false, '#ffee00')
    for (const [title, command] of [['Strikethrough', 'strikeThrough'], ['Align left', 'justifyLeft'], ['Align center', 'justifyCenter'], ['Align right', 'justifyRight'], ['Numbered list', 'insertOrderedList'], ['Clear formatting', 'removeFormat']]) {
      await user.click(screen.getByTitle(title))
      expect(document.execCommand).toHaveBeenCalledWith(command, false, undefined)
    }
    expect(onChange).toHaveBeenCalled()
  })

  it('inserts a bordered table of the requested size and rejects bad sizes', async () => {
    const onToast = vi.fn(), user = userEvent.setup()
    render(<Harness onChange={vi.fn()} onToast={onToast} />)
    await user.click(screen.getByTitle('Insert table'))
    const editor = screen.getByTestId('editor')
    expect(editor.querySelectorAll('tr')).toHaveLength(3)
    expect(editor.querySelectorAll('td')).toHaveLength(6)
    expect(editor.querySelector('table')?.getAttribute('style')).toBe('border-collapse: collapse; width: 100%')
    window.prompt = vi.fn(() => 'huge')
    await user.click(screen.getByTitle('Insert table'))
    expect(onToast).toHaveBeenCalledWith('Enter a size like 3x2 (up to 20 columns and 100 rows)')
  })

  it('pastes sanitized HTML, pastes plain text with Ctrl+Shift+V, and embeds pasted images', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} onToast={vi.fn()} />)
    const editor = screen.getByTestId('editor')
    fireEvent.paste(editor, { clipboardData: clipboard({ 'text/html': '<p class="MsoNormal" style="color: red; mso-bidi: x" onclick="x()"><b>Bold</b><script>alert(1)</script></p>', 'text/plain': 'Bold' }) })
    expect(editor.innerHTML).toBe('<p style="color: red"><b>Bold</b></p>')
    fireEvent.keyDown(editor, { key: 'V', ctrlKey: true, shiftKey: true })
    fireEvent.paste(editor, { clipboardData: clipboard({ 'text/html': '<b>Rich</b>', 'text/plain': 'Rich' }) })
    expect(document.execCommand).toHaveBeenLastCalledWith('insertText', false, 'Rich')
    fireEvent.paste(editor, { clipboardData: clipboard({ 'text/plain': 'Only text' }) })
    expect(document.execCommand).toHaveBeenLastCalledWith('insertText', false, 'Only text')
    fireEvent.paste(editor, { clipboardData: clipboard({}, [png()]) })
    await waitFor(() => expect(editor.querySelector('img')).not.toBeNull())
    const image = editor.querySelector('img')!
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
    expect(image.getAttribute('alt')).toBe('chart')
    expect(image.getAttribute('data-aerio-cid')).toMatch(/@aerio\.local$/)
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('embeds dropped or chosen images and refuses unsupported or oversized files', async () => {
    const onToast = vi.fn(), onChange = vi.fn()
    render(<Harness onChange={onChange} onToast={onToast} />)
    const editor = screen.getByTestId('editor')
    fireEvent.drop(editor, { dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    expect(onToast).toHaveBeenCalledWith('Use the paperclip to attach files')
    fireEvent.drop(editor, { dataTransfer: { files: [png()] } })
    await waitFor(() => expect(editor.querySelectorAll('img')).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('Choose inline images'), { target: { files: [png()] } })
    await waitFor(() => expect(editor.querySelectorAll('img')).toHaveLength(2))
    const ids = Array.from(editor.querySelectorAll('img')).map((item) => item.getAttribute('data-aerio-cid'))
    expect(new Set(ids).size).toBe(2)
    const big = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 })
    await insertImageFiles(editor, [big, new File(['<svg/>'], 'v.svg', { type: 'image/svg+xml' })], onChange, onToast)
    expect(onToast).toHaveBeenCalledWith('Only PNG, JPEG, GIF, WebP, and BMP images can be placed inline')
    expect(onToast).toHaveBeenCalledWith('big.png is larger than 5 MB — attach it instead')
    expect(editor.querySelectorAll('img')).toHaveLength(2)
  })
})
