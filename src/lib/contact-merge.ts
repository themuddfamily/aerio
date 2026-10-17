// Builds the result of merging two contacts of the same owner. The survivor keeps its identity
// (id, provider ids, revision, raw provider data); every multi-value field is combined, and each
// single-value field is taken from whichever record the user chose in the merge preview.
import type { Contact, ContactField, ContactList } from '../types'
import type { ContactListRelink } from '../contact-merge-types'
import { contactGroupNames, editableFields, withContactFields } from './contact-fields'
import { isSyncedContact } from './contact-duplicates'

export const MERGE_SCALAR_FIELDS = ['name', 'company', 'title', 'nickname', 'birthday', 'photo', 'notes'] as const
export type MergeScalarField = typeof MERGE_SCALAR_FIELDS[number]
export type MergeChoice = 'survivor' | 'other' | 'both'
export type MergeChoices = Partial<Record<MergeScalarField, MergeChoice>>

export const mergeFieldLabels: Record<MergeScalarField, string> = {
  name: 'Name', company: 'Company', title: 'Job title', nickname: 'Nickname', birthday: 'Birthday', photo: 'Photo', notes: 'Notes'
}

export interface MergeFieldPreview {
  field: MergeScalarField
  label: string
  survivor?: string
  other?: string
  choice: MergeChoice
  // Only fields where both records hold different values need a decision.
  conflict: boolean
}

const present = (value: string | undefined) => value?.trim() ? value : undefined

export function defaultMergeChoice(field: MergeScalarField, survivor: Contact, other: Contact): MergeChoice {
  const mine = present(survivor[field])
  const theirs = present(other[field])
  if (field === 'notes' && mine && theirs && mine.trim() !== theirs.trim()) return 'both'
  return mine || !theirs ? 'survivor' : 'other'
}

export function mergeFieldPreviews(survivor: Contact, other: Contact, choices: MergeChoices = {}): MergeFieldPreview[] {
  return MERGE_SCALAR_FIELDS.flatMap((field) => {
    const mine = present(survivor[field])
    const theirs = present(other[field])
    if (!mine && !theirs) return []
    const conflict = Boolean(mine && theirs && mine.trim() !== theirs.trim())
    const choice = choices[field] && (choices[field] !== 'both' || field === 'notes') ? choices[field]! : defaultMergeChoice(field, survivor, other)
    return [{ field, label: mergeFieldLabels[field], survivor: mine, other: theirs, choice: conflict ? choice : mine ? 'survivor' : 'other', conflict }]
  })
}

// Other values join the survivor's; the survivor's primary stays primary.
const combined = (mine: ContactField[], theirs: ContactField[]) => [...mine, ...theirs.map(({ preferred: _preferred, ...field }) => field)]

function combinedUrls(survivor: Contact, other: Contact) {
  const seen = new Set<string>()
  return combined(survivor.urls ?? [], other.urls ?? []).filter((field) => {
    const key = field.value.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildMergedContact(survivor: Contact, other: Contact, choices: MergeChoices = {}): Contact {
  const next: Contact = { ...survivor }
  for (const preview of mergeFieldPreviews(survivor, other, choices)) {
    const value = preview.choice === 'both' ? `${preview.survivor!.trim()}\n\n${preview.other!.trim()}` : preview.choice === 'other' ? preview.other : preview.survivor
    if (value) next[preview.field] = value
    else delete next[preview.field]
  }
  // Structured name parts belong to whichever name was kept.
  const nameFrom = mergeFieldPreviews(survivor, other, choices).find((preview) => preview.field === 'name')?.choice === 'other' ? other : survivor
  if (nameFrom.nameParts) next.nameParts = nameFrom.nameParts
  else delete next.nameParts
  next.favorite = survivor.favorite || (!isSyncedContact(survivor) && other.favorite)
  const mine = editableFields(survivor)
  const theirs = editableFields(other)
  const merged = withContactFields(next, {
    emails: combined(mine.emails, theirs.emails),
    phones: combined(mine.phones, theirs.phones),
    addresses: combined(mine.addresses, theirs.addresses),
    groups: [...contactGroupNames(survivor), ...contactGroupNames(other)]
  }, survivor.group)
  const urls = combinedUrls(survivor, other)
  if (urls.length) merged.urls = urls
  else delete merged.urls
  return merged
}

// Values a provider cannot store after the merge, so the preview can warn before anything is written.
export function mergeWarnings(survivor: Contact, other: Contact, merged: Contact) {
  const warnings: string[] = []
  if (!isSyncedContact(survivor)) return warnings
  if (survivor.provider === 'microsoft') {
    if ((merged.emails?.length ?? 0) > 3) warnings.push('Outlook keeps up to three email addresses; the others are not saved to Outlook.')
    if ((merged.phones ?? []).filter((field) => field.type === 'mobile').length > 1) warnings.push('Outlook keeps one mobile number; extra mobile numbers are saved as work numbers.')
    if (merged.photo && merged.photo !== survivor.photo) warnings.push('Microsoft contact photos are not synchronized, so the chosen photo stays as it is in Outlook.')
  }
  if (survivor.provider === 'gmail' && contactGroupNames(other).some((group) => !contactGroupNames(survivor).includes(group))) {
    warnings.push('Google contact groups are joined separately after the update; groups that cannot be edited are skipped.')
  }
  if (isSyncedContact(other)) warnings.push(`The duplicate is deleted from ${survivor.provider === 'gmail' ? 'Google Contacts' : 'Outlook'}. Undo recreates it as a new contact.`)
  return warnings
}

// Distribution-list members that pointed at the merged-away contact now point at the survivor.
export function relinkListMembers(lists: ContactList[], fromId: string, toId: string) {
  const relinked: ContactListRelink[] = []
  const next = lists.map((list) => {
    if (!list.members.some((member) => member.contactId === fromId)) return list
    return {
      ...list,
      members: list.members.map((member) => {
        if (member.contactId !== fromId) return member
        relinked.push({ listId: list.id, email: member.email })
        return { ...member, contactId: toId }
      })
    }
  })
  return { lists: next, relinked }
}

// Reverses relinkListMembers for the members it recorded.
export function restoreListMembers(lists: ContactList[], relinked: ContactListRelink[], fromId: string, toId: string) {
  if (!relinked.length) return lists
  return lists.map((list) => {
    const emails = new Set(relinked.filter((item) => item.listId === list.id).map((item) => item.email.toLowerCase()))
    if (!emails.size) return list
    return { ...list, members: list.members.map((member) => member.contactId === fromId && emails.has(member.email.toLowerCase()) ? { ...member, contactId: toId } : member) }
  })
}

// Stable comparison for undo conflict checks: payloads round-trip through JSON storage.
export function sameContact(first: Contact | undefined, second: Contact | undefined) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      : value
  return JSON.stringify(canonical(first)) === JSON.stringify(canonical(second))
}
