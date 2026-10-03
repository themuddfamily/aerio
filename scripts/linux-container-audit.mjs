import { mkdtempSync, rmSync, readFileSync, realpathSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Container launches require a native Linux ordinary user')
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const directory = mkdtempSync(join(tmpdir(), 'aerio-container-audit-'))

function executable(path, containerRoot) {
  const resolved = realpathSync(path)
  const location = relative(containerRoot, resolved)
  if (!location || location.startsWith('..') || isAbsolute(location) || !statSync(resolved).isFile()) throw new Error('Unsafe extracted executable')
  return resolved
}

try {
  const appImage = join(root, 'release', `Aerio-${pkg.version}-linux-x86_64.AppImage`)
  const deb = join(root, 'release', `Aerio-${pkg.version}-linux-amd64.deb`)
  const options = { cwd: directory, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }
  await exec(appImage, ['--appimage-extract'], options)
  const appDir = join(directory, 'squashfs-root')
  const application = executable(join(appDir, 'aerio'), appDir)
  const audit = join(root, 'scripts/native-platform-audit.mjs')
  const appResult = await exec(process.execPath, [audit, application], options)
  console.log('Extracted AppImage: ' + appResult.stdout.trim())
  const debDir = join(directory, 'deb')
  await exec('dpkg-deb', ['--extract', deb, debDir], options)
  const installed = executable(join(debDir, 'opt', 'Aerio', 'aerio'), debDir)
  const debResult = await exec(process.execPath, [audit, installed], options)
  console.log('Extracted DEB: ' + debResult.stdout.trim())
  // Inspect the generated desktop entry rather than assuming window association metadata survived packaging.
  const entries = readdirSync(join(debDir, 'usr/share/applications'))
  if (!entries.includes('aerio.desktop')) throw new Error('DEB desktop identity mismatch')
  const desktop = readFileSync(join(debDir, 'usr/share/applications/aerio.desktop'), 'utf8')
  if (!/^StartupWMClass=aerio$/m.test(desktop) || !/^Exec=.*aerio/m.test(desktop)) throw new Error('DEB desktop executable/window association mismatch')
  console.log('Linux release container extraction, packaged launch/restart and desktop identity audit passed.')
} finally {
  const location = relative(tmpdir(), directory)
  if (!location.startsWith('aerio-container-audit-') || location.includes('..') || isAbsolute(location)) throw new Error('Unsafe container audit cleanup')
  rmSync(directory, { recursive: true, force: true })
}
