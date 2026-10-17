import type { MailRemoteContentReport, MailTrackingReason } from '../../src/mail-types'

// Classification is purely lexical: it inspects the markup and URL text only
// and never resolves, connects to, or fetches the remote resource.

// Hosts whose images exist to report opens. Kept deliberately conservative so
// ordinary newsletter artwork is still governed by the user's image choice.
const knownTrackerHosts = [
  'bat.bing.com',
  'bananatag.com',
  'doubleclick.net',
  'emltrk.com',
  'getnotify.com',
  'google-analytics.com',
  'mailfoogae.appspot.com',
  'mailtrack.io',
  'mandrillapp.com',
  'mixpanel.com',
  'pixel.mathtag.com',
  'returnpath.net',
  'sendgrid.net',
  'list-manage.com',
  'track.hubspot.com',
  't.yesware.com',
  'mailstat.us',
  'pstmrk.it'
]

const trackingPathPatterns = [
  /\/wf\/open(?:[/?]|$)/i,
  /\/track(?:ing)?\/open/i,
  /\/open\.(?:gif|png|php|aspx?)(?:[/?]|$)/i,
  /\/(?:open|email)[-_]?(?:pixel|beacon)/i,
  /\/(?:pixel|beacon|tracking[-_]?pixel)\.(?:gif|png)(?:[/?]|$)/i,
  /\/(?:o|e\/o|e\/open)\.gif(?:[/?]|$)/i,
  /\/(?:pixel|beacon|trk|track)\/?(?:\?|$)/i
]

export interface TrackingClassification {
  tracker: boolean
  host: string
  reasons: MailTrackingReason[]
}

export interface TrackingCandidate {
  src: string
  width?: number
  height?: number
  style?: string
}

const hostMatches = (host: string, candidate: string) => host === candidate || host.endsWith(`.${candidate}`)

function parseRemote(src: string) {
  try {
    const url = new URL(src)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Reasons a URL alone suggests open tracking. Used for markup and redirect hops. */
export function trackingUrlReasons(src: string): MailTrackingReason[] {
  const url = parseRemote(src)
  if (!url) return []
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const reasons: MailTrackingReason[] = []
  if (knownTrackerHosts.some((candidate) => hostMatches(host, candidate))) reasons.push('known-tracker-host')
  if (trackingPathPatterns.some((pattern) => pattern.test(`${url.pathname}${url.search}`))) reasons.push('tracking-path')
  return reasons
}

export function isHiddenStyle(style: string | undefined) {
  if (!style) return false
  const declarations = new Map<string, string>()
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) continue
    declarations.set(declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).replace(/!important/i, '').trim().toLowerCase())
  }
  const tiny = (value: string | undefined) => value !== undefined && /^(?:0|[01](?:\.\d+)?px)$/.test(value)
  return declarations.get('display') === 'none' ||
    declarations.get('visibility') === 'hidden' ||
    /^0(?:\.0+)?$/.test(declarations.get('opacity') ?? '') ||
    tiny(declarations.get('width')) || tiny(declarations.get('height')) ||
    tiny(declarations.get('max-width')) || tiny(declarations.get('max-height'))
}

const tinyDimensions = (width?: number, height?: number) =>
  width !== undefined && height !== undefined
    ? width <= 4 && height <= 4
    : (width ?? height) !== undefined && (width ?? height)! <= 1

export function classifyTrackingImage(candidate: TrackingCandidate): TrackingClassification {
  const url = parseRemote(candidate.src)
  const reasons: MailTrackingReason[] = []
  if (url) {
    if (tinyDimensions(candidate.width, candidate.height)) reasons.push('tiny-dimensions')
    if (isHiddenStyle(candidate.style)) reasons.push('hidden-style')
    reasons.push(...trackingUrlReasons(candidate.src))
  }
  return { tracker: reasons.length > 0, host: url?.hostname.toLowerCase() ?? '', reasons }
}

/** Accumulates per-message findings, grouping trackers by host. */
export class RemoteContentRecorder {
  private remoteImages = 0
  private readonly trackers = new Map<string, { reasons: Set<MailTrackingReason>; count: number }>()

  recordImage(classification: TrackingClassification) {
    this.remoteImages += 1
    if (!classification.tracker) return
    const existing = this.trackers.get(classification.host) ?? { reasons: new Set<MailTrackingReason>(), count: 0 }
    classification.reasons.forEach((reason) => existing.reasons.add(reason))
    existing.count += 1
    this.trackers.set(classification.host, existing)
  }

  report(): MailRemoteContentReport {
    return {
      remoteImages: this.remoteImages,
      trackers: [...this.trackers.entries()].map(([host, finding]) => ({ host, reasons: [...finding.reasons], count: finding.count }))
    }
  }
}
