import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
const run = promisify(execFile)
const literal = (value) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

/** Runs actual inbound AppleScript against the packaged app, not an emitted JS event. */
export async function auditMacAppleScript(application, page) {
  if (process.platform !== 'darwin') throw new Error('AppleScript audit requires macOS')
  const executable = await application.evaluate(({ app }) => app.getPath('exe'))
  const bundle = dirname(dirname(dirname(executable)))
  assert.match(readFileSync(join(bundle, 'Contents', 'Resources', 'Aerio.sdef'), 'utf8'), /name="call tool"/)
  const dictionary = await run('sdef', [bundle], { timeout: 10_000 })
  assert.match(dictionary.stdout, /AerIcall/)
  const original = await page.evaluate(() => window.aerio.mcp.status())
  const issued = await page.evaluate(() => window.aerio.mcp.createClient('AppleScript disposable audit'))
  const call = async (request = { name: 'list_accounts', arguments: {} }, token = issued.token) => {
    const source = `tell application ${literal(bundle)}\ncall tool ${literal(JSON.stringify(request))} authorization ${literal(token)}\nend tell`
    try {
      const result = await run('osascript', ['-e', source], { timeout: 30_000, maxBuffer: 3 * 1024 * 1024 })
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      if (/1743|not authorized|not permitted/i.test(String(error.stderr))) throw new Error('macOS denied the native osascript Apple event. Grant the test runner Automation access to Aerio; no runtime success is claimed.')
      throw new Error(`Native AppleScript command failed (killed=${Boolean(error.killed)}, signal=${error.signal ?? 'none'}, code=${error.code ?? 'none'}): ${String(error.stderr || error.message).replaceAll(issued.token, '[token]')}`)
    }
  }
  try {
    await page.evaluate(() => window.aerio.mcp.save({ enabled: false, capabilities: { write: false, send: false, delete: false }, accountScope: [] }))
    assert.equal((await call()).error.code, 'disabled')
    await page.evaluate(() => window.aerio.mcp.save({ enabled: true, capabilities: { write: false, send: false, delete: false }, accountScope: [] }))
    const accounts = await call(); assert.equal(accounts.ok, true); assert.deepEqual(accounts.result.result.accounts, [])
    assert.equal((await call({ name: 'send_draft', arguments: {} })).error.code, 'capability-disabled')
    assert.equal((await call(undefined, 'invalid-token')).error.code, 'unauthorized')
    await page.evaluate(() => window.aerio.appLock.enable('applescript-native-fixture'))
    await page.evaluate(() => window.aerio.appLock.lock())
    assert.equal((await call()).error.code, 'locked')
    await page.evaluate(() => window.aerio.appLock.unlock('applescript-native-fixture'))
    await page.evaluate(() => window.aerio.appLock.disable('applescript-native-fixture'))
    await page.evaluate((id) => window.aerio.mcp.revokeClient(id), issued.client.id)
    assert.equal((await call()).error.code, 'unauthorized')
    console.log('Native AppleScript dictionary + inbound osascript, client authorization, disabled automation, empty account scope, lock and revocation checks passed.')
  } finally {
    const lock = await page.evaluate(() => window.aerio.appLock.status())
    if (lock.locked) await page.evaluate(() => window.aerio.appLock.unlock('applescript-native-fixture'))
    if (lock.enabled) await page.evaluate(() => window.aerio.appLock.disable('applescript-native-fixture'))
    await page.evaluate((id) => window.aerio.mcp.revokeClient(id), issued.client.id)
    await page.evaluate((settings) => window.aerio.mcp.save(settings), original.settings)
  }
}
