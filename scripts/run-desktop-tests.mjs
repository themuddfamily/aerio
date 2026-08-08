import { spawnSync } from 'node:child_process'

const visible = process.argv.includes('--visible') || process.env.AERIO_TEST_VISIBLE === '1'
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run the desktop checks through npm so the npm executable can be located')

console.log(visible
  ? 'Running desktop tests with Electron windows visible.'
  : 'Running desktop tests with Electron windows hidden.')

const result = spawnSync(process.execPath, [npmCli, 'run', 'test:desktop:checks'], {
  cwd: process.cwd(),
  env: { ...process.env, AERIO_TEST_VISIBLE: visible ? '1' : '0' },
  stdio: 'inherit'
})

if (result.error) throw result.error
if (result.status !== 0 && !visible) {
  console.error('\nDesktop tests failed. Re-run `npm run test:desktop:visible` to watch the same scenario in real time.')
}
process.exitCode = result.status ?? 1
