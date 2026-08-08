import { describe, expect, it } from 'vitest'
import { imapMessageLabels } from './imap-client'

describe('IMAP message labels', () => {
  it('retains custom keywords while normalizing system flags', () => {
    const labels = imapMessageLabels(
      { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' },
      new Set(['\\Seen', '\\Flagged', '$Important', 'Avast: Scanned'])
    )
    expect(labels).toEqual(expect.arrayContaining(['INBOX', 'STARRED', 'IMPORTANT', 'keyword:Avast: Scanned']))
    expect(labels).not.toContain('UNREAD')
  })
})
