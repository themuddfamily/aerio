import { CalendarPlus, CheckSquare, ChevronsDownUp, ChevronsUpDown, Copy, Download, FileText, Filter, Info, Languages, NotebookPen, Printer, Tags, Type } from 'lucide-react'
import { useState, useEffect } from 'react'
import type { ContextMenuItem } from './ContextMenu'
import type { MailAccountSummary, MailLabel, MailMessageDetail, MailMessageRef, MailMessageLocalData } from '../mail-types'
import type { Note } from '../types'
import type { SyncedCalendar } from '../productivity-types'
import MailRulesModal from './MailRulesModal'
import Modal from './Modal'

type Tool = 'categories' | 'copy' | 'meeting' | 'task' | 'rule' | 'note' | 'translate' | 'format' | 'properties'
export const messageRef = (message: MailMessageDetail): MailMessageRef => ({ accountId: message.accountId, threadId: message.threadId, messageId: message.id })
const localTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const defaultLocal: MailMessageLocalData = { categories: [], format: 'auto', fontSize: 14, noteIds: [], taskIds: [] }

export function useMailMessageTools({ accounts, onToast, collapseAll, expandAll, onUpdated }: {
  accounts: MailAccountSummary[]; onToast(message: string): void; collapseAll(): void; expandAll(): void
  onUpdated(message: MailMessageDetail, local: MailMessageLocalData): void
}) {
  const [dialog, setDialog] = useState<{ tool: Tool; message: MailMessageDetail }>()
  const run = async (action: () => Promise<void>) => {
    try { await action() } catch (error) { onToast(error instanceof Error ? error.message : 'The message action failed') }
  }
  const items = (message: MailMessageDetail): ContextMenuItem[] => {
    const ref = messageRef(message)
    const readOnly = Boolean(accounts.find((account) => account.id === message.accountId)?.archived)
    const open = (tool: Tool) => () => setDialog({ tool, message })
    return [
      { label: 'Collapse all messages', icon: ChevronsDownUp, separatorBefore: true, action: collapseAll },
      { label: 'Expand all messages', icon: ChevronsUpDown, action: expandAll },
      { label: 'Edit categories…', icon: Tags, separatorBefore: true, action: open('categories') },
      { label: 'Save email as…', icon: Download, action: () => run(async () => { const result = await window.aerio.mail.messageTools.save(ref); if (result.savedPath) onToast('Email saved') }) },
      { label: 'Save all attachments…', icon: Download, disabled: !message.attachments.length, action: () => run(async () => { const result = await window.aerio.mail.messageTools.saveAttachments(ref); if (result.count) onToast(`Saved ${result.count} attachment${result.count === 1 ? '' : 's'}`) }) },
      { label: 'Copy to folder…', icon: Copy, disabled: readOnly, action: open('copy') },
      { label: 'Print email…', icon: Printer, action: () => run(() => window.aerio.mail.messageTools.print(ref, message.local?.format ?? 'auto')) },
      { label: 'Create meeting from email…', icon: CalendarPlus, separatorBefore: true, action: open('meeting') },
      { label: 'Create task from email…', icon: CheckSquare, action: open('task') },
      { label: 'Create rule from email…', icon: Filter, disabled: readOnly, action: open('rule') },
      { label: 'Add note…', icon: NotebookPen, action: open('note') },
      { label: 'Translate…', icon: Languages, separatorBefore: true, disabled: !message.text.trim(), action: open('translate') },
      { label: 'Message format…', icon: Type, action: open('format') },
      { label: 'Message properties', icon: Info, action: open('properties') }
    ]
  }
  return { items, dialog: dialog && <MessageToolDialog key={`${dialog.tool}:${dialog.message.accountId}:${dialog.message.id}`} {...dialog} accounts={accounts} onToast={onToast} onUpdated={onUpdated} onClose={() => setDialog(undefined)} /> }
}

