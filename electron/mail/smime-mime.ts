import { canonicalizeLineEndings, headerValue, parseContentType, parseEntity, splitMultipart } from './openpgp-mime'

// MIME plumbing for S/MIME (RFC 8551). Pure string handling: the crypto lives
// in smime-cms.ts. The generic multipart helpers are shared with PGP/MIME.

const CRLF = '\r\n'
const boundary = () => `aerio-smime-${crypto.randomUUID()}`
const base64Lines = (data: Uint8Array) => Buffer.from(data).toString('base64').replace(/.{76}/g, `$&${CRLF}`)

export interface SmimeEntity {
  headers: string[]
  body: string
}

/** multipart/signed with a detached application/pkcs7-signature part (RFC 8551 section 3.5.3). */
export function buildSignedEntity(inner: string, signature: Uint8Array): SmimeEntity {
  const outer = boundary()
  const body = [
    'This is a cryptographically signed message in MIME format.',
    '',
    `--${outer}`, inner, `--${outer}`,
    'Content-Type: application/pkcs7-signature; name="smime.p7s"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7s"',
    'Content-Description: S/MIME Cryptographic Signature',
    '', base64Lines(signature), `--${outer}--`, ''
  ].join(CRLF)
  return { headers: [`Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${outer}"`], body }
}

/** application/pkcs7-mime enveloped-data (RFC 8551 section 3.3). */
export function buildEnvelopedEntity(envelope: Uint8Array): SmimeEntity {
  return {
    headers: [
      'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="smime.p7m"',
      'Content-Description: S/MIME Encrypted Message'
    ],
    body: `${base64Lines(envelope)}${CRLF}`
  }
}

export const entityText = (entity: SmimeEntity) => entity.headers.join(CRLF) + CRLF + CRLF + entity.body

export function assembleSmimeMessage(outer: string[], entity: SmimeEntity) {
  return [...outer, 'MIME-Version: 1.0', ...entity.headers].join(CRLF) + CRLF + CRLF + entity.body
}

export type SmimeStructure =
  | { kind: 'signed'; signedPart: string; signature: Buffer }
  | { kind: 'pkcs7'; der: Buffer; smimeType?: string }
  | { kind: 'none' }

const SIGNATURE_TYPES = /^application\/(?:x-)?pkcs7-signature$/
const MIME_TYPES = /^application\/(?:x-)?pkcs7-mime$/

function decodedBody(raw: string) {
  const entity = parseEntity(raw)
  const encoding = headerValue(entity, 'content-transfer-encoding')?.toLowerCase()
  if (encoding && encoding !== 'base64') throw new Error('The S/MIME part is not base64 encoded')
  return Buffer.from(entity.body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
}

/** Recognizes S/MIME at the top level of an entity: detached multipart/signed, or application/pkcs7-mime. */
export function detectSmime(raw: string): SmimeStructure {
  const entity = parseEntity(raw)
  const type = parseContentType(headerValue(entity, 'content-type'))
  if (type.type === 'multipart/signed' && type.params.boundary && SIGNATURE_TYPES.test(type.params.protocol?.toLowerCase() ?? '')) {
    const parts = splitMultipart(entity.body, type.params.boundary)
    if (parts.length < 2) return { kind: 'none' }
    return { kind: 'signed', signedPart: canonicalizeLineEndings(parts[0]), signature: decodedBody(parts[1]) }
  }
  const filename = type.params.name ?? ''
  if (MIME_TYPES.test(type.type) || type.type === 'application/octet-stream' && /\.p7m$/i.test(filename)) {
    return { kind: 'pkcs7', der: decodedBody(raw), smimeType: type.params['smime-type']?.toLowerCase() }
  }
  return { kind: 'none' }
}
