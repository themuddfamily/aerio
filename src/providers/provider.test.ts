import { describe, expect, it } from 'vitest'
import { capabilitiesFor, capableProviders } from './provider'

describe('provider capabilities', () => {
  it('exposes Calendar and Contacts through the existing Google and Microsoft connections', () => {
    for (const provider of ['gmail', 'microsoft'] as const) {
      expect(capabilitiesFor(provider).modules.calendar).toMatchObject({ transport: 'remote', status: 'ready', read: true, write: false })
      expect(capabilitiesFor(provider).modules.contacts).toMatchObject({ transport: 'remote', status: 'ready', read: true, write: false })
    }
  })

  it('does not pretend that an IMAP mail connection includes unrelated provider APIs', () => {
    expect(capabilitiesFor('imap').modules.mail).toMatchObject({ transport: 'remote', status: 'ready' })
    expect(capabilitiesFor('imap').modules.calendar).toMatchObject({ transport: 'local', status: 'ready' })
    expect(capableProviders('chat', ['gmail', 'microsoft'])).toEqual([])
  })
})
