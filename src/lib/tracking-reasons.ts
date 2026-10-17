import type { MailTrackingReason } from '../mail-types'

export const trackingReasonLabels: Record<MailTrackingReason, string> = {
  'tiny-dimensions': 'it is sized as an invisible pixel',
  'hidden-style': 'it is styled to be hidden',
  'known-tracker-host': 'it is served by a known email tracking service',
  'tracking-path': 'its address looks like an open-tracking link'
}

export function describeTrackingReasons(reasons: readonly MailTrackingReason[]) {
  const labels = reasons.map((reason) => trackingReasonLabels[reason])
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
