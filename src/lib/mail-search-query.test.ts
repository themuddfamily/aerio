import { describe, expect, it } from 'vitest'
import { compileMailSearchQuery, mailSearchQueryError, parseMailSearchQuery, MAIL_SEARCH_MAX_LENGTH } from './mail-search-query'

describe('mail search query parser', () => {
  it('keeps the legacy whitespace behaviour of prefix terms joined by AND', () => {
    expect(compileMailSearchQuery('quarterly report')).toEqual({ include: '("quarterly"*) AND ("report"*)' })
    expect(compileMailSearchQuery('invoice')).toEqual({ include: '"invoice"*' })
  })

  it('treats empty and punctuation-only input as no search', () => {
    expect(compileMailSearchQuery('')).toBeUndefined()
    expect(compileMailSearchQuery('   - & -- ')).toBeUndefined()
    expect(compileMailSearchQuery('invoice --')).toEqual({ include: '"invoice"*' })
    expect(compileMailSearchQuery('"  "')).toBeUndefined()
  })

  it('compiles quoted phrases as exact phrases', () => {
    expect(compileMailSearchQuery('"quarterly report" draft')).toEqual({ include: '("quarterly report") AND ("draft"*)' })
  })

  it('honours explicit AND, OR, NOT and parentheses with NOT > AND > OR precedence', () => {
    expect(compileMailSearchQuery('a OR b c')).toEqual({ include: '("a"*) OR (("b"*) AND ("c"*))' })
    expect(compileMailSearchQuery('(a OR b) AND c')).toEqual({ include: '(("a"*) OR ("b"*)) AND ("c"*)' })
    expect(compileMailSearchQuery('(invoice OR receipt) NOT paid')).toEqual({ include: '("invoice"*) OR ("receipt"*)', exclude: '("paid"*)' })
    expect(compileMailSearchQuery('(invoice -paid) OR refund')).toEqual({ include: '(("invoice"*) NOT (("paid"*))) OR ("refund"*)' })
  })

  it('lets top-level NOT terms stand alone as conversation exclusions', () => {
    expect(compileMailSearchQuery('-newsletter NOT "weekly digest"')).toEqual({ exclude: '("newsletter"*) OR ("weekly digest")' })
    expect(compileMailSearchQuery('NOT NOT invoice')).toEqual({ include: '"invoice"*' })
    expect(compileMailSearchQuery('-(promo OR sale)')).toEqual({ exclude: '(("promo"*) OR ("sale"*))' })
  })

  it('treats lowercase operator words as ordinary terms', () => {
    expect(compileMailSearchQuery('salt and pepper')).toEqual({ include: '("salt"*) AND ("and"*) AND ("pepper"*)' })
  })

  it('maps field prefixes onto FTS columns, including phrases and groups', () => {
    expect(compileMailSearchQuery('from:ada subject:"launch plan"')).toEqual({ include: '(sender:"ada"*) AND (subject:"launch plan")' })
    expect(compileMailSearchQuery('to:(grace OR linus) -cc:bob')).toEqual({ include: '(recipients:"grace"*) OR (recipients:"linus"*)', exclude: '(recipients:"bob"*)' })
    expect(compileMailSearchQuery('attachment:invoice.pdf body:total')).toEqual({ include: '(attachment_names:"invoice.pdf"*) AND (body:"total"*)' })
    expect(compileMailSearchQuery('FROM:ada')).toEqual({ include: 'sender:"ada"*' })
  })

  it('leaves unknown prefixes as plain words', () => {
    expect(compileMailSearchQuery('re:status')).toEqual({ include: '"re:status"*' })
  })

  it('never lets raw FTS syntax escape its quotes', () => {
    expect(compileMailSearchQuery('x" OR body:* "')).toEqual({ include: '("x"*) AND ("OR body:*")' })
    expect(mailSearchQueryError('a"b')).toMatch(/quotation mark/)
    expect(compileMailSearchQuery('NEAR body* {subject}:x ^start')).toEqual({ include: '("NEAR"*) AND ("body*"*) AND ("{subject}:x"*) AND ("^start"*)' })
  })

  it('reports clear validation errors with positions', () => {
    expect(parseMailSearchQuery('report "unfinished')).toEqual({ ok: false, error: 'Close the quotation mark at character 8', position: 7 })
    expect(mailSearchQueryError('(a OR b')).toMatch(/closing parenthesis/)
    expect(mailSearchQueryError('a OR b)')).toMatch(/unmatched closing parenthesis at character 7/)
    expect(mailSearchQueryError('()')).toMatch(/inside the parentheses/)
    expect(mailSearchQueryError('invoice AND')).toBe('Add a search term after AND')
    expect(mailSearchQueryError('invoice OR')).toBe('Add a search term after OR')
    expect(mailSearchQueryError('NOT')).toBe('Add a search term after NOT')
    expect(mailSearchQueryError('OR invoice')).toMatch(/before OR at character 1/)
    expect(mailSearchQueryError('from:')).toBe('Add a search term after from:')
    expect(compileMailSearchQuery('from: ada')).toEqual({ include: 'sender:"ada"*' })
    expect(mailSearchQueryError('subject:(from:ada)')).toMatch(/cannot be nested/)
    expect(mailSearchQueryError('a OR -b')).toMatch(/Combine NOT/)
    expect(mailSearchQueryError('a'.repeat(MAIL_SEARCH_MAX_LENGTH + 1))).toMatch(/Shorten/)
    expect(mailSearchQueryError(Array.from({ length: 65 }, (_, index) => `t${index}`).join(' '))).toMatch(/64 search terms/)
    expect(mailSearchQueryError(`${'('.repeat(17)}a${')'.repeat(17)}`)).toMatch(/nested parentheses/)
    expect(() => compileMailSearchQuery('a AND')).toThrow('Add a search term after AND')
    expect(mailSearchQueryError('(invoice OR receipt) -paid')).toBeUndefined()
  })
})
