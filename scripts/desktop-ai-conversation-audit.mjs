import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-ai-conversation-audit-'))
const requests = []
const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'reply', text: requests.length === 1 ? 'Native assistant first answer' : 'Native assistant follow-up answer' }) } }] }))
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
let application
try {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  let page
  for (let attempt = 0; attempt < 5; attempt++) {
    page = application.windows().find((candidate) => !candidate.isClosed() && !candidate.url().startsWith('aerio-chat-service:')) ?? await application.waitForEvent('window')
    try { await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 15_000 }); break } catch (error) { if (!page.isClosed()) throw error }
  }
  const settings = { enabled: true, provider: 'openai-compatible', model: 'disposable-audit-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, includeSenderDetails: false, webSearchApiKey: 'disposable-unused-search-token', features: { conversation: true } }
  await page.evaluate(async (settings) => { const value = await window.aerio.ai.configure(settings); window.dispatchEvent(new CustomEvent('aerio-ai-settings-changed', { detail: value })) }, settings)
  await page.getByRole('button', { name: 'AI assistant', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI assistant' })
  assert.deepEqual((await page.evaluate(() => window.aerio.ai.conversation.state())).scope, { allowMail: false, accountIds: [], allowWeb: false })
  await dialog.getByLabel('Allow public-web research').check()
  await dialog.getByLabel('Message to AI assistant').fill('Remember the native audit question')
  assert.equal(await dialog.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), false)
  await dialog.getByLabel('Public search query for this message').fill('public native audit topic')
  await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
  await dialog.getByText('Native assistant first answer', { exact: true }).waitFor()
  await dialog.getByLabel('Message to AI assistant').fill('Follow up on that answer')
  assert.equal(await dialog.getByLabel('Public search query for this message').inputValue(), '')
  assert.equal(await dialog.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), false)
  await dialog.getByLabel('Public search query for this message').fill('public native audit follow-up topic')
  await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
  await dialog.getByText('Native assistant follow-up answer', { exact: true }).waitFor()
  assert.equal(requests.length, 2)
  assert.ok(JSON.stringify(requests[1]).includes('Remember the native audit question'))
  assert.ok(JSON.stringify(requests[1]).includes('Native assistant first answer'))
  assert.ok(JSON.stringify(requests[1]).includes('public native audit follow-up topic'))
  const state = await page.evaluate(() => window.aerio.ai.conversation.state())
  assert.equal(state.messages.length, 4)
  assert.deepEqual(state.scope, { allowMail: false, accountIds: [], allowWeb: true })
  await dialog.getByRole('button', { name: 'Clear conversation', exact: true }).click()
  await dialog.getByText('Native assistant first answer', { exact: true }).waitFor({ state: 'detached' })
  assert.equal((await page.evaluate(() => window.aerio.ai.conversation.state())).messages.length, 0)
  console.log('Native conversational AI audit passed: launcher, compatible HTTP provider, real IPC multi-turn, default scopes, per-turn public query control, explicit clear.')
} finally {
  await application?.close()
  await new Promise((done) => server.close(done))
  const target = resolve(profile), rel = relative(resolve(tmpdir()), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !target.includes('aerio-ai-conversation-audit-')) throw new Error('Unsafe audit cleanup path')
  rmSync(target, { recursive: true, force: true })
}
