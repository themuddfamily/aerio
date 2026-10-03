import { createReadStream } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { load, JSON_SCHEMA } from 'js-yaml'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

async function range(path, position, length) {
  const handle = await open(path, 'r')
  try {
    const result = Buffer.alloc(length)
    const { bytesRead } = await handle.read(result, 0, length, position)
    if (bytesRead !== length) throw new Error('Truncated artifact')
    return result
  } finally { await handle.close() }
}

function blockmap(bytes, expectedSize, compressed = 'gzip') {
  const decode = compressed === 'gzip' ? gunzipSync : inflateRawSync
  const map = JSON.parse(decode(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'))
  if (!['1', '2'].includes(map.version) || !Array.isArray(map.files) || !map.files.length) throw new Error('Invalid blockmap structure')
  let offset = 0
  for (const file of map.files) {
    if (typeof file.name !== 'string' || file.offset !== offset || !Array.isArray(file.sizes) || !file.sizes.length || !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length || file.sizes.some((size) => !Number.isSafeInteger(size) || size <= 0) || file.checksums.some((hash) => typeof hash !== 'string' || !hash)) throw new Error('Invalid blockmap chunks')
    offset += file.sizes.reduce((sum, size) => sum + size, 0)
    if (!Number.isSafeInteger(offset)) throw new Error('Invalid blockmap size')
  }
  if (offset !== expectedSize) throw new Error('Blockmap does not cover artifact size')
}

async function sha512(path) {
  const hash = createHash('sha512')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('base64')
}

function binaryArchitecture(header, platform, arch) {
  if (platform === 'mac') {
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007)) throw new Error('Incorrect Mach-O executable architecture')
  } else if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)) {
    throw new Error('Incorrect ELF executable architecture')
  }
}

async function nativeCheck({ platform, arch, artifacts }) {
  if (process.platform !== (platform === 'mac' ? 'darwin' : 'linux')) throw new Error('Container validation requires the native platform host')
  const options = { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }
  if (platform === 'mac') {
    await run('hdiutil', ['verify', artifacts.get('dmg').path], options)
    await run('unzip', ['-t', artifacts.get('zip').path], options)
    const listing = await run('unzip', ['-Z1', artifacts.get('zip').path], options)
    for (const entry of ['Contents/MacOS/Aerio', 'Contents/Resources/app.asar', 'Contents/Resources/app-update.yml']) {
      if (!listing.stdout.split('\n').includes(`Aerio.app/${entry}`)) throw new Error(`ZIP omits ${entry}`)
    }
  } else {
    const architecture = await run('dpkg-deb', ['--field', artifacts.get('deb').path, 'Architecture'], options)
    if (architecture.stdout.trim() !== (arch === 'x64' ? 'amd64' : 'arm64')) throw new Error('Incorrect DEB architecture')
    const listing = await run('dpkg-deb', ['--contents', artifacts.get('deb').path], options)
    for (const entry of ['/aerio', '/resources/app.asar', '/resources/app-update.yml']) {
      if (!listing.stdout.split('\n').some((line) => line.trimEnd().endsWith(entry))) throw new Error(`DEB omits ${entry}`)
    }
  }
}

