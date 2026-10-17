import { describe, expect, it } from 'vitest'
import { attachmentSearchStatus } from './mail-attachment-text'

describe('attachmentSearchStatus', () => {
  it('only raises a notice for searchable-looking files that could not be indexed', () => {
    expect(attachmentSearchStatus(undefined)).toBeUndefined()
    expect(attachmentSearchStatus({ status: 'pending' })).toEqual({ label: 'Contents will be searchable after indexing' })
    expect(attachmentSearchStatus({ status: 'indexed' })).toEqual({ label: 'Contents are searchable' })
    expect(attachmentSearchStatus({ status: 'indexed', truncated: true })?.notice).toBe('Partly searchable')
    expect(attachmentSearchStatus({ status: 'unsupported' })?.notice).toBeUndefined()
    expect(attachmentSearchStatus({ status: 'empty', detail: 'No text was found' })).toEqual({ label: 'No text was found' })
    expect(attachmentSearchStatus({ status: 'encrypted' })?.notice).toBe('Password-protected')
    expect(attachmentSearchStatus({ status: 'too-large' })?.notice).toBe('Too large to search')
    expect(attachmentSearchStatus({ status: 'timeout', detail: 'Reading the attachment took too long' })).toEqual({
      label: 'Contents could not be read for search: Reading the attachment took too long', notice: 'Not searchable'
    })
    expect(attachmentSearchStatus({ status: 'memory-limit' })?.notice).toBe('Not searchable')
  })
})
