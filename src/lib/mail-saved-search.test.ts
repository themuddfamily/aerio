import { describe, expect, it } from 'vitest'
import type { MailSavedSearch } from '../mail-types'
import { normalizeMailSearchFilters, savedSearchMatchesView, validateMailSavedSearch } from './mail-saved-search'

describe('saved mail search validation', () => {
  it('trims and normalizes a valid saved search', () => {
    expect(validateMailSavedSearch({ id: 'search', name: ' Mine ', query: ' a OR b ', folder: 'inbox', accountId: 'acc', labelId: 'lbl', filters: { from: ' ada ', to: '', unread: false, dateFrom: '2026-01-01' } }))
      .toEqual({ id: 'search', name: 'Mine', query: 'a OR b', folder: 'inbox', accountId: 'acc', labelId: 'lbl', filters: { from: 'ada', unread: false, dateFrom: '2026-01-01' } })
    expect(validateMailSavedSearch({ name: 'Unread', folder: 'all', filters: { unread: true } })).toEqual({ name: 'Unread', query: '', folder: 'all', filters: { unread: true } })
  })

  it('rejects malformed payloads', () => {
    const base = { name: 'Search', query: 'invoice', folder: 'all', filters: {} }
    expect(() => validateMailSavedSearch(null)).toThrow(/invalid/)
    expect(() => validateMailSavedSearch({ ...base, name: 'x'.repeat(101) })).toThrow(/name/)
    expect(() => validateMailSavedSearch({ ...base, query: 42 })).toThrow(/query is invalid/)
    expect(() => validateMailSavedSearch({ ...base, query: '"open' })).toThrow(/quotation mark/)
    expect(() => validateMailSavedSearch({ ...base, folder: 'nowhere' })).toThrow(/mailbox/)
    expect(() => validateMailSavedSearch({ ...base, accountId: 7 })).toThrow(/account/)
    expect(() => validateMailSavedSearch({ ...base, labelId: 'label' })).toThrow(/account for a label/)
    expect(() => validateMailSavedSearch({ ...base, id: 'x'.repeat(501) })).toThrow(/id is invalid/)
    expect(() => validateMailSavedSearch({ ...base, query: ' ' })).toThrow(/Add search words or filters/)
  })

  it('rejects unknown or mistyped filters', () => {
    expect(normalizeMailSearchFilters(undefined)).toEqual({})
    expect(() => normalizeMailSearchFilters([])).toThrow(/filters/)
    expect(() => normalizeMailSearchFilters({ raw: 'x' })).toThrow(/filters/)
    expect(() => normalizeMailSearchFilters({ from: 1 })).toThrow(/filters/)
    expect(() => normalizeMailSearchFilters({ unread: 'yes' })).toThrow(/filters/)
    expect(() => normalizeMailSearchFilters({ dateFrom: 'tomorrow' })).toThrow(/dates/)
    expect(() => normalizeMailSearchFilters({ dateFrom: '2026-02-02', dateTo: '2026-01-01' })).toThrow(/before the end date/)
  })
})

describe('savedSearchMatchesView', () => {
  const saved: MailSavedSearch = { id: 's', name: 'S', query: 'invoice', folder: 'all', accountId: 'acc', filters: { unread: true }, createdAt: '', updatedAt: '' }
  const view = { accountId: 'acc', folder: 'all' as const, query: ' invoice ', filters: { unread: true } }

  it('matches the exact scope, query, and filters', () => {
    expect(savedSearchMatchesView(saved, view)).toBe(true)
    expect(savedSearchMatchesView({ ...saved, accountId: undefined }, { ...view, accountId: 'all' })).toBe(true)
    expect(savedSearchMatchesView(saved, { ...view, accountId: 'all' })).toBe(false)
    expect(savedSearchMatchesView(saved, { ...view, folder: 'inbox' })).toBe(false)
    expect(savedSearchMatchesView(saved, { ...view, labelId: 'label' })).toBe(false)
    expect(savedSearchMatchesView(saved, { ...view, query: 'invoices' })).toBe(false)
    expect(savedSearchMatchesView(saved, { ...view, filters: {} })).toBe(false)
  })
})
