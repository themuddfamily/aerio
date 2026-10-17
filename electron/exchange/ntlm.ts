import { createHmac, randomBytes } from 'node:crypto'
import { md4 } from './md4'

// NTLMv2 (MS-NLMP) client messages for HTTP authentication to Exchange. Only connection
// authentication is implemented: no signing/sealing and no key exchange, which HTTP over TLS does
// not use. When the server sends a timestamp, a MIC is included as MS-NLMP recommends. Channel
// binding (Extended Protection for Authentication) is not implemented; see docs/exchange-ews.md.

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1')

export const NTLM_FLAGS = {
  UNICODE: 0x0000_0001,
  REQUEST_TARGET: 0x0000_0004,
  NTLM: 0x0000_0200,
  ALWAYS_SIGN: 0x0000_8000,
  EXTENDED_SESSIONSECURITY: 0x0008_0000,
  TARGET_INFO: 0x0080_0000,
  VERSION: 0x0200_0000,
  NEGOTIATE_128: 0x2000_0000,
  NEGOTIATE_56: 0x8000_0000
} as const

const CLIENT_FLAGS = (NTLM_FLAGS.UNICODE | NTLM_FLAGS.REQUEST_TARGET | NTLM_FLAGS.NTLM | NTLM_FLAGS.ALWAYS_SIGN |
  NTLM_FLAGS.EXTENDED_SESSIONSECURITY | NTLM_FLAGS.TARGET_INFO | NTLM_FLAGS.VERSION | NTLM_FLAGS.NEGOTIATE_128 | NTLM_FLAGS.NEGOTIATE_56) >>> 0

// Windows 10.0 build 19041, NTLMSSP_REVISION_W2K3. The version is informational only.
const VERSION = Buffer.from([10, 0, 0x61, 0x4a, 0, 0, 0, 0x0f])

export const AV = { EOL: 0, NB_COMPUTER: 1, NB_DOMAIN: 2, DNS_COMPUTER: 3, DNS_DOMAIN: 4, FLAGS: 6, TIMESTAMP: 7 } as const

export class NtlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NtlmError'
  }
}

const utf16 = (value: string) => Buffer.from(value, 'utf16le')
const hmacMd5 = (key: Buffer, ...data: Buffer[]) => {
  const hmac = createHmac('md5', key)
  for (const part of data) hmac.update(part)
  return hmac.digest()
}

/** Splits DOMAIN\user; a UPN (user@domain) is sent whole with an empty domain, as Windows does. */
export function ntlmIdentity(username: string, domain?: string) {
  const slash = username.indexOf('\\')
  if (slash > 0) return { domain: username.slice(0, slash), user: username.slice(slash + 1) }
  return { domain: domain ?? '', user: username }
}

export const ntHash = (password: string) => md4(utf16(password))

/** NTOWFv2 = HMAC_MD5(MD4(UNICODE(password)), UNICODE(UPPER(user) + domain)). */
export function ntowfV2(password: string, user: string, domain: string) {
  return hmacMd5(ntHash(password), utf16(user.toUpperCase() + domain))
}

export function negotiateMessage() {
  const message = Buffer.alloc(40)
  SIGNATURE.copy(message, 0)
  message.writeUInt32LE(1, 8)
  message.writeUInt32LE(CLIENT_FLAGS, 12)
  // Empty domain and workstation fields (offsets point at the end of the header).
  message.writeUInt32LE(40, 20)
  message.writeUInt32LE(40, 28)
  VERSION.copy(message, 32)
  return message
}

export interface NtlmChallenge {
  flags: number
  serverChallenge: Buffer
  targetName: string
  targetInfo: Buffer
  raw: Buffer
}

function field(message: Buffer, offset: number) {
  const length = message.readUInt16LE(offset)
  const start = message.readUInt32LE(offset + 4)
  if (start + length > message.length) throw new NtlmError('The server sent a malformed NTLM challenge')
  return message.subarray(start, start + length)
}

export function parseChallengeMessage(value: Buffer): NtlmChallenge {
  if (value.length < 32 || !value.subarray(0, 8).equals(SIGNATURE) || value.readUInt32LE(8) !== 2) throw new NtlmError('The server sent a malformed NTLM challenge')
  const flags = value.readUInt32LE(20)
  const targetName = field(value, 12)
  const targetInfo = value.length >= 48 ? Buffer.from(field(value, 40)) : Buffer.alloc(0)
  return {
    flags,
    serverChallenge: Buffer.from(value.subarray(24, 32)),
    targetName: flags & NTLM_FLAGS.UNICODE ? targetName.toString('utf16le') : targetName.toString('latin1'),
    targetInfo,
    raw: Buffer.from(value)
  }
}

export interface AvPair { id: number; value: Buffer }

export function parseAvPairs(info: Buffer): AvPair[] {
  const pairs: AvPair[] = []
  let offset = 0
  while (offset + 4 <= info.length) {
    const id = info.readUInt16LE(offset)
    const length = info.readUInt16LE(offset + 2)
    if (id === AV.EOL) break
    if (offset + 4 + length > info.length) throw new NtlmError('The server sent malformed NTLM target information')
    pairs.push({ id, value: Buffer.from(info.subarray(offset + 4, offset + 4 + length)) })
    offset += 4 + length
  }
  return pairs
}

