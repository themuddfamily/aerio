import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import hoodiecrow from 'hoodiecrow-imap'
import { SMTPServer } from 'smtp-server'
import { generate } from 'selfsigned'
import { ImapSmtpClient } from '../electron/mail/imap-client.ts'
import { MailWorkerClient } from '../electron/mail/worker-client.ts'

const root = resolve(import.meta.dirname, '..')
const raw = (id, subject = id) => `From: Fixture <sender@example.test>\r\nTo: testuser@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDisposable integration body ${id}\r\n`
const certificates = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] })

async function until(predicate, description) {
  const end = Date.now() + 25_000
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}

async function scenario(security) {
  const profile = mkdtempSync(join(tmpdir(), 'aerio-imap-integration-'))
  const sockets = new Set()
  const deliveries = []
  const authentications = []
  let rejectDelivery = false
  let worker
  const credentials = { key: certificates.private, cert: certificates.cert }
  const imap = hoodiecrow({
    secureConnection: security === 'tls', credentials,
    plugins: ['STARTTLS', 'LOGINDISABLED', 'SPECIAL-USE', 'ID', 'NAMESPACE', 'UNSELECT'],
    storage: {
      INBOX: { messages: [{ raw: raw('initial', 'Initial integration message') }] },
      '': { separator: '/', folders: {
        Outbox: { 'special-use': '\\Sent', messages: [{ raw: raw('sent') }] },
        Working: { 'special-use': '\\Drafts' },
        Discarded: { 'special-use': '\\Trash' },
        Stored: { 'special-use': '\\Archive' },
        Unwanted: { 'special-use': '\\Junk' },
        Container: { flags: ['\\Noselect'] }
      } }
    }
  })
  const login = imap.getCommandHandler('LOGIN')
  imap.setCommandHandler('LOGIN', (connection, ...args) => {
    authentications.push({ protocol: 'imap', secure: connection.secureConnection })
    return login(connection, ...args)
  })
  const smtp = new SMTPServer({
    secure: security === 'tls', ...credentials, logger: false, closeTimeout: 1_000,
    onAuth(auth, session, callback) {
      authentications.push({ protocol: 'smtp', secure: session.secure })
      callback(auth.username === 'testuser' && auth.password === 'testpass' ? null : new Error('Fixture authentication failed'), { user: 'testuser' })
    },
    onData(stream, session, callback) {
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => {
        if (rejectDelivery) { const error = new Error('Temporary fixture delivery failure'); error.responseCode = 451; callback(error); return }
        deliveries.push({ raw: Buffer.concat(chunks), envelope: session.envelope, secure: session.secure })
        callback()
      })
    }
  })
  for (const server of [imap.server, smtp.server]) {
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.on('error', () => undefined) // Expected TLS rejection probes close the socket.
  }
  try {
    await new Promise((resolve, reject) => { imap.server.once('error', reject); imap.listen(0, '127.0.0.1', resolve) })
    await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve) })
    const config = { provider: 'imap', email: 'testuser@example.test', displayName: 'Disposable account', username: 'testuser', password: 'testpass', imapHost: '127.0.0.1', imapPort: imap.server.address().port, imapSecurity: security, smtpHost: '127.0.0.1', smtpPort: smtp.server.address().port, smtpSecurity: security, allowInvalidCertificates: true }
    const client = new ImapSmtpClient(config)
    if (security === 'starttls') {
      const starttls = imap.capabilities.STARTTLS
      delete imap.capabilities.STARTTLS
      await assert.rejects(client.verify(), /STARTTLS|TLS|security/i)
      imap.capabilities.STARTTLS = starttls
      smtp.options.disabledCommands.push('STARTTLS')
      await assert.rejects(client.send(Buffer.from(raw('downgrade-probe')), ['reader@example.test']), /TLS|500|502/i)
      smtp.options.disabledCommands = smtp.options.disabledCommands.filter((command) => command !== 'STARTTLS')
      assert.equal(deliveries.length, 0)
    }
    await assert.rejects(new ImapSmtpClient({ ...config, allowInvalidCertificates: false }).verify(), /self.signed|certificate/i)
    await assert.rejects(new ImapSmtpClient({ ...config, password: 'wrong' }).verify(), (error) => error.authenticationFailed === true)
    await client.verify()
    let initialRef
    await client.withConnection(async (connection) => {
      const folders = await client.listFolders(connection)
      assert.equal(folders.some((folder) => folder.path === 'Container'), false)
      for (const [path, use] of [['Outbox', '\\Sent'], ['Working', '\\Drafts'], ['Discarded', '\\Trash'], ['Stored', '\\Archive'], ['Unwanted', '\\Junk']]) assert.equal(folders.find((folder) => folder.path === path)?.specialUse, use)
      const inbox = folders.find((folder) => folder.path === 'INBOX')
      const inventory = await client.inventoryFolder(connection, inbox)
      assert.equal(inventory.refs.length, 1)
      initialRef = inventory.refs[0]
      assert.ok(initialRef.labels.includes('UNREAD'))
      assert.deepEqual((await client.fetchRaw(connection, inbox, initialRef)).raw, Buffer.from(imap.getMailbox('INBOX').messages[0].raw))
    })
    await client.applyAction([{ folder: 'INBOX', uid: initialRef.uid }], 'read')
    await client.applyAction([{ folder: 'INBOX', uid: initialRef.uid }], 'star')
    await client.withConnection(async (connection) => {
      const inventory = await client.inventoryFolder(connection, { path: 'INBOX', name: 'INBOX' })
      assert.equal(inventory.refs[0].labels.includes('UNREAD'), false)
      assert.ok(inventory.refs[0].labels.includes('STARRED'))
    })
    const draft = await client.saveDraft(Buffer.from(raw('draft')))
    assert.equal(imap.getMailbox('Working').messages.length, 1)
    const replacement = await client.saveDraft(Buffer.from(raw('replacement')), draft)
    assert.equal(imap.getMailbox('Working').messages.length, 1)
    await client.deleteDraft(replacement)
    assert.equal(imap.getMailbox('Working').messages.length, 0)
    await client.applyAction([{ folder: 'INBOX', uid: initialRef.uid }], 'archive')
    assert.equal(imap.getMailbox('INBOX').messages.length, 0)
    assert.equal(imap.getMailbox('Stored').messages.length, 1)
    await client.applyAction([{ folder: 'Stored', uid: imap.getMailbox('Stored').messages[0].uid }], 'unarchive')
    assert.equal(imap.getMailbox('INBOX').messages.length, 1)
    await client.send(Buffer.from(raw('direct-send')), ['reader@example.test', 'hidden@example.test'])
    assert.deepEqual(deliveries[0].envelope.rcptTo.map((item) => item.address), ['reader@example.test', 'hidden@example.test'])
    assert.match(deliveries[0].raw.toString(), /direct-send/)
    rejectDelivery = true
    await assert.rejects(client.send(Buffer.from(raw('rejected-send')), ['reader@example.test']), /451|Temporary/)
    assert.equal(deliveries.length, 1)
    rejectDelivery = false
    await client.send(Buffer.from(raw('retried-send')), ['reader@example.test'])
    assert.equal(deliveries.length, 2)

    const events = []
    const startWorker = async () => {
      worker = new MailWorkerClient(join(root, 'dist-electron/main/mail-worker.js'), async () => ({ type: 'imap', config }), (event) => events.push(event))
      await worker.request({ type: 'initialize', payload: { databasePath: join(profile, 'mail.sqlite'), contentPath: join(profile, 'mail') } })
      await worker.request({ type: 'network', payload: { online: false } })
    }
    const sync = async () => {
      events.length = 0
      await worker.request({ type: 'sync:start', payload: { accountId: 'integration' } })
      await until(() => {
        const error = events.find((event) => event.type === 'sync-progress' && event.payload.phase === 'error')
        if (error) throw new Error(error.payload.error ?? error.payload.message ?? JSON.stringify(error.payload))
        return events.some((event) => event.type === 'sync-progress' && event.payload.phase === 'complete')
      }, 'worker sync completion')
    }
    await startWorker()
    await worker.request({ type: 'accounts:upsert', payload: { id: 'integration', provider: 'imap', email: config.email, displayName: config.displayName, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: false, syncEnabled: true } })
    await worker.request({ type: 'network', payload: { online: true } })
    await sync()
    const first = await worker.request({ type: 'mail:list', payload: { folder: 'inbox', accountIds: ['integration'] } })
    assert.equal(first.total, 1)
    const detail = await worker.request({ type: 'mail:thread', payload: { accountId: 'integration', threadId: first.items[0].id } })
    assert.match(detail.messages[0].text, /Disposable integration body initial/)
    assert.equal((await worker.request({ type: 'mail:list', payload: { folder: 'sent', accountIds: ['integration'] } })).total, 1)
    const draftInput = { id: 'worker-draft', accountId: 'integration', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Worker draft', text: 'Saved through the actual worker', attachmentPaths: [] }
    await worker.request({ type: 'drafts:save', payload: draftInput })
    assert.equal(imap.getMailbox('Working').messages.length, 1)
    await worker.request({ type: 'drafts:save', payload: { ...draftInput, subject: 'Updated worker draft' } })
    assert.equal(imap.getMailbox('Working').messages.length, 1)
    await worker.request({ type: 'drafts:delete', payload: { id: draftInput.id } })
    assert.equal(imap.getMailbox('Working').messages.length, 0)
    const list = imap.getCommandHandler('LIST')
    imap.setCommandHandler('LIST', (connection, _parsed, _data, callback) => {
      connection.socket.destroy()
      callback()
    })
    events.length = 0
    await worker.request({ type: 'sync:start', payload: { accountId: 'integration' } })
    await until(() => events.some((event) => event.type === 'sync-progress' && event.payload.phase === 'error'), 'disconnected sync reporting failure')
    assert.equal((await worker.request({ type: 'mail:list', payload: { folder: 'inbox', accountIds: ['integration'] } })).total, 1)
    imap.setCommandHandler('LIST', list)
    await sync()
    imap.appendMessage('INBOX', [], undefined, raw('incremental'))
    await sync()
    assert.equal((await worker.request({ type: 'mail:list', payload: { folder: 'inbox', accountIds: ['integration'] } })).total, 2)
    // A changed UIDVALIDITY with reused UIDs must replace old cached identities.
    const inbox = imap.getMailbox('INBOX')
    inbox.uidvalidity += 1
    inbox.messages = []; inbox.uidnext = 1
    imap.appendMessage('INBOX', [], undefined, raw('reset', 'Reset UIDVALIDITY message'))
    await sync()
    const reset = await worker.request({ type: 'mail:list', payload: { folder: 'inbox', accountIds: ['integration'] } })
    assert.equal(reset.total, 1)
    assert.equal(reset.items[0].subject, 'Reset UIDVALIDITY message')
    await worker.request({ type: 'network', payload: { online: false } })
    await worker.request({ type: 'drafts:schedule', payload: { input: { id: 'restart-send', accountId: 'integration', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Worker recovery send', text: 'Recovered offline delivery', attachmentPaths: [] }, deliveryAt: new Date(Date.now() - 1_000).toISOString() } })
    await worker.close(); worker = undefined
    await startWorker()
    assert.equal((await worker.request({ type: 'mail:list', payload: { folder: 'inbox', accountIds: ['integration'] } })).total, 1)
    assert.equal((await worker.request({ type: 'drafts:get', payload: { id: 'restart-send' } })).status, 'scheduled')
    await worker.request({ type: 'network', payload: { online: true } })
    await until(async () => (await worker.request({ type: 'drafts:get', payload: { id: 'restart-send' } })).status === 'sent', 'scheduled delivery after restart')
    assert.equal(deliveries.length, 3)
    assert.match(deliveries[2].raw.toString(), /Worker recovery send/)
    if (security === 'starttls') {
      const configPath = join(profile, 'live-test.json'), output = join(profile, 'live-evidence')
      writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, timeoutMs: 10_000, accounts: [{ alias: 'custom-imap-loopback', provider: 'imap', accountClass: 'custom-imap', credentialEnv: 'AERIO_LIVE_LOOPBACK' }] }))
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/live-provider-runner.mjs'), '--run', '--config', configPath, '--output', output], { cwd: root, env: { ...process.env, AERIO_LIVE_TESTS: '1', AERIO_LIVE_LOOPBACK: JSON.stringify({ type: 'imap', email: config.email, config }) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let text = ''
        child.stdout.on('data', (chunk) => { text += chunk })
        child.stderr.on('data', (chunk) => { text += chunk })
        const timer = setTimeout(() => { child.kill(); reject(new Error('Live runner fixture timeout')) }, 30_000)
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('exit', (code) => { clearTimeout(timer); resolve({ code, text }) })
      })
      assert.equal(result.code, 0, result.text)
      const filename = readdirSync(output).find((name) => name.endsWith('.json'))
      const reportText = readFileSync(join(output, filename), 'utf8')
      assert.equal(JSON.parse(reportText).runs[0].checks.length, 4)
      assert.ok(JSON.parse(reportText).runs[0].checks.every((check) => check.result === 'Pass'))
      assert.doesNotMatch(reportText, /testuser|testpass|example\.test|integration body|127\.0\.0\.1/)
      const rows = readFileSync(join(output, filename.replace('.json', '.md')), 'utf8')
      assert.match(rows, /\| SYNC-01 \| Partial \|/)
      assert.equal(deliveries.length, 3, 'Read-only live checks must not send mail')
      console.log('✓ opt-in live runner uses the loopback account and exports sanitized diagnostics and scoped evidence')
    }
    assert.ok(authentications.some((item) => item.protocol === 'imap'))
    assert.ok(authentications.some((item) => item.protocol === 'smtp'))
    assert.ok(authentications.every((item) => item.secure), 'All authentication must occur after encryption')
    console.log(`✓ ${security}: encrypted authentication, special folders, raw fetch/flags/moves/drafts, SMTP rejection/retry, real-worker sync/UIDVALIDITY and offline restart delivery`)
  } finally {
    if (worker) await worker.close().catch(() => undefined)
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise((resolve) => imap.close(resolve)), new Promise((resolve) => smtp.close(resolve))])
    const location = relative(tmpdir(), profile)
    assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-imap-integration-'))
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

await scenario('tls')
await scenario('starttls')
