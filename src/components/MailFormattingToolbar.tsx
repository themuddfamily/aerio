import { Baseline, Bold, Highlighter, ImagePlus, Italic, Link, List, ListOrdered, RemoveFormatting, Strikethrough, Table, TextAlignCenter, TextAlignEnd, TextAlignStart, Underline } from 'lucide-react'
import { useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_TYPES } from '../lib/mail-rich-text'
import { inlineImageHtml, parseTableSize, sanitizePastedHtml, tableHtml } from '../lib/mail-paste'
import { insertHtmlAtRange } from './MailTemplatePicker'

interface MailFormattingToolbarProps {
  editorRef: RefObject<HTMLDivElement | null>
  onEditorChange(): void
  onToast(message: string): void
  /** Accessible toolbar name; the Notes editor reuses this toolbar. */
  label?: string
  /** Composer-specific controls (signature, templates, AI) shown after the formatting buttons. */
  children?: ReactNode
}

const FONTS = [
  { label: 'Sans serif', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Serif', value: 'Georgia, \'Times New Roman\', serif' },
  { label: 'Monospace', value: '\'Courier New\', monospace' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' }
]
// execCommand font sizes 1-7; with styleWithCSS they become CSS keywords the allowlist accepts.
const SIZES = [{ label: 'Small', value: '2' }, { label: 'Normal', value: '3' }, { label: 'Large', value: '5' }, { label: 'Huge', value: '6' }]

function editorRange(editor: HTMLElement | null) {
  const selection = editor?.ownerDocument.getSelection()
  if (!editor || !selection?.rangeCount) return undefined
  const range = selection.getRangeAt(0)
  return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : undefined
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read'))
    reader.readAsDataURL(file)
  })
}

/**
 * Embeds image files at the caret as data URLs marked with a Content-ID. The
 * HTML itself carries the image, so autosave and reopening keep it; delivery
 * converts each one to a multipart/related part.
 */
export async function insertImageFiles(editor: HTMLElement, files: File[], onChange: () => void, onToast: (message: string) => void, range?: Range) {
  const images = files.filter((file) => INLINE_IMAGE_TYPES.includes(file.type))
  if (images.length < files.length) onToast('Only PNG, JPEG, GIF, WebP, and BMP images can be placed inline')
  const markup: string[] = []
  for (const file of images) {
    if (file.size > INLINE_IMAGE_MAX_BYTES) {
      onToast(`${file.name || 'The image'} is larger than 5 MB — attach it instead`)
      continue
    }
    try { markup.push(inlineImageHtml(await readDataUrl(file), file.name.replace(/\.[^.]+$/, '') || 'Image')) } catch { onToast('The image could not be read') }
  }
  if (!markup.length) return
  insertHtmlAtRange(editor, markup.join(''), range)
  onChange()
}

/**
 * Paste and drop handling for the rich editor: images are embedded, HTML is
 * sanitized, and Ctrl+Shift+V pastes plain text only.
 */
export function useRichEditorInput({ editorRef, onEditorChange, onToast }: Omit<MailFormattingToolbarProps, 'children' | 'label'>) {
  const plainNextPaste = useRef(false)
  return {
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      plainNextPaste.current = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v'
    },
    onPaste(event: ClipboardEvent<HTMLDivElement>) {
      const editor = event.currentTarget
      const plainOnly = plainNextPaste.current
      plainNextPaste.current = false
      const data = event.clipboardData
      event.preventDefault()
      const files = Array.from(data.files ?? [])
      if (!plainOnly && files.length && files.every((file) => file.type.startsWith('image/'))) {
        void insertImageFiles(editor, files, onEditorChange, onToast, editorRange(editor))
        return
      }
      const html = plainOnly ? '' : data.getData('text/html')
      const safe = html ? sanitizePastedHtml(html, editor.ownerDocument) : ''
      if (safe) insertHtmlAtRange(editor, safe, editorRange(editor))
      else editor.ownerDocument.execCommand('insertText', false, data.getData('text/plain'))
      onEditorChange()
    },
    onDrop(event: DragEvent<HTMLDivElement>) {
      const files = Array.from(event.dataTransfer.files ?? [])
      if (!files.length) return
      // Dropped non-image files would otherwise be opened by the browser.
      event.preventDefault()
      const editor = event.currentTarget
      const document = editor.ownerDocument as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
      const range = document.caretRangeFromPoint?.(event.clientX, event.clientY) ?? undefined
      if (files.some((file) => file.type.startsWith('image/'))) void insertImageFiles(editor, files.filter((file) => file.type.startsWith('image/')), onEditorChange, onToast, range)
      else onToast('Use the paperclip to attach files')
    }
  }
}

