import { describe, expect, it } from 'vitest'
import type { MailRuleInput } from '../../src/mail-types'
import { mailRuleMatches, type ParsedMailMessage } from './database'

const message = (overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage => ({
  accountId: 'account-1',
  id: 'message-1',
  threadId: 'thread-1',
  historyId: '1',
  internalDate: '2026-08-08T10:00:00.000Z',
  fromName: 'Ada Lovelace',
  fromEmail: 'ada@example.com',
  to: ['Aerio Team <team@aerio.test>'],
  cc: ['Grace Hopper <grace@example.com>'],
  subject: 'Weekly Project Launch Update',
  messageIdHeader: '<message-1@example.com>',
  references: [],
  snippet: 'The build is ready for review.',
  text: 'Hello team, the build is ready for review. Kind regards, Ada',
  html: '<p>Hello team, the build is ready for review.</p>',
  labelIds: ['INBOX', 'UNREAD'],
  sizeEstimate: 100,
  rawPath: 'message-1.eml',
  attachments: [],
  ...overrides
})

const rule = (conditions: MailRuleInput['conditions'], match: MailRuleInput['match'] = 'all'): MailRuleInput => ({
  accountId: 'account-1',
  name: 'Test rule',
  enabled: true,
  match,
  conditions,
  actions: [{ action: 'archive' }]
})

describe('mail rule matching', () => {
  it('matches sender display names without regard to case', () => {
    expect(mailRuleMatches(rule([{ field: 'from', operator: 'contains', value: 'ADA LOVELACE' }]), message())).toBe(true)
  })

  it('matches a bare sender address with equals even when a display name exists', () => {
    expect(mailRuleMatches(rule([{ field: 'from', operator: 'equals', value: 'ada@example.com' }]), message())).toBe(true)
  })

  it('matches the sender display name exactly', () => {
    expect(mailRuleMatches(rule([{ field: 'from', operator: 'equals', value: 'Ada Lovelace' }]), message())).toBe(true)
  })

  it('does not treat a partial sender address as equal', () => {
    expect(mailRuleMatches(rule([{ field: 'from', operator: 'equals', value: 'ada@' }]), message())).toBe(false)
  })

  it('matches recipients found in Cc as well as To', () => {
    expect(mailRuleMatches(rule([{ field: 'to', operator: 'contains', value: 'grace@example.com' }]), message())).toBe(true)
  })

  it('supports starts-with subject conditions', () => {
    expect(mailRuleMatches(rule([{ field: 'subject', operator: 'starts-with', value: 'weekly project' }]), message())).toBe(true)
  })

  it('supports ends-with body conditions', () => {
    expect(mailRuleMatches(rule([{ field: 'body', operator: 'ends-with', value: 'regards, ada' }]), message())).toBe(true)
  })

  it('requires every condition in all mode', () => {
    expect(mailRuleMatches(rule([
      { field: 'from', operator: 'contains', value: 'ada' },
      { field: 'subject', operator: 'contains', value: 'invoice' }
    ]), message())).toBe(false)
  })

  it('accepts one matching condition in any mode', () => {
    expect(mailRuleMatches(rule([
      { field: 'from', operator: 'contains', value: 'nobody' },
      { field: 'subject', operator: 'contains', value: 'launch' }
    ], 'any'), message())).toBe(true)
  })

  it('trims condition values before comparing them', () => {
    expect(mailRuleMatches(rule([{ field: 'subject', operator: 'contains', value: '  project launch  ' }]), message())).toBe(true)
  })

  it('rejects empty condition values even in any mode', () => {
    expect(mailRuleMatches(rule([{ field: 'subject', operator: 'contains', value: '   ' }], 'any'), message())).toBe(false)
  })

  it('does not match a rule with no conditions', () => {
    expect(mailRuleMatches(rule([]), message())).toBe(false)
  })
})
