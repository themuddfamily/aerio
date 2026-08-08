import { describe, expect, it } from 'vitest'
import type { MailLabel } from '../mail-types'
import { visibleMailLabels } from './mail-labels'

const labels: MailLabel[] = [
  { accountId: 'account-1', id: 'INBOX', name: 'Inbox', type: 'system' },
  { accountId: 'account-1', id: 'Label_42', name: 'Avast: Scanned', type: 'user', color: '#4986e7' },
  { accountId: 'account-2', id: 'Label_42', name: 'Another account', type: 'user' }
]

describe('visible mail labels', () => {
  it('maps opaque provider IDs to user-facing tag names and hides system labels', () => {
    expect(visibleMailLabels('account-1', ['INBOX', 'UNREAD', 'Label_42'], labels)).toEqual([
      { id: 'Label_42', name: 'Avast: Scanned', color: '#4986e7' }
    ])
  })

  it('exposes synchronized Outlook categories and IMAP keywords', () => {
    expect(visibleMailLabels('account-1', ['category:Customer', 'keyword:Follow up'], labels).map((label) => label.name))
      .toEqual(['Customer', 'Follow up'])
  })

  it('does not borrow a label name from another account', () => {
    expect(visibleMailLabels('account-3', ['Label_42'], labels)).toEqual([])
  })

  it('deduplicates labels by their trimmed case-insensitive display name', () => {
    const available: MailLabel[] = [
      { accountId: 'account-1', id: 'one', name: 'Project', type: 'user' },
      { accountId: 'account-1', id: 'two', name: ' project ', type: 'user' }
    ]
    expect(visibleMailLabels('account-1', ['one', 'two'], available)).toEqual([{ id: 'one', name: 'Project', color: undefined }])
  })

  it('ignores unknown provider labels and empty category names', () => {
    expect(visibleMailLabels('account-1', ['UNKNOWN', 'category:   ', 'keyword:'], labels)).toEqual([])
  })

  it('preserves provider order while trimming category and keyword prefixes', () => {
    expect(visibleMailLabels('account-1', ['keyword: Follow up ', 'category: Customer '], labels).map((label) => label.name))
      .toEqual(['Follow up', 'Customer'])
  })
})