export default function MailFormattingToolbar({ editorRef, onEditorChange, onToast, label = 'Message formatting', children }: MailFormattingToolbarProps) {
  const savedRange = useRef<Range | undefined>(undefined)
  const imageInput = useRef<HTMLInputElement>(null)
  const keepSelection = { onMouseDown: (event: { preventDefault(): void }) => event.preventDefault() }
  // Selects and color pickers take focus, so the editor selection is captured first and restored before the command.
  const rememberSelection = () => { savedRange.current = editorRange(editorRef.current) ?? savedRange.current }
  const restoreSelection = () => {
    const editor = editorRef.current
    const range = savedRange.current
    editor?.focus()
    if (!editor || !range || !editor.contains(range.commonAncestorContainer)) return
    const selection = editor.ownerDocument.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const format = (command: string, value?: string, restore = false) => {
    const editor = editorRef.current
    if (restore) restoreSelection()
    else editor?.focus()
    if (value !== undefined) editor?.ownerDocument.execCommand('styleWithCSS', false, 'true')
    editor?.ownerDocument.execCommand(command, false, value)
    onEditorChange()
  }

  const addLink = () => {
    const value = editorRef.current?.ownerDocument.defaultView?.prompt('Link address (https:// or mailto:)')?.trim()
    if (!value) return
    if (!/^(https?:|mailto:)/i.test(value)) {
      onToast('Use an https://, http://, or mailto: link')
      return
    }
    format('createLink', value)
  }

  const addTable = () => {
    const editor = editorRef.current
    const range = editorRange(editor)
    const value = editor?.ownerDocument.defaultView?.prompt('Table size (columns x rows)', '3x2')
    if (!editor || !value) return
    const size = parseTableSize(value)
    if (!size) {
      onToast('Enter a size like 3x2 (up to 20 columns and 100 rows)')
      return
    }
    insertHtmlAtRange(editor, tableHtml(size.columns, size.rows), range)
    onEditorChange()
  }

  return (
    <div className="compose-formatting" role="toolbar" aria-label={label}>
      <select className="compose-format-select" aria-label="Font" defaultValue="" onMouseDown={rememberSelection} onFocus={rememberSelection} onChange={(event) => { if (event.target.value) format('fontName', event.target.value, true); event.target.value = '' }}>
        <option value="" disabled>Font</option>
        {FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
      </select>
      <select className="compose-format-select" aria-label="Text size" defaultValue="" onMouseDown={rememberSelection} onFocus={rememberSelection} onChange={(event) => { if (event.target.value) format('fontSize', event.target.value, true); event.target.value = '' }}>
        <option value="" disabled>Size</option>
        {SIZES.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
      </select>
      <button className="icon-button" title="Bold" {...keepSelection} onClick={() => format('bold')}><Bold size={15} /></button>
      <button className="icon-button" title="Italic" {...keepSelection} onClick={() => format('italic')}><Italic size={15} /></button>
      <button className="icon-button" title="Underline" {...keepSelection} onClick={() => format('underline')}><Underline size={15} /></button>
      <button className="icon-button" title="Strikethrough" {...keepSelection} onClick={() => format('strikeThrough')}><Strikethrough size={15} /></button>
      <label className="icon-button compose-color" title="Text color" onMouseDown={rememberSelection}><Baseline size={15} /><input type="color" aria-label="Text color" defaultValue="#c0392b" onChange={(event) => format('foreColor', event.target.value, true)} /></label>
      <label className="icon-button compose-color" title="Highlight color" onMouseDown={rememberSelection}><Highlighter size={15} /><input type="color" aria-label="Highlight color" defaultValue="#fff59d" onChange={(event) => format('hiliteColor', event.target.value, true)} /></label>
      <span className="compose-formatting-divider" aria-hidden="true" />
      <button className="icon-button" title="Align left" {...keepSelection} onClick={() => format('justifyLeft')}><TextAlignStart size={15} /></button>
      <button className="icon-button" title="Align center" {...keepSelection} onClick={() => format('justifyCenter')}><TextAlignCenter size={15} /></button>
      <button className="icon-button" title="Align right" {...keepSelection} onClick={() => format('justifyRight')}><TextAlignEnd size={15} /></button>
      <button className="icon-button" title="Bulleted list" {...keepSelection} onClick={() => format('insertUnorderedList')}><List size={15} /></button>
      <button className="icon-button" title="Numbered list" {...keepSelection} onClick={() => format('insertOrderedList')}><ListOrdered size={15} /></button>
      <span className="compose-formatting-divider" aria-hidden="true" />
      <button className="icon-button" title="Add link" {...keepSelection} onClick={addLink}><Link size={15} /></button>
      <button className="icon-button" title="Insert table" {...keepSelection} onClick={addTable}><Table size={15} /></button>
      <button className="icon-button" title="Insert image" {...keepSelection} onClick={() => { rememberSelection(); imageInput.current?.click() }}><ImagePlus size={15} /></button>
      <input ref={imageInput} type="file" hidden accept={INLINE_IMAGE_TYPES.join(',')} multiple aria-label="Choose inline images" onChange={(event) => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        const editor = editorRef.current
        if (editor && files.length) void insertImageFiles(editor, files, onEditorChange, onToast, savedRange.current)
      }} />
      <button className="icon-button" title="Clear formatting" {...keepSelection} onClick={() => format('removeFormat')}><RemoveFormatting size={15} /></button>
      {children}
    </div>
  )
}
