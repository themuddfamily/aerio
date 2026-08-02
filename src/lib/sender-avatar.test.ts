import { describe, expect, it } from 'vitest'
import { senderDomainFromEmail, senderFaviconUrl } from './sender-avatar'

describe('sender avatars', () => {
  it('extracts normalized public domains from sender addresses', () => {
    expect(senderDomainFromEmail('Aerio Team <hello@News.Example.com>')).toBe('news.example.com')
    expect(senderFaviconUrl('hello@example.com')).toBe('aerio-image://favicon/example.com')
  })

  it('does not create remote requests for malformed, local, or IP domains', () => {
    for (const email of ['missing-address', 'a@localhost', 'a@service.local', 'a@127.0.0.1', 'a@-broken.example.com']) {
      expect(senderFaviconUrl(email)).toBeUndefined()
    }
  })
})
