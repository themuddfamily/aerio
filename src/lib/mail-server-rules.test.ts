import { describe, expect, it } from 'vitest'
import type { MailRuleInput } from '../mail-types'
import {
  MICROSOFT_ARCHIVE_FOLDER,
  describeGmailFilter,
  describeMicrosoftRule,
  gmailFilterForRule,
  mapMailRuleToServer,
  microsoftRuleForRule
} from './mail-server-rules'

const rule = (overrides: Partial<MailRuleInput> = {}): MailRuleInput => ({
  accountId: 'account-1', name: 'Newsletters', enabled: true, match: 'all',
  conditions: [{ field: 'from', operator: 'equals', value: 'news@example.com' }],
  actions: [{ action: 'archive' }],
  ...overrides
})

const blocking = (mapping: { issues: { level: string; part: string; index?: number }[] }) =>
  mapping.issues.filter((issue) => issue.level === 'unsupported').map((issue) => `${issue.part}${issue.index ?? ''}`)

describe('Gmail filter mapping', () => {
  it('blocks archive triggers for both server providers', () => {
    for (const provider of ['gmail', 'microsoft'] as const) {
      const mapping = mapMailRuleToServer(rule({ trigger: 'archive' }), provider)
      expect(mapping.supported).toBe(false)
      expect(mapping.issues).toContainEqual(expect.objectContaining({ part: 'rule', level: 'unsupported', message: expect.stringContaining('archive') }))
    }
  })
  it('builds an AND query, a negated "any" exception query, and label actions', () => {
    const { filter, mapping } = gmailFilterForRule(rule({
      conditions: [
        { field: 'from', operator: 'equals', value: 'news@example.com' },
        { field: 'to', operator: 'contains', value: 'team list' },
        { field: 'has-attachment', operator: 'is', value: 'yes' },
        { field: 'size', operator: 'greater-than', value: '100' }
      ],
      exceptions: [
        { field: 'subject', operator: 'contains', value: 'urgent' },
        { field: 'header', headerName: 'List-Id', operator: 'contains', value: 'alerts.example.com' }
      ],
      actions: [{ action: 'read' }, { action: 'move', labelId: 'Label_7' }, { action: 'star' }]
    }))
    expect(mapping.supported).toBe(true)
    expect(filter).toEqual({
      criteria: { query: 'from:news@example.com {to:"team list" cc:"team list"} has:attachment larger:102400', negatedQuery: '{subject:urgent list:alerts.example.com}' },
      action: { addLabelIds: ['Label_7', 'STARRED'], removeLabelIds: ['UNREAD', 'INBOX'] }
    })
    expect(mapping.issues).toEqual([expect.objectContaining({ part: 'rule', level: 'approximate', message: expect.stringContaining('whole words') })])
  })

  it('uses OR grouping for "any" rules and maps the remaining actions', () => {
    const { filter } = gmailFilterForRule(rule({
      match: 'any',
      conditions: [
        { field: 'subject', operator: 'contains', value: 'invoice' },
        { field: 'from', operator: 'ends-with', value: '@billing.example.com' },
        { field: 'has-attachment', operator: 'is', value: 'no' }
      ],
      actions: [{ action: 'important' }, { action: 'trash' }, { action: 'label', labelId: 'Label_1' }]
    }))
    expect(filter?.criteria).toEqual({ query: '{subject:invoice from:billing.example.com -has:attachment}' })
    expect(filter?.action).toEqual({ addLabelIds: ['IMPORTANT', 'TRASH', 'Label_1'] })
  })

  it('reports each condition, exception, and action that Gmail cannot represent', () => {
    const { filter, mapping } = gmailFilterForRule(rule({
      trigger: 'outgoing',
      conditions: [
        { field: 'subject', operator: 'starts-with', value: '[Project]' },
        { field: 'age', operator: 'greater-than', value: '3' },
        { field: 'label', operator: 'is', value: 'Label_1' },
        { field: 'importance', operator: 'is', value: 'low' },
        { field: 'header', headerName: 'X-Spam', operator: 'contains', value: 'yes' },
        { field: 'from', operator: 'starts-with', value: 'news' }
      ],
      exceptions: [{ field: 'body', operator: 'equals', value: 'x' }],
      actions: [{ action: 'move', labelId: 'folder:abc' }]
    }))
    expect(filter).toBeUndefined()
    expect(mapping.supported).toBe(false)
    expect(blocking(mapping)).toEqual(['rule', 'condition0', 'condition1', 'condition2', 'condition3', 'condition4', 'condition5', 'exception0', 'action0', 'rule'])
  })

  it('marks approximate body, importance, and display-name mappings without blocking them', () => {
    const { mapping, filter } = gmailFilterForRule(rule({
      conditions: [
        { field: 'body', operator: 'contains', value: 'quarterly report' },
        { field: 'importance', operator: 'is', value: 'high' },
        { field: 'cc', operator: 'equals', value: 'Grace Hopper' }
      ]
    }))
    expect(mapping.supported).toBe(true)
    expect(mapping.issues.map((issue) => issue.level)).toEqual(['approximate', 'approximate', 'approximate'])
    expect(filter?.criteria?.query).toBe('"quarterly report" is:important cc:"Grace Hopper"')
  })
})

