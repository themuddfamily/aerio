// Duplicate contact detection. Candidates are suggestions only: nothing here merges anything.
// Matching is deliberately conservative, because a wrong merge is worse than a missed one.
import type { Contact } from '../types'
import type { SyncedContact } from '../productivity-types'
import type { ContactAssociation, ContactOwner } from '../contact-merge-types'
import { contactEmailAddresses, normalizedContactEmail } from './contact-fields'

export type DuplicateConfidence = 'high' | 'medium' | 'low'

export interface DuplicateCandidate {
  id: string
  first: Contact
  second: Contact
  score: number
  confidence: DuplicateConfidence
  reasons: string[]
  // Same owner: the records can be merged. Different owners: they can only be linked locally.
  action: 'merge' | 'link'
  // Why a same-owner pair cannot be merged right now.
  blocked?: string
}

export const isSyncedContact = (contact: Contact): contact is SyncedContact =>
  'remoteId' in contact && 'accountId' in contact && 'provider' in contact && 'readOnly' in contact

export const contactOwner = (contact: Contact): ContactOwner => isSyncedContact(contact) ? contact.accountId : 'local'
export const contactPairKey = (firstId: string, secondId: string) => [firstId, secondId].sort().join('|')

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

// Lower-cased address. Only Gmail ignores dots in the local part, so dots are dropped there and
// nowhere else; plus tags are kept everywhere because they can route to different people or rules.
export function comparableEmail(value: string) {
  const email = normalizedContactEmail(value)
  const at = email.lastIndexOf('@')
  if (at <= 0) return email
  const domain = email.slice(at + 1)
  return GMAIL_DOMAINS.has(domain) ? `${email.slice(0, at).replaceAll('.', '')}@gmail.com` : email
}

export interface ComparablePhone { digits: string; international: boolean }