function MessageToolDialog({ tool, message, accounts, onToast, onUpdated, onClose }: {
  tool: Tool; message: MailMessageDetail; accounts: MailAccountSummary[]; onToast(message: string): void
  onUpdated(message: MailMessageDetail, local: MailMessageLocalData): void; onClose(): void
}) {
  const local = message.local ?? defaultLocal
  const ref = messageRef(message)
  const [title, setTitle] = useState(message.subject || 'Email')
  const [content, setContent] = useState(tool === 'note' ? '' : message.text)
  const [categories, setCategories] = useState(local.categories.join(', '))
  const [format, setFormat] = useState(local.format)
  const [fontSize, setFontSize] = useState(local.fontSize)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [destination, setDestination] = useState('')
  const [calendars, setCalendars] = useState<SyncedCalendar[]>([])
  const [calendarId, setCalendarId] = useState('')
  const [notes, setNotes] = useState<Note[]>([])
  const [start, setStart] = useState(localTime(new Date(Date.now() + 60 * 60_000)))
  const [end, setEnd] = useState(localTime(new Date(Date.now() + 2 * 60 * 60_000)))
  const [due, setDue] = useState('')
  const account = accounts.find((item) => item.id === message.accountId)
  const [attendees, setAttendees] = useState([...new Set([message.fromEmail, ...message.to, ...message.cc].filter((email) => email.toLowerCase() !== account?.email.toLowerCase()))].join(', '))
  const [endpoint, setEndpoint] = useState(() => window.localStorage.getItem('aerio-translation-endpoint') || 'https://libretranslate.com')
  const [apiKey, setApiKey] = useState('')
  const [target, setTarget] = useState(() => window.localStorage.getItem('aerio-translation-target') || 'en')
  const [source, setSource] = useState('auto')
  const [translation, setTranslation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(['copy', 'meeting', 'rule', 'note'].includes(tool))

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (tool === 'copy' || tool === 'rule') {
          const values = await window.aerio.mail.mail.labels([message.accountId])
          if (!active) return
          setLabels(values)
          const choices = values.filter((label) => account?.provider === 'gmail' ? label.type === 'user' || label.id === 'INBOX' : label.id.startsWith('folder:') && !/draft|sent|outbox/i.test(label.name))
          setDestination(choices[0]?.id ?? '')
        }
        if (tool === 'meeting') {
          const snapshot = await window.aerio.productivity.snapshot()
          if (!active) return
          const writable = snapshot.calendars.filter((calendar) => calendar.canWrite)
          setCalendars(writable)
          setCalendarId(writable.find((calendar) => calendar.accountId === message.accountId)?.id ?? writable[0]?.id ?? '')
        }
        if (tool === 'note') {
          const values = await window.aerio.mail.messageTools.notes(ref)
          if (active) setNotes(values)
        }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'The message details could not be loaded') }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  const perform = async (action: () => Promise<void>, success: string, close = true) => {
    setBusy(true); setError('')
    try { await action(); if (success) onToast(success); if (close) onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The message action failed') }
    finally { setBusy(false) }
  }
  const updateLocal = async (updates: Parameters<typeof window.aerio.mail.messageTools.updateLocal>[1]) => {
    const saved = await window.aerio.mail.messageTools.updateLocal(ref, updates)
    onUpdated(message, saved)
  }
  const copyTargets = labels.filter((label) => account?.provider === 'gmail' ? label.type === 'user' || label.id === 'INBOX' : label.id.startsWith('folder:') && !/draft|sent|outbox/i.test(label.name))
  const titles: Record<Tool, string> = { categories: 'Edit categories', copy: 'Copy to folder', meeting: 'Create meeting from email', task: 'Create task from email', rule: 'Create rule from email', note: 'Add note', translate: 'Translate email', format: 'Message format', properties: 'Message properties' }

  if (tool === 'rule' && !loading && !error) return <MailRulesModal accounts={accounts} labels={labels} onToast={onToast} onClose={onClose} initialRule={{ accountId: message.accountId, name: `Mail from ${message.fromName || message.fromEmail}`, enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'equals', value: message.fromEmail }], actions: [{ action: 'archive' }] }} />

  return <Modal title={titles[tool]} subtitle={message.subject} width={tool === 'properties' || tool === 'translate' ? 'large' : 'small'} closeEnabled={!busy} onClose={onClose}>
    <div className="form-stack message-tool-form">
      {loading && <p role="status">Loading…</p>}
      {error && <p role="alert" className="message-tool-error">{error}</p>}
      {tool === 'categories' && <><p>Categories are saved on this computer for this email.</p><label className="field-label">Categories<input autoFocus value={categories} onChange={(event) => setCategories(event.target.value)} placeholder="Work, Personal, Follow up" /></label><small>Separate category names with commas. Clear the field to remove them.</small></>}
      {tool === 'format' && <><label className="field-label">Display format<select value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="auto">Automatic</option><option value="plain">Plain text</option><option value="html" disabled={!message.html}>HTML</option></select></label><label className="field-label">Text size<select value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))}>{[10, 12, 14, 16, 18, 20, 24, 28].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label></>}
      {tool === 'copy' && !loading && <><p>{account?.provider === 'gmail' ? 'Gmail keeps this email in its current locations and adds the destination label.' : 'Creates a copy of this email and keeps the original in its current folder.'}</p><label className="field-label">Destination<select value={destination} onChange={(event) => setDestination(event.target.value)}>{copyTargets.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>{!copyTargets.length && <p>No destination folders are available.</p>}</>}
      {['meeting', 'task', 'note'].includes(tool) && <><label className="field-label">Title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="field-label">{tool === 'note' ? 'Note' : 'Description'}<textarea rows={5} value={content} onChange={(event) => setContent(event.target.value)} /></label></>}
      {tool === 'task' && <label className="field-label">Due date<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>}
      {tool === 'note' && notes.length > 0 && <section className="message-linked-notes"><h3>Notes attached to this email</h3>{notes.map((note) => <article key={note.id}><strong>{note.title}</strong><p>{note.content}</p></article>)}</section>}
      {tool === 'meeting' && <><label className="field-label">Calendar<select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>{!loading && !calendars.length && <p>Connect and sync a writable Google or Microsoft calendar to create a meeting.</p>}<label className="field-label">Starts<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label className="field-label">Ends<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><label className="field-label">Attendees<input value={attendees} onChange={(event) => setAttendees(event.target.value)} /></label><small>Saving creates the calendar event and invites the listed attendees.</small></>}
      {tool === 'translate' && <><p>Email text will be sent to the translation server you choose.</p><label className="field-label">LibreTranslate server<input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><label className="field-label">API key (if required)<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><label className="field-label">Source language code<input value={source} onChange={(event) => setSource(event.target.value)} placeholder="auto" /></label><label className="field-label">Target language code<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="en, fr, de, es…" /></label>{translation && <section aria-label="Translated message"><h3>Translation</h3><pre className="mail-text">{translation}</pre></section>}</>}
      {tool === 'properties' && <dl className="message-properties">{Object.entries({ Subject: message.subject, From: `${message.fromName} <${message.fromEmail}>`, To: message.to.join(', '), Cc: message.cc.join(', '), Date: new Date(message.date).toLocaleString(), Account: account?.email ?? message.accountId, Provider: account?.provider ?? '', 'Message ID': message.messageIdHeader ?? message.id, 'Conversation ID': message.threadId, References: message.references?.join('\n') ?? '', Labels: message.labelIds.join(', '), Categories: local.categories.join(', '), Attachments: message.attachments.map((attachment) => `${attachment.filename} (${attachment.size} bytes, ${attachment.mimeType})`).join('\n'), 'Linked notes': String(local.noteIds.length), 'Linked tasks': String(local.taskIds.length), Format: local.format }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>)}</dl>}
    </div>
    <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={onClose}>{tool === 'properties' ? 'Close' : 'Cancel'}</button><span className="spacer" />
      {tool === 'categories' && <button className="button primary" disabled={busy} onClick={() => void perform(() => updateLocal({ categories: categories.split(',') }), 'Categories saved')}>Save categories</button>}
      {tool === 'format' && <button className="button primary" disabled={busy} onClick={() => void perform(() => updateLocal({ format, fontSize }), 'Message format saved')}>Save format</button>}
      {tool === 'copy' && <button className="button primary" disabled={busy || loading || !destination} onClick={() => void perform(() => window.aerio.mail.messageTools.copy(ref, destination), 'Email copied')}>Copy</button>}
      {tool === 'task' && <button className="button primary" disabled={busy || !title.trim()} onClick={() => void perform(() => window.aerio.mail.messageTools.createTask(ref, { title, notes: content, due: due ? new Date(`${due}T12:00:00`).toISOString() : undefined }), 'Task created from email')}>Create task</button>}
      {tool === 'note' && <button className="button primary" disabled={busy || loading || !title.trim() || !content.trim()} onClick={() => void perform(() => window.aerio.mail.messageTools.addNote(ref, { title, content }), 'Note attached to email')}>Save note</button>}
      {tool === 'meeting' && <button className="button primary" disabled={busy || loading || !calendarId || !title.trim() || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)} onClick={() => void perform(async () => {
        const attendeeList = attendees.split(',').map((email) => email.trim()).filter(Boolean)
        if (attendeeList.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Enter attendee email addresses separated by commas')
        await window.aerio.productivity.createEvent({ id: crypto.randomUUID(), calendarId, title, description: `${content}\n\nFrom email: ${message.messageIdHeader ?? message.id}`, start: new Date(start).toISOString(), end: new Date(end).toISOString(), attendees: attendeeList, color: calendars.find((calendar) => calendar.id === calendarId)?.color ?? '#6659e8', reminderMinutes: 15, recurrence: 'none' })
      }, 'Meeting created from email')}>Create meeting</button>}
      {tool === 'translate' && <button className="button primary" disabled={busy || !endpoint.trim() || !target.trim()} onClick={() => void perform(async () => {
        const result = await window.aerio.mail.messageTools.translate(ref, { endpoint, apiKey, target, source })
        setTranslation(result)
        window.localStorage.setItem('aerio-translation-endpoint', endpoint)
        window.localStorage.setItem('aerio-translation-target', target)
      }, '', false)}>{busy ? 'Translating…' : 'Translate'}</button>}
    </footer>
  </Modal>
}
