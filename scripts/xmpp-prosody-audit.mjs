import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { generate } from 'selfsigned'
import { client, xml } from '@xmpp/client'
import { XmppChatAdapter } from '../electron/chat/providers/xmpp.ts'
import { ProviderChatRuntime } from '../electron/chat/providers/runtime.ts'
import { ChatVault } from '../electron/chat/chat-vault.ts'

// Real disposable Prosody, extracted into /tmp rather than installed as a system service.
// Windows requires an Ubuntu WSL distribution; Linux requires Ubuntu/Debian apt packages.
// Run: npx tsx scripts/xmpp-prosody-audit.mjs
const windows = process.platform === 'win32'
const command = windows ? 'wsl' : 'sh'
const args = windows ? ['-d', 'Ubuntu', '--', 'sh', '-s'] : ['-s']
const shell = (source) => {
  const result = spawnSync(command, args, { input: source, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  if (result.status !== 0) throw new Error(`Prosody fixture setup failed: ${result.stderr || result.stdout || result.error}`)
  return result.stdout
}
const id = randomUUID(), linux = `/tmp/aerio-prosody-${id}`, cache = '/tmp/aerio-xmpp-audit-packages'
const host = windows ? shell('hostname -I\n').trim().split(/\s+/)[0] : '127.0.0.1'
assert.match(host, /^\d+\.\d+\.\d+\.\d+$/)
const certificate = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: host }] }] })
const previousCAs = getCACertificates('default')
setDefaultCACertificates([...previousCAs, certificate.cert])
const directory = mkdtempSync(join(tmpdir(), 'aerio-xmpp-cache-')), opened = new Set(), raw = []
let processHandle, log = '', locked = false
const env = `export LUA_PATH='${cache}/root/usr/share/lua/5.4/?.lua;${cache}/root/usr/share/lua/5.4/?/init.lua;;'\nexport LUA_CPATH='${cache}/root/usr/lib/x86_64-linux-gnu/lua/5.4/?.so;;'\nexport LD_LIBRARY_PATH='${cache}/root/usr/lib/x86_64-linux-gnu'\n`
const config = `daemonize = false
run_as_root = true
data_path = "${linux}/data"
plugin_paths = { "${cache}/root/usr/lib/prosody/modules" }
interfaces = { "${host}" }
c2s_ports = { 15222 }
c2s_direct_tls_ports = { 15223 }
s2s_ports = {}
http_ports = {}
https_ports = { 15284 }
http_default_host = "localhost"
cross_domain_websocket = true
modules_enabled = { "roster", "saslauth", "tls", "disco", "private", "mam", "smacks", "websocket" }
modules_disabled = { "s2s" }
authentication = "internal_hashed"
c2s_require_encryption = true
default_archive_policy = true
log = { info = "*console", error = "*console" }
ssl = { key = "${linux}/key.pem", certificate = "${linux}/cert.pem" }
VirtualHost "localhost"
Component "conference.localhost" "muc"
modules_enabled = { "muc_mam" }
muc_log_all_rooms = true
muc_room_default_persistent = true
`
const waitFor = async (check, message, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)) }
  throw new Error(`${message}\n${log.slice(-4000)}`)
}
function runtime(name, adapter = new XmppChatAdapter({ timeout: 5000 })) {
  const vault = new ChatVault(join(directory, name + '.vault'), { assertSecure() {}, encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() })
  const value = new ProviderChatRuntime({ path: join(directory, name + '.sqlite'), vault, adapters: [adapter], assertSecure() {}, locked: () => locked, online: () => true, notificationsEnabled: () => false, changed() {}, notify() {} })
  opened.add(value); return value
}
try {
  shell(`set -eu
mkdir -p '${cache}/root' '${linux}/data'
cd '${cache}'
if [ ! -f root/usr/bin/lua5.4 ] || [ ! -f root/usr/bin/prosody ]; then
  apt-get download prosody lua5.4 lua-expat lua-filesystem lua-sec lua-socket lua-bitop
  find . -maxdepth 1 -name '*.deb' -exec dpkg-deb -x {} root \\;
fi
sed 's|/usr/lib/prosody|${cache}/root/usr/lib/prosody|g' root/usr/bin/prosody > '${linux}/prosody'
sed 's|/usr/lib/prosody|${cache}/root/usr/lib/prosody|g' root/usr/bin/prosodyctl > '${linux}/prosodyctl'
printf '%s' '${Buffer.from(config).toString('base64')}' | base64 -d > '${linux}/prosody.cfg.lua'
printf '%s' '${Buffer.from(certificate.private).toString('base64')}' | base64 -d > '${linux}/key.pem'
printf '%s' '${Buffer.from(certificate.cert).toString('base64')}' | base64 -d > '${linux}/cert.pem'
${env}
'${cache}/root/usr/bin/lua5.4' '${linux}/prosodyctl' --config '${linux}/prosody.cfg.lua' register alice localhost fixture-password
'${cache}/root/usr/bin/lua5.4' '${linux}/prosodyctl' --config '${linux}/prosody.cfg.lua' register bob localhost fixture-password
`)
  processHandle = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  processHandle.stdout.on('data', (chunk) => { log += chunk.toString() }); processHandle.stderr.on('data', (chunk) => { log += chunk.toString() })
  processHandle.stdin.end(`${env}\necho $$ > '${linux}/process.pid'\nexec '${cache}/root/usr/bin/lua5.4' '${linux}/prosody' --config '${linux}/prosody.cfg.lua'\n`)
  await waitFor(() => log.includes('Activated service') || log.includes('Activated host'), 'Prosody did not start')
  const untrusted = new XmppChatAdapter({ timeout: 3000 })
  setDefaultCACertificates(previousCAs)
  await assert.rejects(untrusted.connect({ jid: 'alice@localhost', password: 'fixture-password', service: `xmpps://${host}:15223` }), /certificate|connection/i)
  untrusted.suspend(); setDefaultCACertificates([...previousCAs, certificate.cert])
  const badAuth = new XmppChatAdapter({ timeout: 3000 })
  await assert.rejects(badAuth.connect({ jid: 'alice@localhost', password: 'incorrect-fixture-password', service: `xmpp://${host}:15222` }), (error) => error.kind === 'auth')
  badAuth.suspend()
  // A separate standard xmpp.js client provisions an existing room and roster entries.
  const admin = client({ service: `xmpps://${host}:15223`, domain: 'localhost', username: 'alice', password: 'fixture-password', resource: 'fixture-provision', timeout: 5000 })
  raw.push(admin); admin.reconnect.stop(); admin.on('error', () => {}); await admin.start()
  await waitFor(() => admin.streamManagement.enabled, 'Provisioning stream management did not finish')
  await admin.send(xml('presence'))
  await admin.iqCaller.request(xml('iq', { type: 'set' }, xml('query', { xmlns: 'jabber:iq:roster' }, xml('item', { jid: 'bob@localhost', name: 'Bob fixture' }))))
  const joined = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Provisioning room join timed out')), 5000)
    const listener = (stanza) => { if (stanza.is('presence') && stanza.attrs.from === 'audit@conference.localhost/provision' && stanza.getChild('x', 'http://jabber.org/protocol/muc#user')?.getChildren('status').some((item) => item.attrs.code === '110')) { clearTimeout(timer); admin.removeListener('stanza', listener); done() } }
    admin.on('stanza', listener)
  })
  await admin.send(xml('presence', { to: 'audit@conference.localhost/provision' }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' }))); await joined
  await admin.iqCaller.request(xml('iq', { type: 'set', to: 'audit@conference.localhost' }, xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' }, xml('x', { xmlns: 'jabber:x:data', type: 'submit' }))))
  await admin.stop(); raw.splice(raw.indexOf(admin), 1)
  let alice = runtime('alice'), bob = runtime('bob')
  const a = await alice.connect('xmpp', { jid: 'alice@localhost', password: 'fixture-password', service: `xmpp://${host}:15222`, rooms: 'audit@conference.localhost' })
  const b = await bob.connect('xmpp', { jid: 'bob@localhost', password: 'fixture-password', service: `xmpps://${host}:15223`, contacts: 'alice@localhost', rooms: 'audit@conference.localhost' })
  assert.ok(alice.snapshot().rooms.some((room) => room.name === 'Bob fixture'))
  assert.ok(alice.snapshot().rooms.find((room) => room.id === 'muc:audit@conference.localhost')?.canSend, JSON.stringify(alice.snapshot().rooms))
  await alice.send(a.id, 'jid:bob@localhost', 'Private STARTTLS fixture message')
  await waitFor(async () => (await bob.messages(b.id, 'jid:alice@localhost')).items.some((message) => message.body === 'Private STARTTLS fixture message'), 'Direct message readback failed')
  await bob.send(b.id, 'muc:audit@conference.localhost', 'Direct TLS room message')
  await waitFor(async () => (await alice.messages(a.id, 'muc:audit@conference.localhost')).items.some((message) => message.body === 'Direct TLS room message'), 'MUC message readback failed')
  const websocket = runtime('websocket')
  const wsAccount = await websocket.connect('xmpp', { jid: 'bob@localhost', password: 'fixture-password', service: `wss://${host}:15284/xmpp-websocket`, contacts: 'alice@localhost' })
  await websocket.send(wsAccount.id, 'jid:alice@localhost', 'Secure WebSocket fixture message')
  await waitFor(async () => (await alice.messages(a.id, 'jid:bob@localhost')).items.some((message) => message.body === 'Secure WebSocket fixture message'), 'WSS message readback failed')
  websocket.close(); opened.delete(websocket)
  await assert.rejects(alice.markRead(a.id, 'jid:bob@localhost'), /does not support/)
  alice.close(); opened.delete(alice); bob.close(); opened.delete(bob)
  // New connections and a new runtime read server archives, not the previous process's memory.
  alice = runtime('alice'); bob = runtime('bob')
  await alice.refresh(a.id); await bob.refresh(b.id)
  const restoredRoom = await alice.messages(a.id, 'muc:audit@conference.localhost'), restoredDirect = await bob.messages(b.id, 'jid:alice@localhost')
  assert.ok(!restoredRoom.stale && restoredRoom.items.some((message) => message.body === 'Direct TLS room message'))
  assert.ok(!restoredDirect.stale && restoredDirect.items.some((message) => message.body === 'Private STARTTLS fixture message'))
  const breaking = new XmppChatAdapter({ timeout: 5000, create: (options) => {
    const connection = client(options), send = connection.send.bind(connection)
    connection.send = async (stanza) => {
      const result = await send(stanza)
      if (stanza.is('message') && stanza.getChildText('body') === 'Ambiguous socket fixture send') connection.socket.socket.destroy()
      return result
    }
    return connection
  } })
  const interrupted = runtime('socket-interrupted', breaking)
  const interruptedAccount = await interrupted.connect('xmpp', { jid: 'alice@localhost', password: 'fixture-password', service: `xmpp://${host}:15222`, contacts: 'bob@localhost' })
  await assert.rejects(interrupted.send(interruptedAccount.id, 'jid:bob@localhost', 'Ambiguous socket fixture send'), /confirm|acknowledged/i)
  interrupted.close(); opened.delete(interrupted)
  const recovered = runtime('socket-interrupted')
  assert.ok((await recovered.messages(interruptedAccount.id, 'jid:bob@localhost')).items.some((message) => message.body === 'Ambiguous socket fixture send' && message.delivery === 'review'))
  assert.ok((await bob.messages(b.id, 'jid:alice@localhost')).items.filter((message) => message.body === 'Ambiguous socket fixture send').length <= 1)
  alice.store.saveSend(a.id, 'jid:bob@localhost', { id: 'interrupted', senderId: 'alice@localhost', sender: 'Alice', timestamp: new Date().toISOString(), body: 'Interrupted fixture send', own: true, delivery: 'sending' })
  alice.close(); opened.delete(alice); alice = runtime('alice')
  assert.ok((await alice.messages(a.id, 'jid:bob@localhost')).items.some((message) => message.id === 'interrupted' && message.delivery === 'review'))
  locked = true; alice.broadcast(); bob.broadcast()
  assert.deepEqual(alice.snapshot().accounts, [])
  await assert.rejects(alice.send(a.id, 'jid:bob@localhost', 'Locked send'), /Unlock/)
  locked = false
  await alice.refresh(a.id)
  assert.equal((await alice.messages(a.id, 'jid:bob@localhost')).items.filter((message) => message.body === 'Interrupted fixture send' && !message.delivery).length, 0)
  alice.close(); opened.delete(alice)
  assert.ok(!readFileSync(join(directory, 'alice.sqlite')).toString().includes('Private STARTTLS fixture message'))
  console.log('PASS: real Prosody STARTTLS + direct TLS + WSS, authenticated SASL, roster, two-user DM/MUC, MAM restart readback, encrypted cache, lock and interrupted-send review without replay.')
} catch (error) { console.error(log.slice(-8000)); throw error }
finally {
  for (const value of opened) value.close()
  for (const value of raw) await value.stop().catch(() => {})
  shell(`if [ -f '${linux}/process.pid' ]; then kill -TERM "$(cat '${linux}/process.pid')" 2>/dev/null || true; fi\n`)
  processHandle?.kill()
  // Cleanup paths are generated under the task's fixed temporary prefix only.
  if (!linux.startsWith('/tmp/aerio-prosody-') || !/^[\da-f-]+$/.test(id)) throw new Error('Unsafe fixture cleanup path')
  shell(`rm -rf -- '${linux}'\n`)
  setDefaultCACertificates(previousCAs)
  const resolved = resolve(directory); assert.ok(resolved.startsWith(resolve(tmpdir()) + sep)); rmSync(resolved, { recursive: true, force: true })
}
