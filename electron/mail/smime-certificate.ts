import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import forge from 'node-forge'
import type { SmimeChainEntry, SmimeChainStatus, SmimeKeyUsage } from '../../src/smime-types'
import { content, integerHex, isContext, isUniversal, oid, OID, parseDer, raw, TAG, text, time, type DerNode } from './smime-der'

// X.509 certificate handling for S/MIME: reading PEM/DER/PKCS#12 files,
// extracting the fields S/MIME cares about (emails, key usage, issuer and
// serial), and validating a chain up to a trust anchor. Signature checks use
// Node's native X509Certificate, so chains with EC or RSA-PSS issuers work.

export interface ParsedCertificate {
  der: Buffer
  x509: X509Certificate
  /** SHA-256 of the DER encoding, upper-case hex. */
  fingerprint: string
  subject: string
  commonName?: string
  issuer: string
  /** Raw DER of the issuer Name, for exact IssuerAndSerialNumber matching. */
  issuerDer: Buffer
  serialNumber: string
  subjectKeyId?: string
  emails: string[]
  validFrom: Date
  validTo: Date
  isCa: boolean
  /** Undefined when the certificate has no key-usage extension. */
  keyUsageBits?: Set<string>
  /** Undefined when the certificate has no extended key-usage extension. */
  extendedKeyUsage?: string[]
  keyType: string
  algorithm: string
}

const KEY_USAGE_BITS = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly']

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function nameAttributes(data: Uint8Array, name: DerNode) {
  const attributes: { type: string; value: string }[] = []
  for (const set of name.children) for (const pair of set.children) {
    const [type, value] = pair.children
    if (type && value && isUniversal(type, TAG.OID)) attributes.push({ type: oid(data, type), value: text(data, value) })
  }
  return attributes
}

/** Parses one DER certificate. Throws with a readable message when it is not an X.509 certificate. */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const buffer = Buffer.from(der)
  let x509: X509Certificate
  try { x509 = new X509Certificate(buffer) } catch (error) { throw new Error(`That is not a readable X.509 certificate: ${errorText(error)}`) }
  const root = parseDer(buffer)
  const tbs = root.children[0]
  const fields = tbs.children
  let index = isContext(fields[0], 0) ? 1 : 0
  const serial = fields[index++]
  index += 1 // signature algorithm
  const issuer = fields[index++]
  const validity = fields[index++]
  const subject = fields[index++]
  const subjectAttributes = nameAttributes(buffer, subject)
  const emails = new Set(subjectAttributes.filter((item) => item.type === OID.emailAddress).map((item) => item.value.trim().toLowerCase()))
  let keyUsageBits: Set<string> | undefined
  let extendedKeyUsage: string[] | undefined
  let subjectKeyId: string | undefined
  let isCa = false
  const extensions = fields.find((field) => isContext(field, 3))?.children[0]?.children ?? []
  for (const extension of extensions) {
    const id = oid(buffer, extension.children[0])
    const value = extension.children[extension.children.length - 1]
    try {
      if (id === OID.subjectAltName) {
        const bytes = content(buffer, value)
        // rfc822Name is [1] IMPLICIT IA5String in GeneralNames.
        for (const name of parseDer(bytes).children) if (name.tagClass === 2 && name.tagNumber === 1) emails.add(content(bytes, name).toString('latin1').trim().toLowerCase())
      } else if (id === OID.keyUsage) {
        const bits = content(buffer, value)
        const inner = parseDer(bits)
        const bytes = content(bits, inner).subarray(1)
        keyUsageBits = new Set(KEY_USAGE_BITS.filter((_name, bit) => (bytes[bit >> 3] ?? 0) & (0x80 >> (bit & 7))))
      } else if (id === OID.extKeyUsage) {
        const bytes = content(buffer, value)
        extendedKeyUsage = parseDer(bytes).children.map((item) => oid(bytes, item))
      } else if (id === OID.basicConstraints) {
        const bytes = content(buffer, value)
        const first = parseDer(bytes).children[0]
        isCa = Boolean(first && isUniversal(first, TAG.BOOLEAN) && bytes[first.contentStart] !== 0)
      } else if (id === '2.5.29.14') {
        const bytes = content(buffer, value)
        subjectKeyId = content(bytes, parseDer(bytes)).toString('hex').toUpperCase()
      }
    } catch {
      // A malformed optional extension is treated as absent.
    }
  }
  const publicKey = x509.publicKey
  const details = publicKey.asymmetricKeyDetails ?? {}
  const keyType = publicKey.asymmetricKeyType ?? 'unknown'
  const algorithm = keyType === 'rsa' || keyType === 'rsa-pss' ? `${keyType === 'rsa' ? 'RSA' : 'RSA-PSS'} ${details.modulusLength ?? ''}`.trim() : keyType === 'ec' ? `ECDSA (${details.namedCurve ?? 'unknown curve'})` : keyType.toUpperCase()
  const [notBefore, notAfter] = validity.children
  return {
    der: buffer,
    x509,
    fingerprint: createHash('sha256').update(buffer).digest('hex').toUpperCase(),
    subject: x509.subject.replaceAll('\n', ', '),
    commonName: subjectAttributes.find((item) => item.type === OID.commonName)?.value,
    issuer: x509.issuer.replaceAll('\n', ', '),
    issuerDer: raw(buffer, issuer),
    serialNumber: integerHex(buffer, serial),
    subjectKeyId,
    emails: [...emails].filter(Boolean),
    validFrom: time(buffer, notBefore) ?? new Date(x509.validFrom),
    validTo: time(buffer, notAfter) ?? new Date(x509.validTo),
    isCa: isCa || x509.ca,
    keyUsageBits,
    extendedKeyUsage,
    keyType,
    algorithm
  }
}

