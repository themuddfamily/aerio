import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { Attachment, Note } from '../types'
import { INLINE_IMAGE_ATTRIBUTE, isAllowedLink } from '../lib/mail-rich-text'
import { sanitizePastedHtml } from '../lib/mail-paste'
import { collapsePastedWhitespace, pendingEditorImages, sanitizeNoteHtml, serializeNoteEditor } from '../lib/note-editor-html'
import { NOTE_IMAGE_ATTRIBUTE, NOTE_INLINE_IMAGE_LIMIT, noteEditorHtml, noteImageIds } from '../lib/note-rich-text'
import MailFormattingToolbar, { insertImageFiles, useRichEditorInput } from './MailFormattingToolbar'
import { insertHtmlAtRange } from './MailTemplatePicker'

export type NoteBodyChange = Pick<Note, 'html' | 'content'> & { attachments?: Attachment[] }

interface NoteRichEditorProps {
  note: Note
  onChange(change: NoteBodyChange): void
  onToast(message: string): void
  /** Shows the body without editing (read-only server folders, notes waiting for review). */
  readOnly?: boolean
}

const BLOCK_STYLES = [
  { label: 'Paragraph', value: 'div' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
  { label: 'Quote', value: 'blockquote' },
  { label: 'Preformatted', value: 'pre' }
]

function editorRange(editor: HTMLElement | null) {
  const selection = editor?.ownerDocument.getSelection()
  if (!editor || !selection?.rangeCount) return undefined
  const range = selection.getRangeAt(0)
  return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : undefined
}

const inlineIds = (attachments: Attachment[] | undefined) => new Set((attachments ?? []).filter((attachment) => attachment.inline).map((attachment) => attachment.id))

/**
 * The rich Notes body editor (docs/rich-notes.md). It reuses the mail
 * composer's toolbar and paste policy; pictures become managed inline
 * attachments referenced by id, and the plain-text projection is emitted with
 * every change. A plain-text note is shown converted losslessly and only gains
 * a rich body once it is edited.
 */
export default function NoteRichEditor({ note, onChange, onToast, readOnly = false }: NoteRichEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // The latest attachment list, including inline pictures emitted but not yet rendered back.
  const attachments = useRef(note.attachments)
  const propAttachments = useRef(note.attachments)
  if (propAttachments.current !== note.attachments) {
    propAttachments.current = note.attachments
    attachments.current = note.attachments
  }
  const shown = useRef<string | undefined>(undefined)
  const imageUrls = useRef(new Map<string, string>())
  const storing = useRef(new WeakSet<HTMLImageElement>())
  const plainNextPaste = useRef(false)
  const savedRange = useRef<Range | undefined>(undefined)

  const hydrate = () => {
    const editor = editorRef.current
    if (!editor) return
    const known = new Map((attachments.current ?? []).filter((attachment) => attachment.inline).map((attachment) => [attachment.id, attachment]))
    for (const image of Array.from(editor.querySelectorAll<HTMLImageElement>(`img[${NOTE_IMAGE_ATTRIBUTE}]`))) {
      if (image.getAttribute('src')) continue
      const id = image.getAttribute(NOTE_IMAGE_ATTRIBUTE) ?? ''
      const cached = imageUrls.current.get(id)
      const path = known.get(id)?.path
      if (cached) image.setAttribute('src', cached)
      else if (path) {
        void window.aerio.productivity.readNoteImage(path).then((url) => {
          imageUrls.current.set(id, url)
          if (image.isConnected && !image.getAttribute('src')) image.setAttribute('src', url)
        }).catch(() => { image.title = 'This picture is unavailable' })
      }
    }
  }

  // Loads the note into the editor, and reloads it when the body changes from outside (restore, sync).
  useLayoutEffect(() => {
    const editor = editorRef.current
    const html = noteEditorHtml(note)
    if (!editor || html === shown.current) return
    shown.current = html
    editor.innerHTML = sanitizeNoteHtml(html, editor.ownerDocument, inlineIds(note.attachments))
    hydrate()
  }, [note.html, note.content])

  const emit = (added: Attachment[] = []) => {
    const editor = editorRef.current
    if (!editor) return
    const previous = attachments.current ?? []
    const all = [...previous, ...added]
    const { html, content } = serializeNoteEditor(editor, inlineIds(all))
    const referenced = new Set(noteImageIds(html))
    // A picture deleted from the body takes its managed file with it on the next save.
    const kept = all.filter((attachment) => !attachment.inline || referenced.has(attachment.id))
    const changed = added.length > 0 || kept.length !== previous.length
    shown.current = html
    if (changed) attachments.current = kept
    onChangeRef.current({ html, content, ...(changed ? { attachments: kept } : {}) })
  }

  const storePendingImages = async () => {
    const editor = editorRef.current
    if (!editor) return
    const pending = pendingEditorImages(editor).filter((image) => !storing.current.has(image))
    if (!pending.length) return
    let available = NOTE_INLINE_IMAGE_LIMIT - inlineIds(attachments.current).size
    const added: Attachment[] = []
    for (const image of pending) {
      storing.current.add(image)
      if (available <= 0) {
        image.remove()
        onToast(`A note can contain up to ${NOTE_INLINE_IMAGE_LIMIT} pictures`)
        continue
      }
      const dataUrl = image.getAttribute('src') ?? ''
      try {
        const attachment = await window.aerio.productivity.saveNoteImage({ name: image.getAttribute('alt') || 'Picture', dataUrl })
        available -= 1
        imageUrls.current.set(attachment.id, dataUrl)
        image.setAttribute(NOTE_IMAGE_ATTRIBUTE, attachment.id)
        image.removeAttribute(INLINE_IMAGE_ATTRIBUTE)
        added.push(attachment)
      } catch (error) {
        image.remove()
        onToast(error instanceof Error ? error.message : 'The picture could not be added')
      }
    }
    emit(added)
  }

  const handleChange = () => {
    emit()
    void storePendingImages()
  }

  const { onDrop } = useRichEditorInput({ editorRef, onEditorChange: handleChange, onToast })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    plainNextPaste.current = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v'
  }

  // Pasted HTML gets the composer's sanitizer (no scripts, handlers, forms, or remote images); embedded pictures are then stored.
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = event.currentTarget
    const plainOnly = plainNextPaste.current
    plainNextPaste.current = false
    event.preventDefault()
    const data = event.clipboardData
    const files = Array.from(data.files ?? [])
    if (!plainOnly && files.length && files.every((file) => file.type.startsWith('image/'))) {
      void insertImageFiles(editor, files, handleChange, onToast, editorRange(editor))
      return
    }
    const html = plainOnly ? '' : data.getData('text/html')
    const safe = html ? collapsePastedWhitespace(sanitizePastedHtml(html, editor.ownerDocument), editor.ownerDocument) : ''
    if (safe) insertHtmlAtRange(editor, safe, editorRange(editor))
    else editor.ownerDocument.execCommand('insertText', false, data.getData('text/plain'))
    handleChange()
  }

  // Links are edited in place; Ctrl/Cmd+click opens them in the default browser.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return
    const href = (event.target as Element).closest?.('a[href]')?.getAttribute('href')
    if (!href || !isAllowedLink(href)) return
    event.preventDefault()
    window.open(href, '_blank', 'noopener')
  }

  const rememberSelection = () => { savedRange.current = editorRange(editorRef.current) ?? savedRange.current }
  const applyBlockStyle = (tag: string) => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const range = savedRange.current
    if (range && editor.contains(range.commonAncestorContainer)) {
      const selection = editor.ownerDocument.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    editor.ownerDocument.execCommand('formatBlock', false, `<${tag}>`)
    handleChange()
  }

  return (
    <div className="note-rich-editor">
      {!readOnly && <MailFormattingToolbar editorRef={editorRef} onEditorChange={handleChange} onToast={onToast} label="Note formatting">
        <span className="compose-formatting-divider" aria-hidden="true" />
        <select className="compose-format-select" aria-label="Paragraph style" defaultValue="" onMouseDown={rememberSelection} onFocus={rememberSelection} onChange={(event) => { if (event.target.value) applyBlockStyle(event.target.value); event.target.value = '' }}>
          <option value="" disabled>Style</option>
          {BLOCK_STYLES.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
        </select>
      </MailFormattingToolbar>}
      <div
        ref={editorRef}
        className="note-content-input note-rich-body"
        contentEditable={!readOnly}
        aria-readonly={readOnly || undefined}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Note body"
        data-placeholder="Start writing…"
        spellCheck
        onInput={handleChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onClick={onClick}
      />
    </div>
  )
}
