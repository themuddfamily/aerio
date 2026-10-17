import { CheckCircle2, CopyX, Search, SkipForward, Trash2, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DuplicateCleanupEntry, DuplicateGroup, DuplicateKind, DuplicateRemovalItemResult, DuplicateScanRequest, DuplicateScanResult, DuplicateScopeOwner,
  DuplicateUndoItemResult
} from '../duplicate-cleanup-types'
import Modal from './Modal'

const kinds: { id: DuplicateKind; label: string; scope: string }[] = [
  { id: 'mail', label: 'Mail', scope: 'accounts and folders' },
  { id: 'event', label: 'Calendar', scope: 'calendars' },
  { id: 'task', label: 'Tasks', scope: 'task lists' }
]
const confidenceLabel = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' } as const
const outcomeLabel = { removed: 'Removed', stale: 'Skipped (changed since the scan)', failed: 'Failed', skipped: 'Kept', restored: 'Restored' } as const
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

interface GroupChoice { keeperId: string; removeIds: string[] }

const defaultChoice = (group: DuplicateGroup): GroupChoice => ({
  keeperId: group.keeperId,
  removeIds: group.items.filter((item) => item.id !== group.keeperId && item.removable).map((item) => item.id)
})

function buildRequest(kind: DuplicateKind, owners: DuplicateScopeOwner[], wholeOwners: Set<string>, containers: Set<string>): DuplicateScanRequest | undefined {
  if (kind === 'mail') {
    const scopes = owners.filter((owner) => !owner.readOnly).flatMap((owner) => {
      if (wholeOwners.has(owner.id)) return [{ accountId: owner.id }]
      const labelIds = owner.containers.filter((item) => containers.has(`${owner.id}\n${item.id}`)).map((item) => item.id)
      return labelIds.length ? [{ accountId: owner.id, labelIds }] : []
    })
    return scopes.length ? { kind, scopes } : undefined
  }
  const ids = owners.flatMap((owner) => owner.containers.filter((item) => !item.readOnly && containers.has(`${owner.id}\n${item.id}`)).map((item) => item.id))
  if (!ids.length) return undefined
  return kind === 'event' ? { kind, calendarIds: ids } : { kind, listIds: ids }
}

