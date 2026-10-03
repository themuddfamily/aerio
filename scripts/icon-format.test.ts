import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { encodeIcns } from './icon-format.mjs'

async function images() {
  return new Map(await Promise.all([128, 256, 512, 1024].map(async (size) => [size, await sharp({ create: { width: size, height: size, channels: 4, background: '#7667f7' } }).png().toBuffer()] as const)))
}

describe('macOS icon resources', () => {
  it('encodes each PNG representation with correct ICNS chunk and file lengths', async () => {
    const encoded = encodeIcns(await images())
    expect(encoded.subarray(0, 4).toString()).toBe('icns')
    expect(encoded.readUInt32BE(4)).toBe(encoded.length)
    let offset = 8
    for (const [type, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]] as const) {
      expect(encoded.subarray(offset, offset + 4).toString()).toBe(type)
      const length = encoded.readUInt32BE(offset + 4)
      const decoded = await sharp(encoded.subarray(offset + 8, offset + length)).metadata()
      expect(decoded).toMatchObject({ format: 'png', width: size, height: size })
      offset += length
    }
    expect(offset).toBe(encoded.length)
  })

  it.each(['missing', 'size', 'format'])('rejects %s representations', async (kind) => {
    const input = await images()
    if (kind === 'missing') input.delete(256)
    if (kind === 'size') input.set(256, input.get(128)!)
    if (kind === 'format') input.set(256, Buffer.alloc(30))
    expect(() => encodeIcns(input)).toThrow(/256px PNG/)
  })
})
