import { createHash, verify as verifySignature, type KeyObject } from 'node:crypto'
import forge from 'node-forge'
import { CONTENT_CIPHERS, DIGEST_OIDS, integerHex, isContext, isUniversal, octets, oid, OID, parseDer, raw, retag, SIGNATURE_DIGESTS, TAG, time, type DerNode, content } from './smime-der'
import { forgeCertificate, forgePrivateKey, parseCertificate, type ParsedCertificate } from './smime-certificate'

// CMS (RFC 5652) for S/MIME. Creating signatures and enveloped data uses
// node-forge (RSA PKCS#1 v1.5 signatures and key transport, AES-256-CBC
// content encryption). Verification is done here with Node's native crypto
// over the exact signed bytes, because forge does not verify CMS signatures.

const binary = (value: Uint8Array) => Buffer.from(value).toString('binary')
const fromBinary = (value: string) => Buffer.from(value, 'binary')
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Creates a detached SignedData over the exact content bytes, with signing time and the certificate chain. */
export function signDetached(data: Buffer, privateKey: KeyObject, certificate: ParsedCertificate, chain: ParsedCertificate[], signingTime: Date) {
  const message = forge.pkcs7.createSignedData()
  message.content = forge.util.createBuffer(binary(data))
  for (const cert of [certificate, ...chain]) message.addCertificate(forgeCertificate(cert))
  message.addSigner({
    key: forgePrivateKey(privateKey) as unknown as string,
    certificate: forgeCertificate(certificate),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signingTime as unknown as string }
    ]
  })
  message.sign({ detached: true })
  return fromBinary(forge.asn1.toDer(message.toAsn1()).getBytes())
}

/** Encrypts content for every recipient certificate as EnvelopedData with AES-256-CBC. */
export function encryptEnveloped(data: Buffer, recipients: ParsedCertificate[]) {
  if (!recipients.length) throw new Error('No recipient certificates')
  const message = forge.pkcs7.createEnvelopedData()
  for (const cert of recipients) message.addRecipient(forgeCertificate(cert))
  message.content = forge.util.createBuffer(binary(data))
  message.encrypt(undefined, forge.pki.oids['aes256-CBC'])
  return fromBinary(forge.asn1.toDer(message.toAsn1()).getBytes())
}

/** Unwraps a ContentInfo, returning its type and the inner content node. */
export function contentInfo(der: Uint8Array) {
  const root = parseDer(der)
  const [type, wrapped] = root.children
  if (!isUniversal(root, TAG.SEQUENCE) || !type || !isUniversal(type, TAG.OID)) throw new Error('This is not CMS data')
  return { type: oid(der, type), content: wrapped && isContext(wrapped, 0) ? wrapped.children[0] : undefined }
}

export interface CmsRecipient {
  issuerDer?: Buffer
  serialNumber?: string
  subjectKeyId?: string
  /** Only key transport recipients (RSA) can be decrypted here. */
  supported: boolean
}

export interface EnvelopedInfo {
  authenticated: boolean
  algorithm: string
  recipients: CmsRecipient[]
}

export function envelopedInfo(der: Uint8Array): EnvelopedInfo {
  const info = contentInfo(der)
  if (info.type !== OID.envelopedData && info.type !== OID.authEnvelopedData) throw new Error('This is not CMS enveloped data')
  const fields = info.content?.children ?? []
  const recipientSet = fields.find((field) => isUniversal(field, TAG.SET))
  const encrypted = fields.find((field, index) => index > 0 && isUniversal(field, TAG.SEQUENCE))
  const algorithmId = encrypted?.children[1]?.children[0]
  const algorithmOid = algorithmId ? oid(der, algorithmId) : ''
  const recipients = (recipientSet?.children ?? []).map((recipient): CmsRecipient => {
    if (!isUniversal(recipient, TAG.SEQUENCE)) return { supported: false }
    const id = recipient.children[1]
    if (isUniversal(id, TAG.SEQUENCE)) return { issuerDer: raw(der, id.children[0]), serialNumber: integerHex(der, id.children[1]), supported: true }
    if (isContext(id, 0)) return { subjectKeyId: content(der, id).toString('hex').toUpperCase(), supported: true }
    return { supported: false }
  })
  return { authenticated: info.type === OID.authEnvelopedData, algorithm: CONTENT_CIPHERS[algorithmOid] ?? algorithmOid, recipients }
}

export const recipientMatches = (recipient: Pick<CmsRecipient, 'issuerDer' | 'serialNumber' | 'subjectKeyId'>, cert: ParsedCertificate) =>
  recipient.issuerDer ? recipient.serialNumber === cert.serialNumber && recipient.issuerDer.equals(cert.issuerDer) : Boolean(recipient.subjectKeyId && recipient.subjectKeyId === cert.subjectKeyId)

/** Decrypts EnvelopedData for one of your certificates. Throws when it cannot. */
export function decryptEnveloped(der: Uint8Array, certificate: ParsedCertificate, privateKey: KeyObject) {
  const info = envelopedInfo(der)
  if (info.authenticated) throw new Error(`This message uses ${info.algorithm || 'authenticated encryption'} (AuthEnvelopedData), which Aerio cannot decrypt yet`)
  if (!/^(?:AES-(?:128|192|256)-CBC|3DES-CBC)$/.test(info.algorithm)) throw new Error(`This message uses an unsupported encryption algorithm (${info.algorithm})`)
  let message: forge.pkcs7.PkcsEnvelopedData
  try {
    message = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(binary(der))) as forge.pkcs7.PkcsEnvelopedData
  } catch (error) {
    throw new Error(`The encrypted data could not be read: ${errorText(error)}`)
  }
  const recipient = message.findRecipient(forgeCertificate(certificate))
  if (!recipient) throw new Error('This message was not encrypted to that certificate')
  try {
    message.decrypt(recipient, forgePrivateKey(privateKey))
  } catch (error) {
    throw new Error(`This message could not be decrypted: ${errorText(error)}`)
  }
  const result = (message as unknown as { content?: forge.util.ByteStringBuffer }).content
  if (!result) throw new Error('This message could not be decrypted')
  return fromBinary(result.getBytes())
}