export default function DuplicateCleanupModal({ onClose }: { onClose(): void }) {
  const api = window.aerio.duplicates
  const [kind, setKind] = useState<DuplicateKind>('mail')
  const [owners, setOwners] = useState<DuplicateScopeOwner[]>()
  const [wholeOwners, setWholeOwners] = useState<Set<string>>(new Set())
  const [containers, setContainers] = useState<Set<string>>(new Set())
  const [scan, setScan] = useState<DuplicateScanResult>()
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({})
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string>()
  const [results, setResults] = useState<(DuplicateRemovalItemResult | DuplicateUndoItemResult)[]>([])
  const [history, setHistory] = useState<DuplicateCleanupEntry[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')

  const loadHistory = useCallback(() => { void api?.history().then(setHistory).catch(() => undefined) }, [api])
  useEffect(() => { loadHistory() }, [loadHistory])
  useEffect(() => {
    let active = true
    setOwners(undefined)
    setWholeOwners(new Set())
    setContainers(new Set())
    setScan(undefined)
    setResults([])
    setError('')
    void api?.scopes(kind).then((value) => { if (active) setOwners(value) }).catch((reason) => { if (active) { setOwners([]); setError(message(reason)) } })
    return () => { active = false }
  }, [api, kind])

  const request = useMemo(() => owners ? buildRequest(kind, owners, wholeOwners, containers) : undefined, [containers, kind, owners, wholeOwners])
  const visibleGroups = useMemo(() => (scan?.groups ?? []).filter((group) => !skipped.has(group.id)), [scan, skipped])
  const selected = visibleGroups.find((group) => group.id === selectedId) ?? visibleGroups[0]
  const pending = visibleGroups.map((group) => ({ group, choice: choices[group.id] ?? defaultChoice(group) })).filter(({ choice }) => choice.removeIds.length)
  const pendingCount = pending.reduce((total, { choice }) => total + choice.removeIds.length, 0)

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setError('')
    try { await action() } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }

  const toggle = (set: Set<string>, value: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(value)
    else next.delete(value)
    return next
  }

  const startScan = () => request && run('scan', async () => {
    const result = await api!.scan(request)
    setScan(result)
    setChoices(Object.fromEntries(result.groups.map((group) => [group.id, defaultChoice(group)])))
    setSkipped(new Set())
    setSelectedId(result.groups[0]?.id)
    setResults([])
  })

  const removeSelected = () => scan && run('remove', async () => {
    const result = await api!.remove({ scanId: scan.scanId, groups: pending.map(({ group, choice }) => ({ groupId: group.id, keeperId: choice.keeperId, removeIds: choice.removeIds })) })
    setResults(result.results)
    const removed = new Set(result.results.filter((item) => item.outcome === 'removed').map((item) => item.itemId))
    const groups = scan.groups.map((group) => ({ ...group, items: group.items.filter((item) => !removed.has(item.id)) })).filter((group) => group.items.length > 1)
    setScan({ ...scan, groups })
    setChoices((current) => Object.fromEntries(groups.map((group) => {
      const previous = current[group.id]
      return [group.id, previous ? { keeperId: previous.keeperId, removeIds: previous.removeIds.filter((id) => !removed.has(id)) } : defaultChoice(group)]
    })))
    loadHistory()
  })

  const dismiss = (group: DuplicateGroup) => scan && run(`dismiss-${group.id}`, async () => {
    await api!.dismiss(scan.scanId, group.id)
    setScan({ ...scan, groups: scan.groups.filter((item) => item.id !== group.id), dismissed: scan.dismissed + 1 })
  })

  const undo = (entry: DuplicateCleanupEntry) => run(`undo-${entry.id}`, async () => {
    const result = await api!.undo(entry.id)
    setResults(result.results)
    loadHistory()
  })

  const setChoice = (group: DuplicateGroup, choice: GroupChoice) => setChoices((current) => ({ ...current, [group.id]: choice }))

  if (!api) return null
  const kindInfo = kinds.find((item) => item.id === kind)!
  return (
    <Modal title="Find duplicates" subtitle="Scan chosen places for duplicate copies. Nothing is removed until you review each group and confirm." className="duplicate-cleanup-modal" onClose={onClose}>
      <div className="duplicate-cleanup">
        <div className="duplicate-kinds" role="tablist" aria-label="What to clean up">
          {kinds.map((item) => (
            <button key={item.id} role="tab" aria-selected={kind === item.id} className={`button ${kind === item.id ? 'primary' : 'ghost'} small`} disabled={Boolean(busy)} onClick={() => setKind(item.id)}>{item.label}</button>
          ))}
        </div>
        {error && <p className="merge-warning" role="alert">{error}</p>}
        {!scan && <section className="duplicate-scope" aria-label={`Choose ${kindInfo.scope}`}>
          {!owners && <p className="provider-source-note">Loading {kindInfo.scope}…</p>}
          {owners && !owners.length && <p className="provider-source-note">There are no {kindInfo.scope} to scan.</p>}
          {owners?.map((owner) => (
            <fieldset key={owner.id} className="duplicate-owner" disabled={owner.readOnly}>
              <legend>
                <label className="check-label">
                  <input
                    type="checkbox"
                    aria-label={kind === 'mail' ? `All folders in ${owner.label}` : `Every ${kind === 'event' ? 'calendar' : 'list'} in ${owner.label}`}
                    checked={kind === 'mail' ? wholeOwners.has(owner.id) : owner.containers.filter((item) => !item.readOnly).length > 0 && owner.containers.filter((item) => !item.readOnly).every((item) => containers.has(`${owner.id}\n${item.id}`))}
                    onChange={(event) => {
                      if (kind === 'mail') setWholeOwners((current) => toggle(current, owner.id, event.target.checked))
                      else setContainers((current) => {
                        const next = new Set(current)
                        for (const item of owner.containers.filter((value) => !value.readOnly)) {
                          if (event.target.checked) next.add(`${owner.id}\n${item.id}`)
                          else next.delete(`${owner.id}\n${item.id}`)
                        }
                        return next
                      })
                    }}
                  /> {owner.label}{kind === 'mail' ? ' (all folders)' : ''}
                </label>
              </legend>
              {owner.readOnlyReason && <small className="provider-source-note">{owner.readOnlyReason}</small>}
              <div className="duplicate-containers">
                {owner.containers.map((item) => (
                  <label key={item.id} className="check-label" title={item.readOnlyReason}>
                    <input
                      type="checkbox"
                      disabled={item.readOnly || (kind === 'mail' && wholeOwners.has(owner.id))}
                      checked={(kind === 'mail' && wholeOwners.has(owner.id)) || containers.has(`${owner.id}\n${item.id}`)}
                      onChange={(event) => setContainers((current) => toggle(current, `${owner.id}\n${item.id}`, event.target.checked))}
                    /> {item.label}{item.readOnly && <small> — {item.readOnlyReason ?? 'read-only'}</small>}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="duplicate-actions">
            <button className="button primary" disabled={!request || Boolean(busy)} onClick={() => void startScan()}><Search size={16} /> {busy === 'scan' ? 'Scanning…' : 'Find duplicates'}</button>
          </div>
        </section>}
        {scan && <section className="duplicate-review" aria-label="Duplicate groups">
          <div className="duplicate-summary">
            <span>Scanned {scan.scanned.toLocaleString()} item{scan.scanned === 1 ? '' : 's'} · {visibleGroups.length} group{visibleGroups.length === 1 ? '' : 's'} to review{scan.dismissed ? ` · ${scan.dismissed} marked “Not duplicates” earlier` : ''}</span>
            <button className="button ghost small" disabled={Boolean(busy)} onClick={() => { setScan(undefined); setResults([]) }}>New scan</button>
          </div>
          {scan.excluded.map((item) => <small key={`${item.label}-${item.reason}`} className="provider-source-note">Not scanned: {item.label} — {item.reason}</small>)}
          {!visibleGroups.length && <p className="provider-source-note">No duplicates to review.</p>}
          {visibleGroups.length > 0 && <div className="duplicate-review-body">
            <ul className="duplicate-groups" aria-label="Groups">
              {visibleGroups.map((group) => (
                <li key={group.id}>
                  <button className={`duplicate-group-button confidence-${group.confidence} ${selected?.id === group.id ? 'active' : ''}`} aria-pressed={selected?.id === group.id} onClick={() => setSelectedId(group.id)}>
                    <strong>{group.items[0].title}</strong>
                    <small>{group.items.length} copies · {confidenceLabel[group.confidence]}</small>
                  </button>
                </li>
              ))}
            </ul>
            {selected && <GroupReview
              group={selected}
              choice={choices[selected.id] ?? defaultChoice(selected)}
              busy={Boolean(busy)}
              onChoice={(choice) => setChoice(selected, choice)}
              onSkip={() => setSkipped((current) => toggle(current, selected.id, true))}
              onDismiss={() => void dismiss(selected)}
            />}
          </div>}
          <footer className="modal-footer">
            <small>{pendingCount ? `${pendingCount} cop${pendingCount === 1 ? 'y' : 'ies'} in ${pending.length} group${pending.length === 1 ? '' : 's'} will be removed. Removed mail goes to Trash; every removal can be undone below.` : 'Nothing selected for removal.'}</small>
            <span className="spacer" />
            <button className="button primary" disabled={!pendingCount || Boolean(busy)} onClick={() => void removeSelected()}><Trash2 size={16} /> {busy === 'remove' ? 'Removing…' : `Remove selected (${pendingCount})`}</button>
          </footer>
        </section>}
        {results.length > 0 && <section className="duplicate-results" aria-label="Results" aria-live="polite">
          <h3>Results</h3>
          <ul>
            {results.map((item) => (
              <li key={`${item.itemId}-${item.outcome}`} className={`outcome-${item.outcome}`}>
                <strong>{outcomeLabel[item.outcome]}</strong> {item.title}{item.message && <small>{item.message}</small>}
              </li>
            ))}
          </ul>
        </section>}
        {history.length > 0 && <section className="merge-journal" aria-label="Recent cleanups">
          <h3>Recent cleanups</h3>
          <ul>
            {history.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <span>{kinds.find((item) => item.id === entry.kind)?.label} · removed {entry.removed} · {entry.titles.slice(0, 3).join(', ')}{entry.titles.length > 3 ? '…' : ''} · {new Date(entry.createdAt).toLocaleString()}</span>
                {entry.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
                {entry.undoneAt
                  ? <small>Undone {new Date(entry.undoneAt).toLocaleString()}</small>
                  : <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void undo(entry)}><Undo2 size={14} /> Undo</button>}
              </li>
            ))}
          </ul>
        </section>}
      </div>
    </Modal>
  )
}

function GroupReview({ group, choice, busy, onChoice, onSkip, onDismiss }: {
  group: DuplicateGroup
  choice: GroupChoice
  busy: boolean
  onChoice(choice: GroupChoice): void
  onSkip(): void
  onDismiss(): void
}) {
  const labels = group.items[0].details.map((detail) => detail.label)
  const keep = (id: string) => onChoice({ keeperId: id, removeIds: group.items.filter((item) => item.id !== id && item.removable).map((item) => item.id) })
  return (
    <div className="duplicate-group-detail">
      <p className="duplicate-reasons"><em>{confidenceLabel[group.confidence]}</em> {group.reasons.map((reason) => reason.label).join(' · ')}</p>
      {group.notes.map((note) => <small key={note} className="provider-source-note">{note}</small>)}
      <div className="duplicate-compare">
        <table className="merge-fields">
          <thead>
            <tr>
              <th scope="col">Field</th>
              {group.items.map((item, index) => (
                <th key={item.id} scope="col">
                  <span className="duplicate-copy-title">Copy {index + 1}{item.id === choice.keeperId && <CheckCircle2 size={14} aria-label="kept" />}</span>
                  <small>{item.ownerLabel} · {item.containerLabel}</small>
                  <label className="check-label"><input type="radio" name={`keep-${group.id}`} aria-label={`Keep copy ${index + 1}`} checked={choice.keeperId === item.id} onChange={() => keep(item.id)} /> Keep</label>
                  <label className="check-label" title={item.blockedReason}>
                    <input
                      type="checkbox"
                      aria-label={`Remove copy ${index + 1}`}
                      disabled={item.id === choice.keeperId || !item.removable}
                      checked={choice.removeIds.includes(item.id)}
                      onChange={(event) => onChoice({ ...choice, removeIds: event.target.checked ? [...choice.removeIds, item.id] : choice.removeIds.filter((id) => id !== item.id) })}
                    /> Remove
                  </label>
                  {item.blockedReason && <small className="merge-warning">{item.blockedReason}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => {
              const values = group.items.map((item) => item.details.find((detail) => detail.label === label)?.value ?? '')
              const differs = values.some((value) => value !== values[0])
              return (
                <tr key={label} className={differs ? 'duplicate-differs' : undefined}>
                  <th scope="row">{label}</th>
                  {values.map((value, index) => <td key={group.items[index].id}>{value}</td>)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="duplicate-actions">
        <button className="button ghost small" disabled={busy} onClick={onSkip}><SkipForward size={14} /> Skip group</button>
        <button className="button ghost small" disabled={busy} onClick={onDismiss}><X size={14} /> Not duplicates</button>
        <button className="button ghost small" disabled={busy || !choice.removeIds.length} onClick={() => onChoice({ ...choice, removeIds: [] })}><CopyX size={14} /> Keep all</button>
      </div>
    </div>
  )
}
