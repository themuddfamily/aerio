import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyPlatformConfig(config) {
  const require = createRequire(import.meta.url)
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
  await validateConfiguration(config, { isEnabled: false })
  const targets = (value) => (Array.isArray(value) ? value : [value]).map((entry) => typeof entry === 'string' ? entry : entry?.target)
  if (config.appId !== 'com.aerio.desktop') throw new Error('The stable application ID must be preserved')
  if (!['dmg', 'zip'].every((target) => targets(config.mac?.target).includes(target))) throw new Error('macOS requires DMG and ZIP targets')
  if (config.mac?.hardenedRuntime !== true) throw new Error('macOS hardened runtime must remain enabled')
  if (!config.mac?.artifactName?.includes('${arch}') || !config.linux?.artifactName?.includes('${arch}')) throw new Error('Platform artifacts must include architecture')
  if (!['AppImage', 'deb'].every((target) => targets(config.linux?.target).includes(target))) throw new Error('Linux requires AppImage and DEB targets')
  if (config.linux?.executableName !== 'aerio') throw new Error('Linux executable identity must remain stable')
  if (config.win?.verifyUpdateCodeSignature !== true) throw new Error('Windows signature verification must remain enabled')
  const publish = config.publish?.find((entry) => entry.provider === 'github')
  if (publish?.owner !== 'themuddfamily' || publish.repo !== 'aerio' || publish.releaseType !== 'draft') throw new Error('Platform publishing must use the existing draft release source')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    await verifyPlatformConfig(packageJson.build)
    console.log('Platform packaging configuration passed the installed electron-builder schema and platform invariants.')
  } catch (error) {
    console.error(`Platform configuration verification failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
