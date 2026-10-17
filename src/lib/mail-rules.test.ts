import { describe, expect, it } from 'vitest'
import type { MailRuleCondition, MailRuleInput } from '../mail-types'
import {
  defaultMailRuleCondition,
  mailRuleConditionError,
  mailRuleImportance,
  mailRuleMatches,
  mailRuleNeedsHeaders,
  mailRuleTrigger,
  mailRuleTriggersForLabels,
  type MailRuleMessage
} from './mail-rules'

const NOW = Date.parse('2026-10-10T12:00:00Z')

const message = (overrides: Partial<MailRuleMessage> = {}): MailRuleMessage => ({
  accountId: 'account-1',
  fromName: 'Ada Lovelace',
  fromEmail: 'ada@example.com',
  to: ['Aerio Team <team@aerio.test>'],
  cc: ['Grace Hopper <grace@example.com>'],
  subject: 'Weekly update',
  text: 'Hello team',
  labelIds: ['INBOX', 'folder:projects'],
  sizeEstimate: 300 * 1024,
  internalDate: '2026-10-01T12:00:00Z',
  attachmentCount: 1,
  headers: { 'list-id': ['Project list <project.example.com>'], 'x-priority': ['3'] },
  ...overrides
})

const rule = (conditions: MailRuleCondition[], extra: Partial<MailRuleInput> = {}): MailRuleInput => ({
  accountId: 'account-1', name: 'Rule', enabled: true, match: 'all', conditions, actions: [{ action: 'archive' }], ...extra
})

const matches = (condition: MailRuleCondition, value = message()) => mailRuleMatches(rule([condition]), value, NOW)

describe('advanced mail rule conditions', () => {
  it('matches Cc recipients separately from To and compares recipient addresses exactly', () => {
    expect(matches({ field: 'cc', operator: 'contains', value: 'grace' })).toBe(true)
    expect(matches({ field: 'cc', operator: 'contains', value: 'team@aerio.test' })).toBe(false)
    expect(matches({ field: 'cc', operator: 'equals', value: 'grace@example.com' })).toBe(true)
    expect(matches({ field: 'to', operator: 'equals', value: 'Aerio Team' })).toBe(true)
    expect(matches({ field: 'to', operator: 'equals', value: 'team@aerio' })).toBe(false)
  })

  it('checks named headers case-insensitively and never matches when headers are unknown', () => {
    expect(matches({ field: 'header', headerName: 'List-Id', operator: 'contains', value: 'project.example.com' })).toBe(true)
    expect(matches({ field: 'header', headerName: 'List-Id', operator: 'starts-with', value: 'project list' })).toBe(true)
    expect(matches({ field: 'header', headerName: 'X-Missing', operator: 'contains', value: 'x' })).toBe(false)
    expect(matches({ field: 'header', headerName: 'List-Id', operator: 'contains', value: 'project' }, message({ headers: undefined }))).toBe(false)
  })

  it('checks attachments, size, and age ranges', () => {
    expect(matches({ field: 'has-attachment', operator: 'is', value: 'yes' })).toBe(true)
    expect(matches({ field: 'has-attachment', operator: 'is', value: 'no' })).toBe(false)
    expect(matches({ field: 'has-attachment', operator: 'is', value: 'no' }, message({ attachmentCount: undefined, attachments: [] }))).toBe(true)
    expect(matches({ field: 'has-attachment', operator: 'is', value: 'yes' }, message({ attachmentCount: undefined }))).toBe(false)
    expect(matches({ field: 'size', operator: 'greater-than', value: '200' })).toBe(true)
    expect(matches({ field: 'size', operator: 'less-than', value: '200' })).toBe(false)
    expect(matches({ field: 'size', operator: 'less-than', value: '200' }, message({ sizeEstimate: undefined }))).toBe(false)
    expect(matches({ field: 'age', operator: 'greater-than', value: '7' })).toBe(true)
    expect(matches({ field: 'age', operator: 'less-than', value: '7' })).toBe(false)
    expect(matches({ field: 'age', operator: 'less-than', value: '7' }, message({ internalDate: 'not a date' }))).toBe(false)
  })

  it('derives importance from headers before the IMPORTANT label', () => {
    expect(mailRuleImportance({ headers: { importance: ['High'] } })).toBe('high')
    expect(mailRuleImportance({ headers: { 'x-priority': ['5 (Lowest)'] } })).toBe('low')
    expect(mailRuleImportance({ headers: { priority: ['non-urgent'] }, labelIds: ['IMPORTANT'] })).toBe('low')
    expect(mailRuleImportance({ labelIds: ['IMPORTANT'] })).toBe('high')
    expect(mailRuleImportance({})).toBe('normal')
    expect(matches({ field: 'importance', operator: 'is', value: 'normal' })).toBe(true)
  })

  it('checks folder or label membership by exact id', () => {
    expect(matches({ field: 'label', operator: 'is', value: 'folder:projects' })).toBe(true)
    expect(matches({ field: 'label', operator: 'is', value: 'folder:Projects' })).toBe(false)
  })

  it('skips the rule when any exception matches', () => {
    const base = [{ field: 'from', operator: 'contains', value: 'ada' }] as MailRuleCondition[]
    expect(mailRuleMatches(rule(base, { exceptions: [{ field: 'subject', operator: 'contains', value: 'weekly' }] }), message(), NOW)).toBe(false)
    expect(mailRuleMatches(rule(base, { exceptions: [
      { field: 'subject', operator: 'contains', value: 'monthly' },
      { field: 'has-attachment', operator: 'is', value: 'no' }
    ] }), message(), NOW)).toBe(true)
    expect(mailRuleMatches(rule(base, { exceptions: [] }), message(), NOW)).toBe(true)
  })

  it('reports which rules read headers', () => {
    expect(mailRuleNeedsHeaders(rule([{ field: 'subject', operator: 'contains', value: 'x' }]))).toBe(false)
    expect(mailRuleNeedsHeaders(rule([{ field: 'subject', operator: 'contains', value: 'x' }], { exceptions: [{ field: 'importance', operator: 'is', value: 'low' }] }))).toBe(true)
  })
})

