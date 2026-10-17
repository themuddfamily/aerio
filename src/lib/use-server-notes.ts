import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ServerNote, ServerNotesSnapshot } from '../server-notes-types'
import type { Note } from '../types'

// Renderer state for server-synchronized Notes (docs/server-notes.md). Edits show at once and are
// sent after a short pause; the main process queues them durably and returns the stored note.
// The main process re-sanitizes rich bodies, so the body the editor emitted is kept on screen
// while the stored copy is that same body, which keeps the caret where the user is typing.

const EMPTY: ServerNotesSnapshot = { accounts: [], folders: [], notes: [], review: [] }
const SEND_DELAY_MS = 400

export const isServerNote = (note: Note | undefined): note is ServerNote => Boolean(note && 'owner' in note)

export function useServerNotes(onToast: (message: string) => void) {
  const api = window.aerio?.serverNotes
  const [snapshot, setSnapshot] = useState<ServerNotesSnapshot>(EMPTY)
  const [revision, setRevision] = useState(0)
  const drafts = useRef(new Map<string, ServerNote>())
  const echoes = useRef(new Map<string, { stored?: string; html?: string; content: string }>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const toast = useRef(onToast)
  toast.current = onToast

  useEffect(() => {
    if (!api) return
    let active = true
    void api.snapshot().then((value) => { if (active) setSnapshot(value) }).catch(() => undefined)
    const stop = api.onChanged((value) => setSnapshot(value))
    return () => { active = false; stop() }
  }, [api])

  const send = useCallback((id: string) => {
    timers.current.delete(id)
    const draft = drafts.current.get(id)
    if (!draft || !api) return
    void api.update(draft).then((stored) => {
      echoes.current.set(id, { stored: stored.html, html: draft.html, content: draft.content })
      if (drafts.current.get(id) === draft) drafts.current.delete(id)
      setSnapshot((current) => ({ ...current, notes: current.notes.map((note) => note.id === id ? stored : note) }))
      setRevision((value) => value + 1)
    }).catch((error: unknown) => {
      if (drafts.current.get(id) === draft) drafts.current.delete(id)
      setRevision((value) => value + 1)
      toast.current(error instanceof Error ? error.message : 'The note could not be saved')
    })
  }, [api])

  // Unsent edits are sent when the view closes.
  useEffect(() => () => {
    for (const [id, timer] of timers.current) { clearTimeout(timer); send(id) }
  }, [send])

  const notes = useMemo(() => snapshot.notes.map((note) => {
    const draft = drafts.current.get(note.id)
    if (draft) return draft
    const echo = echoes.current.get(note.id)
    return echo && echo.stored === note.html && echo.html !== undefined ? { ...note, html: echo.html, content: echo.content } : note
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [snapshot, revision])

  const update = useCallback((note: ServerNote, changes: Partial<Note>) => {
    const next: ServerNote = { ...note, ...changes, updatedAt: new Date().toISOString() }
    drafts.current.set(note.id, next)
    setRevision((value) => value + 1)
    clearTimeout(timers.current.get(note.id))
    timers.current.set(note.id, setTimeout(() => send(note.id), SEND_DELAY_MS))
  }, [send])

  const create = useCallback(async (folderId: string, note: Note) => {
    if (!api) throw new Error('Server notes are not available')
    const created = await api.create(folderId, note)
    setSnapshot((current) => ({ ...current, notes: [...current.notes.filter((item) => item.id !== created.id), created] }))
    return created
  }, [api])

  const remove = useCallback(async (id: string) => {
    if (!api) return
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    drafts.current.delete(id)
    setSnapshot(await api.remove(id))
  }, [api])

  return { available: Boolean(api), snapshot, notes, update, create, remove }
}
