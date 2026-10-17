import { describe, expect, it } from 'vitest'
import type { Contact } from '../types'
import type { SyncedContact } from '../productivity-types'
import type { ContactAssociation } from '../contact-merge-types'
import {
  comparableEmail, comparablePhone, contactOwner, contactPairKey, findDuplicateCandidates, linkedContactIds, nameSimilarity, phonesMatch, scoreDuplicatePair
} from './contact-duplicates'

const local = (id: string, name: string, extra: Partial<Contact> = {}): Contact => ({ id, name, email: '', group: 'Personal', favorite: false, color: '#000', source: 'local', ...extra })
const google = (id: string, name: string, extra: Partial<SyncedContact> = {}): SyncedContact => ({
  id, name, email: '', group: 'Google', favorite: false, color: '#000', remoteId: `people/${id}`, accountId: 'g1', provider: 'gmail', readOnly: false, ...extra
})

describe('normalization', () => {
  it('ignores dots only for Gmail addresses and keeps plus tags everywhere', () => {
    expect(comparableEmail(' Ada.Lovelace@GMAIL.com ')).toBe('adalovelace@gmail.com')
    expect(comparableEmail('ada.lovelace@googlemail.com')).toBe('adalovelace@gmail.com')
    expect(comparableEmail('ada.lovelace@example.com')).toBe('ada.lovelace@example.com')
    expect(comparableEmail('ada+news@gmail.com')).not.toBe(comparableEmail('ada@gmail.com'))
  })

  it('compares phones as digits with country codes, trunk prefixes, and extensions', () => {
    expect(comparablePhone('+44 (20) 7946-0000')).toEqual({ digits: '442079460000', international: true })
    expect(comparablePhone('0044 20 7946 0000')).toEqual({ digits: '442079460000', international: true })
    expect(comparablePhone('020 7946 0000 ext. 12')).toEqual({ digits: '2079460000', international: false })
    expect(comparablePhone('123')).toBeUndefined()
    expect(phonesMatch(comparablePhone('+44 20 7946 0000')!, comparablePhone('020 7946 0000')!)).toBe(true)
    expect(phonesMatch(comparablePhone('+1 555 123 4567')!, comparablePhone('+44 555 123 4567')!)).toBe(false)
    // A short national number is not matched against the tail of an international one.
    expect(phonesMatch(comparablePhone('+49 30 1234567')!, comparablePhone('1234567')!)).toBe(false)
  })

  it('scores names independent of order, case, accents, and honorifics', () => {
    expect(nameSimilarity('Lovelace, Ada', 'ada lovelace')).toBe(1)
    expect(nameSimilarity('Dr. José Núñez', 'Jose Nunez')).toBe(1)
    expect(nameSimilarity('A. Lovelace', 'Ada Lovelace')).toBeGreaterThanOrEqual(0.8)
    expect(nameSimilarity('Ada Lovelace', 'Alan Turing')).toBe(0)
  })
})

describe('scoreDuplicatePair', () => {
  it('rates a shared address with the same name as high confidence and explains why', () => {
    expect(scoreDuplicatePair(local('a', 'Ada Lovelace', { email: 'ada@example.com' }), local('b', 'Lovelace, Ada', { email: 'ADA@example.com', phone: '+44 20 7946 0000' })))
      .toEqual({ score: 1, confidence: 'high', reasons: ['Same email address ada@example.com', 'Same name'] })
  })

  it('treats a shared family or team address with different names as weak evidence', () => {
    const scored = scoreDuplicatePair(local('a', 'Ada Lovelace', { email: 'family@example.com' }), local('b', 'Byron Lovelace', { email: 'family@example.com' }))
    expect(scored?.confidence).not.toBe('high')
    const different = scoreDuplicatePair(local('a', 'Ada King', { email: 'office@example.com' }), local('b', 'Charles Babbage', { email: 'office@example.com' }))
    expect(different).toMatchObject({ confidence: 'low', reasons: ['Same email address office@example.com', 'Names differ'] })
  })

  it('does not suggest single shared first names or unrelated contacts', () => {
    expect(scoreDuplicatePair(local('a', 'Alex'), local('b', 'Alex'))).toBeUndefined()
    expect(scoreDuplicatePair(local('a', 'Ada Lovelace', { email: 'a@x.test' }), local('b', 'Alan Turing', { email: 'b@x.test' }))).toBeUndefined()
    expect(scoreDuplicatePair(local('a', 'Ada Lovelace', { email: 'a@x.test' }), local('b', 'Ada Lovelace', { email: 'b@x.test' })))
      .toEqual({ score: 0.35, confidence: 'low', reasons: ['Same name', 'No shared email address'] })
  })

  it('matches every typed value, not only the primary ones', () => {
    const first = local('a', 'Ada Lovelace', { email: 'ada@home.test', phones: [{ value: '+44 20 7946 0000', type: 'work' }] })
    const second = local('b', 'Ada L', { email: 'other@x.test', emails: [{ value: 'other@x.test' }, { value: 'ada@home.test', type: 'work' }], phone: '020 7946 0000' })
    expect(scoreDuplicatePair(first, second)?.reasons).toEqual(['Same email address ada@home.test', 'Same phone number +44 20 7946 0000', 'Similar name'])
  })
})