describe('mail rule validation', () => {
  it('provides complete defaults for each field', () => {
    expect(defaultMailRuleCondition('has-attachment')).toEqual({ field: 'has-attachment', operator: 'is', value: 'yes' })
    expect(defaultMailRuleCondition('size')).toEqual({ field: 'size', operator: 'greater-than', value: '' })
    expect(defaultMailRuleCondition('header')).toEqual({ field: 'header', operator: 'contains', value: '', headerName: '' })
    expect(defaultMailRuleCondition()).toEqual({ field: 'from', operator: 'contains', value: '' })
  })

  it.each([
    [undefined, 'Finish every rule condition'],
    [{ field: 'nope', operator: 'contains', value: 'x' }, 'Finish every rule condition'],
    [{ field: 'size', operator: 'contains', value: '1' }, 'Finish every rule condition'],
    [{ field: 'subject', operator: 'contains', value: '  ' }, 'Finish every rule condition'],
    [{ field: 'header', operator: 'contains', value: 'x' }, 'Enter the header name to check'],
    [{ field: 'header', operator: 'contains', value: 'x', headerName: 'Bad Name' }, 'Enter the header name to check'],
    [{ field: 'has-attachment', operator: 'is', value: 'maybe' }, 'Choose yes or no for the attachment condition'],
    [{ field: 'importance', operator: 'is', value: 'urgent' }, 'Choose an importance level'],
    [{ field: 'size', operator: 'greater-than', value: '1.5' }, 'Enter the size as a whole number of kilobytes'],
    [{ field: 'age', operator: 'less-than', value: '99999' }, 'Enter the age as a whole number of days']
  ])('rejects %j', (condition, error) => {
    expect(mailRuleConditionError(condition as MailRuleCondition)).toBe(error)
  })

  it('accepts complete advanced conditions', () => {
    expect(mailRuleConditionError({ field: 'header', operator: 'contains', value: 'x', headerName: 'List-Id' })).toBeUndefined()
    expect(mailRuleConditionError({ field: 'age', operator: 'greater-than', value: '30' })).toBeUndefined()
    expect(mailRuleConditionError({ field: 'label', operator: 'is', value: 'folder:abc' })).toBeUndefined()
  })
})

describe('mail rule triggers', () => {
  it('defaults stored rules to incoming', () => {
    expect(mailRuleTrigger({})).toBe('incoming')
    expect(mailRuleTrigger({ trigger: 'outgoing' })).toBe('outgoing')
  })

  it('classifies new mail by its labels', () => {
    expect(mailRuleTriggersForLabels(['INBOX', 'UNREAD'])).toEqual(['incoming'])
    expect(mailRuleTriggersForLabels(['SENT'])).toEqual(['outgoing'])
    expect(mailRuleTriggersForLabels(['sent', 'INBOX'])).toEqual(['incoming', 'outgoing'])
    expect(mailRuleTriggersForLabels(['DRAFT'])).toEqual([])
    expect(mailRuleTriggersForLabels(['folder:archive'])).toEqual(['incoming'])
  })
})
