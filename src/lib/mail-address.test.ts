import { describe, expect, it } from 'vitest'
import { draftRecipientsAreSyncable, isCompleteMailAddress } from './mail-address'

describe('mail addresses', () => {
  it('accepts complete bare and named addresses', () => {
    expect(isCompleteMailAddress('alex@example.com')).toBe(true)
    expect(isCompleteMailAddress('Alex Avery <alex@example.com>')).toBe(true)
  })

  it('keeps partially typed addresses out of provider sync', () => {
    expect(isCompleteMailAddress('alex@')).toBe(false)
    expect(isCompleteMailAddress('Alex')).toBe(false)
    expect(draftRecipientsAreSyncable(['alex@'], [], [])).toBe(false)
  })

  it('allows a recipient-free draft to sync', () => {
    expect(draftRecipientsAreSyncable([], [], [])).toBe(true)
  })

  it('rejects non-string and overlong address values', () => {
    expect(isCompleteMailAddress(undefined)).toBe(false)
    expect(isCompleteMailAddress(`${'a'.repeat(490)}@example.com`)).toBe(false)
  })

  it('rejects whitespace, missing domains, and multiple-address strings', () => {
    expect(isCompleteMailAddress('alex @example.com')).toBe(false)
    expect(isCompleteMailAddress('alex@example')).toBe(false)
    expect(isCompleteMailAddress('alex@example.com, sam@example.com')).toBe(false)
  })

  it('rejects incomplete named-address syntax', () => {
    expect(isCompleteMailAddress('Alex Avery <alex@example.com')).toBe(false)
    expect(isCompleteMailAddress('Alex Avery <>')).toBe(false)
  })

  it('blocks provider sync when any recipient field is incomplete', () => {
    expect(draftRecipientsAreSyncable(['valid@example.com'], ['copy@example.com'], ['hidden@'])).toBe(false)
    expect(draftRecipientsAreSyncable(['valid@example.com'], ['copy@example.com'], ['hidden@example.com'])).toBe(true)
  })
})
