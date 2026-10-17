import { trackingUrlReasons } from './tracking-protection'

export interface RemoteImageFetchDependencies {
  lookup(hostname: string): Promise<Array<{ address: string }>>
  isPrivateAddress(address: string): boolean
  fetch(url: string, init: RequestInit): Promise<Response>
}

const MAX_REDIRECTS = 5
const blocked = () => new Response('Blocked', { status: 403 })

async function destinationAllowed(target: URL, dependencies: RemoteImageFetchDependencies) {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false
  if (target.username || target.password) return false
  const hostname = target.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false
  const addresses = await dependencies.lookup(target.hostname)
  return addresses.length > 0 && !addresses.some((address) => dependencies.isPrivateAddress(address.address))
}

/**
 * Fetches a user-approved message image. Redirects are followed manually so
 * every hop is re-validated: a hop to a private network address or to a
 * suspected tracker is refused instead of silently followed.
 */
export async function fetchRemoteImage(remote: string, dependencies: RemoteImageFetchDependencies) {
  let target = new URL(remote)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!await destinationAllowed(target, dependencies)) return blocked()
    // The first hop was already classified when the message was sanitized;
    // later hops are only known now, so classify them before connecting.
    if (hop > 0 && trackingUrlReasons(target.toString()).length) return blocked()
    const response = await dependencies.fetch(target.toString(), {
      credentials: 'omit',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Aerio mail image proxy',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*'
      }
    })
    if (response.type === 'opaqueredirect') return blocked()
    if (response.status < 300 || response.status >= 400 || response.status === 304) return response
    const location = response.headers.get('location')
    if (!location) return blocked()
    target = new URL(location, target)
  }
  return blocked()
}
