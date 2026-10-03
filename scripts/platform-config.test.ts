import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { verifyPlatformConfig } from './verify-platform-config.mjs'

describe('native platform packaging configuration', () => {
  it('validates the actual configuration against the installed builder schema', async () => {
    await expect(verifyPlatformConfig(structuredClone(packageJson.build))).resolves.toBeUndefined()
  })

  it.each(['zip', 'runtime', 'architecture', 'linux-target', 'identity', 'signature', 'publish', 'schema'])('refuses a broken %s configuration', async (kind) => {
    const config: any = structuredClone(packageJson.build)
    if (kind === 'zip') config.mac.target = ['dmg']
    if (kind === 'runtime') config.mac.hardenedRuntime = false
    if (kind === 'architecture') config.mac.artifactName = 'Aerio.${ext}'
    if (kind === 'linux-target') config.linux.target = ['AppImage']
    if (kind === 'identity') config.appId = 'different.app'
    if (kind === 'signature') config.win.verifyUpdateCodeSignature = false
    if (kind === 'publish') config.publish[0].releaseType = 'release'
    if (kind === 'schema') config.mac.notARealBuilderOption = true
    await expect(verifyPlatformConfig(config)).rejects.toThrow()
  })
})