export function keyUsageSummary(cert: ParsedCertificate): SmimeKeyUsage {
  const bit = (name: string) => cert.keyUsageBits ? cert.keyUsageBits.has(name) : undefined
  return {
    digitalSignature: bit('digitalSignature'),
    nonRepudiation: bit('nonRepudiation'),
    keyEncipherment: bit('keyEncipherment'),
    emailProtection: !cert.extendedKeyUsage || cert.extendedKeyUsage.includes(OID.emailProtection) || cert.extendedKeyUsage.includes(OID.anyExtendedKeyUsage)
  }
}

/** The certificate may sign mail (RFC 8550 section 4.4). RSA only: signing uses PKCS#1 v1.5. */
export function canSignMail(cert: ParsedCertificate) {
  const usage = keyUsageSummary(cert)
  return cert.keyType === 'rsa' && usage.emailProtection && (!cert.keyUsageBits || cert.keyUsageBits.has('digitalSignature') || cert.keyUsageBits.has('nonRepudiation'))
}

/** The certificate may receive encrypted mail through RSA key transport. */
export function canEncryptTo(cert: ParsedCertificate) {
  const usage = keyUsageSummary(cert)
  return cert.keyType === 'rsa' && usage.emailProtection && (!cert.keyUsageBits || cert.keyUsageBits.has('keyEncipherment'))
}

export const isExpired = (cert: ParsedCertificate, at: Date) => cert.validTo.getTime() < at.getTime()
export const isNotYetValid = (cert: ParsedCertificate, at: Date) => cert.validFrom.getTime() > at.getTime()

const PEM_BLOCK = /-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g

/** Reads every certificate in a PEM bundle, or one DER certificate. */
export function readCertificates(data: string | Uint8Array): ParsedCertificate[] {
  const textValue = typeof data === 'string' ? data : Buffer.from(data).toString('latin1')
  if (/-----BEGIN [A-Z0-9 ]*CERTIFICATE-----/.test(textValue)) {
    return [...textValue.matchAll(PEM_BLOCK)].map((match) => parseCertificate(Buffer.from(match[1].replace(/\s+/g, ''), 'base64')))
  }
  if (typeof data === 'string') throw new Error('Paste a PEM certificate (-----BEGIN CERTIFICATE-----)')
  return [parseCertificate(data)]
}

export const certificatePem = (cert: ParsedCertificate) => cert.x509.toString()

const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' }) as Buffer

export interface Pkcs12Contents {
  privateKey: KeyObject
  certificate: ParsedCertificate
  chain: ParsedCertificate[]
}

export class Pkcs12PasswordError extends Error {
  constructor(message = 'The PKCS#12 password is incorrect') {
    super(message)
    this.name = 'Pkcs12PasswordError'
  }
}

/** Opens a PKCS#12 (.p12/.pfx) file and pairs its private key with the matching certificate. */
export function readPkcs12(data: Uint8Array, password: string): Pkcs12Contents {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(data).toString('binary')), false, password)
  } catch (error) {
    const message = errorText(error)
    if (/password|MAC|decrypt/i.test(message)) throw new Pkcs12PasswordError()
    throw new Error(`That is not a readable PKCS#12 file: ${message}`)
  }
  const keys: KeyObject[] = []
  for (const type of [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag]) {
    for (const bag of p12.getBags({ bagType: type })[type] ?? []) {
      const info = bag.key ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key)) : (bag as { asn1?: forge.asn1.Asn1 }).asn1
      if (info) keys.push(createPrivateKey({ key: Buffer.from(forge.asn1.toDer(info).getBytes(), 'binary'), format: 'der', type: 'pkcs8' }))
    }
  }
  const certificates: ParsedCertificate[] = []
  for (const bag of p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []) {
    const asn1 = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : (bag as { asn1?: forge.asn1.Asn1 }).asn1
    if (asn1) certificates.push(parseCertificate(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')))
  }
  if (!keys.length) throw new Error('This PKCS#12 file has no private key. Import a .cer or .pem file for someone else’s certificate.')
  for (const key of keys) {
    const publicKey = spki(createPublicKey(key))
    const certificate = certificates.find((cert) => spki(cert.x509.publicKey).equals(publicKey))
    if (certificate) return { privateKey: key, certificate, chain: certificates.filter((cert) => cert !== certificate) }
  }
  throw new Error('No certificate in this PKCS#12 file matches its private key')
}

/** Writes a password-protected PKCS#12 (AES-256, SHA-256 MAC) for backup or moving to another device. */
export function writePkcs12(privateKey: KeyObject, certificate: ParsedCertificate, chain: ParsedCertificate[], password: string, friendlyName?: string) {
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }) as string)
  const certs = [certificate, ...chain].map((cert) => forge.pki.certificateFromAsn1(forge.asn1.fromDer(cert.der.toString('binary'))))
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, certs, password, { algorithm: 'aes256', generateLocalKeyId: true, ...(friendlyName ? { friendlyName } : {}) })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
}

