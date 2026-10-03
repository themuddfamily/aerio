// PNG-backed ICNS representations avoid host-specific iconutil during resource generation.
const representations = new Map([[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']])

export function encodeIcns(images) {
  const chunks = []
  for (const [size, type] of representations) {
    const png = images.get(size)
    if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
      throw new Error(`ICNS requires a square ${size}px PNG`)
    }
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    chunks.push(header, png)
  }
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}
