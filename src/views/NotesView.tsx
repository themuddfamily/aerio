import {
  Archive, Copy, FileText, Folder, Grid2X2, List, Pin, Plus, Search, Tag, Trash2
} from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useMemo, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, Note } from '../types'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'

interface NotesViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onToast(message: string): void
}

export default function NotesView({ state, query, onChange, onToast }: NotesViewProps) {
  const { showContextMenu } = useContextMenu()
  const [folder, setFolder] = useState('All notes')
  const [selectedId, setSelectedId] = useState(state.notes[0]?.id ?? '')
  const [grid, setGrid] = useState(false)
  const [tagFilter, setTagFilter] = useState<string>()
  const folders = ['All notes', 'Pinned', ...Array.from(new Set(state.notes.map((note) => note.folder))), 'Archive']
  const notes = useMemo(() => state.notes
    .filter((note) => folder === 'All notes' ? !note.archived : folder === 'Pinned' ? note.pinned && !note.archived : folder === 'Archive' ? note.archived : note.folder === folder && !note.archived)
    .filter((note) => !tagFilter || note.tags.includes(tagFilter))
    .filter((note) => !query || `${note.title} ${note.content} ${note.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)),
  [folder, query, state.notes, tagFilter])
  const selected = notes.find((note) => note.id === selectedId) ?? notes[0]

  const update = (updates: Partial<Note>) => {
    if (!selected) return
    onChange({ ...state, notes: state.notes.map((note) => note.id === selected.id ? { ...note, ...updates, updatedAt: new Date().toISOString() } : note) })
  }

  const changeNote = (note: Note, updates: Partial<Note>) => onChange({
    ...state,
    notes: state.notes.map((item) => item.id === note.id ? { ...item, ...updates, updatedAt: new Date().toISOString() } : item)
  })

  const create = (targetFolder = folder, tags: string[] = []) => {
    const note: Note = {
      id: uid('note'), folder: !['All notes', 'Pinned', 'Archive'].includes(targetFolder) ? targetFolder : 'Personal',
      title: 'Untitled note', content: '', tags, pinned: targetFolder === 'Pinned', archived: false, updatedAt: new Date().toISOString()
    }
    onChange({ ...state, notes: [note, ...state.notes] })
    setSelectedId(note.id)
    setFolder(targetFolder === 'Archive' ? 'All notes' : targetFolder)
    setTagFilter(tags[0])
  }

  const duplicateNote = (note: Note) => {
    const duplicate = { ...note, id: uid('note'), title: `${note.title} (copy)`, archived: false, updatedAt: new Date().toISOString() }
    onChange({ ...state, notes: [duplicate, ...state.notes] })
    setFolder('All notes')
    setTagFilter(undefined)
    setSelectedId(duplicate.id)
    onToast('Note duplicated')
  }

  const deleteNote = (note: Note) => {
    if (!window.confirm(`Delete “${note.title}”?`)) return
    onChange({ ...state, notes: state.notes.filter((item) => item.id !== note.id) })
    if (selectedId === note.id) setSelectedId('')
    onToast('Note deleted')
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
    { label: 'Copy note text', icon: Copy, action: () => copyText(`${note.title}\n\n${note.content}`) },
    { label: 'Delete note', icon: Trash2, separatorBefore: true, danger: true, action: () => deleteNote(note) }
  ]

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" onClick={() => create()}><Plus size={18} /> New note</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Library</span>
          {folders.map((item) => (
            <button key={item} className={`sidebar-item ${folder === item && !tagFilter ? 'active' : ''}`} onClick={() => { setFolder(item); setTagFilter(undefined) }} onContextMenu={(event) => showContextMenu(event, [
              { label: `Open ${item}`, icon: Folder, action: () => { setFolder(item); setTagFilter(undefined) } },
              { label: `New note${!['All notes', 'Pinned', 'Archive'].includes(item) ? ` in ${item}` : ''}`, icon: Plus, separatorBefore: true, action: () => create(item) }
            ], item)}>
              {item === 'Pinned' ? <Pin size={17} /> : item === 'Archive' ? <Archive size={17} /> : item === 'All notes' ? <FileText size={17} /> : <Folder size={17} />}
              <span>{item}</span><em>{item === 'All notes' ? state.notes.filter((note) => !note.archived).length : item === 'Pinned' ? state.notes.filter((note) => note.pinned && !note.archived).length : item === 'Archive' ? state.notes.filter((note) => note.archived).length : state.notes.filter((note) => note.folder === item && !note.archived).length}</em>
            </button>
          ))}
        </div>
        <div className="sidebar-group">
          <span className="sidebar-label">Tags</span>
          {Array.from(new Set(state.notes.flatMap((note) => note.tags))).slice(0, 6).map((tag) => <button className={`sidebar-item ${tagFilter === tag ? 'active' : ''}`} key={tag} onClick={() => { setTagFilter((current) => current === tag ? undefined : tag); setFolder('All notes') }} onContextMenu={(event) => showContextMenu(event, [
            { label: `Show #${tag}`, icon: Tag, action: () => { setTagFilter(tag); setFolder('All notes') } },
            { label: `New note tagged #${tag}`, icon: Plus, separatorBefore: true, action: () => create('Personal', [tag]) },
            { label: 'Copy tag', icon: Copy, action: () => copyText(tag) }
          ], `#${tag}`)}><Tag size={15} /><span>{tag}</span></button>)}
        </div>
      </aside>
      <section className="notes-list-panel">
        <header className="panel-heading">
          <div><h1>{tagFilter ? `#${tagFilter}` : folder}</h1><p>{notes.length} notes</p></div>
          <div className="segmented icon-segmented"><button aria-label="List view" className={!grid ? 'active' : ''} onClick={() => setGrid(false)}><List size={15} /></button><button aria-label="Grid view" className={grid ? 'active' : ''} onClick={() => setGrid(true)}><Grid2X2 size={15} /></button></div>
        </header>
        <div className={grid ? 'notes-grid' : 'notes-list'} onContextMenu={(event) => showContextMenu(event, [
          { label: 'New note', icon: Plus, action: () => create() },
          { label: grid ? 'Switch to list view' : 'Switch to grid view', icon: grid ? List : Grid2X2, action: () => setGrid((value) => !value) }
        ], 'Notes')}>
          {notes.map((note) => (
            <button key={note.id} className={`note-card ${selected?.id === note.id ? 'selected' : ''}`} style={{ '--note-color': note.color ?? 'var(--surface)' } as React.CSSProperties} onClick={() => setSelectedId(note.id)} onContextMenu={(event) => showContextMenu(event, noteMenu(note), note.title)}>
              <span className="note-card-top">{note.pinned && <Pin size={13} fill="currentColor" />}<time>{formatDistanceToNow(parseISO(note.updatedAt), { addSuffix: true })}</time></span>
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
              <select aria-label="Note folder" value={selected.folder} onChange={(event) => update({ folder: event.target.value })}>
                {Array.from(new Set(['Personal', 'Studio', 'Ideas', ...state.notes.map((note) => note.folder)])).map((item) => <option key={item}>{item}</option>)}
              </select>
              <span className="save-state">Saved locally</span>
              <span className="spacer" />
              <button className={`icon-button ${selected.pinned ? 'active' : ''}`} title="Pin note" onClick={() => update({ pinned: !selected.pinned })}><Pin size={17} fill={selected.pinned ? 'currentColor' : 'none'} /></button>
              <button className="icon-button" title="Archive" onClick={() => { update({ archived: true }); setSelectedId(''); onToast('Note archived') }}><Archive size={17} /></button>
              <button className="icon-button danger" title="Delete" onClick={() => {
                onChange({ ...state, notes: state.notes.filter((note) => note.id !== selected.id) })
                setSelectedId('')
                onToast('Note deleted')
              }}><Trash2 size={17} /></button>
            </header>
            <div className="note-paper">
              <input className="note-title-input" aria-label="Note title" value={selected.title} onChange={(event) => update({ title: event.target.value })} />
              <div className="tag-editor">
                <Tag size={14} /><input value={selected.tags.join(', ')} onChange={(event) => update({ tags: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="Add tags, separated by commas" />
              </div>
              <textarea className="note-content-input" value={selected.content} onChange={(event) => update({ content: event.target.value })} placeholder="Start writing…" />
              <footer><span>{selected.content.trim().split(/\s+/).filter(Boolean).length} words</span><span>Edited {formatDistanceToNow(parseISO(selected.updatedAt), { addSuffix: true })}</span></footer>
            </div>
          </>
        ) : <div className="empty-state grow"><FileText size={32} /><h3>Select a note</h3></div>}
      </section>
    </div>
  )
}