let systemRoots: ParsedCertificate[] | undefined

/** Mozilla's root store as bundled with Node/Electron. Parsed once, lazily. */
export function systemRootCertificates() {
  if (!systemRoots) {
    systemRoots = []
    for (const pem of rootCertificates) {
      try { systemRoots.push(...readCertificates(pem)) } catch { /* An unreadable bundled root is skipped. */ }
    }
  }
  return systemRoots
}

const verifiesWith = (cert: ParsedCertificate, issuer: ParsedCertificate) => {
  try { return cert.x509.verify(issuer.x509.publicKey) } catch { return false }
}
const signedBy = (cert: ParsedCertificate, issuer: ParsedCertificate) => {
  try { return cert.x509.checkIssued(issuer.x509) && verifiesWith(cert, issuer) } catch { return false }
}

export interface ChainResult {
  status: SmimeChainStatus
  path: ParsedCertificate[]
  detail?: string
}

/**
 * Builds a path from the certificate to a trust anchor. Issuers come from the
 * pool (certificates in the message or the store) and the anchors; each link
 * must verify, issuers must be CAs allowed to sign certificates, and every
 * issuer must be inside its validity period. Revocation is not checked.
 */
export function validateChain(leaf: ParsedCertificate, pool: ParsedCertificate[], anchors: ParsedCertificate[], at: Date): ChainResult {
  const anchorFingerprints = new Set(anchors.map((item) => item.fingerprint))
  const candidates = [...pool, ...anchors]
  const path = [leaf]
  let current = leaf
  for (let depth = 0; depth < 10; depth += 1) {
    if (anchorFingerprints.has(current.fingerprint)) return { status: 'trusted', path }
    const issuer = candidates.find((item) => item.fingerprint !== current.fingerprint && !path.some((entry) => entry.fingerprint === item.fingerprint) && signedBy(current, item))
    if (!issuer) {
      // checkIssued() refuses self-issued leaves without keyCertSign, so compare names directly.
      if (current.subject === current.issuer && verifiesWith(current, current)) return { status: 'untrusted-root', path, detail: `The root certificate ${current.commonName ?? current.subject} is not trusted` }
      return { status: 'incomplete', path, detail: `The issuer ${current.issuer} is not available` }
    }
    if (!issuer.isCa || issuer.keyUsageBits && !issuer.keyUsageBits.has('keyCertSign')) return { status: 'invalid', path: [...path, issuer], detail: `${issuer.commonName ?? issuer.subject} is not allowed to issue certificates` }
    if (isExpired(issuer, at) || isNotYetValid(issuer, at)) return { status: 'invalid', path: [...path, issuer], detail: `The issuing certificate ${issuer.commonName ?? issuer.subject} is not valid at this time` }
    path.push(issuer)
    current = issuer
  }
  return { status: 'invalid', path, detail: 'The certificate chain is too long' }
}

export function chainEntries(result: ChainResult, anchors: ParsedCertificate[], at: Date): SmimeChainEntry[] {
  const anchorFingerprints = new Set(anchors.map((item) => item.fingerprint))
  return result.path.map((cert) => ({
    subject: cert.commonName ?? cert.subject,
    issuer: cert.issuer,
    fingerprint: cert.fingerprint,
    validFrom: cert.validFrom.toISOString(),
    validTo: cert.validTo.toISOString(),
    expired: isExpired(cert, at),
    trustAnchor: anchorFingerprints.has(cert.fingerprint)
  }))
}

export const forgeCertificate = (cert: ParsedCertificate) => forge.pki.certificateFromAsn1(forge.asn1.fromDer(cert.der.toString('binary')))
export const forgePrivateKey = (key: KeyObject) => forge.pki.privateKeyFromPem(key.export({ type: 'pkcs1', format: 'pem' }) as string)
