import { describe, expect, it } from 'vitest'
import { md4 } from './md4'
import {
  authenticateMessage, AV, encodeAvPairs, negotiateMessage, ntHash, ntlmIdentity, ntlmV2Response, ntowfV2, parseAuthenticateMessage, parseAvPairs, parseChallengeMessage
} from './ntlm'

const hex = (value: Buffer) => value.toString('hex')

describe('MD4 (RFC 1320 test suite)', () => {
  it.each([
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '043f8582f241db351ce627e153e7f0e4'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', 'e33b4ddc9c38f2199c3e7b164fcc0536']
  ])('hashes %j', (input, expected) => {
    expect(hex(md4(Buffer.from(input, 'latin1')))).toBe(expected)
  })

  it('handles inputs around the 56-byte padding boundary', () => {
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120]) expect(md4(Buffer.alloc(length, 0x61))).toHaveLength(16)
  })
})

// MS-NLMP 4.2.2 and 4.2.4: User "User", Domain "Domain", password "Password".
const serverChallenge = Buffer.from('0123456789abcdef', 'hex')
const clientChallenge = Buffer.from('aaaaaaaaaaaaaaaa', 'hex')
const targetInfo = encodeAvPairs([{ id: AV.NB_DOMAIN, value: Buffer.from('Domain', 'utf16le') }, { id: AV.NB_COMPUTER, value: Buffer.from('Server', 'utf16le') }])

describe('NTLMv2 (MS-NLMP test vectors)', () => {
  it('derives the NT hash and NTOWFv2 key', () => {
    expect(hex(ntHash('Password'))).toBe('a4f49c406510bdcab6824ee7c30fd852')
    expect(hex(ntowfV2('Password', 'User', 'Domain'))).toBe('0c868a403bfd7a93a3001ef22ef02e3f')
  })

  it('computes NTProofStr, the LMv2 response, and the session base key', () => {
    const result = ntlmV2Response({ ntowf: ntowfV2('Password', 'User', 'Domain'), serverChallenge, clientChallenge, timestamp: Buffer.alloc(8), targetInfo })
    expect(hex(result.ntProof)).toBe('68cd0ab851e51c96aabc927bebef6a1c')
    expect(hex(result.lmResponse)).toBe('86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa')
    expect(hex(result.sessionBaseKey)).toBe('8de40ccadbc14a82f15cb0ad0de95ca3')
  })

  it('splits DOMAIN\\user and keeps UPNs whole', () => {
    expect(ntlmIdentity('CONTOSO\\ada')).toEqual({ domain: 'CONTOSO', user: 'ada' })
    expect(ntlmIdentity('ada@contoso.test')).toEqual({ domain: '', user: 'ada@contoso.test' })
  })

  it('builds negotiate and authenticate messages a server can verify, with a MIC when the server sends a timestamp', () => {
    const negotiate = negotiateMessage()
    expect(negotiate.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0')
    expect(negotiate.readUInt32LE(8)).toBe(1)
    const info = encodeAvPairs([{ id: AV.NB_DOMAIN, value: Buffer.from('CONTOSO', 'utf16le') }, { id: AV.TIMESTAMP, value: Buffer.alloc(8, 1) }])
    const challengeBytes = Buffer.alloc(48 + info.length)
    Buffer.from('NTLMSSP\0', 'latin1').copy(challengeBytes)
    challengeBytes.writeUInt32LE(2, 8)
    challengeBytes.writeUInt32LE(48, 16)
    challengeBytes.writeUInt32LE(0xe28a8235 >>> 0, 20)
    serverChallenge.copy(challengeBytes, 24)
    challengeBytes.writeUInt16LE(info.length, 40)
    challengeBytes.writeUInt16LE(info.length, 42)
    challengeBytes.writeUInt32LE(48, 44)
    info.copy(challengeBytes, 48)
    const challenge = parseChallengeMessage(challengeBytes)
    const { message, ntProof } = authenticateMessage({ username: 'CONTOSO\\ada', password: 'Pa55w0rd!', challenge, negotiate, clientChallenge })
    const parsed = parseAuthenticateMessage(message)
    expect(parsed).toMatchObject({ domain: 'CONTOSO', user: 'ada', workstation: 'AERIO' })
    // Zero LM response and a non-zero MIC because the challenge carried MsvAvTimestamp.
    expect(parsed.lmResponse.equals(Buffer.alloc(24))).toBe(true)
    expect(parsed.mic?.equals(Buffer.alloc(16))).toBe(false)
    expect(parsed.ntResponse.subarray(0, 16).equals(ntProof)).toBe(true)
    // The client announces the MIC in MsvAvFlags inside its copy of the target information.
    const blob = parsed.ntResponse.subarray(16)
    const pairs = parseAvPairs(blob.subarray(28))
    expect(pairs.find((pair) => pair.id === AV.FLAGS)?.value.readUInt32LE(0)).toBe(2)
  })

  it('rejects malformed challenges', () => {
    expect(() => parseChallengeMessage(Buffer.from('not ntlm at all, really not'))).toThrow(/malformed/)
  })
})
