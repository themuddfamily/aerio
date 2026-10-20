import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
if (process.platform !== 'darwin') { console.log('macOS native integrations are built on macOS only.'); process.exit(0) }
const require = createRequire(import.meta.url)
const headers = resolve(dirname(require.resolve('node-api-headers/package.json')), 'include')
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'build/native')
mkdirSync(output, { recursive: true })
for (const name of ['apple-script', 'spotlight']) {
  const result = spawnSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=12.0', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-DNAPI_VERSION=8', '-I', headers, '-framework', 'Cocoa', ...(name === 'spotlight' ? ['-framework', 'CoreSpotlight'] : []), resolve(root, `native/macos/${name}.mm`), '-o', resolve(output, `${name}.node`)], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`macOS ${name} compilation failed: ${result.error ?? result.status}`)
}
