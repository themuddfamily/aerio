import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { setLinuxLoginItem } from '../electron/linux-login.ts'

if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Run the login audit as an ordinary Linux user')
const home = mkdtempSync(join(tmpdir(), 'aerio-login-exec-'))
try {
  const executable = join(home, 'Aerio "`$\\%; probe')
  const output = join(home, 'arguments.json')
  writeFileSync(executable, '#!/usr/bin/python3\nimport json, sys\nwith open(' + JSON.stringify(output) + ', "w") as target:\n    json.dump(sys.argv, target)\n', { mode: 0o700 })
  const options = { home, executable }
  setLinuxLoginItem(true, options)
  const entry = join(home, '.config', 'autostart', 'aerio.desktop')
  const launch = spawnSync('gio', ['launch', entry], { encoding: 'utf8', timeout: 15_000 })
  if (launch.error || launch.status !== 0) throw new Error(`Desktop launcher rejected the entry: ${launch.stderr}\n${readFileSync(entry, 'utf8')}`)
  for (let attempt = 0; attempt < 100 && !existsSync(output); attempt++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), [executable, '--aerio-login'])
  setLinuxLoginItem(false, options)
  assert.equal(existsSync(entry), false)
  console.log('Linux desktop launcher preserves reserved executable characters and the login argument; owned removal passes.')
} finally {
  const location = relative(tmpdir(), home)
  if (!location.startsWith('aerio-login-exec-') || location.includes('..') || isAbsolute(location)) throw new Error('Unsafe login audit cleanup')
  rmSync(home, { recursive: true, force: true })
}