describe('inbox category rule mapping', () => {
  it('maps built-in categories to Gmail category search and labels, and keeps custom tabs and Outlook local', () => {
    const categoryRule = rule({ conditions: [{ field: 'category', operator: 'is', value: 'promotions' }], actions: [{ action: 'set-category', category: 'updates' }] })
    const gmail = gmailFilterForRule(categoryRule)
    expect(gmail.mapping.supported).toBe(true)
    expect(gmail.filter).toEqual({ criteria: { query: 'category:promotions' }, action: { addLabelIds: ['CATEGORY_UPDATES'] } })
    expect(gmail.mapping.issues).toEqual([expect.objectContaining({ part: 'condition', level: 'approximate' })])
    const custom = gmailFilterForRule(rule({ conditions: [{ field: 'category', operator: 'is', value: 'custom:x' }], actions: [{ action: 'set-category', category: 'custom:x' }] }))
    expect(blocking(custom.mapping)).toEqual(['condition0', 'action0', 'rule'])
    const outlook = microsoftRuleForRule(categoryRule)
    expect(outlook.messageRule).toBeUndefined()
    expect(blocking(outlook.mapping)).toEqual(['condition0', 'rule', 'action0'])
  })
})

describe('Microsoft rule mapping', () => {
  it('maps predicates, exceptions, and actions', () => {
    const { messageRule, mapping } = microsoftRuleForRule(rule({
      conditions: [
        { field: 'from', operator: 'equals', value: 'news@example.com' },
        { field: 'subject', operator: 'contains', value: 'weekly' },
        { field: 'size', operator: 'greater-than', value: '10' },
        { field: 'size', operator: 'less-than', value: '500' },
        { field: 'importance', operator: 'is', value: 'high' },
        { field: 'has-attachment', operator: 'is', value: 'yes' }
      ],
      exceptions: [
        { field: 'subject', operator: 'contains', value: 'urgent' },
        { field: 'subject', operator: 'contains', value: 'action required' }
      ],
      actions: [{ action: 'read' }, { action: 'important' }, { action: 'move', labelId: 'folder:archive-id' }, { action: 'label', labelId: 'category:Newsletters' }]
    }))
    expect(mapping).toEqual({ provider: 'microsoft', supported: true, issues: [] })
    expect(messageRule).toEqual({
      displayName: 'Newsletters',
      isEnabled: true,
      conditions: {
        fromAddresses: [{ emailAddress: { address: 'news@example.com' } }],
        subjectContains: ['weekly'],
        withinSizeRange: { minimumSize: 11, maximumSize: 499 },
        importance: 'high',
        hasAttachments: true
      },
      exceptions: { subjectContains: ['urgent', 'action required'] },
      actions: { markAsRead: true, markImportance: 'high', moveToFolder: 'archive-id', assignCategories: ['Newsletters'], stopProcessingRules: false }
    })
  })

  it('merges "any" conditions of one kind and uses the well-known Archive and Deleted Items actions', () => {
    const archive = microsoftRuleForRule(rule({ match: 'any', conditions: [
      { field: 'to', operator: 'contains', value: 'sales@' },
      { field: 'to', operator: 'contains', value: 'support@' }
    ] }))
    expect(archive.messageRule?.conditions).toEqual({ recipientContains: ['sales@', 'support@'] })
    expect(archive.messageRule?.actions?.moveToFolder).toBe(MICROSOFT_ARCHIVE_FOLDER)
    expect(microsoftRuleForRule(rule({ actions: [{ action: 'trash' }] })).messageRule?.actions).toEqual({ delete: true, stopProcessingRules: false })
  })

  it('blocks mappings that would change the rule meaning', () => {
    const anyMixed = microsoftRuleForRule(rule({ match: 'any', conditions: [
      { field: 'from', operator: 'contains', value: 'a' },
      { field: 'subject', operator: 'contains', value: 'b' }
    ] }))
    expect(blocking(anyMixed.mapping)).toEqual(['rule', 'rule'])
    const repeated = microsoftRuleForRule(rule({ conditions: [
      { field: 'subject', operator: 'contains', value: 'a' },
      { field: 'subject', operator: 'contains', value: 'b' }
    ] }))
    expect(blocking(repeated.mapping)).toEqual(['condition1'])
    const conflicts = microsoftRuleForRule(rule({
      trigger: 'outgoing',
      conditions: [
        { field: 'importance', operator: 'is', value: 'high' },
        { field: 'importance', operator: 'is', value: 'low' },
        { field: 'has-attachment', operator: 'is', value: 'no' },
        { field: 'body', operator: 'starts-with', value: 'x' },
        { field: 'to', operator: 'starts-with', value: 'x' },
        { field: 'from', operator: 'starts-with', value: 'x' },
        { field: 'age', operator: 'less-than', value: '1' },
        { field: 'label', operator: 'is', value: 'folder:x' }
      ],
      exceptions: [{ field: 'from', operator: 'contains', value: 'x' }, { field: 'subject', operator: 'contains', value: 'y' }],
      actions: [{ action: 'star' }, { action: 'archive' }, { action: 'move', labelId: 'folder:x' }, { action: 'trash' }, { action: 'label', labelId: 'Label_1' }]
    }))
    expect(conflicts.messageRule).toBeUndefined()
    expect(blocking(conflicts.mapping)).toEqual(['rule', 'condition2', 'condition3', 'condition4', 'condition5', 'condition6', 'condition7', 'condition1', 'exception', 'action0', 'action2', 'action3', 'action4'])
  })

  it('marks approximate sender, recipient, Cc, and header mappings', () => {
    const { mapping, messageRule } = microsoftRuleForRule(rule({ conditions: [
      { field: 'from', operator: 'equals', value: 'Ada' },
      { field: 'cc', operator: 'contains', value: 'grace' },
      { field: 'header', headerName: 'List-Id', operator: 'contains', value: 'list.example.com' }
    ] }))
    expect(mapping.supported).toBe(true)
    expect(mapping.issues).toHaveLength(3)
    expect(messageRule?.conditions).toEqual({ senderContains: ['Ada'], recipientContains: ['grace'], headerContains: ['list.example.com'] })
  })
})

