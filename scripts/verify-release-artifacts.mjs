import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { load, JSON_SCHEMA } from 'js-yaml'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
let directory = resolve(process.argv[2] ?? 'release')
const architectures = (process.argv[3] ?? 'x64').split(',')
const product = packageJson.build.productName
const version = packageJson.version

async function artifact(name) {
  const path = await realpath(join(directory, name))
  const location = relative(directory, path)
  if (!location || location.startsWith('..') || isAbsolute(location)) throw new Error(`Artifact escapes release directory: ${name}`)
  const details = await stat(path)
  if (!details.isFile() || details.size === 0) throw new Error(`Missing or empty artifact: ${name}`)
  return { path, size: details.size }
}

async function checksum(path) {
  const hash = createHash('sha512')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('base64')
}

async function check() {
  directory = await realpath(directory)
  if (!architectures.length || architectures.some((arch) => !['x64', 'arm64', 'ia32'].includes(arch)) || new Set(architectures).size !== architectures.length) throw new Error('Architectures must be a unique comma-separated list of x64, arm64, or ia32')
  const metadataFile = await artifact('latest.yml')
  const metadata = load(await readFile(metadataFile.path, 'utf8'), { schema: JSON_SCHEMA })
  if (!metadata || metadata.version !== version) throw new Error(`latest.yml must describe package version ${version}`)
  if (typeof metadata.releaseDate !== 'string' || !Number.isFinite(Date.parse(metadata.releaseDate))) throw new Error('latest.yml has an invalid releaseDate')
  if (!Array.isArray(metadata.files) || !metadata.files.length) throw new Error('latest.yml must contain installer files')
  const installers = new Map()
  for (const arch of architectures) {
    const name = `${product}-${version}-setup-${arch}.exe`
    const installer = await artifact(name)
    await artifact(`${product}-${version}-portable-${arch}.exe`)
    const blockmap = await artifact(`${name}.blockmap`)
    const map = JSON.parse(gunzipSync(await readFile(blockmap.path), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'))
    if (!['1', '2'].includes(map.version) || !Array.isArray(map.files) || !map.files.length) throw new Error(`Invalid blockmap structure: ${name}`)
    let offset = 0
    for (const file of map.files) {
      if (typeof file.name !== 'string' || file.offset !== offset || !Array.isArray(file.sizes) || !file.sizes.length || !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length || file.checksums.some((value) => typeof value !== 'string' || !value) || file.sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) throw new Error(`Invalid blockmap chunks: ${name}`)
      offset += file.sizes.reduce((sum, size) => sum + size, 0)
    }
    if (offset !== installer.size) throw new Error(`Blockmap does not cover installer size: ${name}`)
    installers.set(name, { ...installer, hash: await checksum(installer.path) })
    const unpacked = arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`
    const configFile = await artifact(`${unpacked}/resources/app-update.yml`)
    const config = load(await readFile(configFile.path, 'utf8'), { schema: JSON_SCHEMA })
    const publish = packageJson.build.publish.find((entry) => entry.provider === 'github')
    if (config?.provider !== 'github' || config.owner !== publish.owner || config.repo !== publish.repo) throw new Error(`Incorrect installed update provider: ${unpacked}`)
  }
  const referenced = new Set()
  for (const file of metadata.files) {
    if (typeof file.url !== 'string') throw new Error('latest.yml contains an invalid installer URL')
    const name = decodeURIComponent(file.url)
    const installer = installers.get(name)
    if (!installer || referenced.has(name)) throw new Error(`latest.yml references an unexpected or duplicate installer: ${file.url}`)
    if (file.size !== installer.size || file.sha512 !== installer.hash) throw new Error(`latest.yml size/checksum mismatch: ${name}`)
    referenced.add(name)
  }
  if (referenced.size !== installers.size) throw new Error('latest.yml omits a required installer architecture')
  if (metadata.path !== undefined || metadata.sha512 !== undefined) {
    const installer = installers.get(metadata.path)
    if (!installer || metadata.sha512 !== installer.hash) throw new Error('latest.yml legacy path/checksum disagrees with installer files')
  }
  console.log(`Release artifacts verified for Aerio ${version} (${architectures.join(', ')}): installers, portable executables, blockmaps, latest.yml checksums, and installed update configuration.`)
}

try { await check() } catch (error) {
  console.error(`Release artifact verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
