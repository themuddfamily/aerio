import { ShieldCheck } from 'lucide-react'
import type { MailRemoteContentReport } from '../mail-types'
import { describeTrackingReasons } from '../lib/tracking-reasons'

interface TrackingProtectionNoticeProps {
  report?: MailRemoteContentReport
  remoteImagesPermitted: boolean
}

export default function TrackingProtectionNotice({ report, remoteImagesPermitted }: TrackingProtectionNoticeProps) {
  const trackers = report?.trackers ?? []
  if (!trackers.length) return null
  const total = trackers.reduce((sum, finding) => sum + finding.count, 0)
  const summary = `${total.toLocaleString()} suspected tracking image${total === 1 ? '' : 's'}`

  return (
    <details className="tracking-protection-notice">
      <summary>
        <ShieldCheck size={15} aria-hidden="true" />
        <span>{remoteImagesPermitted
          ? `${summary} stayed blocked while other remote images loaded.`
          : `${summary} will stay blocked even if you load remote images.`}</span>
      </summary>
      <p>Tracking images report when and where you open a message. Aerio identifies them from the message itself, without contacting the sender.</p>
      <ul>
        {trackers.map((finding) => <li key={finding.host}>
          <strong>{finding.host}</strong>
          {finding.count > 1 ? ` (${finding.count.toLocaleString()} images)` : ''}: blocked because {describeTrackingReasons(finding.reasons)}.
        </li>)}
      </ul>
    </details>
  )
}
