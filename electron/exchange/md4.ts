// MD4 (RFC 1320) in plain TypeScript. NTLM's NT hash is MD4(UTF-16LE(password)), but OpenSSL 3
// moved MD4 to its legacy provider, so `createHash('md4')` throws in current Node and Electron
// builds. MD4 is used here only to derive the NTLM key; it is not a general-purpose hash.

const rotl = (value: number, shift: number) => (value << shift) | (value >>> (32 - shift))

export function md4(input: Uint8Array): Buffer {
  const length = input.length
  // Pad with 0x80, zeros to 56 mod 64, then the 64-bit little-endian bit length.
  const padded = new Uint8Array(((length + 8) >>> 6) * 64 + 64)
  padded.set(input)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = length * 8
  view.setUint32(padded.length - 8, bits >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bits / 0x1_0000_0000) >>> 0, true)

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const x = new Array<number>(16)
  const f = (p: number, q: number, r: number) => (p & q) | (~p & r)
  const g = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r)
  const h = (p: number, q: number, r: number) => p ^ q ^ r

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) x[index] = view.getUint32(offset + index * 4, true)
    const [aa, bb, cc, dd] = [a, b, c, d]
    // Round 1
    for (const k of [0, 4, 8, 12]) {
      a = rotl((a + f(b, c, d) + x[k]) | 0, 3)
      d = rotl((d + f(a, b, c) + x[k + 1]) | 0, 7)
      c = rotl((c + f(d, a, b) + x[k + 2]) | 0, 11)
      b = rotl((b + f(c, d, a) + x[k + 3]) | 0, 19)
    }
    // Round 2
    for (const k of [0, 1, 2, 3]) {
      a = rotl((a + g(b, c, d) + x[k] + 0x5a827999) | 0, 3)
      d = rotl((d + g(a, b, c) + x[k + 4] + 0x5a827999) | 0, 5)
      c = rotl((c + g(d, a, b) + x[k + 8] + 0x5a827999) | 0, 9)
      b = rotl((b + g(c, d, a) + x[k + 12] + 0x5a827999) | 0, 13)
    }
    // Round 3
    for (const k of [0, 2, 1, 3]) {
      a = rotl((a + h(b, c, d) + x[k] + 0x6ed9eba1) | 0, 3)
      d = rotl((d + h(a, b, c) + x[k + 8] + 0x6ed9eba1) | 0, 9)
      c = rotl((c + h(d, a, b) + x[k + 4] + 0x6ed9eba1) | 0, 11)
      b = rotl((b + h(c, d, a) + x[k + 12] + 0x6ed9eba1) | 0, 15)
    }
    a = (a + aa) | 0
    b = (b + bb) | 0
    c = (c + cc) | 0
    d = (d + dd) | 0
  }
  const out = Buffer.alloc(16)
  out.writeInt32LE(a, 0)
  out.writeInt32LE(b, 4)
  out.writeInt32LE(c, 8)
  out.writeInt32LE(d, 12)
  return out
}
