import { readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { builtinModules } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { validateHostedConfig, validateReport, publicAddress } from './matrix-hosted-contract.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
let stage = 'configuration', application, scratch, finished = false, cleaned = false
function input() {
  const path = process.env.AERIO_MATRIX_INTEROP_CONFIG ?? join(root, '.env.matrix-interop.local.json')
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  return { homeserver: process.env.AERIO_MATRIX_HOMESERVER, userA: process.env.AERIO_MATRIX_USER_A, passwordA: process.env.AERIO_MATRIX_PASSWORD_A, userB: process.env.AERIO_MATRIX_USER_B, passwordB: process.env.AERIO_MATRIX_PASSWORD_B, disposableAccounts: process.env.AERIO_MATRIX_DISPOSABLE_USERS === '1', acceptServerMutations: process.env.AERIO_MATRIX_ACCEPT_SERVER_MUTATIONS === '1' }
}
const hash = (path) => {
  const value = createHash('sha256')
  const visit = (target, prefix = '') => { for (const item of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (item.isSymbolicLink()) throw Error('Service bundle contains symbolic links'); const name = join(prefix, item.name); if (item.isDirectory()) visit(join(target, item.name), name); else { value.update(name.replace(/\\/g, '/')); value.update(readFileSync(join(target, item.name))) } } }
  visit(path); return value.digest('hex')
}
async function run() {
  if (args.length !== 1 || !['--run', '--validate', '--check-runtime'].includes(args[0])) throw Error('Use --validate, --check-runtime or --run')
  const offline = args[0] === '--check-runtime'
  const config = offline ? undefined : validateHostedConfig(input())
  if (args[0] === '--validate') { console.log('Configuration is structurally valid. No network, Electron acceptance or evidence output was performed.'); return }
  if (process.env.AERIO_CHAT_PREVIEW === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('Preview or TLS overrides are forbidden')
  stage = 'public-host-validation'
  if (!offline) { const addresses = await lookup(new URL(config.homeserver).hostname, { all: true }); if (!addresses.length || addresses.some((address) => !publicAddress(address.address))) throw Error('Hosted DNS must resolve only to public addresses') }
  const sdk = `matrix-js-sdk ${JSON.parse(readFileSync(join(root, 'node_modules/matrix-js-sdk/package.json'), 'utf8')).version}`
  if (sdk !== 'matrix-js-sdk 43.0.0') throw Error('Unexpected SDK version')
  stage = 'building-shipped-service'
  // Compile the actual production service/preload configs, not a test substitute.
  await build({ configFile: join(root, 'vite.chat-service.config.ts'), logLevel: 'silent' })
  await build({ configFile: join(root, 'vite.preload.config.ts'), logLevel: 'silent' })
  scratch = mkdtempSync(join(tmpdir(), 'aerio-hosted-matrix-'))
  const runner = join(scratch, 'runner'), profile = join(scratch, 'profile'); mkdirSync(profile)
  stage = 'building-acceptance-main'
  await build({ configFile: false, root, logLevel: 'silent', build: { target: 'node24', outDir: runner, emptyOutDir: true, minify: false, lib: { entry: join(root, 'scripts/matrix-hosted-main.ts'), formats: ['cjs'], fileName: () => 'acceptance.cjs' }, rolldownOptions: { external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] } } })
  const serviceHash = hash(join(root, 'dist-electron/chat-service')), preloadHash = createHash('sha256').update(readFileSync(join(root, 'dist-electron/preload/chat-service-preload.cjs'))).digest('hex')
  let report, version
  for (const phase of offline ? ['offline-runtime-probe'] : ['initial', 'restart', 'restore']) {
    stage = phase
    // A new full Electron process for each phase; profile and encrypted IndexedDB persist.
    const environment = { ...process.env, AERIO_CHAT_PREVIEW: '0', AERIO_MATRIX_AUDIT_PROFILE: profile, AERIO_MATRIX_REPO_ROOT: root }
    delete environment.ELECTRON_RUN_AS_NODE
    for (const name of ['AERIO_MATRIX_INTEROP_CONFIG', 'AERIO_MATRIX_HOMESERVER', 'AERIO_MATRIX_USER_A', 'AERIO_MATRIX_PASSWORD_A', 'AERIO_MATRIX_USER_B', 'AERIO_MATRIX_PASSWORD_B']) delete environment[name]
    application = await electron.launch({ executablePath: electronPath, args: [join(runner, 'acceptance.cjs')], cwd: root, env: environment, timeout: 60_000 })
    await application.evaluate(async () => { const end = Date.now() + 30_000; while (!globalThis.__matrixHostedAcceptance) { if (Date.now() > end) throw Error('Acceptance main did not initialize'); await new Promise((done) => setTimeout(done, 100)) } })
    const current = await application.evaluate(() => process.versions.electron)
    if (version && current !== version) throw Error('Electron version changed across phases')
    version = current
    // Credentials cross only Playwright's private local main-process control channel.
    report = await application.evaluate(async (_electron, { config, phase, offline }) => offline ? globalThis.__matrixHostedAcceptance.probe() : globalThis.__matrixHostedAcceptance.run(config, phase), { config, phase, offline })
    await application.close(); application = undefined
    console.log(offline ? 'Offline runtime phase completed.' : `Hosted acceptance phase completed: ${phase}`)
  }
  if (offline) { if (!report.passed || report.sdk !== sdk || report.electron !== version) throw Error('Offline runtime probe failed'); finished = true; console.log('Offline shipped-service persistence probe passed. No hosted interoperability was tested and no evidence artifact was written.'); return }
  cleaned = true // restore phase logs out every session after leaving the room.
  stage = 'final-evidence-validation'
  const sanitized = validateReport(report, { sdk, electron: version, homeserver: config.homeserver })
  if (hash(join(root, 'dist-electron/chat-service')) !== serviceHash || createHash('sha256').update(readFileSync(join(root, 'dist-electron/preload/chat-service-preload.cjs'))).digest('hex') !== preloadHash) throw Error('Shipped artifacts changed during acceptance')
  const evidence = { ...sanitized, platform: process.platform, arch: process.arch, serviceSha256: serviceHash, preloadSha256: preloadHash }
  const directory = join(root, 'live-test-evidence'); mkdirSync(directory, { recursive: true })
  if (realpathSync(directory) !== resolve(directory)) throw Error('Evidence directory must not be a symbolic link')
  const destination = join(directory, `matrix-hosted-${Date.now()}-${randomUUID()}.json`), temporary = destination + '.partial'
  writeFileSync(temporary, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, destination)
  finished = true
  console.log(`Full hosted acceptance passed. Sanitized release evidence: ${relative(root, destination)}`)
  console.log('No chat gate was changed. Release review must bind this evidence to the shipped artifacts.')
}
try { await run() }
catch {
  // Never print provider exceptions, tokens, identifiers, recovery keys or raw traces.
  console.error(`Hosted Matrix acceptance failed closed at ${stage}. No interoperability evidence was written.`)
  if (application) {
    try { await application.evaluate(async (_electron, config) => globalThis.__matrixHostedAcceptance.run(config, 'cleanup'), validateHostedConfig(input())); cleaned = true } catch { /* Keep encrypted state for operator recovery when remote revocation fails. */ }
  }
  process.exitCode = 1
} finally {
  await application?.close().catch(() => {})
  if (scratch && (finished || cleaned || !existsSync(join(scratch, 'profile/hosted-state.os-encrypted')))) {
    const resolved = resolve(scratch), inside = relative(resolve(tmpdir()), resolved)
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !resolved.includes('aerio-hosted-matrix-')) throw Error('Unsafe acceptance cleanup target')
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } else if (scratch) console.error('The disposable acceptance profile was retained under the OS temporary aerio-hosted-matrix directory because remote cleanup was not confirmed. Revoke its test-account devices before removal.')
}
