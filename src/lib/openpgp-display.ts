import type { OpenPgpKeySummary, OpenPgpSignatureResult } from '../openpgp-types'

/** Groups a fingerprint in blocks of four for reading aloud and comparing. */
export const formatFingerprint = (value: string) => value.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')

export const friendlyOpenPgpError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback : fallback

export type SignatureTone = 'good' | 'warning' | 'bad'

/** One plain-language line per signature; manual verification is shown separately from cryptographic validity. */
export function signatureSummary(result: OpenPgpSignatureResult): { tone: SignatureTone; text: string } {
  const who = result.userIds?.[0] ?? `key ${result.keyId}`
  const verified = result.verification === 'verified'
  switch (result.status) {
    case 'valid':
      return verified
        ? { tone: 'good', text: `Valid signature from ${who}. You verified this key’s fingerprint.` }
        : { tone: 'warning', text: `Valid signature from ${who}, but you have not verified this key’s fingerprint.` }
    case 'unknown-key':
      return { tone: 'warning', text: `Signed with key ${result.keyId}, which is not in your keyring. Import the sender’s public key to check it.` }
    case 'expired-key':
      return { tone: 'warning', text: `Signed by ${who} with a key that has expired.${result.detail ? ` ${result.detail}.` : ''}` }
    case 'revoked-key':
      return { tone: 'bad', text: `Signed by ${who} with a key that has been revoked. Do not trust this signature.` }
    default:
      return { tone: 'bad', text: `The signature from ${who} is not valid. The message may have been changed after it was signed.` }
  }
}

export function keyStatusLabel(key: Pick<OpenPgpKeySummary, 'revoked' | 'expired' | 'canEncrypt' | 'hasPrivateKey' | 'canSign'>) {
  if (key.revoked) return 'Revoked'
  if (key.expired) return 'Expired'
  if (!key.canEncrypt && !(key.hasPrivateKey && key.canSign)) return 'Unusable'
  return key.hasPrivateKey ? 'Your key' : 'Public key'
}