export interface CmsSigner {
  issuerDer?: Buffer
  serialNumber?: string
  subjectKeyId?: string
  digest?: string
  signatureAlgorithm: string
  signedAttributes?: DerNode
  attributes: Map<string, DerNode>
  signature: Buffer
  signedAt?: Date
}

export interface SignedDataInfo {
  der: Buffer
  contentType: string
  /** Encapsulated content for opaque (application/pkcs7-mime signed-data) messages. */
  content?: Buffer
  certificates: ParsedCertificate[]
  signers: CmsSigner[]
}

export function parseSignedData(input: Uint8Array): SignedDataInfo {
  const der = Buffer.from(input)
  const info = contentInfo(der)
  if (info.type !== OID.signedData || !info.content) throw new Error('This is not CMS signed data')
  const fields = info.content.children
  const encapsulated = fields[2]
  const contentType = encapsulated?.children[0] ? oid(der, encapsulated.children[0]) : OID.data
  const eContent = encapsulated?.children[1] && isContext(encapsulated.children[1], 0) ? encapsulated.children[1].children[0] : undefined
  const certificates: ParsedCertificate[] = []
  for (const field of fields.slice(3)) {
    if (!isContext(field, 0)) continue
    for (const child of field.children) {
      // Only X.509 certificates (SEQUENCE); attribute certificates are skipped.
      if (!isUniversal(child, TAG.SEQUENCE)) continue
      try { certificates.push(parseCertificate(raw(der, child))) } catch { /* An unreadable extra certificate is ignored. */ }
    }
  }
  const signerSet = fields[fields.length - 1]
  const signers = (isUniversal(signerSet, TAG.SET) ? signerSet.children : []).map((signer): CmsSigner => {
    const parts = signer.children
    const sid = parts[1]
    const digestOid = parts[2]?.children[0] ? oid(der, parts[2].children[0]) : ''
    let cursor = 3
    const signedAttributes = isContext(parts[cursor], 0) ? parts[cursor++] : undefined
    const signatureAlgorithm = parts[cursor]?.children[0] ? oid(der, parts[cursor].children[0]) : ''
    const signature = parts[cursor + 1] ? octets(der, parts[cursor + 1]) : Buffer.alloc(0)
    const attributes = new Map<string, DerNode>()
    for (const attribute of signedAttributes?.children ?? []) {
      const [type, values] = attribute.children
      if (type && values?.children[0]) attributes.set(oid(der, type), values.children[0])
    }
    const signingTime = attributes.get(OID.signingTime)
    return {
      ...(isUniversal(sid, TAG.SEQUENCE) ? { issuerDer: raw(der, sid.children[0]), serialNumber: integerHex(der, sid.children[1]) } : {}),
      ...(isContext(sid, 0) ? { subjectKeyId: content(der, sid).toString('hex').toUpperCase() } : {}),
      digest: DIGEST_OIDS[digestOid] ?? SIGNATURE_DIGESTS[digestOid],
      signatureAlgorithm,
      signedAttributes,
      attributes,
      signature,
      signedAt: signingTime ? time(der, signingTime) : undefined
    }
  })
  return { der, contentType, content: eContent ? octets(der, eContent) : undefined, certificates, signers }
}

export const signerMatches = (signer: Pick<CmsSigner, 'issuerDer' | 'serialNumber' | 'subjectKeyId'>, cert: ParsedCertificate) => recipientMatches(signer, cert)

/**
 * Verifies one signer over the signed content. With signed attributes the
 * message digest attribute must match the content and the signature covers
 * the attributes re-tagged as a SET (RFC 5652 section 5.4).
 */
export function verifySigner(signed: SignedDataInfo, signer: CmsSigner, data: Buffer, certificate: ParsedCertificate): { valid: boolean; supported: boolean; detail?: string } {
  if (!signer.digest) return { valid: false, supported: false, detail: 'The signature uses an unsupported digest algorithm' }
  if (signer.signatureAlgorithm === OID.rsaPss) return { valid: false, supported: false, detail: 'RSA-PSS signatures are not supported yet' }
  const digest = createHash(signer.digest).update(data).digest()
  let signedBytes = data
  if (signer.signedAttributes) {
    const messageDigest = signer.attributes.get(OID.messageDigest)
    if (!messageDigest || !octets(signed.der, messageDigest).equals(digest)) return { valid: false, supported: true, detail: 'The message content does not match its signature' }
    const contentType = signer.attributes.get(OID.contentType)
    if (contentType && oid(signed.der, contentType) !== signed.contentType) return { valid: false, supported: true, detail: 'The signed content type does not match' }
    signedBytes = retag(signed.der, signer.signedAttributes, 0x31)
  }
  try {
    const valid = verifySignature(signer.digest, signedBytes, certificate.x509.publicKey, signer.signature)
    return valid ? { valid, supported: true } : { valid, supported: true, detail: 'The signature does not match the signer’s certificate' }
  } catch (error) {
    return { valid: false, supported: false, detail: `The signature could not be checked: ${errorText(error)}` }
  }
}