export async function verifyPlatformArtifacts({ directory = 'release', platform, arch = process.arch, packageJson, checkContainers = nativeCheck }) {
  if (!['mac', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Specify mac/linux and x64/arm64')
  const root = await realpath(resolve(directory))
  const product = packageJson.build.productName
  const version = packageJson.version
  async function artifact(name) {
    const path = await realpath(join(root, name))
    const location = relative(root, path)
    if (!location || location.startsWith('..') || isAbsolute(location)) throw new Error('Artifact escapes release directory')
    const info = await stat(path)
    if (!info.isFile() || !info.size) throw new Error(`Missing or empty artifact: ${name}`)
    return { path, size: info.size, mode: info.mode }
  }
  const extensions = platform === 'mac' ? ['dmg', 'zip'] : ['AppImage', 'deb']
  const artifacts = new Map()
  const names = new Map()
  for (const extension of extensions) {
    const artifactArch = platform === 'linux' && arch === 'x64' ? (extension === 'deb' ? 'amd64' : 'x86_64') : arch
    const name = `${product}-${version}-${platform}-${artifactArch}.${extension}`
    const file = await artifact(name)
    const header = await range(file.path, 0, 24)
    if (extension === 'zip' && !header.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) throw new Error('Invalid ZIP header')
    if (extension === 'dmg' && (file.size < 512 || (await range(file.path, file.size - 512, 4)).toString() !== 'koly')) throw new Error('Invalid DMG trailer')
    if (extension === 'deb' && header.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('Invalid DEB header')
    if (extension === 'AppImage') {
      binaryArchitecture(header, 'linux', arch)
      if (!header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2]))) throw new Error('Invalid AppImage runtime marker')
      const size = (await range(file.path, file.size - 4, 4)).readUInt32BE(0)
      if (!size || size > 16 * 1024 * 1024 || size + 4 >= file.size) throw new Error('Invalid embedded blockmap length')
      blockmap(await range(file.path, file.size - size - 4, size), file.size - size - 4, 'deflate')
      file.blockMapSize = size
    } else if (platform === 'mac') {
      const map = await artifact(`${name}.blockmap`)
      if (map.size > 16 * 1024 * 1024) throw new Error('Oversized blockmap')
      blockmap(await readFile(map.path), file.size)
    }
    file.hash = await sha512(file.path)
    artifacts.set(extension, file)
    names.set(name, file)
  }
  const manifestName = platform === 'mac' ? 'latest-mac.yml' : `latest-linux${arch === 'x64' ? '' : `-${arch}`}.yml`
  const manifest = await artifact(manifestName)
  if (manifest.size > 1024 * 1024) throw new Error('Oversized update metadata')
  const metadata = load(await readFile(manifest.path, 'utf8'), { schema: JSON_SCHEMA })
  if (metadata?.version !== version || typeof metadata.releaseDate !== 'string' || !Number.isFinite(Date.parse(metadata.releaseDate)) || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Invalid platform update metadata')
  const referenced = new Set()
  for (const entry of metadata.files) {
    if (typeof entry?.url !== 'string') throw new Error('Invalid artifact URL')
    const name = decodeURIComponent(entry.url)
    const file = names.get(name)
    if (!file || referenced.has(name) || entry.size !== file.size || entry.sha512 !== file.hash || (file.blockMapSize !== undefined && entry.blockMapSize !== file.blockMapSize)) throw new Error('Unexpected, duplicate or inconsistent artifact metadata')
    referenced.add(name)
  }
  if (referenced.size !== names.size) throw new Error('Update metadata omits required artifacts')
  if (metadata.path !== undefined || metadata.sha512 !== undefined) {
    if (!names.has(metadata.path) || names.get(metadata.path).hash !== metadata.sha512) throw new Error('Inconsistent legacy update metadata')
  }
  const unpacked = platform === 'mac' ? (arch === 'x64' ? 'mac' : `mac-${arch}`) : (arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`)
  const base = platform === 'mac' ? `${unpacked}/${product}.app/Contents` : unpacked
  const resources = platform === 'mac' ? `${base}/Resources` : `${base}/resources`
  const executable = await artifact(platform === 'mac' ? `${base}/MacOS/${product}` : `${base}/aerio`)
  binaryArchitecture(await range(executable.path, 0, 24), platform, arch)
  if (process.platform !== 'win32' && !(executable.mode & 0o111)) throw new Error('Packaged executable is not executable')
  const update = await artifact(`${resources}/app-update.yml`)
  const config = load(await readFile(update.path, 'utf8'), { schema: JSON_SCHEMA })
  const publish = packageJson.build.publish.find((entry) => entry.provider === 'github')
  if (config?.provider !== 'github' || config.owner !== publish.owner || config.repo !== publish.repo) throw new Error('Incorrect packaged update provider')
  await artifact(`${resources}/build/icon.png`)
  await artifact(`${resources}/build/trayTemplate.png`)
  await artifact(`${resources}/build/trayTemplate@2x.png`)
  const archive = await artifact(`${resources}/app.asar`)
  for (const entry of ['package.json', 'dist/index.html', 'dist-electron/main/main.js', 'dist-electron/main/mail-worker.js', 'dist-electron/preload/preload.cjs']) {
    const details = asar.statFile(archive.path, join(...entry.split('/')), false)
    if (!details.size || details.unpacked || details.link) throw new Error(`Invalid packaged application resource: ${entry}`)
  }
  const installed = JSON.parse(asar.extractFile(archive.path, 'package.json').toString('utf8'))
  if (installed.version !== version || installed.main !== packageJson.main || installed.name !== packageJson.name) throw new Error('Packaged application identity mismatch')
  await checkContainers({ platform, arch, artifacts })
  return { platform, arch, version, artifacts: [...names.keys()], manifest: manifestName }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const result = await verifyPlatformArtifacts({ platform: process.argv[2], directory: process.argv[3], arch: process.argv[4], packageJson })
    console.log(`Platform artifacts verified: ${JSON.stringify(result)}`)
  } catch (error) {
    console.error(`Platform artifact verification failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
