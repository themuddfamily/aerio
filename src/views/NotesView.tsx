import {
  AlertTriangle, Archive, ArrowRightLeft, Cloud, Copy, ExternalLink, FileText, FileUp, Folder, Grid2X2, List, Paperclip, Pin, Plus, Search, Tag, Trash2, X
} from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useMemo, useRef, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, Note } from '../types'
import type { NoteOwnerTarget } from '../server-notes-types'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import NoteRichEditor from '../components/NoteRichEditor'
import { NOTE_FILE_ATTACHMENT_LIMIT } from '../lib/note-rich-text'
import { isServerNote, useServerNotes } from '../lib/use-server-notes'
import {
  importMessage, NoteTransferDialog, ownerLabel, ServerNotesAccountHeading, ServerNotesReviewDialog, transferMessage, VNoteImportDialog
} from '../components/ServerNotesDialogs'

interface NotesViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onToast(message: string): void
}

// Provider folders (docs/server-notes.md) are selected as `server:<folder id>`; Local folders by name.
const SERVER_PREFIX = 'server:'
const SPECIAL = ['All notes', 'Pinned', 'Archive']

export default function NotesView({ state, query, onChange, onToast }: NotesViewProps) {
  const { showContextMenu } = useContextMenu()
  const server = useServerNotes(onToast)
  const latest = useRef(state)
  latest.current = state
  const [folder, setFolder] = useState('All notes')
  const allNotes = useMemo<Note[]>(() => [...state.notes, ...server.notes], [server.notes, state.notes])
  const [selectedId, setSelectedId] = useState(state.notes[0]?.id ?? '')
  const [grid, setGrid] = useState(false)
  const [tagFilter, setTagFilter] = useState<string>()
  const [transfer, setTransfer] = useState<{ note: Note; mode: 'copy' | 'move' }>()
  const [importing, setImporting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [syncing, setSyncing] = useState('')
  const localFolders = Array.from(new Set(state.notes.map((note) => note.folder)))
  const folders = ['All notes', 'Pinned', ...localFolders, 'Archive']
  const serverFolderId = folder.startsWith(SERVER_PREFIX) ? folder.slice(SERVER_PREFIX.length) : undefined
  const serverFolder = server.snapshot.folders.find((item) => item.id === serverFolderId)
  const inFolder = (note: Note, name: string) => name === 'All notes' ? !note.archived : name === 'Pinned' ? note.pinned && !note.archived : name === 'Archive' ? note.archived
    : name.startsWith(SERVER_PREFIX) ? isServerNote(note) && note.owner.folderId === name.slice(SERVER_PREFIX.length) && !note.archived
      : !isServerNote(note) && note.folder === name && !note.archived
  const notes = useMemo(() => allNotes
    .filter((note) => inFolder(note, folder))
    .filter((note) => !tagFilter || note.tags.includes(tagFilter))
    .filter((note) => !query || `${note.title} ${note.content} ${note.tags.join(' ')} ${(note.attachments ?? []).filter((attachment) => !attachment.inline).map((attachment) => attachment.name).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [folder, query, allNotes, tagFilter])
  const selected = notes.find((note) => note.id === selectedId) ?? notes[0]
  // Inline pictures are part of the rich body; only file attachments are listed.
  const files = (selected?.attachments ?? []).filter((attachment) => !attachment.inline)
  const locked = isServerNote(selected) && (selected.readOnly || selected.sync === 'review')
  const folderTitle = serverFolder ? serverFolder.name : folder

  const changeNote = (note: Note, updates: Partial<Note>) => {
    if (isServerNote(note)) return server.update(note, updates)
    const current = latest.current
    onChange({ ...current, notes: current.notes.map((item) => item.id === note.id ? { ...item, ...updates, updatedAt: new Date().toISOString() } : item) })
  }
  const update = (updates: Partial<Note>) => { if (selected) changeNote(selected, updates) }

  const addLocalNotes = (added: Note[], replaced: Note[] = [], removeIds: string[] = []) => {
    if (!added.length && !replaced.length && !removeIds.length) return
    const current = latest.current
    const byId = new Map(replaced.map((note) => [note.id, note]))
    onChange({ ...current, notes: [...added, ...current.notes.filter((note) => !removeIds.includes(note.id)).map((note) => byId.get(note.id) ?? note)] })
  }

  const create = (targetFolder = folder, tags: string[] = []) => {
    const base: Note = {
      id: uid('note'), folder: !SPECIAL.includes(targetFolder) && !targetFolder.startsWith(SERVER_PREFIX) ? targetFolder : 'Personal',
      title: 'Untitled note', content: '', tags, pinned: targetFolder === 'Pinned', archived: false, updatedAt: new Date().toISOString()
    }
    if (targetFolder.startsWith(SERVER_PREFIX)) {
      const target = server.snapshot.folders.find((item) => item.id === targetFolder.slice(SERVER_PREFIX.length))
      if (!target || target.readOnly) return onToast('This notes folder is read-only')
      void server.create(target.id, { ...base, folder: target.name }).then((created) => {
        setSelectedId(created.id)
        setFolder(targetFolder)
        setTagFilter(tags[0])
      }).catch((error: unknown) => onToast(error instanceof Error ? error.message : 'The note could not be created'))
      return
    }
    onChange({ ...latest.current, notes: [base, ...latest.current.notes] })
    setSelectedId(base.id)
    setFolder(targetFolder === 'Archive' ? 'All notes' : targetFolder)
    setTagFilter(tags[0])
  }

  const duplicateNote = (note: Note) => {
    const duplicate = { ...note, id: uid('note'), title: `${note.title} (copy)`, archived: false, updatedAt: new Date().toISOString() }
    if (isServerNote(note)) {
      if (note.readOnly) return onToast('This notes folder is read-only; use Copy to… to copy the note elsewhere')
      void server.create(note.owner.folderId, duplicate).then((created) => { setSelectedId(created.id); onToast('Note duplicated') })
        .catch((error: unknown) => onToast(error instanceof Error ? error.message : 'The note could not be duplicated'))
      return
    }
    onChange({ ...latest.current, notes: [duplicate, ...latest.current.notes] })
    setFolder('All notes')
    setTagFilter(undefined)
    setSelectedId(duplicate.id)
    onToast('Note duplicated')
  }

  const removeNote = (note: Note) => {
    if (isServerNote(note)) {
      if (note.readOnly) return onToast('This notes folder is read-only')
      void server.remove(note.id).then(() => onToast('Note deleted')).catch((error: unknown) => onToast(error instanceof Error ? error.message : 'The note could not be deleted'))
    } else {
      onChange({ ...latest.current, notes: latest.current.notes.filter((item) => item.id !== note.id) })
      onToast('Note deleted')
    }
    if (selectedId === note.id) setSelectedId('')
  }

  const deleteNote = (note: Note) => {
    if (!window.confirm(`Delete “${note.title}”?${isServerNote(note) ? ' It is also deleted on the server.' : ''}`)) return
    removeNote(note)
  }

  const attachFiles = async () => {
    if (!selected) return
    try {
      const attachments = await window.aerio.productivity.chooseNoteAttachments()
      if (!attachments.length) return
      if (files.length + attachments.length > NOTE_FILE_ATTACHMENT_LIMIT) throw new Error(`A note can contain up to ${NOTE_FILE_ATTACHMENT_LIMIT} attachments`)
      update({ attachments: [...(selected.attachments ?? []), ...attachments] })
      onToast(`${attachments.length} attachment${attachments.length === 1 ? '' : 's'} added`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachments could not be added')
    }
  }

  const openAttachment = async (path?: string) => {
    if (!path) return onToast('That attachment is unavailable')
    try {
      const result = await window.aerio.productivity.openNoteAttachment(path)
      if (result.error) throw new Error(result.error)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be opened')
    }
  }

  const syncAccount = async (accountId: string) => {
    setSyncing(accountId)
    try { await window.aerio.serverNotes?.sync(accountId) } catch (error) {
      onToast(error instanceof Error ? error.message : 'Notes could not be synchronized')
    } finally { setSyncing('') }
  }

  const noteMenu = (note: Note): ContextMenuItem[] => [
    { label: 'Open note', icon: FileText, action: () => setSelectedId(note.id) },
    { label: note.pinned ? 'Unpin note' : 'Pin note', icon: Pin, checked: note.pinned, separatorBefore: true, action: () => changeNote(note, { pinned: !note.pinned }) },
    { label: note.archived ? 'Restore from Archive' : 'Archive note', icon: Archive, action: () => {
      changeNote(note, { archived: !note.archived })
      if (selectedId === note.id) setSelectedId('')
      onToast(note.archived ? 'Note restored' : 'Note archived')
    } },
    { label: 'Duplicate note', icon: Copy, separatorBefore: true, action: () => duplicateNote(note) },
    ...(server.available && (isServerNote(note) || server.snapshot.folders.some((item) => !item.readOnly)) ? [
      { label: 'Copy to…', icon: Copy, action: () => setTransfer({ note, mode: 'copy' }) },
      { label: 'Move to…', icon: ArrowRightLeft, action: () => setTransfer({ note, mode: 'move' }) }
    ] satisfies ContextMenuItem[] : []),
    { label: 'Copy note text', icon: Copy, action: () => copyText(`${note.title}\n\n${note.content}`) },
    { label: 'Delete note', icon: Trash2, separatorBefore: true, danger: true, action: () => deleteNote(note) }
  ]

  const folderButton = (item: string, label: string, icon: React.ReactNode, count: number) => (
    <button key={item} className={`sidebar-item ${folder === item && !tagFilter ? 'active' : ''}`} onClick={() => { setFolder(item); setTagFilter(undefined) }} onContextMenu={(event) => showContextMenu(event, [
      { label: `Open ${label}`, icon: Folder, action: () => { setFolder(item); setTagFilter(undefined) } },
      { label: `New note${!SPECIAL.includes(item) ? ` in ${label}` : ''}`, icon: Plus, separatorBefore: true, action: () => create(item) }
    ], label)}>
      {icon}<span>{label}</span><em>{count}</em>
    </button>
  )
  const importTarget: NoteOwnerTarget = serverFolder ? { kind: 'server', folderId: serverFolder.id } : { kind: 'local', folder: !SPECIAL.includes(folder) ? folder : localFolders[0] ?? 'Personal' }
  const ownerAccounts = server.snapshot.accounts.filter((account) => server.snapshot.folders.some((item) => item.accountId === account.id))
  const saveState = !isServerNote(selected) ? 'Saved locally'
    : selected.readOnly ? 'Read-only on the server' : selected.sync === 'review' ? 'Needs review' : selected.sync === 'pending' ? 'Waiting to sync' : 'Synced'

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" disabled={Boolean(serverFolder?.readOnly)} onClick={() => create()}><Plus size={18} /> New note</button>
        {server.snapshot.review.length > 0 && <button className="sidebar-item server-notes-review-button" onClick={() => setReviewing(true)}><AlertTriangle size={16} /><span>Notes to review</span><em>{server.snapshot.review.length}</em></button>}
        <div className="sidebar-group">
          <span className="sidebar-label">Library</span>
          {folderButton('All notes', 'All notes', <FileText size={17} />, allNotes.filter((note) => !note.archived).length)}
          {folderButton('Pinned', 'Pinned', <Pin size={17} />, allNotes.filter((note) => note.pinned && !note.archived).length)}
          {folderButton('Archive', 'Archive', <Archive size={17} />, allNotes.filter((note) => note.archived).length)}
        </div>
        <div className="sidebar-group">
          <span className="sidebar-label">Local</span>
          {folders.filter((item) => !SPECIAL.includes(item)).map((item) => folderButton(item, item, <Folder size={17} />, state.notes.filter((note) => note.folder === item && !note.archived).length))}
        </div>
        {ownerAccounts.map((account) => <div className="sidebar-group" key={account.id}>
          <ServerNotesAccountHeading name={account.name} status={account.status} error={account.error} syncing={syncing === account.id} onSync={() => void syncAccount(account.id)} />
          {server.snapshot.folders.filter((item) => item.accountId === account.id).map((item) => folderButton(`${SERVER_PREFIX}${item.id}`, item.name, <Cloud size={17} />, server.notes.filter((note) => note.owner.folderId === item.id && !note.archived).length))}
        </div>)}
        <div className="sidebar-group">
          <span className="sidebar-label">Tags</span>
          {Array.from(new Set(allNotes.flatMap((note) => note.tags))).slice(0, 6).map((tag) => <button className={`sidebar-item ${tagFilter === tag ? 'active' : ''}`} key={tag} onClick={() => { setTagFilter((current) => current === tag ? undefined : tag); setFolder('All notes') }} onContextMenu={(event) => showContextMenu(event, [
            { label: `Show #${tag}`, icon: Tag, action: () => { setTagFilter(tag); setFolder('All notes') } },
            { label: `New note tagged #${tag}`, icon: Plus, separatorBefore: true, action: () => create('Personal', [tag]) },
            { label: 'Copy tag', icon: Copy, action: () => copyText(tag) }
          ], `#${tag}`)}><Tag size={15} /><span>{tag}</span></button>)}
        </div>
        {server.available && <button className="sidebar-item" onClick={() => setImporting(true)}><FileUp size={16} /><span>Import vNote…</span></button>}
      </aside>
      <section className="notes-list-panel">
        <header className="panel-heading">
          <div><h1>{tagFilter ? `#${tagFilter}` : folderTitle}</h1><p>{notes.length} notes{serverFolder ? ` · ${serverFolder.readOnly ? 'Read-only' : 'Synchronized'}${serverFolder.error ? ` · ${serverFolder.error}` : ''}` : ''}</p></div>
          <div className="segmented icon-segmented"><button aria-label="List view" className={!grid ? 'active' : ''} onClick={() => setGrid(false)}><List size={15} /></button><button aria-label="Grid view" className={grid ? 'active' : ''} onClick={() => setGrid(true)}><Grid2X2 size={15} /></button></div>
        </header>
        <div className={grid ? 'notes-grid' : 'notes-list'} onContextMenu={(event) => showContextMenu(event, [
          { label: 'New note', icon: Plus, action: () => create() },
          { label: grid ? 'Switch to list view' : 'Switch to grid view', icon: grid ? List : Grid2X2, action: () => setGrid((value) => !value) }
        ], 'Notes')}>
          {notes.map((note) => (
            <button key={note.id} className={`note-card ${selected?.id === note.id ? 'selected' : ''}`} style={{ '--note-color': note.color ?? 'var(--surface)' } as React.CSSProperties} onClick={() => setSelectedId(note.id)} onContextMenu={(event) => showContextMenu(event, noteMenu(note), note.title)}>
              <span className="note-card-top">{note.pinned && <Pin size={13} fill="currentColor" />}{isServerNote(note) && <Cloud size={12} aria-label={note.sync === 'synced' ? 'Synchronized' : note.sync === 'pending' ? 'Waiting to sync' : 'Needs review'} className={`note-sync-${note.sync}`} />}<time>{formatDistanceToNow(parseISO(note.updatedAt), { addSuffix: true })}</time></span>
              <strong>{note.title}</strong>
              <p>{note.content.slice(0, grid ? 140 : 90) || 'Start writing…'}</p>
              <span className="note-tags">{note.tags.slice(0, 3).map((tag) => <em key={tag}>#{tag}</em>)}</span>
            </button>
          ))}
          {notes.length === 0 && <div className="empty-state"><Search size={28} /><h3>No notes here</h3></div>}
        </div>
      </section>
      <section className="note-editor-panel">
        {selected ? (
          <>
            <header className="note-editor-toolbar" onContextMenu={(event) => showContextMenu(event, noteMenu(selected), selected.title)}>
              {isServerNote(selected)
                ? <span className="note-owner-label" title={ownerLabel(selected, server.snapshot)}><Cloud size={14} /> {ownerLabel(selected, server.snapshot)}</span>
                : <select aria-label="Note folder" value={selected.folder} onChange={(event) => update({ folder: event.target.value })}>
                  {Array.from(new Set(['Personal', 'Studio', 'Ideas', ...state.notes.map((note) => note.folder)])).map((item) => <option key={item}>{item}</option>)}
                </select>}
              <span className="save-state">{saveState}</span>
              {isServerNote(selected) && selected.sync === 'review' && <button className="button ghost" onClick={() => setReviewing(true)}>Review</button>}
              <span className="spacer" />
              {server.available && server.snapshot.folders.length > 0 && <button className="icon-button" title="Move to another folder" onClick={() => setTransfer({ note: selected, mode: 'move' })}><ArrowRightLeft size={17} /></button>}
              <button className="icon-button" title="Attach files" disabled={locked} onClick={() => void attachFiles()}><Paperclip size={17} /></button>
              <button className={`icon-button ${selected.pinned ? 'active' : ''}`} title="Pin note" onClick={() => update({ pinned: !selected.pinned })}><Pin size={17} fill={selected.pinned ? 'currentColor' : 'none'} /></button>
              <button className="icon-button" title="Archive" onClick={() => { update({ archived: true }); setSelectedId(''); onToast('Note archived') }}><Archive size={17} /></button>
              <button className="icon-button danger" title="Delete" disabled={isServerNote(selected) && selected.readOnly} onClick={() => removeNote(selected)}><Trash2 size={17} /></button>
            </header>
            <div className="note-paper">
              <input className="note-title-input" aria-label="Note title" value={selected.title} readOnly={locked} onChange={(event) => update({ title: event.target.value })} />
              <div className="tag-editor">
                <Tag size={14} /><input value={selected.tags.join(', ')} readOnly={locked} onChange={(event) => update({ tags: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="Add tags, separated by commas" />
              </div>
              <NoteRichEditor key={selected.id} note={selected} readOnly={locked} onChange={update} onToast={onToast} />
              {files.length > 0 && <section className="note-attachments" aria-label="Note attachments">
                <header><Paperclip size={14} /><strong>Attachments</strong><span>{files.length}</span></header>
                {files.map((attachment) => <div className="note-attachment" key={attachment.id} onContextMenu={(event) => showContextMenu(event, [
                  { label: 'Open attachment', icon: ExternalLink, action: () => void openAttachment(attachment.path) },
                  ...(locked ? [] : [{ label: 'Remove from note', icon: Trash2, danger: true, separatorBefore: true, action: () => update({ attachments: selected.attachments?.filter((item) => item.id !== attachment.id) }) }])
                ], attachment.name)}>
                  <button onClick={() => void openAttachment(attachment.path)}><FileText size={16} /><span><strong>{attachment.name}</strong><small>{attachment.size < 1024 ? `${attachment.size} B` : `${(attachment.size / 1024).toFixed(1)} KB`}</small></span></button>
                  {!locked && <button className="icon-button" aria-label={`Remove ${attachment.name}`} title="Remove attachment" onClick={() => update({ attachments: selected.attachments?.filter((item) => item.id !== attachment.id) })}><X size={15} /></button>}
                </div>)}
              </section>}
              <footer><span>{selected.content.trim().split(/\s+/).filter(Boolean).length} words</span><span>Edited {formatDistanceToNow(parseISO(selected.updatedAt), { addSuffix: true })}</span></footer>
            </div>
          </>
        ) : <div className="empty-state grow"><FileText size={32} /><h3>Select a note</h3></div>}
      </section>
      {transfer && <NoteTransferDialog mode={transfer.mode} note={transfer.note} localFolders={Array.from(new Set(['Personal', ...localFolders]))} snapshot={server.snapshot} onClose={() => setTransfer(undefined)} onDone={(result, targetName) => {
        addLocalNotes(result.localNotes, [], result.removeLocalIds)
        if (transfer.mode === 'move' && result.localNotes[0]) setSelectedId(result.localNotes[0].id)
        setTransfer(undefined)
        onToast(transferMessage(result, transfer.mode, targetName))
      }} />}
      {importing && <VNoteImportDialog localFolders={Array.from(new Set(['Personal', ...localFolders]))} snapshot={server.snapshot} initialTarget={importTarget} onClose={() => setImporting(false)} onImported={(result, targetName) => {
        addLocalNotes(result.localNotes, result.replacedLocal)
        setImporting(false)
        onToast(importMessage(result, targetName))
      }} />}
      {reviewing && <ServerNotesReviewDialog snapshot={server.snapshot} onClose={() => setReviewing(false)} onLocalNotes={(added) => addLocalNotes(added)} onToast={onToast} />}
    </div>
  )
}
