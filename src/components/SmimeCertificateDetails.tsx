import type { SmimeCertificateSummary } from '../smime-types'
import { certificateName, chainStatusLabel, formatCertificateFingerprint } from '../lib/smime-display'

const date = (value: string) => new Date(value).toLocaleDateString()
const yesNo = (value: boolean | undefined) => value === undefined ? 'not restricted' : value ? 'yes' : 'no'

/** Expandable certificate facts: issuer chain, validity, key usage, email addresses, and revocation status. */
export default function SmimeCertificateDetails({ cert, summaryLabel = 'Certificate details' }: { cert: SmimeCertificateSummary; summaryLabel?: string }) {
  return (
    <details className="smime-certificate-details">
      <summary>{summaryLabel}</summary>
      <dl>
        <dt>Subject</dt><dd>{cert.subject}</dd>
        <dt>Email</dt><dd>{cert.emails.join(', ') || 'none'}</dd>
        <dt>Issuer</dt><dd>{cert.issuer}</dd>
        <dt>Valid</dt><dd>{date(cert.validFrom)} – {date(cert.validTo)}{cert.expired ? ' (expired)' : cert.notYetValid ? ' (not yet valid)' : ''}</dd>
        <dt>Key</dt><dd>{cert.algorithm} · serial {cert.serialNumber}</dd>
        <dt>Key usage</dt><dd>signing {yesNo(cert.keyUsage.digitalSignature ?? cert.keyUsage.nonRepudiation)}, encryption {yesNo(cert.keyUsage.keyEncipherment)}, email protection {cert.keyUsage.emailProtection ? 'yes' : 'no'}</dd>
        <dt>Chain</dt><dd>{chainStatusLabel(cert.chainStatus, cert.trusted)}
          <ol className="smime-chain">{cert.chain.map((entry) => <li key={entry.fingerprint}>{entry.subject}{entry.trustAnchor ? ' (trust anchor)' : ''}{entry.expired ? ' (expired)' : ''} <small>until {date(entry.validTo)}</small></li>)}</ol>
        </dd>
        <dt>Revocation</dt><dd>Not checked (Aerio does not query CRLs or OCSP)</dd>
        <dt>SHA-256</dt><dd><code aria-label={`Fingerprint of ${certificateName(cert)}`}>{formatCertificateFingerprint(cert.fingerprint, true)}</code></dd>
      </dl>
    </details>
  )
}
