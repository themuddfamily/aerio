import { describe, expect, it } from 'vitest'
import { assembleProtectedMessage, buildEncryptedEntity, buildSignedEntity, canonicalizeLineEndings, detectPgpMime, parseContentType, sevenBitEntity, splitForProtection, splitMultipart } from './openpgp-mime'

describe('PGP/MIME structure', () => {
  it('parses content types with quoted and bare parameters', () => {
    expect(parseContentType('Multipart/Signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="a \\"b\\""')).toEqual({
      type: 'multipart/signed', params: { micalg: 'pgp-sha256', protocol: 'application/pgp-signature', boundary: 'a "b"' }
    })
    expect(parseContentType(undefined)).toEqual({ type: 'text/plain', params: {} })
  })

  it('splits parts byte-for-byte, ignoring preamble and epilogue, with either line ending', () => {
    expect(splitMultipart('preamble\r\n--b\r\nA\r\n\r\none\r\n--b\r\ntwo\r\n--b--\r\nepilogue', 'b')).toEqual(['A\r\n\r\none', 'two'])
    expect(splitMultipart('--x.y\nfirst\n--x.y--\n', 'x.y')).toEqual(['first'])
    expect(splitMultipart('--b\r\nunterminated', 'b')).toEqual([])
    expect(canonicalizeLineEndings('a\nb\rc\r\nd')).toBe('a\r\nb\r\nc\r\nd')
  })

  it('makes 8bit leaves 7-bit clean while leaving encoded parts alone', () => {
    const entity = sevenBitEntity('Content-Type: multipart/mixed; boundary="m"\r\n\r\n--m\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\nGrüße\r\n--m\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n--m--\r\n')
    expect(entity).not.toMatch(/[^\x00-\x7f]/)
    expect(entity).toContain(Buffer.from('Grüße').toString('base64'))
    expect(entity).toContain('\r\nAAEC\r\n')
    expect(sevenBitEntity('Content-Type: text/plain\r\n\r\nascii only')).toBe('Content-Type: text/plain\r\n\r\nascii only')
  })

  it('separates envelope headers from protected content and reassembles them', () => {
    const { outer, inner } = splitForProtection('Subject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody\n')
    expect(outer).toEqual(['Subject: Hi'])
    expect(inner).toBe('Content-Type: text/plain\r\n\r\nBody\r\n')
    const signed = assembleProtectedMessage(outer, buildSignedEntity(inner, '-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----\n', 'pgp-sha256'))
    expect(signed).toMatch(/^Subject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: multipart\/signed/)
    const structure = detectPgpMime(signed)
    expect(structure).toEqual({ kind: 'signed', signedPart: inner, signature: '-----BEGIN PGP SIGNATURE-----\r\nx\r\n-----END PGP SIGNATURE-----' })
    const encrypted = detectPgpMime(assembleProtectedMessage(outer, buildEncryptedEntity('-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----')))
    expect(encrypted).toEqual({ kind: 'encrypted', armored: '-----BEGIN PGP MESSAGE-----\r\nabc\r\n-----END PGP MESSAGE-----\r\n' })
  })

  it('ignores multiparts that are not RFC 3156', () => {
    expect(detectPgpMime('Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="b"\r\n\r\n--b\r\nx\r\n--b--')).toEqual({ kind: 'none' })
    expect(detectPgpMime('Content-Type: multipart/signed; protocol="application/pgp-signature"\r\n\r\nno boundary')).toEqual({ kind: 'none' })
    expect(detectPgpMime('Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"\r\n\r\n--b\r\nonly one\r\n--b--')).toEqual({ kind: 'none' })
    expect(detectPgpMime('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"\r\n\r\n--b--')).toEqual({ kind: 'none' })
  })
})
