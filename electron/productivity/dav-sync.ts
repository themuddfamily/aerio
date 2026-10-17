import type { DavCollectionKind } from '../../src/dav-types'
import { DavClient, DavHttpError, resolveHref, sameCollection } from './dav-client'
import {
  CALDAV_NS, CALENDARSERVER_NS, CARDDAV_NS, DAV_NS, multigetBody, propfindBody, propText, syncCollectionBody,
  type DavResponse
} from './dav-xml'

export const MULTIGET_BATCH = 100
const MAX_SYNC_ROUNDS = 50

export interface SyncTarget {
  url: string
  kind: DavCollectionKind
  ctag?: string
  syncToken?: string
  supportsSyncCollection: boolean
}

export interface FetchedResource {
  href: string
  etag?: string
  data: string
}

export interface CollectionChanges {
  changed: FetchedResource[]
  removed: string[]
  // A full listing: any locally known href that was not listed is gone from the server.
  complete: boolean
  ctag?: string
  syncToken?: string
  mode: 'sync-collection' | 'ctag'
  unchanged?: boolean
}

const normalizeEtag = (value: string | null | undefined) => value?.trim() || undefined
const contentType = (kind: DavCollectionKind) => kind === 'calendar' ? /text\/calendar/i : /text\/(x-)?vcard/i
const dataProp = (kind: DavCollectionKind): [string, string] => kind === 'calendar' ? [CALDAV_NS, 'calendar-data'] : [CARDDAV_NS, 'address-data']
const isMember = (response: DavResponse, collectionUrl: string, base: string) => {
  const href = resolveHref(response.href, base)
  // Members are always inside the collection; anything else in a listing is ignored.
  if (sameCollection(href, collectionUrl) || !href.startsWith(collectionUrl.endsWith('/') ? collectionUrl : `${collectionUrl}/`)) return false
  // Sub-collections (and the occasional trailing-slash member) are not calendar objects.
  const type = response.props.get(`{${DAV_NS}}resourcetype`)
  return !(type && type.children.some((child) => child.ns === DAV_NS && child.name === 'collection'))
}

const syncTokenInvalid = (error: unknown) => error instanceof DavHttpError && (
  error.status === 403 || error.status === 409 || error.status === 410 || error.status === 400 || /valid-sync-token/.test(error.body)
)

/** Fetches resource bodies with calendar-multiget / addressbook-multiget, falling back to GET per resource. */
export async function fetchResources(client: DavClient, target: SyncTarget, hrefs: string[]): Promise<FetchedResource[]> {
  const fetched: FetchedResource[] = []
  const [ns, name] = dataProp(target.kind)
  for (let index = 0; index < hrefs.length; index += MULTIGET_BATCH) {
    const batch = hrefs.slice(index, index + MULTIGET_BATCH)
    try {
      const result = await client.multistatus('REPORT', target.url, multigetBody(target.kind, batch.map((href) => new URL(href).pathname)), '1')
      const seen = new Set<string>()
      for (const response of result.responses) {
        const href = resolveHref(response.href, result.url)
        const data = propText(response, ns, name)
        if (!data) continue
        seen.add(href)
        fetched.push({ href, data, ...(normalizeEtag(propText(response, DAV_NS, 'getetag')) ? { etag: normalizeEtag(propText(response, DAV_NS, 'getetag')) } : {}) })
      }
      // Members the multiget skipped (404 or omitted data) are fetched individually below.
      batch.splice(0, batch.length, ...batch.filter((href) => !seen.has(href)))
    } catch (error) {
      // Servers without multiget support fall back to one GET per resource.
      if (!(error instanceof DavHttpError) || error.status === 401) throw error
    }
    for (const href of batch) {
      const response = await client.request('GET', href, { headers: { Accept: target.kind === 'calendar' ? 'text/calendar' : 'text/vcard' } })
      if (response.status === 404 || response.status === 410) continue
      if (response.status < 200 || response.status >= 300) throw new DavHttpError(`The server responded with ${response.status} while reading an item`, response.status)
      fetched.push({ href, data: response.text, ...(normalizeEtag(response.headers.get('etag')) ? { etag: normalizeEtag(response.headers.get('etag')) } : {}) })
    }
  }
  return fetched
}

