import { GitMerge, Link2, Undo2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Contact } from '../types'
import type { ContactAssociation, ContactMergeEntry } from '../contact-merge-types'
import { findDuplicateCandidates, type DuplicateCandidate } from '../lib/contact-duplicates'
import { buildMergedContact, mergeFieldPreviews, mergeWarnings, type MergeChoice, type MergeChoices, type MergeScalarField } from '../lib/contact-merge'
import { contactGroupNames } from '../lib/contact-fields'
import Modal from './Modal'

const confidenceLabel = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' } as const

export function ContactDuplicatesModal({
  contacts, associations, merges, ownerLabel, onReview, onLink, onDismiss, onUndo, onClose
}: {
  contacts: Contact[]
  associations: ContactAssociation[]
  merges: ContactMergeEntry[]
  ownerLabel(contact: Contact): string
  onReview(candidate: DuplicateCandidate): void
  onLink(candidate: DuplicateCandidate): Promise<void> | void
  onDismiss(candidate: DuplicateCandidate): Promise<void> | void
  onUndo(entry: ContactMergeEntry): Promise<void> | void
  onClose(): void
}) {
  const candidates = useMemo(() => findDuplicateCandidates(contacts, { associations }), [associations, contacts])
  const [busy, setBusy] = useState<string>()
  const run = async (id: string, action: () => Promise<void> | void) => {
    setBusy(id)
    try { await action() } finally { setBusy(undefined) }
  }
  return (
    <Modal title="Possible duplicates" subtitle="Suggestions only. Nothing is merged until you review and confirm it." className="contact-duplicates-modal" onClose={onClose}>
      <div className="contact-duplicates">
        {!candidates.length && <p className="provider-source-note">No likely duplicates found. Pairs you marked as not duplicates or linked are not suggested again.</p>}
        <ul className="duplicate-list" aria-label="Duplicate suggestions">
          {candidates.map((candidate) => (
            <li key={candidate.id} className={`duplicate-candidate confidence-${candidate.confidence}`}>
              <div className="duplicate-pair">
                {[candidate.first, candidate.second].map((contact) => (
                  <span key={contact.id}><strong>{contact.name}</strong><small>{contact.email || 'No email'} · {ownerLabel(contact)}</small></span>
                ))}
              </div>
              <p className="duplicate-reasons"><em>{confidenceLabel[candidate.confidence]} ({Math.round(candidate.score * 100)}%)</em> {candidate.reasons.join(' · ')}</p>
              {candidate.action === 'link' && <p className="provider-source-note">These contacts are stored in different places, so they can be linked on this PC but not merged.</p>}
              {candidate.blocked && <p className="provider-source-note">{candidate.blocked}</p>}
              <div className="duplicate-actions">
                {candidate.action === 'merge'
                  ? <button className="button primary small" disabled={Boolean(candidate.blocked) || busy === candidate.id} onClick={() => onReview(candidate)}><GitMerge size={14} /> Review merge</button>
                  : <button className="button primary small" disabled={busy === candidate.id} onClick={() => void run(candidate.id, () => onLink(candidate))}><Link2 size={14} /> Link</button>}
                <button className="button ghost small" disabled={busy === candidate.id} onClick={() => void run(candidate.id, () => onDismiss(candidate))}><X size={14} /> Not duplicates</button>
              </div>
            </li>
          ))}
        </ul>
        {merges.length > 0 && <section className="merge-journal" aria-label="Recent merges">
          <h3>Recent merges</h3>
          <ul>
            {merges.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <span>Merged <strong>{entry.loserBefore.name}</strong> into <strong>{entry.survivorBefore.name}</strong> · {new Date(entry.createdAt).toLocaleString()}{entry.kind === 'provider' ? ' · provider account' : ' · local'}</span>
                {entry.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
                {entry.undoneAt
                  ? <small>Undone {new Date(entry.undoneAt).toLocaleString()}</small>
                  : <button className="button ghost small" disabled={busy === entry.id} onClick={() => void run(entry.id, () => onUndo(entry))}><Undo2 size={14} /> Undo</button>}
              </li>
            ))}
          </ul>
        </section>}
      </div>
    </Modal>
  )
}

