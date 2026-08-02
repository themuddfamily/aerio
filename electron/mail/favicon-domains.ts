import { getDomain } from 'tldts'

export function faviconDomainCandidates(hostname: string) {
  const registrableDomain = getDomain(hostname, { allowPrivateDomains: true })
  return [...new Set([hostname, registrableDomain].filter((value): value is string => Boolean(value)))]
}
