import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import packageJson from '../package.json'
import { verifyPlatformArtifacts } from './verify-platform-artifacts.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')

function binary(platform: string, arch: string) {
  const bytes = Buffer.alloc(64)
  if (platform === 'mac') {
    bytes.writeUInt32LE(0xfeedfacf)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  }
  return bytes
}

function map(size: number) {
  return { version: '2', files: [{ name: 'file', offset: 0, sizes: [size], checksums: ['fixture'] }] }
}

async function fixture(platform: string, arch = 'x64') {
  const directory = await mkdtemp(join(tmpdir(), 'aerio-platform-artifacts-'))
  async function put(name: string, data: string | Buffer, mode?: number) {
    const path = join(directory, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, data, { mode })
  }
  const extensions = platform === 'mac' ? ['dmg', 'zip'] : ['AppImage', 'deb']
  const metadata: any = { version: packageJson.version, releaseDate: '2026-10-01T12:00:00Z', files: [] }
  for (const ext of extensions) {
    const artifactArch = platform === 'linux' && arch === 'x64' ? (ext === 'deb' ? 'amd64' : 'x86_64') : arch
    const name = `Aerio-${packageJson.version}-${platform}-${artifactArch}.${ext}`
    let bytes = Buffer.alloc(ext === 'dmg' ? 1024 : 64)
    let blockMapSize: number | undefined
    if (ext === 'dmg') bytes.write('koly', bytes.length - 512)
    if (ext === 'zip') bytes.write('504b0304', 0, 'hex')
    if (ext === 'deb') bytes.write('!<arch>\n')
    if (ext === 'AppImage') {
      bytes = binary('linux', arch)
      bytes.set([0x41, 0x49, 2], 8)
      const compressed = deflateRawSync(JSON.stringify(map(bytes.length)))
      const length = Buffer.alloc(4)
      length.writeUInt32BE(compressed.length)
      bytes = Buffer.concat([bytes, compressed, length])
      blockMapSize = compressed.length
    }
    await put(name, bytes)
    if (platform === 'mac') await put(`${name}.blockmap`, gzipSync(JSON.stringify(map(bytes.length))))
    metadata.files.push({ url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64'), ...(blockMapSize === undefined ? {} : { blockMapSize }) })
  }
  const base = platform === 'mac' ? `${arch === 'x64' ? 'mac' : `mac-${arch}`}/Aerio.app/Contents` : arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`
  const resources = `${base}/${platform === 'mac' ? 'Resources' : 'resources'}`
  const executable = platform === 'mac' ? `${base}/MacOS/Aerio` : `${base}/aerio`
  await put(executable, binary(platform, arch), 0o755)
  await put(`${resources}/app-update.yml`, 'provider: github\nowner: themuddfamily\nrepo: aerio\n')
  for (const file of ['icon.png', 'trayTemplate.png', 'trayTemplate@2x.png']) await put(`${resources}/build/${file}`, 'fixture resource')
  await put('source/package.json', JSON.stringify({ name: packageJson.name, version: packageJson.version, main: packageJson.main }))
  for (const file of ['dist/index.html', 'dist-electron/main/main.js', 'dist-electron/main/mail-worker.js', 'dist-electron/preload/preload.cjs']) await put(`source/${file}`, 'fixture application')
  const archive = join(directory, resources, 'app.asar')
  await asar.createPackage(join(directory, 'source'), archive)
  const manifest = platform === 'mac' ? 'latest-mac.yml' : `latest-linux${arch === 'x64' ? '' : `-${arch}`}.yml`
  await put(manifest, JSON.stringify(metadata))
  return { directory, metadata, resources, executable, archive, put, manifest }
}

describe('platform artifact verification', () => {
  it.each([['mac', 'x64'], ['mac', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']])('validates %s/%s files, real ASAR entries and metadata before requesting native container checks', async (platform, arch) => {
    const f = await fixture(platform, arch)
    try {
      const checkContainers = vi.fn(async () => {})
      const result = await verifyPlatformArtifacts({ directory: f.directory, platform, arch, packageJson, checkContainers })
      expect(result).toMatchObject({ platform, arch, version: packageJson.version })
      expect(checkContainers).toHaveBeenCalledOnce()
      expect(checkContainers.mock.calls[0]).toHaveLength(1)
    } finally { await rm(f.directory, { recursive: true, force: true }) }
  })

  for (const platform of ['mac', 'linux']) {
    it.each(['version', 'date', 'checksum', 'size', 'duplicate', 'omitted', 'url', 'legacy', 'architecture', 'resource', 'provider', 'asar', 'app-identity', 'missing-entry', 'header', 'blockmap', 'native-failure'])(`${platform} rejects %s`, async (kind) => {
      const f = await fixture(platform)
      try {
        if (kind === 'version') f.metadata.version = '0.0.0'
        if (kind === 'date') f.metadata.releaseDate = 'not a date'
        if (kind === 'checksum') f.metadata.files[0].sha512 = 'wrong'
        if (kind === 'size') f.metadata.files[0].size++
        if (kind === 'duplicate') f.metadata.files.push(f.metadata.files[0])
        if (kind === 'omitted') f.metadata.files.pop()
        if (kind === 'url') f.metadata.files[0].url = '..%2Foutside'
        if (kind === 'legacy') { f.metadata.path = f.metadata.files[0].url; f.metadata.sha512 = 'wrong' }
        if (kind === 'architecture') await f.put(f.executable, binary(platform, 'arm64'), 0o755)
        if (kind === 'resource') await unlink(join(f.directory, f.resources, 'build/trayTemplate.png'))
        if (kind === 'provider') await f.put(`${f.resources}/app-update.yml`, 'provider: github\nowner: incorrect\nrepo: aerio')
        if (kind === 'asar') await f.put(`${f.resources}/app.asar`, 'not an asar')
        if (kind === 'app-identity' || kind === 'missing-entry') {
          if (kind === 'app-identity') await f.put('source/package.json', JSON.stringify({ name: packageJson.name, version: '0.0.0', main: packageJson.main }))
          else await unlink(join(f.directory, 'source/dist-electron/preload/preload.cjs'))
          await asar.createPackage(join(f.directory, 'source'), f.archive)
        }
        if (kind === 'header') await f.put(f.metadata.files[0].url, Buffer.alloc(1024))
        if (kind === 'blockmap') {
          if (platform === 'mac') await f.put(`${f.metadata.files[0].url}.blockmap`, gzipSync(JSON.stringify(map(1))))
          else {
            const bytes = await readFile(join(f.directory, f.metadata.files[0].url))
            bytes.writeUInt32BE(0, bytes.length - 4)
            await f.put(f.metadata.files[0].url, bytes)
          }
        }
        await f.put(f.manifest, JSON.stringify(f.metadata))
        const checkContainers = vi.fn(async () => { if (kind === 'native-failure') throw new Error('Native container validation failed') })
        await expect(verifyPlatformArtifacts({ directory: f.directory, platform, arch: 'x64', packageJson, checkContainers })).rejects.toThrow()
        if (kind !== 'native-failure') expect(checkContainers).not.toHaveBeenCalled()
      } finally { await rm(f.directory, { recursive: true, force: true }) }
    })
  }
})