// RFC 6578 sync-collection. A token the server no longer honours restarts from an empty token.
async function syncCollectionReport(client: DavClient, target: SyncTarget, local: Map<string, string | undefined>) {
  let token = target.syncToken
  let complete = !token
  const changedEtags = new Map<string, string | undefined>()
  const removed = new Set<string>()
  for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
    let result
    try {
      result = await client.multistatus('REPORT', target.url, syncCollectionBody(token, [[DAV_NS, 'getetag'], [DAV_NS, 'getcontenttype'], [DAV_NS, 'resourcetype']]), '0')
    } catch (error) {
      if (token && syncTokenInvalid(error)) {
        token = undefined
        complete = true
        changedEtags.clear()
        removed.clear()
        continue
      }
      throw error
    }
    let truncated = false
    for (const response of result.responses) {
      const href = resolveHref(response.href, result.url)
      if (sameCollection(href, target.url)) {
        if (response.status === 507) truncated = true
        continue
      }
      if (response.status === 404 || response.status === 410) {
        removed.add(href)
        changedEtags.delete(href)
        continue
      }
      if (!isMember(response, target.url, result.url)) continue
      const type = propText(response, DAV_NS, 'getcontenttype')
      if (type && !contentType(target.kind).test(type)) continue
      removed.delete(href)
      changedEtags.set(href, normalizeEtag(propText(response, DAV_NS, 'getetag')))
    }
    const nextToken = result.syncToken
    if (!truncated || !nextToken || nextToken === token) {
      token = nextToken ?? token
      const changed = [...changedEtags].filter(([href, etag]) => !etag || local.get(href) !== etag).map(([href]) => href)
      return { changed, removed: [...removed], complete, listed: new Set(changedEtags.keys()), syncToken: token }
    }
    token = nextToken
  }
  throw new Error('The server kept truncating its change list; try synchronizing again later')
}

// Fallback for servers without sync-collection: compare the collection ctag, then list every
// member's ETag and diff against the local copy.
async function ctagDiff(client: DavClient, target: SyncTarget, local: Map<string, string | undefined>) {
  const head = await client.multistatus('PROPFIND', target.url, propfindBody([[CALENDARSERVER_NS, 'getctag'], [DAV_NS, 'sync-token']]), '0')
  const ctag = head.responses[0] ? propText(head.responses[0], CALENDARSERVER_NS, 'getctag') : undefined
  if (ctag && target.ctag && ctag === target.ctag) return { unchanged: true as const, ctag }
  const listing = await client.multistatus('PROPFIND', target.url, propfindBody([[DAV_NS, 'getetag'], [DAV_NS, 'getcontenttype'], [DAV_NS, 'resourcetype']]), '1')
  const listed = new Map<string, string | undefined>()
  for (const response of listing.responses) {
    if (!isMember(response, target.url, listing.url) || (response.status && response.status >= 400)) continue
    const type = propText(response, DAV_NS, 'getcontenttype')
    if (type && !contentType(target.kind).test(type)) continue
    listed.set(resolveHref(response.href, listing.url), normalizeEtag(propText(response, DAV_NS, 'getetag')))
  }
  const changed = [...listed].filter(([href, etag]) => !etag || local.get(href) !== etag).map(([href]) => href)
  const removed = [...local.keys()].filter((href) => !listed.has(href))
  return { unchanged: false as const, ctag, changed, removed }
}

/**
 * Pulls server changes for one collection. `local` maps known hrefs to their last-seen ETag.
 * Uses sync-collection when advertised and falls back to ctag + ETag comparison when the
 * server does not support it (or rejects the report).
 */
export async function pullCollection(client: DavClient, target: SyncTarget, local: Map<string, string | undefined>): Promise<CollectionChanges> {
  if (target.supportsSyncCollection) {
    try {
      const result = await syncCollectionReport(client, target, local)
      const removed = result.complete
        ? [...new Set([...result.removed, ...[...local.keys()].filter((href) => !result.listed.has(href))])]
        : result.removed
      const changed = await fetchResources(client, target, result.changed)
      return { changed, removed, complete: result.complete, mode: 'sync-collection', ...(result.syncToken ? { syncToken: result.syncToken } : {}) }
    } catch (error) {
      // 501/405/403 on an empty token: the report is not really available. Use the ctag path.
      if (!(error instanceof DavHttpError) || error.status === 401 || error.status === 404) throw error
    }
  }
  const diff = await ctagDiff(client, target, local)
  if (diff.unchanged) return { changed: [], removed: [], complete: false, mode: 'ctag', unchanged: true, ...(diff.ctag ? { ctag: diff.ctag } : {}) }
  const changed = await fetchResources(client, target, diff.changed)
  return { changed, removed: diff.removed, complete: true, mode: 'ctag', ...(diff.ctag ? { ctag: diff.ctag } : {}) }
}
