import { describe, expect, it } from 'vitest'
import type { MailLabel } from '../mail-types'
import {
  gmailLabelColor,
  isSystemMailFolder,
  mailFolderCapabilities,
  mailFolderDescendants,
  mailFolderLeafName,
  mailFolderNameConflict,
  mailFolderNameError,
  mailFolderTree
} from './mail-folders'

const labels: MailLabel[] = [
  { accountId: 'a', id: 'folder:INBOX', name: 'INBOX', type: 'system' },
  { accountId: 'a', id: 'folder:Work/Clients', name: 'Work/Clients', type: 'user', parentId: 'folder:Work' },
  { accountId: 'a', id: 'folder:Work', name: 'Work', type: 'user' },
  { accountId: 'a', id: 'folder:Work/Clients/Acme', name: 'Work/Clients/Acme', type: 'user', parentId: 'folder:Work/Clients' },
  { accountId: 'a', id: 'folder:Archive', name: 'Archive', type: 'user' },
  { accountId: 'b', id: 'folder:Work', name: 'Work', type: 'user' }
]

describe('mail folder helpers', () => {
  it('describes provider capabilities', () => {
    expect(mailFolderCapabilities('gmail')).toEqual(expect.objectContaining({ kind: 'label', canColor: true, deleteKeepsMessages: true }))
    expect(mailFolderCapabilities('microsoft')).toEqual(expect.objectContaining({ kind: 'folder', canNest: true, canColor: false }))
    expect(mailFolderCapabilities('fastmail')).toEqual(expect.objectContaining({ canCreate: true, deleteKeepsMessages: false }))
    expect(mailFolderCapabilities(undefined).canCreate).toBe(false)
  })

  it('orders nested folders under their parents with leaf names', () => {
    expect(mailFolderTree('a', labels).map((row) => `${row.depth}:${row.leafName}`)).toEqual(['0:INBOX', '0:Archive', '0:Work', '1:Clients', '2:Acme'])
    expect(mailFolderLeafName(labels[3], labels)).toBe('Acme')
    expect(mailFolderDescendants(labels[2], labels).map((label) => label.id)).toEqual(['folder:Work/Clients', 'folder:Work/Clients/Acme'])
  })

  it('validates names and finds sibling conflicts case-insensitively', () => {
    expect(mailFolderNameError('  ', 'gmail')).toBe('Enter a name')
    expect(mailFolderNameError('A/B', 'gmail')).toMatch('parent setting')
    expect(mailFolderNameError('A.B', 'imap', '.')).toMatch('separator')
    expect(mailFolderNameError('Big*', 'imap')).toMatch('* or %')
    expect(mailFolderNameError('inbox', 'microsoft')).toMatch('reserved')
    expect(mailFolderNameError('x'.repeat(226), 'gmail')).toMatch('225')
    expect(mailFolderNameError('Receipts', 'gmail')).toBeUndefined()
    expect(mailFolderNameConflict('a', 'clients', 'folder:Work', labels)?.id).toBe('folder:Work/Clients')
    expect(mailFolderNameConflict('a', 'clients', 'folder:Work', labels, 'folder:Work/Clients')).toBeUndefined()
    expect(mailFolderNameConflict('a', 'Clients', undefined, labels)).toBeUndefined()
  })

  it('recognizes system folders and Gmail palette colors', () => {
    expect(isSystemMailFolder(labels[0])).toBe(true)
    expect(isSystemMailFolder({ id: 'INBOX', type: 'user' })).toBe(true)
    expect(isSystemMailFolder(labels[2])).toBe(false)
    expect(gmailLabelColor('#4A86E8')?.textColor).toBe('#ffffff')
    expect(gmailLabelColor('#123456')).toBeUndefined()
  })
})
