import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const failures = []
const publish = packageJson.build?.publish?.find((entry) => entry.provider === 'github')
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  failures.push(`package.json version "${packageJson.version}" is not a supported release version`)
}
if (tag && tag !== `v${packageJson.version}`) {
  failures.push(`tag ${tag} does not match package version v${packageJson.version}`)
}
if (!packageJson.dependencies?.['electron-updater']) {
  failures.push('electron-updater must be a production dependency')
}
if (publish?.owner !== 'themuddfamily' || publish?.repo !== 'aerio') {
  failures.push('electron-builder must publish update metadata to themuddfamily/aerio')
}
if (publish?.releaseType !== 'draft') {
  failures.push('release builds must remain drafts until they have been reviewed')
}
if (packageJson.build?.win?.verifyUpdateCodeSignature !== true) {
  failures.push('Windows update signature verification must remain enabled')
}
if (process.env.AERIO_REQUIRE_SIGNING === '1') {
  if (!process.env.WIN_CSC_LINK) failures.push('WIN_CSC_LINK is required for a release build')
  if (!process.env.WIN_CSC_KEY_PASSWORD) failures.push('WIN_CSC_KEY_PASSWORD is required for a release build')
}

if (failures.length) {
  console.error(`Release preflight failed:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(`Release preflight passed for Aerio ${packageJson.version}${tag ? ` (${tag})` : ''}.`)
}
