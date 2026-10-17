import { BookUser, DoorOpen, User, Users, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Contact } from '../types'
import type { DirectoryEntry, DirectoryEntryKind, DirectorySearchResult } from '../directory-types'
import type { MailRecipientSuggestion } from '../mail-types'
import { contactEmailAddresses } from '../lib/contact-fields'

// Recipient selection beyond cached-mail suggestions (E41): personal contacts and the read-only
// organization directory, looked up online with a debounce and answered from the offline address
// book when the server cannot be reached.

export const DIRECTORY_KIND_ICONS: Record<DirectoryEntryKind, LucideIcon> = { person: User, group: Users, room: DoorOpen, equipment: Wrench }
export const DIRECTORY_KIND_LABELS: Record<DirectoryEntryKind, string> = { person: 'Person', group: 'Group', room: 'Room', equipment: 'Equipment' }
export const DIRECTORY_LOOKUP_DELAY_MS = 300
const MIN_QUERY = 2

export function DirectoryKindIcon({ kind, size = 14 }: { kind: DirectoryEntryKind; size?: number }) {
  const Icon = DIRECTORY_KIND_ICONS[kind]
  return <Icon size={size} role="img" aria-label={DIRECTORY_KIND_LABELS[kind]} aria-hidden={false} />
}

/** Second line of a directory entry: ambiguous names show title, department, and address. */
export function directoryEntryDetail(entry: DirectoryEntry) {
  if (entry.kind === 'room') return [entry.email, entry.capacity ? `${entry.capacity} seats` : '', entry.building ?? ''].filter(Boolean).join(' · ')
  if (entry.ambiguous) return [entry.title, entry.department, entry.office, entry.email].filter(Boolean).join(' · ')
  return [entry.email, entry.title].filter(Boolean).join(' · ')
}