export function encodeAvPairs(pairs: AvPair[]) {
  const parts = pairs.filter((pair) => pair.id !== AV.EOL).map((pair) => {
    const header = Buffer.alloc(4)
    header.writeUInt16LE(pair.id, 0)
    header.writeUInt16LE(pair.value.length, 2)
    return Buffer.concat([header, pair.value])
  })
  return Buffer.concat([...parts, Buffer.alloc(4)])
}

/** 100-nanosecond intervals since 1601-01-01, little-endian. */
export function fileTime(date = new Date()) {
  const value = (BigInt(date.getTime()) + 11_644_473_600_000n) * 10_000n
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(value)
  return buffer
}

export interface NtlmV2Input {
  ntowf: Buffer
  serverChallenge: Buffer
  clientChallenge: Buffer
  timestamp: Buffer
  targetInfo: Buffer
}

/** MS-NLMP 3.3.2: the NTLMv2 response, its proof, and the session base key. */
export function ntlmV2Response(input: NtlmV2Input) {
  const temp = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), input.timestamp, input.clientChallenge, Buffer.alloc(4), input.targetInfo, Buffer.alloc(4)])
  const proof = hmacMd5(input.ntowf, input.serverChallenge, temp)
  return {
    ntProof: proof,
    ntResponse: Buffer.concat([proof, temp]),
    lmResponse: Buffer.concat([hmacMd5(input.ntowf, input.serverChallenge, input.clientChallenge), input.clientChallenge]),
    sessionBaseKey: hmacMd5(input.ntowf, proof)
  }
}

export interface AuthenticateInput {
  username: string
  password: string
  domain?: string
  workstation?: string
  challenge: NtlmChallenge
  negotiate: Buffer
  clientChallenge?: Buffer
  now?: Date
}

const HEADER = 88

export function authenticateMessage(input: AuthenticateInput) {
  const { user, domain } = ntlmIdentity(input.username, input.domain)
  const workstation = (input.workstation ?? 'AERIO').toUpperCase()
  const pairs = parseAvPairs(input.challenge.targetInfo)
  const serverTime = pairs.find((pair) => pair.id === AV.TIMESTAMP)?.value
  let targetInfo = input.challenge.targetInfo
  if (serverTime) {
    // Announce the MIC in MsvAvFlags (bit 0x2), keeping any flags the server already set.
    const existing = pairs.find((pair) => pair.id === AV.FLAGS)
    const flags = Buffer.alloc(4)
    flags.writeUInt32LE(((existing?.value.length === 4 ? existing.value.readUInt32LE(0) : 0) | 0x2) >>> 0)
    targetInfo = encodeAvPairs([...pairs.filter((pair) => pair.id !== AV.FLAGS), { id: AV.FLAGS, value: flags }])
  }
  const response = ntlmV2Response({
    ntowf: ntowfV2(input.password, user, domain),
    serverChallenge: input.challenge.serverChallenge,
    clientChallenge: input.clientChallenge ?? randomBytes(8),
    timestamp: serverTime ?? fileTime(input.now),
    targetInfo
  })
  // With a server timestamp the LM response must be zero-filled (MS-NLMP 3.1.5.1.2).
  const lm = serverTime ? Buffer.alloc(24) : response.lmResponse
  const payload = [lm, response.ntResponse, utf16(domain), utf16(user), utf16(workstation), Buffer.alloc(0)]
  const header = Buffer.alloc(HEADER)
  SIGNATURE.copy(header, 0)
  header.writeUInt32LE(3, 8)
  let offset = HEADER
  payload.forEach((part, index) => {
    const at = 12 + index * 8
    header.writeUInt16LE(part.length, at)
    header.writeUInt16LE(part.length, at + 2)
    header.writeUInt32LE(offset, at + 4)
    offset += part.length
  })
  header.writeUInt32LE((CLIENT_FLAGS & (input.challenge.flags | NTLM_FLAGS.VERSION)) >>> 0 || CLIENT_FLAGS, 60)
  VERSION.copy(header, 64)
  const message = Buffer.concat([header, ...payload])
  if (serverTime) hmacMd5(response.sessionBaseKey, input.negotiate, input.challenge.raw, message).copy(message, 72)
  return { message, ntProof: response.ntProof, sessionBaseKey: response.sessionBaseKey }
}

/** Parsed type-3 message, for the test fixture and diagnostics. */
export function parseAuthenticateMessage(value: Buffer) {
  if (value.length < 64 || !value.subarray(0, 8).equals(SIGNATURE) || value.readUInt32LE(8) !== 3) throw new NtlmError('Malformed NTLM authenticate message')
  return {
    lmResponse: Buffer.from(field(value, 12)),
    ntResponse: Buffer.from(field(value, 20)),
    domain: field(value, 28).toString('utf16le'),
    user: field(value, 36).toString('utf16le'),
    workstation: field(value, 44).toString('utf16le'),
    flags: value.readUInt32LE(60),
    mic: value.length >= HEADER ? Buffer.from(value.subarray(72, 88)) : undefined
  }
}
