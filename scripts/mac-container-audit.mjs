import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('macOS container audits require a native macOS host')
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const directory = mkdtempSync(join(tmpdir(), 'aerio-mac-container-'))
const mount = join(directory, 'mounted')
let mounted = false
const options = { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
function ownedExecutable(appRoot) {
  const executable = realpathSync(join(appRoot, 'Aerio.app', 'Contents', 'MacOS', 'Aerio'))
  const location = relative(realpathSync(appRoot), executable)
  if (!location || location.startsWith('..') || isAbsolute(location) || !statSync(executable).isFile()) throw new Error('Unsafe macOS container executable')
  return executable
}
try {
  const zip = join(root, 'release', `Aerio-${pkg.version}-mac-${process.arch}.zip`)
  const dmg = join(root, 'release', `Aerio-${pkg.version}-mac-${process.arch}.dmg`)
  const extracted = join(directory, 'zip')
  await exec('ditto', ['-xk', zip, extracted], options)
  const audit = join(root, 'scripts/native-platform-audit.mjs')
  const zipped = await exec(process.execPath, [audit, ownedExecutable(extracted)], options)
  console.log('Extracted ZIP: ' + zipped.stdout.trim())
  mkdirSync(mount)
  await exec('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], options)
  mounted = true
  const disk = await exec(process.execPath, [audit, ownedExecutable(mount)], options)
  console.log('Mounted DMG: ' + disk.stdout.trim())
  await exec('hdiutil', ['detach', mount], options)
  mounted = false
  console.log('Native macOS ZIP extraction and read-only DMG packaged launch audits passed.')
} finally {
  // Never recursively clean a directory while its read-only image is mounted.
  if (mounted) await exec('hdiutil', ['detach', mount], options)
  const location = relative(tmpdir(), directory)
  if (!location.startsWith('aerio-mac-container-') || location.includes('..') || isAbsolute(location)) throw new Error('Unsafe macOS audit cleanup')
  rmSync(directory, { recursive: true, force: true })
}
