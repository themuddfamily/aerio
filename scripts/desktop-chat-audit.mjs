import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

/**
 * Real-Electron Chat gate audit (E30). With a fresh profile it verifies that
 * the packaged chat service self-test runs in the isolated, sandboxed service
 * webContents and records crypto-store persistence evidence; that Chat stays
 * out of navigation while hosted interoperability evidence is missing; and
 * that the developer preview (AERIO_CHAT_PREVIEW=1) shows the clearly
 * labelled Chat workspace without waiving secure storage or persistence. It
 * contacts no homeserver: the only discovery call uses an address the
 * connector must refuse before any network request.
 */
const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-chat-audit-'))
const evidencePath = join(profile, 'chat-gate.json')
let application

async function launch(extra = {}) {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: { ...desktopAuditEnvironment(), ...extra } })
  const page = await application.firstWindow()
  await page.waitForSelector('.app')
  return page
}

async function waitForEvidence(timeout = 90_000) {
  const started = Date.now()
  for (;;) {
    if (existsSync(evidencePath)) {
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
      if (evidence.cryptoPersistence) return evidence
    }
    if (Date.now() - started > timeout) throw new Error('The chat self-test did not record evidence')
    await new Promise((done) => setTimeout(done, 250))
  }
}

try {
  let page = await launch({ AERIO_CHAT_PREVIEW: '0' })
  const evidence = await waitForEvidence()
  assert.equal(evidence.sdk, 'matrix-js-sdk 43.0.0')
  assert.equal(evidence.electron, await application.evaluate(() => process.versions.electron))
  assert.equal(evidence.cryptoPersistence.passed, true, evidence.cryptoPersistence.detail)
  assert.equal(evidence.interoperability, undefined)
  // The evidence file never holds secrets.
  assert.doesNotMatch(readFileSync(evidencePath, 'utf8'), /access_token|syt_|storageKey|recovery/i)
  const closed = await page.evaluate(() => window.aerio.chat.snapshot())
  assert.equal(closed.gate.enabled, false)
  assert.deepEqual(closed.gate.checks.filter((check) => !check.passed).map((check) => check.id), ['interoperability'])
  assert.equal(await page.getByRole('button', { name: 'Chat', exact: true }).count(), 0)
  await assert.rejects(page.evaluate(() => window.aerio.chat.timeline('account', '!room:example.org')), /Chat stays unavailable/)
  console.log(`✓ crypto-store self-test passed in Electron ${evidence.electron}; Chat stays hidden without hosted interoperability evidence`)
  await application.close()

  page = await launch({ AERIO_CHAT_PREVIEW: '1' })
  const preview = await page.evaluate(() => window.aerio.chat.snapshot())
  assert.equal(preview.gate.enabled, true)
  assert.equal(preview.gate.preview, true)
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('note').filter({ hasText: /Chat preview: hosted two-device interoperability is unverified/ }).waitFor()
  const form = page.getByRole('form', { name: 'Add Matrix account' })
  await form.waitFor()
  // Plain HTTP to a non-loopback server is refused before any request is made.
  await assert.rejects(page.evaluate(() => window.aerio.chat.discover('http://matrix.example.org')), /HTTPS|https/)
  // The renderer never receives tokens or keys: the snapshot is display data only.
  assert.doesNotMatch(JSON.stringify(preview), /accessToken|cacheKey|cryptoStoreKey/)
  console.log('✓ developer preview shows the labelled Chat workspace; insecure homeserver URLs are refused')
} finally {
  await application?.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
