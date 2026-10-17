// MIME plumbing for PGP/MIME (RFC 3156). Pure string handling only: the
// crypto lives in openpgp-keyring.ts. Messages are UTF-8 strings; splitting
// keeps every character of a part so signatures cover exactly what was sent.

export interface MimeEntity {
  /** Unfolded header lines, in order. */
  headers: string[]
  body: string
}

const CRLF = '\r\n'

/** Converts bare LF or CR line endings to CRLF, the canonical form signatures cover. */
export const canonicalizeLineEndings = (value: string) => value.replace(/\r\n|\r|\n/g, CRLF)

export function parseEntity(raw: string): MimeEntity {
  const match = /\r?\n\r?\n/.exec(raw)
  const head = match ? raw.slice(0, match.index) : raw
  const body = match ? raw.slice(match.index + match[0].length) : ''
  const headers: string[] = []
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1] += ` ${line.trim()}`
    else if (line) headers.push(line)
  }
  return { headers, body }
}

export function headerValue(entity: MimeEntity, name: string) {
  const prefix = `${name.toLowerCase()}:`
  const line = entity.headers.find((item) => item.toLowerCase().startsWith(prefix))
  return line?.slice(prefix.length).trim()
}

export interface ContentType {
  type: string
  params: Record<string, string>
}

export function parseContentType(value: string | undefined): ContentType {
  if (!value) return { type: 'text/plain', params: {} }
  const [type, ...rest] = value.split(';')
  const params: Record<string, string> = {}
  for (const match of rest.join(';').matchAll(/([\w.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g)) {
    params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1')
  }
  return { type: type.trim().toLowerCase(), params }
}

/**
 * Splits a multipart body into its raw parts, byte-for-byte. Per RFC 2046 the
 * CRLF before each delimiter belongs to the delimiter, not to the part.
 */
export function splitMultipart(body: string, boundary: string) {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g')
  const parts: string[] = []
  let start = -1
  for (const match of body.matchAll(delimiter)) {
    if (start >= 0) parts.push(body.slice(start, match.index))
    if (match[1]) return parts
    const after = match.index + match[0].length
    start = body.startsWith(CRLF, after) ? after + 2 : body.startsWith('\n', after) ? after + 1 : after
  }
  return parts
}

/**
 * Re-encodes 8bit leaf parts as base64 so the entity is 7-bit clean (RFC 3156
 * section 3): a relay converting 8bit text would otherwise break a signature.
 */
export function sevenBitEntity(raw: string): string {
  const entity = parseEntity(raw)
  const type = parseContentType(headerValue(entity, 'content-type'))
  const head = (headers: string[]) => headers.join(CRLF) + CRLF + CRLF
  if (type.type.startsWith('multipart/') && type.params.boundary) {
    const parts = splitMultipart(entity.body, type.params.boundary)
    return head(entity.headers) + parts.map((part) => `--${type.params.boundary}${CRLF}${sevenBitEntity(part)}`).join(CRLF) + `${CRLF}--${type.params.boundary}--${CRLF}`
  }
  const encoding = headerValue(entity, 'content-transfer-encoding')?.toLowerCase()
  const sevenBitAlready = encoding === 'base64' || encoding === 'quoted-printable' || (!encoding || encoding === '7bit') && !/[^\x00-\x7f]/.test(entity.body)
  if (sevenBitAlready) return head(entity.headers) + entity.body
  const headers = [...entity.headers.filter((line) => !/^content-transfer-encoding:/i.test(line)), 'Content-Transfer-Encoding: base64']
  return head(headers) + Buffer.from(entity.body, 'utf8').toString('base64').replace(/.{76}/g, `$&${CRLF}`)
}

/** Splits a complete outgoing message into its envelope headers and the 7-bit body entity to protect. */
export function splitForProtection(message: string) {
  const entity = parseEntity(message)
  const isContent = (line: string) => /^content-/i.test(line)
  const outer = entity.headers.filter((line) => !isContent(line) && !/^mime-version:/i.test(line))
  const content = entity.headers.filter(isContent)
  return { outer, inner: canonicalizeLineEndings(sevenBitEntity(`${content.join(CRLF)}${CRLF}${CRLF}${entity.body}`)) }
}

const boundary = (label: string) => `aerio-${label}-${crypto.randomUUID()}`

export function buildSignedEntity(inner: string, armoredSignature: string, micalg: string) {
  const outer = boundary('signed')
  const body = [
    `--${outer}`, inner, `--${outer}`,
    'Content-Type: application/pgp-signature; name="signature.asc"',
    'Content-Description: OpenPGP digital signature',
    'Content-Disposition: attachment; filename="signature.asc"',
    '', canonicalizeLineEndings(armoredSignature).trimEnd(), `--${outer}--`, ''
  ].join(CRLF)
  return { contentType: `multipart/signed; micalg="${micalg}"; protocol="application/pgp-signature"; boundary="${outer}"`, body }
}

export function buildEncryptedEntity(armoredMessage: string) {
  const outer = boundary('encrypted')
  const body = [
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)',
    `--${outer}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '', 'Version: 1', '',
    `--${outer}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '', canonicalizeLineEndings(armoredMessage).trimEnd(), '',
    `--${outer}--`, ''
  ].join(CRLF)
  return { contentType: `multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${outer}"`, body }
}

export function assembleProtectedMessage(outer: string[], entity: { contentType: string; body: string }) {
  return [...outer, 'MIME-Version: 1.0', `Content-Type: ${entity.contentType}`].join(CRLF) + CRLF + CRLF + entity.body
}

export type PgpMimeStructure =
  | { kind: 'signed'; signedPart: string; signature: string }
  | { kind: 'encrypted'; armored: string }
  | { kind: 'none' }

const partBody = (part: string) => parseEntity(part).body

/** Recognizes RFC 3156 multipart/signed and multipart/encrypted at the top level of an entity. */
export function detectPgpMime(raw: string): PgpMimeStructure {
  const entity = parseEntity(raw)
  const type = parseContentType(headerValue(entity, 'content-type'))
  const protocol = type.params.protocol?.toLowerCase()
  if (!type.params.boundary) return { kind: 'none' }
  if (type.type === 'multipart/signed' && protocol === 'application/pgp-signature') {
    const parts = splitMultipart(entity.body, type.params.boundary)
    if (parts.length < 2) return { kind: 'none' }
    return { kind: 'signed', signedPart: canonicalizeLineEndings(parts[0]), signature: partBody(parts[1]) }
  }
  if (type.type === 'multipart/encrypted' && protocol === 'application/pgp-encrypted') {
    const parts = splitMultipart(entity.body, type.params.boundary)
    const payload = parts.find((part) => parseContentType(headerValue(parseEntity(part), 'content-type')).type === 'application/octet-stream') ?? parts[1]
    if (!payload) return { kind: 'none' }
    return { kind: 'encrypted', armored: partBody(payload) }
  }
  return { kind: 'none' }
}

export function inlinePgpBlock(text: string) {
  const encrypted = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/.exec(text)
  if (encrypted) return { kind: 'inline-encrypted' as const, block: encrypted[0] }
  const signed = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/.exec(text)
  if (signed) return { kind: 'inline-signed' as const, block: signed[0] }
  return undefined
}