const valueText = (field: MergeScalarField, value: string | undefined) => field === 'photo' ? undefined : value

export function ContactMergePreview({
  first, second, ownerLabel, onClose, onMerge
}: {
  first: Contact
  second: Contact
  ownerLabel(contact: Contact): string
  onClose(): void
  onMerge(survivor: Contact, other: Contact, choices: MergeChoices): Promise<void>
}) {
  const [survivorId, setSurvivorId] = useState(first.id)
  const [choices, setChoices] = useState<MergeChoices>({})
  const [saving, setSaving] = useState(false)
  const survivor = survivorId === first.id ? first : second
  const other = survivor === first ? second : first
  const previews = mergeFieldPreviews(survivor, other, choices)
  const merged = buildMergedContact(survivor, other, choices)
  const warnings = mergeWarnings(survivor, other, merged)
  const choose = (field: MergeScalarField, choice: MergeChoice) => setChoices((current) => ({ ...current, [field]: choice }))
  const lists = [
    ['Emails', (merged.emails ?? []).map((field) => field.value)],
    ['Phones', (merged.phones ?? []).map((field) => field.value)],
    ['Addresses', (merged.addresses ?? []).map((field) => field.value)],
    ['Websites', (merged.urls ?? []).map((field) => field.value)],
    ['Groups', contactGroupNames(merged)]
  ] as const
  return (
    <Modal title="Merge contacts" subtitle={`Both records belong to ${ownerLabel(first)}. The kept record keeps its identity; every email, phone, address, website, and group is combined.`} className="contact-merge-modal" onClose={onClose}>
      <div className="form-stack contact-merge-preview">
        <fieldset className="merge-survivor">
          <legend>Keep record</legend>
          {[first, second].map((contact) => (
            <label key={contact.id} className="check-label"><input type="radio" name="merge-survivor" checked={survivorId === contact.id} onChange={() => { setSurvivorId(contact.id); setChoices({}) }} /> {contact.name} <small>({contact.email || 'no email'})</small></label>
          ))}
        </fieldset>
        <table className="merge-fields">
          <thead><tr><th>Field</th><th>{survivor.name} (kept)</th><th>{other.name} (merged away)</th></tr></thead>
          <tbody>
            {previews.map((preview) => (
              <tr key={preview.field}>
                <th scope="row">{preview.label}</th>
                {(['survivor', 'other'] as const).map((side) => {
                  const value = preview[side]
                  return <td key={side}>
                    {value && (preview.conflict
                      ? <label className="check-label"><input type="radio" name={`merge-${preview.field}`} aria-label={`${preview.label} from ${side === 'survivor' ? survivor.name : other.name}`} checked={preview.choice === side} onChange={() => choose(preview.field, side)} /> {preview.field === 'photo' ? <img className="avatar contact-photo merge-photo" src={value} alt="" /> : valueText(preview.field, value)}</label>
                      : preview.field === 'photo' ? <img className="avatar contact-photo merge-photo" src={value} alt="" /> : <span>{value}</span>)}
                  </td>
                })}
                {preview.field === 'notes' && preview.conflict && <td><label className="check-label"><input type="radio" name="merge-notes" aria-label="Keep both notes" checked={preview.choice === 'both'} onChange={() => choose('notes', 'both')} /> Both</label></td>}
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="merge-lists">
          {lists.filter(([, values]) => values.length).map(([label, values]) => <div key={label}><dt>{label}</dt><dd>{values.join(', ')}</dd></div>)}
        </dl>
        {warnings.map((warning) => <small key={warning} className="merge-warning">{warning}</small>)}
        <footer className="modal-footer">
          <span className="spacer" /><button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={saving} onClick={() => {
            setSaving(true)
            void onMerge(survivor, other, choices).finally(() => setSaving(false))
          }}><GitMerge size={16} /> {saving ? 'Merging…' : 'Merge contacts'}</button>
        </footer>
      </div>
    </Modal>
  )
}
