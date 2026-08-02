import { describe, expect, it } from 'vitest'
import { faviconDomainCandidates } from './favicon-domains'

describe('sender favicon domain candidates', () => {
  it('falls back from an email subdomain to the company domain', () => {
    expect(faviconDomainCandidates('email.halfords.com')).toEqual(['email.halfords.com', 'halfords.com'])
  })

  it('respects multi-label public suffixes', () => {
    expect(faviconDomainCandidates('newsletter.halfords.co.uk')).toEqual(['newsletter.halfords.co.uk', 'halfords.co.uk'])
  })

  it('does not duplicate an already registrable domain', () => {
    expect(faviconDomainCandidates('halfords.com')).toEqual(['halfords.com'])
  })

  it('respects private suffixes used by hosted senders', () => {
    expect(faviconDomainCandidates('messages.customer.github.io')).toEqual(['messages.customer.github.io', 'customer.github.io'])
  })
})
