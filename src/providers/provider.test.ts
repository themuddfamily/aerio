import { describe, expect, it } from 'vitest'
import { capabilitiesFor, capableProviders } from './provider'

describe('provider capabilities', () => {
  it('exposes Calendar and Contacts through the existing Google and Microsoft connections', () => {
    expect(capabilitiesFor('gmail').modules.calendar).toMatchObject({ transport: 'remote', status: 'ready', read: true, write: true })
    expect(capabilitiesFor('microsoft').modules.calendar).toMatchObject({ transport: 'remote', status: 'ready', read: true, write: false })
    for (const provider of ['gmail', 'microsoft'] as const) {
      expect(capabilitiesFor(provider).modules.contacts).toMatchObject({ transport: 'remote', status: 'ready', read: true, write: false })
    }
  })

  it('does not pretend that an IMAP mail connection includes unrelated provider APIs', () => {
    expect(capabilitiesFor('imap').modules.mail).toMatchObject({ transport: 'remote', status: 'ready' })
    expect(capabilitiesFor('imap').modules.calendar).toMatchObject({ transport: 'none', status: 'unavailable' })
    expect(capabilitiesFor('imap').modules.contacts).toMatchObject({ transport: 'none', status: 'unavailable' })
    expect(capabilitiesFor('imap').modules.chat).toMatchObject({ transport: 'none', status: 'unavailable' })
    expect(capableProviders('chat', ['gmail', 'microsoft'])).toEqual([])
  })
})