describe('server rule mapping dispatch and descriptions', () => {
  it('reports providers without a rule API', () => {
    expect(mapMailRuleToServer(rule(), 'fastmail')).toMatchObject({ provider: 'fastmail', supported: false, issues: [expect.objectContaining({ part: 'rule' })] })
    expect(mapMailRuleToServer(rule(), undefined).provider).toBe('imap')
    expect(mapMailRuleToServer(rule(), 'gmail').provider).toBe('gmail')
    expect(mapMailRuleToServer(rule(), 'microsoft').provider).toBe('microsoft')
  })

  it('describes Gmail filters created anywhere', () => {
    expect(describeGmailFilter({
      criteria: { from: 'a@example.com', to: 'b@example.com', subject: 'Hi', query: 'has:attachment', negatedQuery: 'urgent', hasAttachment: true, size: 2048, sizeComparison: 'larger' },
      action: { addLabelIds: ['Label_1', 'STARRED'], removeLabelIds: ['INBOX', 'Label_2'], forward: 'c@example.com' }
    }, [{ accountId: 'account-1', id: 'Label_1', name: 'Projects', type: 'user' }])).toEqual({
      conditions: ['From: a@example.com', 'To: b@example.com', 'Subject: Hi', 'Matches: has:attachment', 'Has attachments', 'Size larger than 2 KB'],
      exceptions: ['Doesn’t match: urgent'],
      actions: ['Apply label Projects', 'Add star', 'Archive', 'Remove label Label_2', 'Forward to c@example.com']
    })
    expect(describeGmailFilter({})).toEqual({ conditions: [], exceptions: [], actions: [] })
  })

  it('describes Outlook rules including server-only features', () => {
    expect(describeMicrosoftRule({
      displayName: 'Outlook',
      isEnabled: true,
      conditions: { senderContains: ['a', 'b'], fromAddresses: [{ emailAddress: { address: 'x@example.com' } }], hasAttachments: true, importance: 'high', withinSizeRange: { minimumSize: 1, maximumSize: 2 }, sentOnlyToMe: true, isAutomaticReply: false },
      exceptions: { subjectContains: ['urgent'] },
      actions: { moveToFolder: 'abc', markAsRead: true, forwardTo: [{ emailAddress: { address: 'f@example.com' } }], stopProcessingRules: true, delete: false }
    }, [{ accountId: 'account-1', id: 'folder:abc', name: 'Receipts', type: 'user' }])).toEqual({
      conditions: ['Sender contains a or b', 'From x@example.com', 'Has attachments', 'Importance is high', 'Size between 1 and 2 KB', 'sent only to me'],
      exceptions: ['Subject contains urgent'],
      actions: ['Move to Receipts', 'Mark as read', 'Forward to f@example.com', 'Stop processing more rules']
    })
  })
})
