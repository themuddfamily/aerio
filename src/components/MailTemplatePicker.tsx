import { Download, FilePlus2, Paperclip, Pencil, Search, TextQuote, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { MailTemplate, MailTemplateKind } from '../mail-template-types'
import { formatFileSize } from '../lib/domain'

export interface ComposerAttachment { name: string; size: number; path: string }

interface MailTemplatePickerProps {
  editorRef: RefObject<HTMLDivElement | null>
  subject: string
  attachments: ComposerAttachment[]
  /** Called after HTML was inserted into the editor so the composer can resync its draft state. */
  onEditorChange(): void
  /** Applies whole-message template fields; snippets never call this. */
  onApplyTemplate(changes: { subject?: string; attachments: ComposerAttachment[] }): void
  onToast(message: string): void
}

interface TemplateDraft {
  id?: string
  kind: MailTemplateKind
  name: string
  subject: string
  html: string
  attachments: Array<ComposerAttachment & { id?: string }>
  updatedAt?: string
  session: number
}

const friendlyError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback : fallback

const rangeInside = (editor: HTMLElement, range: Range | undefined) => Boolean(range && editor.contains(range.commonAncestorContainer))

/**
 * Inserts trusted (main-process sanitized) HTML at a saved editor range, or at the
 * end of the message when the caret was never placed. Uses the editor's own
 * document so it also works after the composer is popped out.
 */
export function insertHtmlAtRange(editor: HTMLElement, html: string, saved?: Range) {
  const document = editor.ownerDocument
  const selection = document.getSelection()
  editor.focus()
  let range: Range
  if (saved && rangeInside(editor, saved)) range = saved.cloneRange()
  else {
    range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  selection?.removeAllRanges()
  selection?.addRange(range)
  // execCommand keeps native undo; fall back to direct range insertion where it is unavailable.
  let inserted = false
  try { inserted = typeof document.execCommand === 'function' && document.execCommand('insertHTML', false, html) } catch { inserted = false }
  if (!inserted) {
    range.deleteContents()
    const fragment = range.createContextualFragment(html)
    const last = fragment.lastChild
    range.insertNode(fragment)
    if (last) {
      range.setStartAfter(last)
      range.collapse(true)
    }
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  return selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined
}

export default function MailTemplatePicker({ editorRef, subject, attachments, onEditorChange, onApplyTemplate, onToast }: MailTemplatePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [templates, setTemplates] = useState<MailTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<TemplateDraft>()
  const [busy, setBusy] = useState(false)
  const savedRange = useRef<Range | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const initialBody = useRef('')
  const session = useRef(0)
  const api = window.aerio.mail.templates

  const load = useCallback(async (search: string) => {
    setLoading(true)
    try { setTemplates(await api.list(search.trim() || undefined)) }
    catch (error) { onToast(friendlyError(error, 'Templates could not be loaded')) }
    finally { setLoading(false) }
  }, [api, onToast])

  useEffect(() => {
    if (!open || editing) return
    const timer = setTimeout(() => void load(query), query ? 150 : 0)
    return () => clearTimeout(timer)
  }, [editing, load, open, query])

  const captureSelection = () => {
    const editor = editorRef.current
    const selection = editor?.ownerDocument.getSelection()
    if (!editor || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (rangeInside(editor, range)) savedRange.current = range.cloneRange()
  }

  const toggle = () => {
    if (open) {
      setOpen(false)
      setEditing(undefined)
      return
    }
    captureSelection()
    setOpen(true)
  }

  const close = () => {
    setOpen(false)
    setEditing(undefined)
    setQuery('')
  }

  const apply = async (template: MailTemplate) => {
    const editor = editorRef.current
    if (!editor || busy) return
    setBusy(true)
    try {
      const used = await api.use(template.id)
      if (used.html) savedRange.current = insertHtmlAtRange(editor, used.html, savedRange.current)
      onEditorChange()
      if (used.kind === 'template') {
        onApplyTemplate({
          subject: used.subject || undefined,
          attachments: used.attachments.map((attachment) => ({ name: attachment.name, size: attachment.size, path: attachment.path }))
        })
      }
      close()
      onToast(`Inserted “${used.name}”`)
    } catch (error) {
      onToast(friendlyError(error, 'The template could not be inserted'))
    } finally {
      setBusy(false)
    }
  }

  const startNew = (kind: MailTemplateKind) => {
    const editor = editorRef.current
    let html = ''
    if (kind === 'snippet' && editor && savedRange.current && rangeInside(editor, savedRange.current) && !savedRange.current.collapsed) {
      const container = editor.ownerDocument.createElement('div')
      container.append(savedRange.current.cloneContents())
      html = container.innerHTML
    } else if (kind === 'template' && editor) html = editor.innerHTML
    initialBody.current = html
    setEditing({ session: ++session.current, kind, name: '', subject: kind === 'template' ? subject : '', html, attachments: kind === 'template' ? attachments.map((item) => ({ ...item })) : [] })
  }

  const startEdit = (template: MailTemplate) => {
    initialBody.current = template.html
    setEditing({
    session: ++session.current,
    id: template.id, kind: template.kind, name: template.name, subject: template.subject, html: template.html,
    attachments: template.attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, size: attachment.size, path: attachment.path })),
    updatedAt: template.updatedAt
    })
  }

  const remove = async (template: MailTemplate) => {
    if (!window.confirm(`Delete “${template.name}”? Drafts that already used it keep their copy.`)) return
    try {
      await api.delete(template.id)
      setTemplates((items) => items.filter((item) => item.id !== template.id))
      onToast(`Deleted “${template.name}”`)
    } catch (error) {
      onToast(friendlyError(error, 'The template could not be deleted'))
    }
  }

  const addFiles = async () => {
    try {
      const selected = await window.aerio.chooseAttachments()
      setEditing((current) => {
        if (!current) return current
        const known = new Set(current.attachments.map((item) => item.path.toLowerCase()))
        return { ...current, attachments: [...current.attachments, ...selected.filter((item) => item.path && !known.has(item.path.toLowerCase())).map((item) => ({ name: item.name, size: item.size, path: item.path! }))] }
      })
    } catch (error) {
      onToast(friendlyError(error, 'Attachments could not be selected'))
    }
  }

  const saveTemplate = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      onToast('Give the template a name')
      return
    }
    setBusy(true)
    try {
      const saved = await api.save({
        id: editing.id,
        kind: editing.kind,
        name: editing.name,
        subject: editing.kind === 'template' ? editing.subject : undefined,
        html: bodyRef.current?.innerHTML ?? editing.html,
        attachments: editing.attachments,
        expectedUpdatedAt: editing.updatedAt
      })
      setEditing(undefined)
      onToast(`Saved “${saved.name}”`)
    } catch (error) {
      onToast(friendlyError(error, 'The template could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  const exportBackup = async () => {
    try {
      const result = await api.exportBackup()
      if (result.savedPath) onToast('Templates exported')
    } catch (error) {
      onToast(friendlyError(error, 'Templates could not be exported'))
    }
  }

  const importBackup = async () => {
    try {
      const result = await api.importBackup()
      if (!result) return
      onToast(`Restored ${result.restored} ${result.restored === 1 ? 'template' : 'templates'}`)
      await load(query)
    } catch (error) {
      onToast(friendlyError(error, 'Templates could not be restored'))
    }
  }

  // The body editor is uncontrolled: it is keyed per editing session and seeded once.
  const bindBody = useCallback((element: HTMLDivElement | null) => {
    bodyRef.current = element
    if (element) element.innerHTML = initialBody.current
  }, [])

  return (
    <div className="template-picker-anchor">
      <button className="icon-button" title="Templates and snippets" aria-label="Templates and snippets" aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={toggle}><TextQuote size={15} /></button>
      {open && <div className="template-picker" role="dialog" aria-label="Templates and snippets" data-local-escape onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
        {editing ? <div className="template-editor">
          <header><strong>{editing.id ? 'Edit' : 'New'} {editing.kind === 'snippet' ? 'snippet' : 'message template'}</strong><button className="icon-button" aria-label="Cancel editing" onClick={() => setEditing(undefined)}><X size={14} /></button></header>
          <label>Name<input autoFocus value={editing.name} maxLength={200} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
          {editing.kind === 'template' && <label>Subject<input value={editing.subject} maxLength={998} onChange={(event) => setEditing({ ...editing, subject: event.target.value })} /></label>}
          <div key={editing.session} ref={bindBody} className="template-editor-body" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Template body" data-placeholder="Template text…" onPaste={(event) => {
            event.preventDefault()
            event.currentTarget.ownerDocument.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
          }} />
          {editing.kind === 'template' && <div className="template-editor-files">
            {editing.attachments.map((file, index) => <span key={`${file.path}-${index}`}><Paperclip size={12} />{file.name}{file.size > 0 && <small>{formatFileSize(file.size)}</small>}<button aria-label={`Remove ${file.name} from template`} onClick={() => setEditing({ ...editing, attachments: editing.attachments.filter((_, itemIndex) => itemIndex !== index) })}><X size={12} /></button></span>)}
            <button className="text-button" onClick={() => void addFiles()}><Paperclip size={13} /> Add files</button>
          </div>}
          <footer><button className="button ghost small" onClick={() => setEditing(undefined)}>Cancel</button><button className="button primary small" disabled={busy} onClick={() => void saveTemplate()}>Save</button></footer>
        </div> : <>
          <label className="template-search"><Search size={14} /><input autoFocus aria-label="Search templates" placeholder="Search snippets and templates" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && templates[0]) {
              event.preventDefault()
              void apply(templates[0])
            }
          }} /></label>
          <div className="template-list" role="list">
            {templates.map((template) => <div className="template-item" role="listitem" key={template.id}>
              <button className="template-insert" disabled={busy} onClick={() => void apply(template)} title={template.kind === 'snippet' ? 'Insert at the cursor' : 'Insert body, subject, and attachments'}>
                <strong>{template.name}</strong>
                <small>{template.kind === 'snippet' ? 'Snippet' : 'Template'}{template.subject ? ` · ${template.subject}` : ''}{template.attachments.length ? ` · ${template.attachments.length} ${template.attachments.length === 1 ? 'file' : 'files'}` : ''}</small>
                {template.text && <span>{template.text.slice(0, 120)}</span>}
              </button>
              <button className="icon-button" aria-label={`Edit ${template.name}`} onClick={() => startEdit(template)}><Pencil size={13} /></button>
              <button className="icon-button" aria-label={`Delete ${template.name}`} onClick={() => void remove(template)}><Trash2 size={13} /></button>
            </div>)}
            {!loading && !templates.length && <p className="template-empty">{query ? 'No snippets or templates match.' : 'Save a selection as a snippet, or this message as a template.'}</p>}
          </div>
          <footer>
            <button className="text-button" onClick={() => startNew('snippet')}><FilePlus2 size={13} /> Snippet from selection</button>
            <button className="text-button" onClick={() => startNew('template')}><FilePlus2 size={13} /> Template from message</button>
            <span className="spacer" />
            <button className="icon-button" title="Export templates" aria-label="Export templates" onClick={() => void exportBackup()}><Download size={13} /></button>
            <button className="icon-button" title="Restore templates" aria-label="Restore templates" onClick={() => void importBackup()}><Upload size={13} /></button>
          </footer>
        </>}
      </div>}
    </div>
  )
}
