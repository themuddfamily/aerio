import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Run the native Linux audit as an ordinary user')
const session = process.argv[2] === '--session'
const argument = process.argv[session ? 3 : 2]
const executable = argument?.startsWith('--') ? argument : resolve(argument ?? 'release/linux-unpacked/aerio')
const exec = promisify(execFile)

async function run(command, args, options = {}, timeout = 150_000) {
  const child = spawn(command, args, { stdio: 'inherit', detached: true, ...options })
  const timer = setTimeout(() => {
    if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM')
  }, timeout)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => signal ? reject(new Error(`Audit terminated: ${signal}`)) : resolve(code ?? 1))
    })
  } finally { clearTimeout(timer) }
}
if (session) {
  const daemon = spawnSync('gnome-keyring-daemon', ['--unlock', '--components=secrets'], { input: 'disposable-native-keyring-password\n', encoding: 'utf8', timeout: 15_000 })
  if (daemon.error || daemon.status !== 0) throw new Error('Disposable Secret Service could not start')
  const environment = { ...process.env, XDG_CURRENT_DESKTOP: 'GNOME' }
  if (['--button-audit', '--preferences', '--desktop'].includes(executable)) environment.AERIO_TEST_VISIBLE = '1'
  for (const line of daemon.stdout.split('\n')) {
    const match = /^(GNOME_KEYRING_CONTROL)=(.+)$/.exec(line)
    if (match) environment[match[1]] = match[2].replace(/;.*$/, '')
  }
  const manager = spawn('openbox', ['--sm-disable'], { env: environment, stdio: 'ignore' })
  let managerError
  manager.once('error', (error) => { managerError = error })
  try {
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (managerError) throw managerError
      if (manager.exitCode !== null) throw new Error('Window manager exited before the audit')
      const property = await exec('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env: environment })
      if (/window id # 0x[1-9a-f]/i.test(property.stdout)) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Window manager did not become ready')
    const loginCheck = await run(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'linux-login-exec-audit.mjs')], { env: environment }, 30_000)
    if (loginCheck !== 0) throw new Error('Native Linux login entry audit failed')
    let args
    let command = process.execPath
    if (executable === '--button-audit') args = [join(import.meta.dirname, 'desktop-button-audit.mjs')]
    else if (executable === '--preferences') args = [join(import.meta.dirname, 'desktop-preferences-audit.mjs')]
    else if (executable === '--desktop') { command = 'npm'; args = ['run', 'test:desktop'] }
    else if (executable === '--containers') args = [join(import.meta.dirname, 'linux-container-audit.mjs')]
    else if (executable.startsWith('--')) throw new Error('Unknown Linux audit mode')
    else args = [join(import.meta.dirname, 'native-platform-audit.mjs'), executable]
    process.exitCode = await run(command, args, { env: environment }, executable === '--desktop' ? 900_000 : 150_000)
  } finally {
    manager.kill('SIGTERM')
    spawnSync('gnome-keyring-daemon', ['--shutdown'], { env: environment, stdio: 'ignore', timeout: 10_000 })
  }
} else {
  const home = mkdtempSync(join(tmpdir(), 'aerio-native-home-'))
  const runtime = join(home, 'runtime')
  mkdirSync(runtime, { mode: 0o700 })
  try {
    process.exitCode = await run('dbus-run-session', ['--', 'xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', process.execPath, import.meta.filename, '--session', executable], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_RUNTIME_DIR: runtime }
    }, executable === '--desktop' ? 960_000 : 180_000)
  } finally {
    const location = relative(tmpdir(), home)
    if (!location.startsWith('aerio-native-home-') || location.includes('..') || isAbsolute(location)) throw new Error('Unsafe audit home cleanup path')
    rmSync(home, { recursive: true, force: true })
  }
}
