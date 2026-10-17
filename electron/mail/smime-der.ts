// A small, strict-enough ASN.1 BER/DER reader for S/MIME. It keeps byte
// offsets so signed attributes and certificate names can be compared and
// verified exactly as they were encoded, which a re-encoding parser cannot.

export interface DerNode {
  /** The identifier octet (class, constructed bit and low tag number). */
  tag: number
  tagClass: number
  tagNumber: number
  constructed: boolean
  start: number
  contentStart: number
  contentEnd: number
  end: number
  children: DerNode[]
}

export const TAG = { BOOLEAN: 1, INTEGER: 2, BIT_STRING: 3, OCTET_STRING: 4, NULL: 5, OID: 6, UTF8: 12, SEQUENCE: 16, SET: 17, PRINTABLE: 19, IA5: 22, UTC_TIME: 23, GENERALIZED_TIME: 24 } as const
export const CONTEXT = 2

const MAX_DEPTH = 64

function readNode(data: Uint8Array, offset: number, limit: number, depth: number): DerNode {
  if (depth > MAX_DEPTH) throw new Error('The ASN.1 data is nested too deeply')
  if (offset + 2 > limit) throw new Error('The ASN.1 data is truncated')
  const tag = data[offset]
  let position = offset + 1
  let tagNumber = tag & 0x1f
  if (tagNumber === 0x1f) {
    tagNumber = 0
    let byte: number
    do {
      if (position >= limit) throw new Error('The ASN.1 data is truncated')
      byte = data[position++]
      tagNumber = tagNumber * 128 + (byte & 0x7f)
    } while (byte & 0x80)
  }
  const constructed = (tag & 0x20) !== 0
  if (position >= limit) throw new Error('The ASN.1 data is truncated')
  const lengthByte = data[position++]
  let length: number | undefined
  if (lengthByte === 0x80) length = undefined
  else if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f
    if (count > 4 || position + count > limit) throw new Error('The ASN.1 length is invalid')
    length = 0
    for (let index = 0; index < count; index += 1) length = length * 256 + data[position++]
  } else length = lengthByte
  const contentStart = position
  const children: DerNode[] = []
  let contentEnd: number
  let end: number
  if (length === undefined) {
    // BER indefinite length, which some clients still use for CMS.
    if (!constructed) throw new Error('The ASN.1 data uses an invalid indefinite length')
    let cursor = position
    for (;;) {
      if (cursor + 2 > limit) throw new Error('The ASN.1 data is truncated')
      if (data[cursor] === 0 && data[cursor + 1] === 0) { contentEnd = cursor; end = cursor + 2; break }
      const child = readNode(data, cursor, limit, depth + 1)
      children.push(child)
      cursor = child.end
    }
  } else {
    contentEnd = position + length
    end = contentEnd
    if (contentEnd > limit) throw new Error('The ASN.1 data is truncated')
    if (constructed) {
      let cursor = position
      while (cursor < contentEnd) {
        const child = readNode(data, cursor, contentEnd, depth + 1)
        children.push(child)
        cursor = child.end
      }
    }
  }
  return { tag, tagClass: tag >> 6, tagNumber, constructed, start: offset, contentStart, contentEnd, end, children }
}

export function parseDer(data: Uint8Array): DerNode {
  return readNode(data, 0, data.length, 0)
}

/** Parses the content bytes of a node (e.g. an OCTET STRING wrapping DER) as ASN.1. */
export function parseInner(data: Uint8Array, node: DerNode): DerNode {
  const bytes = octets(data, node)
  return parseDer(bytes)
}

export const isUniversal = (node: DerNode | undefined, tagNumber: number) => Boolean(node) && node!.tagClass === 0 && node!.tagNumber === tagNumber
export const isContext = (node: DerNode | undefined, tagNumber: number) => Boolean(node) && node!.tagClass === CONTEXT && node!.tagNumber === tagNumber

export const raw = (data: Uint8Array, node: DerNode) => Buffer.from(data.subarray(node.start, node.end))
export const content = (data: Uint8Array, node: DerNode) => Buffer.from(data.subarray(node.contentStart, node.contentEnd))

/** The bytes of a string type; constructed (BER chunked) strings are concatenated. */
export function octets(data: Uint8Array, node: DerNode): Buffer {
  if (!node.constructed) return content(data, node)
  return Buffer.concat(node.children.map((child) => octets(data, child)))
}

export function oid(data: Uint8Array, node: DerNode) {
  if (!isUniversal(node, TAG.OID)) throw new Error('Expected an object identifier')
  const bytes = content(data, node)
  const parts: number[] = []
  let value = 0
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) {
      if (!parts.length) parts.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80)
      else parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

/** An INTEGER's value as upper-case hex without leading zero octets, the way X509Certificate reports serials. */
export function integerHex(data: Uint8Array, node: DerNode) {
  const hex = content(data, node).toString('hex').toUpperCase().replace(/^(?:00)+(?=..)/, '')
  return hex || '00'
}

export function text(data: Uint8Array, node: DerNode) {
  return octets(data, node).toString(node.tagNumber === TAG.UTF8 ? 'utf8' : 'latin1')
}

export function time(data: Uint8Array, node: DerNode): Date | undefined {
  const value = content(data, node).toString('latin1')
  const match = node.tagNumber === TAG.UTC_TIME
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(value)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(value)
  if (!match) return undefined
  let year = Number(match[1])
  if (node.tagNumber === TAG.UTC_TIME) year += year < 50 ? 2000 : 1900
  return new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)))
}

/** Re-tags a node's encoding, e.g. [0] IMPLICIT signed attributes as the SET they are signed as (RFC 5652 section 5.4). */
export function retag(data: Uint8Array, node: DerNode, tag: number) {
  const bytes = raw(data, node)
  bytes[0] = tag
  return bytes
}

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  envelopedData: '1.2.840.113549.1.7.3',
  authEnvelopedData: '1.2.840.113549.1.9.16.1.23',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  emailAddress: '1.2.840.113549.1.9.1',
  commonName: '2.5.4.3',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  anyExtendedKeyUsage: '2.5.29.37.0',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  rsaOaep: '1.2.840.113549.1.1.7',
  ecPublicKey: '1.2.840.10045.2.1'
} as const

export const DIGEST_OIDS: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '2.16.840.1.101.3.4.2.4': 'sha224'
}

/** Signature algorithms that name their digest, so the digest OID alone is not the whole story. */
export const SIGNATURE_DIGESTS: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.113549.1.1.14': 'sha224',
  '1.2.840.10045.4.1': 'sha1',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512'
}

export const CONTENT_CIPHERS: Record<string, string> = {
  '2.16.840.1.101.3.4.1.2': 'AES-128-CBC',
  '2.16.840.1.101.3.4.1.22': 'AES-192-CBC',
  '2.16.840.1.101.3.4.1.42': 'AES-256-CBC',
  '2.16.840.1.101.3.4.1.6': 'AES-128-GCM',
  '2.16.840.1.101.3.4.1.46': 'AES-256-GCM',
  '1.2.840.113549.3.7': '3DES-CBC',
  '1.3.14.3.2.7': 'DES-CBC',
  '1.2.840.113549.3.2': 'RC2-CBC'
}
