import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, platform, release } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { MailWorkerClient } from '../electron/mail/worker-client.ts'
import { parseConfig, readCredential, runAccounts, evidenceRows, failureCode } from './live-provider-core.mjs'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
let profile
try {
  if (process.env.AERIO_LIVE_TESTS !== '1' || !args.includes('--run')) throw new Error('Live runner requires AERIO_LIVE_TESTS=1 and --run')
  const configIndex = args.indexOf('--config'), outputIndex = args.indexOf('--output')
  if (configIndex < 0 || !args[configIndex + 1] || outputIndex < 0 || !args[outputIndex + 1] || args.length !== 5) throw new Error('Expected --run --config <file> --output <directory>')
  const config = parseConfig(JSON.parse(readFileSync(resolve(args[configIndex + 1]), 'utf8')))
  // Validate all selected credentials before any provider is contacted.
  const credentials = new Map(config.accounts.map((account) => [account.alias, readCredential(account, process.env)]))
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  profile = mkdtempSync(join(tmpdir(), 'aerio-live-run-'))
  const factory = async (account, timeoutMs, restart = false) => {
    const directory = join(profile, account.alias)
    mkdirSync(directory, { recursive: true })
    const listeners = new Set()
    const { email, credential } = credentials.get(account.alias)
    const client = new MailWorkerClient(join(root, 'dist-electron/main/mail-worker.js'), async () => credential, (event) => { for (const listener of listeners) listener(event) })
    const request = async (command) => {
      if (!['initialize', 'accounts:upsert', 'network', 'accounts:verify', 'sync:start', 'diagnostics:health', 'mail:list', 'shutdown'].includes(command.type)) throw new Error('Live runner command is not permitted')
      let timer
      try { return await Promise.race([client.request(command), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker request timeout')), timeoutMs) })]) }
      finally { clearTimeout(timer) }
    }
    const close = async () => {
      try { await request({ type: 'shutdown' }) } finally { await client.terminate() }
    }
    try {
      await request({ type: 'initialize', payload: { databasePath: join(directory, 'mail.sqlite'), contentPath: join(directory, 'mail') } })
      await request({ type: 'network', payload: { online: false } })
      if (!restart) await request({ type: 'accounts:upsert', payload: { id: 'live-test-account', provider: account.provider, email, displayName: account.alias, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: false, syncEnabled: true } })
      return { request, close, onEvent(callback) { listeners.add(callback); return () => listeners.delete(callback) } }
    } catch (error) { await client.terminate(); throw error }
  }
  const report = await runAccounts(config, factory, { version, commit, dirty, operatingSystem: `${platform()} ${release()}` })
  const output = resolve(args[outputIndex + 1])
  mkdirSync(output, { recursive: true })
  const filename = `live-provider-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`
  writeFileSync(join(output, filename), JSON.stringify(report, null, 2), { mode: 0o600 })
  writeFileSync(join(output, filename.replace('.json', '.md')), '| Date | Commit/version | Provider/account alias | Scenario | Result | Diagnostics | Issue/notes | Tester |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n' + evidenceRows(report, filename) + '\n', { mode: 0o600 })
  const failed = report.runs.some((run) => run.checks.some((check) => check.result === 'Fail'))
  console.log(`Live checks ${failed ? 'failed' : 'passed'} for ${report.runs.length} selected account(s). Evidence: ${filename}`)
  if (failed) process.exitCode = 1
} catch (error) {
  // Do not serialize provider errors, config values, environment variables,
  // filesystem paths, account identities, or response payloads.
  console.error(`Live runner did not complete (${failureCode(error)}). Verify opt-in flags, config, credentials, and the built worker.`)
  process.exitCode = 1
} finally {
  if (profile) {
    const location = relative(tmpdir(), profile)
    if (!location || location.startsWith('..') || isAbsolute(location) || !location.startsWith('aerio-live-run-')) throw new Error('Invalid temporary profile')
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