/** Debounced directory lookup; stale answers are dropped. */
export function useDirectoryLookup(query: string, options: { accountIds?: string[]; kinds?: DirectoryEntryKind[]; enabled?: boolean; limit?: number } = {}) {
  const [result, setResult] = useState<DirectorySearchResult>()
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const accountKey = options.accountIds?.join('\n') ?? ''
  const kindKey = options.kinds?.join(',') ?? ''
  const enabled = options.enabled ?? true
  const limit = options.limit
  useEffect(() => {
    const api = window.aerio?.directory
    const term = query.trim()
    const id = ++request.current
    if (!api || !enabled || term.length < MIN_QUERY) {
      setResult(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => {
      void api.search({ query: term, ...(accountKey ? { accountIds: accountKey.split('\n') } : {}), ...(kindKey ? { kinds: kindKey.split(',') as DirectoryEntryKind[] } : {}), ...(limit ? { limit } : {}) })
        .then((value) => { if (request.current === id) setResult(value) })
        .catch(() => { if (request.current === id) setResult(undefined) })
        .finally(() => { if (request.current === id) setLoading(false) })
    }, DIRECTORY_LOOKUP_DELAY_MS)
    return () => clearTimeout(timer)
  }, [accountKey, enabled, kindKey, limit, query])
  return { result, loading }
}

/** Personal contacts (local and synchronized), loaded once per composer. */
export function usePersonalContacts(enabled: boolean) {
  const [contacts, setContacts] = useState<Contact[]>([])
  useEffect(() => {
    const api = window.aerio?.productivity
    if (!enabled || typeof api?.snapshot !== 'function' || typeof api.localSnapshot !== 'function') return
    let active = true
    void Promise.all([api.snapshot(), api.localSnapshot()]).then(([snapshot, local]) => {
      if (active) setContacts([...(local.contacts ?? []), ...snapshot.contacts])
    }).catch(() => {
      // Contacts are a convenience here; cached-mail suggestions keep working without them.
    })
    return () => { active = false }
  }, [enabled])
  return contacts
}

export function matchPersonalContacts(contacts: Contact[], query: string, exclude: Set<string>, limit = 5): MailRecipientSuggestion[] {
  const term = query.trim().toLowerCase()
  if (term.length < MIN_QUERY) return []
  const result: MailRecipientSuggestion[] = []
  const seen = new Set(exclude)
  for (const contact of contacts) {
    for (const email of contactEmailAddresses(contact)) {
      const key = email.toLowerCase()
      if (seen.has(key) || !`${contact.name} ${email}`.toLowerCase().includes(term)) continue
      seen.add(key)
      result.push({ accountId: '', email, name: contact.name })
      if (result.length >= limit) return result
    }
  }
  return result
}

interface RecipientDirectorySectionsProps {
  accountId: string
  query: string
  enabled: boolean
  /** Addresses already offered by cached-mail suggestions. */
  exclude: MailRecipientSuggestion[]
  onChoose(suggestion: MailRecipientSuggestion): void
  onChooseMany(suggestions: MailRecipientSuggestion[], note: string): void
  onToast(message: string): void
}

/** Sections appended to the composer's recipient suggestions: personal contacts and the directory. */
export function useRecipientDirectorySections({ accountId, query, enabled, exclude, onChoose, onChooseMany, onToast }: RecipientDirectorySectionsProps) {
  const contacts = usePersonalContacts(enabled)
  const { result } = useDirectoryLookup(query, { accountIds: accountId ? [accountId] : undefined, enabled: enabled && Boolean(accountId), limit: 8 })
  const [expanding, setExpanding] = useState<string>()
  const excluded = new Set(exclude.map((item) => item.email.toLowerCase()))
  const personal = enabled ? matchPersonalContacts(contacts, query, excluded) : []
  for (const item of personal) excluded.add(item.email.toLowerCase())
  const directory = enabled ? (result?.entries ?? []).filter((entry) => !excluded.has(entry.email.toLowerCase())) : []
  const offline = result?.source === 'offline'

  const expand = async (entry: DirectoryEntry) => {
    const api = window.aerio?.directory
    if (!api) return
    setExpanding(entry.email)
    try {
      const expansion = await api.expandGroup(entry.accountId, entry.email)
      if (!expansion.members.length) { onToast(`${entry.name} has no members Aerio can list`); return }
      onChooseMany(expansion.members.map((member) => ({ accountId: member.accountId, email: member.email, name: member.name })),
        `Added ${expansion.members.length} members of ${entry.name}${expansion.truncated ? ' (first 500 only)' : ''}`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The group members could not be listed')
    } finally {
      setExpanding(undefined)
    }
  }

  const count = personal.length + directory.length
  const nodes = count === 0 ? null : <>
    {personal.length > 0 && <p className="recipient-suggestions-label">My contacts</p>}
    {personal.map((suggestion) => <button key={`contact:${suggestion.email}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(suggestion)}>
      <span className="avatar"><BookUser size={13} /></span><span><strong>{suggestion.name || suggestion.email}</strong><small>{suggestion.email}</small></span>
    </button>)}
    {directory.length > 0 && <p className="recipient-suggestions-label">Directory · read-only{offline ? ' · saved address book' : ''}</p>}
    {directory.map((entry) => <div key={entry.id} className="directory-suggestion">
      <button onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose({ accountId: entry.accountId, email: entry.email, name: entry.name })} title={`${DIRECTORY_KIND_LABELS[entry.kind]} from the organization directory`} aria-label={`${DIRECTORY_KIND_LABELS[entry.kind]} ${entry.name}, ${directoryEntryDetail(entry)}`}>
        <span className={`avatar directory-kind kind-${entry.kind}`}><DirectoryKindIcon kind={entry.kind} size={13} /></span>
        <span><strong>{entry.name}</strong><small>{directoryEntryDetail(entry)}</small></span>
      </button>
      {entry.kind === 'group' && entry.expandable && <button className="text-button directory-expand" disabled={expanding === entry.email || offline} title={offline ? 'Group members can be listed only while online' : 'Insert the members instead of the group address'} onMouseDown={(event) => event.preventDefault()} onClick={() => void expand(entry)}>{expanding === entry.email ? 'Expanding…' : 'Expand members'}</button>}
    </div>)}
  </>
  return { count, nodes }
}

/** Room and equipment lookup for the scheduling assistant. */
export function DirectoryResourcePicker({ onAdd }: { onAdd(entry: DirectoryEntry): void }) {
  const [query, setQuery] = useState('')
  const { result, loading } = useDirectoryLookup(query, { kinds: ['room', 'equipment'], limit: 10 })
  if (!window.aerio?.directory) return null
  return (
    <div className="directory-resource-picker">
      <label className="field-label grow"><DoorOpen size={14} /> Find a room in the directory<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Room name or building" /></label>
      {query.trim().length >= MIN_QUERY && <div className="directory-resource-results" aria-live="polite">
        {loading && !result && <small>Searching…</small>}
        {result && !result.entries.length && <small>{result.accounts.find((account) => account.error)?.error ?? 'No rooms match'}</small>}
        {result?.entries.map((entry) => <button key={entry.id} className="button ghost small" onClick={() => { onAdd(entry); setQuery('') }}>
          <DirectoryKindIcon kind={entry.kind} /> {entry.name}{entry.capacity ? ` · ${entry.capacity} seats` : ''}
        </button>)}
      </div>}
    </div>
  )
}