describe('findDuplicateCandidates', () => {
  const ada = local('ada', 'Ada Lovelace', { email: 'ada@example.com' })
  const adaCopy = local('ada-2', 'Ada Lovelace', { email: 'ada@example.com' })
  const adaGoogle = google('ada-g', 'Ada Lovelace', { email: 'ada@example.com' })
  const adaGoogleCopy = google('ada-g2', 'Ada King', { email: 'Ada@Example.com' })
  const readOnly = google('ada-r', 'Ada Lovelace', { email: 'ada@example.com', readOnly: true, accountId: 'g2' })
  const readOnlyCopy = google('ada-r2', 'Ada Lovelace', { email: 'ada@example.com', readOnly: true, accountId: 'g2' })

  it('offers merges only within one owner and links across owners', () => {
    const candidates = findDuplicateCandidates([ada, adaCopy, adaGoogle, adaGoogleCopy])
    const byPair = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    expect(byPair.get(contactPairKey('ada', 'ada-2'))?.action).toBe('merge')
    expect(byPair.get(contactPairKey('ada-g', 'ada-g2'))?.action).toBe('merge')
    expect(byPair.get(contactPairKey('ada', 'ada-g'))?.action).toBe('link')
    expect(candidates[0].score).toBeGreaterThanOrEqual(candidates.at(-1)!.score)
    expect(contactOwner(ada)).toBe('local')
    expect(contactOwner(adaGoogle)).toBe('g1')
  })

  it('blocks merging read-only provider contacts and skips linked or dismissed pairs', () => {
    expect(findDuplicateCandidates([readOnly, readOnlyCopy])[0]).toMatchObject({ action: 'merge', blocked: expect.stringMatching(/Read-only/) })
    const associations: ContactAssociation[] = [
      { id: contactPairKey('ada', 'ada-2'), kind: 'dismissed', contactIds: ['ada', 'ada-2'], owners: ['local', 'local'], createdAt: '' }
    ]
    expect(findDuplicateCandidates([ada, adaCopy], { associations })).toEqual([])
  })

  it('avoids comparing every pair in a large address book', () => {
    const many = Array.from({ length: 3_000 }, (_, index) => local(`c-${index}`, `Person ${index} Example`, { email: `person${index}@example.com` }))
    const started = performance.now()
    expect(findDuplicateCandidates([...many, local('dup', 'Person 7 Example', { email: 'person7@example.com' })])).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('linkedContactIds', () => {
  it('follows links transitively and ignores dismissals', () => {
    const associations: ContactAssociation[] = [
      { id: 'a|b', kind: 'link', contactIds: ['a', 'b'], owners: ['local', 'g1'], createdAt: '' },
      { id: 'b|c', kind: 'link', contactIds: ['b', 'c'], owners: ['g1', 'm1'], createdAt: '' },
      { id: 'a|d', kind: 'dismissed', contactIds: ['a', 'd'], owners: ['local', 'local'], createdAt: '' }
    ]
    expect([...linkedContactIds('a', associations)].sort()).toEqual(['b', 'c'])
  })
})