// Roughly E.164: digits only, with a leading + or 00 marking a country code. Extensions are
// dropped and a national trunk 0 is removed. Fewer than 7 digits is too short to compare.
export function comparablePhone(value: string): ComparablePhone | undefined {
  const main = value.split(/(?:ext\.?|x|#|;)/i)[0] ?? ''
  const trimmed = main.trim()
  const international = /^(?:\+|00)/.test(trimmed)
  let digits = trimmed.replace(/\D/g, '')
  if (trimmed.startsWith('00')) digits = digits.slice(2)
  else if (!international && digits.startsWith('0')) digits = digits.slice(1)
  return digits.length >= 7 ? { digits, international } : undefined
}

// A national number matches an international one when it is the tail of it (the country code
// is unknown locally); short numbers never match that way.
export function phonesMatch(first: ComparablePhone, second: ComparablePhone) {
  if (first.international === second.international) return first.digits === second.digits
  const [international, national] = first.international ? [first, second] : [second, first]
  return national.digits.length >= 8 && international.digits.length > national.digits.length && international.digits.endsWith(national.digits)
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir'])

export function nameTokens(value: string) {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((token) => token && !HONORIFICS.has(token))
}

const bigrams = (value: string) => Array.from({ length: Math.max(value.length - 1, 0) }, (_, index) => value.slice(index, index + 2))

function dice(first: string, second: string) {
  if (first === second) return 1
  const a = bigrams(first)
  const b = bigrams(second)
  if (!a.length || !b.length) return 0
  const counts = new Map<string, number>()
  for (const gram of a) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let shared = 0
  for (const gram of b) {
    const count = counts.get(gram) ?? 0
    if (count) { shared += 1; counts.set(gram, count - 1) }
  }
  return (2 * shared) / (a.length + b.length)
}

// 1 for the same tokens in any order ("Lovelace, Ada"), less for initials and small typos.
export function nameSimilarity(first: string, second: string) {
  const a = nameTokens(first)
  const b = nameTokens(second)
  if (!a.length || !b.length) return 0
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const unused = [...long]
  let total = 0
  for (const token of short) {
    let best = 0
    let bestIndex = -1
    unused.forEach((other, index) => {
      const score = token === other ? 1
        : (token.length === 1 && other.startsWith(token)) || (other.length === 1 && token.startsWith(other)) ? 0.7
          : Math.min(token.length, other.length) >= 4 && dice(token, other) >= 0.75 ? 0.85 : 0
      if (score > best) { best = score; bestIndex = index }
    })
    if (bestIndex >= 0) unused.splice(bestIndex, 1)
    total += best
  }
  return total / long.length
}

function contactPhones(contact: Contact) {
  const values = [contact.phone, ...(contact.phones ?? []).map((field) => field.value)].filter((value): value is string => Boolean(value?.trim()))
  return [...new Set(values)].flatMap((value) => {
    const phone = comparablePhone(value)
    return phone ? [{ value: value.trim(), phone }] : []
  })
}

const confidenceOf = (score: number): DuplicateConfidence => score >= 0.9 ? 'high' : score >= 0.6 ? 'medium' : 'low'

export const DUPLICATE_MIN_SCORE = 0.35
export const DUPLICATE_CANDIDATE_LIMIT = 500

// Scores one pair. Returns undefined when nothing meaningful is shared.
export function scoreDuplicatePair(first: Contact, second: Contact) {
  const reasons: string[] = []
  let score = 0
  const firstEmails = new Map(contactEmailAddresses(first).map((email) => [comparableEmail(email), email]))
  const sharedEmails = contactEmailAddresses(second).flatMap((email) => {
    const original = firstEmails.get(comparableEmail(email))
    return original ? [{ original, other: email }] : []
  })
  if (sharedEmails.length) {
    score += 0.7
    const exact = sharedEmails.find((item) => normalizedContactEmail(item.original) === normalizedContactEmail(item.other))
    reasons.push(exact ? `Same email address ${exact.original}` : `Same Gmail address ignoring dots (${sharedEmails[0].original} and ${sharedEmails[0].other})`)
  }
  const secondPhones = contactPhones(second)
  const sharedPhone = contactPhones(first).find((item) => secondPhones.some((other) => phonesMatch(item.phone, other.phone)))
  if (sharedPhone) {
    score += 0.45
    reasons.push(`Same phone number ${sharedPhone.value}`)
  }
  const similarity = nameSimilarity(first.name, second.name)
  const fullName = nameTokens(first.name).length >= 2 && nameTokens(second.name).length >= 2
  if (similarity === 1) {
    score += 0.35
    reasons.push('Same name')
  } else if (similarity >= 0.8) {
    score += 0.2
    reasons.push('Similar name')
  } else if (score > 0 && similarity < 0.35 && nameTokens(first.name).length && nameTokens(second.name).length) {
    // A shared family or team address with clearly different names is a common false positive.
    score -= 0.3
    reasons.push('Names differ')
  }
  if (!sharedEmails.length && !sharedPhone) {
    // A name alone is weak evidence; single names ("Alex") are too common to suggest at all.
    if (similarity < 1 || !fullName) return undefined
    if (contactEmailAddresses(first).length && contactEmailAddresses(second).length) reasons.push('No shared email address')
  }
  score = Math.min(Math.max(score, 0), 1)
  if (score < DUPLICATE_MIN_SCORE) return undefined
  return { score: Math.round(score * 100) / 100, confidence: confidenceOf(score), reasons }
}

const bucketKey = {
  email: (value: string) => `e:${comparableEmail(value)}`,
  // Phones are bucketed by their last 8 digits and verified with phonesMatch afterwards.
  phone: (phone: ComparablePhone) => `p:${phone.digits.slice(-8)}`,
  name: (value: string) => {
    const tokens = nameTokens(value)
    return tokens.length >= 2 ? `n:${[...tokens].sort().join(' ')}` : undefined
  }
}

export interface DuplicateOptions {
  // Linked and dismissed pairs are not suggested again.
  associations?: ContactAssociation[]
  limit?: number
}

export function findDuplicateCandidates(contacts: Contact[], options: DuplicateOptions = {}): DuplicateCandidate[] {
  const skip = new Set((options.associations ?? []).map((association) => contactPairKey(...association.contactIds)))
  const buckets = new Map<string, number[]>()
  const add = (key: string | undefined, index: number) => {
    if (!key) return
    const bucket = buckets.get(key)
    if (bucket) { if (bucket.at(-1) !== index) bucket.push(index) } else buckets.set(key, [index])
  }
  contacts.forEach((contact, index) => {
    for (const email of contactEmailAddresses(contact)) add(bucketKey.email(email), index)
    for (const { phone } of contactPhones(contact)) add(bucketKey.phone(phone), index)
    add(bucketKey.name(contact.name), index)
  })
  const pairs = new Set<string>()
  const candidates: DuplicateCandidate[] = []
  for (const bucket of buckets.values()) {
    // A huge bucket (a shared helpdesk address) would explode quadratically and is rarely useful.
    if (bucket.length < 2 || bucket.length > 50) continue
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const first = contacts[bucket[i]]
        const second = contacts[bucket[j]]
        if (first.id === second.id) continue
        const id = contactPairKey(first.id, second.id)
        if (pairs.has(id) || skip.has(id)) continue
        pairs.add(id)
        const scored = scoreDuplicatePair(first, second)
        if (!scored) continue
        const sameOwner = contactOwner(first) === contactOwner(second)
        const readOnly = [first, second].some((contact) => isSyncedContact(contact) && contact.readOnly)
        candidates.push({
          id, first, second, ...scored,
          action: sameOwner ? 'merge' : 'link',
          ...(sameOwner && readOnly ? { blocked: 'Read-only provider contacts cannot be merged. Enable provider editing first.' } : {})
        })
      }
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.first.name.localeCompare(b.first.name))
    .slice(0, options.limit ?? DUPLICATE_CANDIDATE_LIMIT)
}

// Contacts linked to the given one through local associations, transitively.
export function linkedContactIds(contactId: string, associations: ContactAssociation[]) {
  const links = associations.filter((association) => association.kind === 'link')
  const seen = new Set([contactId])
  const queue = [contactId]
  while (queue.length) {
    const current = queue.shift()!
    for (const link of links) {
      if (!link.contactIds.includes(current)) continue
      const other = link.contactIds[0] === current ? link.contactIds[1] : link.contactIds[0]
      if (!seen.has(other)) { seen.add(other); queue.push(other) }
    }
  }
  seen.delete(contactId)
  return seen
}
