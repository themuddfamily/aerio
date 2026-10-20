import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { connect } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Agent, fetch as fixtureFetch } from 'undici'
import { generate } from 'selfsigned'
import { SlackChatAdapter } from '../electron/chat/providers/slack.ts'
import { RocketChatAdapter } from '../electron/chat/providers/rocketchat.ts'
import { ProviderChatRuntime } from '../electron/chat/providers/runtime.ts'
import { ChatVault } from '../electron/chat/chat-vault.ts'

// Every HTTP request is connected to a disposable local TLS fixture. No external accounts are used.
const directory = mkdtempSync(join(tmpdir(), 'aerio-provider-tls-'))
const certificate = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' })
const slack = [], rocket = [], reads = [], requests = []
let failDelivery = false
const server = createServer({ key: certificate.private, cert: certificate.cert }, async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const url = new URL(request.url, 'https://' + request.headers.host)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  requests.push({ host: request.headers.host, path: url.pathname })
  const reply = (value) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
  if (request.headers.host === 'slack.com') {
    assert.equal(request.headers.authorization, 'Bearer xoxp-fixture')
    const method = url.pathname.split('/').at(-1)
    if (method === 'auth.test') return reply({ ok: true, team_id: 'T123', user_id: 'U123', team: 'Fixture', user: 'Sam' })
    if (method === 'conversations.list') return reply({ ok: true, channels: [{ id: 'C123', name: 'general', is_member: true }] })
    if (method === 'conversations.history' || method === 'conversations.replies') return reply({ ok: true, messages: [...slack].reverse() })
    if (method === 'conversations.mark') { reads.push('slack'); return reply({ ok: true }) }
    if (method === 'chat.postMessage') {
      const item = { ts: `1792490000.${String(slack.length + 1).padStart(6, '0')}`, text: body.text, user: 'U123', ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}) }; slack.push(item)
      if (failDelivery) { response.statusCode = 503; return reply({ ok: false, error: 'internal_error' }) }
      assert.match(body.client_msg_id, /^[0-9a-f-]{36}$/)
      return reply({ ok: true, channel: body.channel, ts: item.ts, message: item })
    }
  } else {
    assert.equal(request.headers.host, 'rocket.example.test')
    assert.equal(request.headers['x-auth-token'], 'fixture-token')
    assert.equal(request.headers['x-user-id'], 'user-1')
    const method = url.pathname.split('/').at(-1)
    if (method === 'me') return reply({ success: true, _id: 'user-1', name: 'Sam' })
    if (method === 'rooms.get') return reply({ success: true, update: [{ _id: 'GENERAL', name: 'general', t: 'c' }] })
    if (method === 'subscriptions.get') return reply({ success: true, update: [{ rid: 'GENERAL', name: 'general', unread: rocket.length }] })
    if (method.endsWith('.history') || method === 'chat.getThreadMessages') return reply({ success: true, messages: [...rocket].reverse() })
    if (method === 'subscriptions.read') { reads.push('rocketchat'); return reply({ success: true }) }
    if (method === 'chat.sendMessage') {
      const item = { ...body.message, ts: new Date().toISOString(), u: { _id: 'user-1', name: 'Sam' } }; rocket.push(item)
      if (failDelivery) { response.statusCode = 503; return reply({ success: false }) }
      return reply({ success: true, message: item })
    }
  }
  response.statusCode = 404; reply({ success: false })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const dispatcher = new Agent({ connect: (_options, callback) => {
  const socket = connect({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: certificate.cert, rejectUnauthorized: true })
  socket.once('secureConnect', () => callback(null, socket)); socket.once('error', callback)
} })
const fetcher = (url, init) => fixtureFetch(url, { ...init, dispatcher })
const opened = new Set()
function open(device) {
  const vault = new ChatVault(join(directory, device + '-vault'), { assertSecure() {}, encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() })
  const runtime = new ProviderChatRuntime({ path: join(directory, device + '.sqlite'), vault, adapters: [new SlackChatAdapter(fetcher), new RocketChatAdapter(fetcher)], assertSecure() {}, locked: () => false, online: () => true, notificationsEnabled: () => false, changed() {}, notify() {} })
  opened.add(runtime); return runtime
}
try {
  for (const provider of ['slack', 'rocketchat']) {
    let first = open(provider + '-first'); const second = open(provider + '-second')
    const input = provider === 'slack' ? { token: 'xoxp-fixture' } : { server: 'https://rocket.example.test', userId: 'user-1', token: 'fixture-token' }
    const one = await first.connect(provider, input), two = await second.connect(provider, input)
    const roomId = provider === 'slack' ? 'C123' : 'GENERAL'
    const sent = await first.send(one.id, roomId, 'Private fixture text')
    assert.ok((await second.messages(two.id, roomId)).items.some((item) => item.id === sent.id && item.body === 'Private fixture text'))
    await second.markRead(two.id, roomId)
    await first.send(one.id, roomId, 'Fixture thread reply', sent.id)
    assert.ok((await second.messages(two.id, roomId, { threadId: sent.id })).items.some((item) => item.body === 'Fixture thread reply'))
    failDelivery = true
    await assert.rejects(first.send(one.id, roomId, 'Ambiguous fixture delivery'), /unknown|confirm|delivery/i)
    failDelivery = false
    first.close(); opened.delete(first)
    first = open(provider + '-first')
    const page = await first.messages(one.id, roomId)
    assert.ok(page.items.some((item) => item.delivery === 'review' && item.body === 'Ambiguous fixture delivery'))
    assert.equal((provider === 'slack' ? slack : rocket).filter((item) => (item.text ?? item.msg) === 'Ambiguous fixture delivery').length, 1, 'Restart never resends an ambiguous delivery')
    first.close(); opened.delete(first)
    assert.ok(!readFileSync(join(directory, provider + '-first.sqlite')).toString().includes('Private fixture text'), 'Message cache is sealed')
    await second.remove(two.id); assert.equal(second.snapshot().accounts.length, 0)
  }
  assert.deepEqual(reads, ['slack', 'rocketchat'])
  assert.ok(requests.every((request) => ['slack.com', 'rocket.example.test'].includes(request.host)))
  console.log('Provider TLS audit passed: Slack and Rocket.Chat authentication, joined rooms, two-device message/thread readback, read markers, sealed SQLite cache, ambiguous-delivery restart without replay, account removal.')
} finally {
  for (const runtime of opened) runtime.close()
  await dispatcher.destroy(); await new Promise((done) => server.close(done))
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('aerio-provider-tls-')) throw Error('Unexpected cleanup path')
  rmSync(target, { recursive: true, force: true })
}
