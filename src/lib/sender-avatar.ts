const blockedSuffixes = ['.internal', '.invalid', '.lan', '.local', '.localhost', '.test']

export function senderDomainFromEmail(value: string) {
  const address = value.trim().match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? value.trim()
  const separator = address.lastIndexOf('@')
  if (separator <= 0 || separator === address.length - 1) return undefined
  const rawDomain = address.slice(separator + 1).trim().replace(/\.$/, '')
  if (!rawDomain || rawDomain.length > 253) return undefined
  let domain: string
  try {
    const target = new URL(`https://${rawDomain}`)
    if (target.port || target.pathname !== '/' || target.search || target.hash) return undefined
    domain = target.hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (!domain.includes('.') || /^\d+(?:\.\d+){3}$/.test(domain) || domain.includes(':')) return undefined
  if (domain === 'localhost' || blockedSuffixes.some((suffix) => domain.endsWith(suffix))) return undefined
  if (!domain.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) return undefined
  return domain
}

export function senderFaviconUrl(email: string) {
  const domain = senderDomainFromEmail(email)
  return domain ? `aerio-image://favicon/${encodeURIComponent(domain)}` : undefined
}
