import type { SmimeCertificateSummary, SmimeChainStatus, SmimeSignatureResult } from '../smime-types'
import type { SignatureTone } from './openpgp-display'

export { friendlyOpenPgpError as friendlySmimeError } from './openpgp-display'

/** SHA-256 fingerprints are long; show them in colon-separated pairs, shortened unless asked for in full. */
export const formatCertificateFingerprint = (value: string, full = false) => {
  const pairs = value.toUpperCase().match(/.{2}/g) ?? []
  return (full ? pairs : pairs.slice(0, 8)).join(':') + (full || pairs.length <= 8 ? '' : '…')
}

export const certificateName = (cert: Pick<SmimeCertificateSummary, 'commonName' | 'emails' | 'subject'>) => cert.commonName ?? cert.emails[0] ?? cert.subject

export function chainStatusLabel(status: SmimeChainStatus, trusted = false) {
  if (trusted) return 'Trusted by you'
  switch (status) {
    case 'trusted': return 'Chain trusted'
    case 'untrusted-root': return 'Root not trusted'
    case 'incomplete': return 'Issuer unknown'
    default: return 'Chain invalid'
  }
}

export function certificateStatusLabel(cert: Pick<SmimeCertificateSummary, 'expired' | 'notYetValid' | 'isCa' | 'hasPrivateKey' | 'canEncrypt' | 'canSign'>) {
  if (cert.expired) return 'Expired'
  if (cert.notYetValid) return 'Not yet valid'
  if (cert.isCa) return 'Certificate authority'
  if (cert.hasPrivateKey) return 'Your certificate'
  return cert.canEncrypt ? 'Recipient certificate' : 'Not usable for encryption'
}

/** One plain-language line per S/MIME signature. Revocation is never checked, so a valid result says so. */
export function smimeSignatureSummary(result: SmimeSignatureResult): { tone: SignatureTone; text: string } {
  const who = result.signer ? certificateName(result.signer) : 'an unknown signer'
  switch (result.status) {
    case 'valid':
      return { tone: 'good', text: `Valid S/MIME signature from ${who}${result.signer?.emails.length ? ` (${result.signer.emails.join(', ')})` : ''}. Revocation was not checked.${result.harvested ? ' The certificate was saved so you can send encrypted replies.' : ''}` }
    case 'untrusted':
      return { tone: 'warning', text: `Signed by ${who}, but the certificate is not trusted. ${result.detail ?? ''}`.trim() }
    case 'email-mismatch':
      return { tone: 'warning', text: `Signed by ${who}, but the certificate does not belong to the sender’s address. ${result.detail ?? ''}`.trim() }
    case 'expired-certificate':
      return { tone: 'warning', text: `Signed by ${who} with a certificate that is not valid now. ${result.detail ?? ''}`.trim() }
    case 'unknown-certificate':
      return { tone: 'warning', text: 'The signer’s certificate was not included, so the signature cannot be checked.' }
    case 'unsupported':
      return { tone: 'warning', text: `The signature from ${who} could not be checked. ${result.detail ?? ''}`.trim() }
    default:
      return { tone: 'bad', text: `The signature from ${who} is not valid. The message may have been changed after it was signed.` }
  }
}
