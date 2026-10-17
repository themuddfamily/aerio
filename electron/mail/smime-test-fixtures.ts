import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import forge from 'node-forge'

// Controlled S/MIME certificate fixtures for tests: a throwaway root CA,
// intermediates, and leaf certificates with chosen validity and key usage.
// Keys come from Node's native RSA generator because forge's is slow.

export interface TestIdentity {
  privateKey: KeyObject
  cert: forge.pki.Certificate
  pem: string
  der: Buffer
}

let serial = 1
const DAY = 86_400_000

export function rsaKeyPair(bits = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  return {
    privateKey,
    forgePrivate: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }) as string),
    forgePublic: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }) as string)
  }
}

export interface IssueOptions {
  commonName: string
  email?: string
  issuer?: TestIdentity
  ca?: boolean
  notBefore?: Date
  notAfter?: Date
  /** forge keyUsage flags; omit for the usual S/MIME leaf (digitalSignature + keyEncipherment). */
  keyUsage?: Record<string, boolean>
  /** Set false to omit extended key usage; a list replaces emailProtection. */
  extKeyUsage?: false | Record<string, boolean>
  now?: number
}

export function issue(options: IssueOptions): TestIdentity {
  const keys = rsaKeyPair()
  const cert = forge.pki.createCertificate()
  const now = options.now ?? Date.now()
  cert.publicKey = keys.forgePublic
  cert.serialNumber = (0x10_0000 + serial++).toString(16)
  cert.validity.notBefore = options.notBefore ?? new Date(now - DAY)
  cert.validity.notAfter = options.notAfter ?? new Date(now + 365 * DAY)
  const subject: forge.pki.CertificateField[] = [{ name: 'commonName', value: options.commonName }, { name: 'organizationName', value: 'Aerio Test' }]
  if (options.email) subject.push({ name: 'emailAddress', value: options.email })
  cert.setSubject(subject)
  cert.setIssuer(options.issuer ? options.issuer.cert.subject.attributes : subject)
  const extensions: Record<string, unknown>[] = []
  if (options.ca) {
    extensions.push({ name: 'basicConstraints', cA: true, critical: true })
    extensions.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true, ...options.keyUsage })
  } else {
    extensions.push({ name: 'basicConstraints', cA: false })
    extensions.push({ name: 'keyUsage', critical: true, ...(options.keyUsage ?? { digitalSignature: true, keyEncipherment: true }) })
    if (options.extKeyUsage !== false) extensions.push({ name: 'extKeyUsage', ...(options.extKeyUsage ?? { emailProtection: true }) })
    if (options.email) extensions.push({ name: 'subjectAltName', altNames: [{ type: 1, value: options.email }] })
  }
  extensions.push({ name: 'subjectKeyIdentifier' })
  cert.setExtensions(extensions)
  cert.sign(options.issuer ? forge.pki.privateKeyFromPem(options.issuer.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string) : keys.forgePrivate, forge.md.sha256.create())
  const pem = forge.pki.certificateToPem(cert)
  return { privateKey: keys.privateKey, cert, pem, der: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary') }
}

/** A PKCS#12 file holding the identity's key and certificate, plus any chain certificates. */
export function pkcs12(identity: TestIdentity, password: string, chain: TestIdentity[] = []) {
  const key = forge.pki.privateKeyFromPem(identity.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string)
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [identity.cert, ...chain.map((item) => item.cert)], password, { algorithm: 'aes256' })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
}

/** A root CA, an intermediate, and leaves for Alice (you), Bob and Carol, plus edge cases. */
export function testPki(now = Date.now()) {
  const root = issue({ commonName: 'Aerio Test Root CA', ca: true, now, notAfter: new Date(now + 3650 * DAY) })
  const intermediate = issue({ commonName: 'Aerio Test Mail CA', ca: true, issuer: root, now })
  const alice = issue({ commonName: 'Alice Example', email: 'alice@example.test', issuer: intermediate, now })
  const bob = issue({ commonName: 'Bob Example', email: 'bob@example.test', issuer: intermediate, now })
  const carol = issue({ commonName: 'Carol Example', email: 'carol@example.test', issuer: intermediate, now })
  const expired = issue({ commonName: 'Old Bob', email: 'old@example.test', issuer: intermediate, now, notBefore: new Date(now - 400 * DAY), notAfter: new Date(now - DAY) })
  const otherRoot = issue({ commonName: 'Unknown Root', ca: true, now })
  const stranger = issue({ commonName: 'Mallory Example', email: 'mallory@example.test', issuer: otherRoot, now })
  const selfSigned = issue({ commonName: 'Self Signed', email: 'self@example.test', now })
  return { root, intermediate, alice, bob, carol, expired, otherRoot, stranger, selfSigned }
}
