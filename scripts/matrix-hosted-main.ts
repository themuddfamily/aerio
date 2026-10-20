import { app, BrowserWindow, ipcMain, protocol, safeStorage, session, WebContentsView } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChatServiceHost, CHAT_SERVICE_SCHEME, chatServicePartition } from '../electron/chat/service-host'
import { CHAT_SDK_VERSION } from '../electron/chat/gate'
import { assertSecureCredentialStorage } from '../electron/mail/secure-storage'
import { passwordLogin, type ChatLoginResult } from '../electron/chat/homeserver'
import { DEFAULT_CHAT_PREFERENCES, type ChatAccountRecord } from '../electron/chat/chat-store'
import { encryptAttachment, decryptAttachment, type EncryptedFileInfo } from '../electron/chat/media'
import type { ChatServiceConnection } from '../electron/chat/chat-service'
import type { ChatServiceCommand, ChatServiceEvent } from '../electron/chat/service/runtime'
import type { ChatVerificationState } from '../src/chat-types'
import { HOSTED_CHECKS, validateHostedConfig } from './matrix-hosted-contract.mjs'

// Standalone acceptance main, never loaded by Aerio's production entry point.
// It uses the production host + unchanged shipped sandboxed service, below the UI gate.
const profile = process.env.AERIO_MATRIX_AUDIT_PROFILE!, root = process.env.AERIO_MATRIX_REPO_ROOT!
if (!profile || !root || process.env.AERIO_CHAT_PREVIEW === '1') throw Error('Acceptance requires an isolated profile without preview overrides')
app.setPath('userData', profile); app.setPath('sessionData', join(profile, 'sessions'))
protocol.registerSchemesAsPrivileged([{ scheme: CHAT_SERVICE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
type Config = { homeserver: string; userA: string; passwordA: string; userB: string; passwordB: string }
type SavedDevice = ChatLoginResult & { id: string; key: string; ed25519?: string }
interface Device extends SavedDevice { connection: ChatServiceConnection; events: ChatServiceEvent[]; contents: Electron.WebContents }
interface State { homeserver: string; devices: SavedDevice[]; roomId: string; recoveryKey?: string; text: { id: string; body: string }[]; files: { id: string; plaintext: string }[]; checks: string[]; versions: string[]; capabilities?: { password: true; names: string[] } }
const statePath = join(profile, 'hosted-state.os-encrypted')
const views = new Map<string, Electron.WebContents>(), opened: Device[] = []
let host: ChatServiceHost, config: Config, state: State, stage = 'initialization'
function check(condition: unknown, label: string): asserts condition { if (!condition) throw Error(label) }
const wait = async <T>(probe: () => T | false | undefined, label: string, timeout = 120_000): Promise<T> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = probe(); if (value) return value; await new Promise((done) => setTimeout(done, 100)) }
  throw Error(label)
}
const events = (device: Device) => device.events.flatMap((event) => event.type === 'batch' ? event.batch.events : [])
const verification = (device: Device, id: string, phase: string) => device.events.flatMap((event) => event.type === 'verification' ? [event.state] : []).find((value) => value.requestId === id && value.phase === phase)
const save = () => writeFileSync(statePath, safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 })
const load = () => JSON.parse(safeStorage.decryptString(readFileSync(statePath))) as State
const pass = (name: string) => { check(HOSTED_CHECKS.includes(name), 'Unknown acceptance check'); if (!state.checks.includes(name)) state.checks.push(name); save() }
async function matrix(device: SavedDevice | undefined, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${config.homeserver}${path}`, { method, headers: { ...(device ? { Authorization: `Bearer ${device.accessToken}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (path === '/_matrix/client/v3/logout' && response.status === 401) return {}
  check(response.ok, 'Hosted homeserver rejected a required operation')
  const text = await response.text(); check(text.length <= 2_000_000, 'Hosted response exceeded acceptance bounds')
  return text ? JSON.parse(text) : {}
}
async function login(user: string, password: string) {
  const result = await passwordLogin(config.homeserver, user, password)
  check(result.userId === user, 'Hosted server returned a different user identity')
  const saved: SavedDevice = { ...result, id: randomUUID(), key: randomBytes(32).toString('base64') }
  state.devices.push(saved); save(); return open(saved)
}
async function open(saved: SavedDevice): Promise<Device> {
  const account: ChatAccountRecord = { id: saved.id, transport: 'matrix', homeserver: config.homeserver, userId: saved.userId, deviceId: saved.deviceId, status: 'connecting', trust: 'unverified', recovery: 'not-set-up', preferences: DEFAULT_CHAT_PREFERENCES, createdAt: new Date().toISOString() }
  const connection = await host.open(account)
  const contents = views.get(chatServicePartition(saved.id))!
  const device: Device = { ...saved, connection, contents, events: [] }; opened.push(device)
  connection.onEvent((event) => { device.events.push(event) })
  const isolation = await contents.executeJavaScript('({node: typeof process, require: typeof require, secure: isSecureContext})')
  check(isolation.node === 'undefined' && isolation.require === 'undefined' && isolation.secure === true && contents.getOSProcessId() !== process.pid, 'Shipped service isolation was not enforced')
  check(contents.getURL().startsWith(`${CHAT_SERVICE_SCHEME}://app/`), 'The shipped service did not load')
  const started = await connection.request<{ ed25519: string }>({ type: 'start', config: { accountId: saved.id, homeserver: config.homeserver, userId: saved.userId, deviceId: saved.deviceId, accessToken: saved.accessToken, useIndexedDB: true, cryptoStoreKey: new Uint8Array(Buffer.from(saved.key, 'base64')) } })
  check(started.ed25519, 'No crypto identity was returned')
  if (saved.ed25519) check(saved.ed25519 === started.ed25519, 'Device crypto identity changed across Electron restart')
  saved.ed25519 = started.ed25519; save()
  await wait(() => device.events.some((event) => event.type === 'status' && event.status === 'ready'), 'Hosted sync never became ready')
  return device
}
async function decrypted(device: Device, id: string, body?: string) {
  return wait(() => events(device).find((event) => event.eventId === id && event.encrypted && event.type === 'm.room.message' && !event.decryptionError && (body === undefined || event.content.body === body)), 'Encrypted hosted history did not decrypt')
}
async function sas(initiator: Device, receiver: Device, own: boolean) {
  const offset = receiver.events.length
  const request = await initiator.connection.request<ChatVerificationState>(own ? { type: 'verify-own' } : { type: 'verify-user', userId: receiver.userId, deviceId: receiver.deviceId })
  const incoming = await wait(() => receiver.events.slice(offset).flatMap((event) => event.type === 'verification' ? [event.state] : []).find((value) => !value.initiatedByMe && value.selfVerification === own && value.otherUserId === initiator.userId && (!value.otherDeviceId || value.otherDeviceId === initiator.deviceId)), 'Hosted SAS request was not received')
  await receiver.connection.request({ type: 'verification', requestId: incoming.requestId, action: 'accept' })
  await wait(() => verification(initiator, request.requestId, 'ready'), 'Hosted SAS did not become ready')
  await initiator.connection.request({ type: 'verification', requestId: request.requestId, action: 'start-sas' })
  const left = await wait(() => verification(initiator, request.requestId, 'show-sas'), 'Initiator SAS absent'), right = await wait(() => verification(receiver, incoming.requestId, 'show-sas'), 'Receiver SAS absent')
  check(left.emoji?.length === 7 && JSON.stringify(left.emoji) === JSON.stringify(right.emoji), 'Hosted SAS emoji mismatch')
  // Confirmation is automatic ONLY in this dedicated disposable-account harness,
  // and ONLY after comparing all seven independently generated SAS entries.
  await Promise.all([initiator.connection.request({ type: 'verification', requestId: request.requestId, action: 'confirm' }), receiver.connection.request({ type: 'verification', requestId: incoming.requestId, action: 'confirm' })])
  await wait(() => verification(initiator, request.requestId, 'done'), 'Initiator SAS did not complete')
  await wait(() => verification(receiver, incoming.requestId, 'done'), 'Receiver SAS did not complete')
}
async function wire(device: Device, id: string, plaintext: string) {
  const result = await matrix(device, `/_matrix/client/v3/rooms/${encodeURIComponent(state.roomId)}/event/${encodeURIComponent(id)}`)
  check(result.type === 'm.room.encrypted' && !JSON.stringify(result.content).includes(plaintext), 'Hosted server received plaintext instead of encrypted content')
}
async function text(sender: Device, receiver: Device, label: string) {
  const body = `Aerio-hosted-${label}-${randomUUID()}`
  const id = await sender.connection.request<string>({ type: 'send', roomId: state.roomId, eventType: 'm.room.message', content: { msgtype: 'm.text', body }, txnId: randomUUID() })
  await decrypted(receiver, id, body); await wire(sender, id, body)
  state.text.push({ id, body }); save(); return id
}
async function file(sender: Device, receiver: Device) {
  const plaintext = `Aerio encrypted acceptance attachment ${randomUUID()}`
  const encoded = await encryptAttachment(new TextEncoder().encode(plaintext))
  const mxc = await sender.connection.request<string>({ type: 'upload', bytes: encoded.ciphertext, mime: 'application/octet-stream' })
  const id = await sender.connection.request<string>({ type: 'send', roomId: state.roomId, eventType: 'm.room.message', content: { msgtype: 'm.file', body: 'acceptance.txt', file: { ...encoded.info, url: mxc }, info: { mimetype: 'text/plain', size: plaintext.length } }, txnId: randomUUID() })
  const received = await decrypted(receiver, id)
  await verifyFile(receiver, received.content.file as EncryptedFileInfo, plaintext)
  await wire(sender, id, plaintext); state.files.push({ id, plaintext }); save()
}
async function verifyFile(device: Device, info: EncryptedFileInfo, plaintext: string) {
  check(info?.url, 'Encrypted attachment metadata absent')
  const downloaded = await device.connection.request<Uint8Array>({ type: 'download', mxc: info.url, limit: 1024 * 1024 })
  check(!Buffer.from(downloaded).includes(Buffer.from(plaintext)), 'Hosted media contains plaintext')
  const restored = await decryptAttachment(new Uint8Array(downloaded), info)
  check(new TextDecoder().decode(restored) === plaintext, 'Encrypted attachment bytes changed')
}
async function stopAll() { for (const device of opened.splice(0)) { await device.connection.request({ type: 'stop' }).catch(() => {}); await device.connection.close() } }
async function lostResponse(sender: Device, receiver: Device) {
  const txnId = randomUUID(), body = `Aerio lost-response ${randomUUID()}`
  let dropped = 0, acknowledged: string | undefined
  const debuggerApi = sender.contents.debugger
  debuggerApi.attach('1.3')
  const paused = async (_event: unknown, method: string, parameters: any) => {
    if (method !== 'Fetch.requestPaused') return
    try {
      if (!dropped && new URL(parameters.request.url).pathname.endsWith(`/${txnId}`) && parameters.responseStatusCode >= 200 && parameters.responseStatusCode < 300) {
        check(new URL(parameters.request.url).pathname.includes('/send/m.room.encrypted/'), 'Lost-response test intercepted a plaintext send')
        const sentBody = parameters.request.postData ?? (await debuggerApi.sendCommand('Network.getRequestPostData', { requestId: parameters.networkId })).postData
        check(typeof sentBody === 'string' && JSON.parse(sentBody).algorithm === 'm.megolm.v1.aes-sha2' && !sentBody.includes(body), 'Lost-response request was not proven encrypted')
        const response = await debuggerApi.sendCommand('Fetch.getResponseBody', { requestId: parameters.requestId })
        acknowledged = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body).event_id
        dropped++; await debuggerApi.sendCommand('Fetch.failRequest', { requestId: parameters.requestId, errorReason: 'ConnectionReset' })
      } else await debuggerApi.sendCommand('Fetch.continueRequest', { requestId: parameters.requestId })
    } catch { await debuggerApi.sendCommand('Fetch.failRequest', { requestId: parameters.requestId, errorReason: 'Failed' }).catch(() => {}) }
  }
  debuggerApi.on('message', paused)
  await debuggerApi.sendCommand('Fetch.enable', { patterns: [{ urlPattern: `*/send/m.room.encrypted/${txnId}*`, requestStage: 'Response' }] })
  const command: ChatServiceCommand = { type: 'send', roomId: state.roomId, eventType: 'm.room.message', content: { msgtype: 'm.text', body }, txnId }
  try {
    await sender.connection.request(command).catch(() => undefined)
    const retried = await sender.connection.request<string>(command)
    check(dropped === 1 && acknowledged === retried, 'Hosted transaction ID did not reconcile to the original accepted event')
    await decrypted(receiver, retried, body)
    const history = await matrix(sender, `/_matrix/client/v3/rooms/${encodeURIComponent(state.roomId)}/messages?dir=b&limit=100`)
    check(Array.isArray(history.chunk) && history.chunk.length < 100 && history.chunk.filter((event: any) => event.event_id === retried).length === 1, 'Hosted event count could not be proven')
    const matches = new Set(events(receiver).filter((event) => event.content.body === body).map((event) => event.eventId))
    check(matches.size === 1 && matches.has(retried), 'Hosted receiver saw duplicate events for one transaction')
  } finally { debuggerApi.off('message', paused); await debuggerApi.sendCommand('Fetch.disable').catch(() => {}); debuggerApi.detach() }
}

async function run(input: unknown, phase: string) {
  config = validateHostedConfig(input)
  assertSecureCredentialStorage(safeStorage)
  state = phase === 'initial' ? { homeserver: config.homeserver, devices: [], roomId: '', text: [], files: [], checks: [], versions: [] } : load()
  stage = phase
  try {
    check(state.homeserver === config.homeserver && (!state.devices[0] || state.devices[0].userId === config.userA) && (!state.devices[1] || state.devices[1].userId === config.userB), 'Acceptance state belongs to a different server or accounts')
    if (phase === 'initial') {
      pass('secureStorage')
      check(host.available(), 'Shipped service missing')
      const selfTest = await host.selfTest(); check(selfTest.passed, 'Encrypted IndexedDB persistence self-test failed'); pass('cryptoPersistence')
      const versions = await matrix(undefined, '/_matrix/client/versions'), capabilities = await matrix(undefined, '/_matrix/client/v3/login')
      check(Array.isArray(versions.versions) && capabilities.flows?.some((flow: any) => flow.type === 'm.login.password'), 'Hosted password flow or versions absent')
      state.versions = versions.versions
      const alice = await login(config.userA, config.passwordA), bob = await login(config.userB, config.passwordB)
      const advertised = await matrix(alice, '/_matrix/client/v3/capabilities')
      check(advertised.capabilities && typeof advertised.capabilities === 'object', 'Hosted capabilities absent')
      state.capabilities = { password: true, names: Object.keys(advertised.capabilities).filter((name) => /^[a-z0-9._-]{1,100}$/.test(name)).sort() }; save()
      pass('passwordLogin'); pass('isolatedShippedService')
      const created = await matrix(alice, '/_matrix/client/v3/createRoom', 'POST', { preset: 'private_chat', name: `Aerio hosted acceptance ${randomUUID()}`, invite: [bob.userId], initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] })
      check(typeof created.room_id === 'string', 'Hosted encrypted room was not created'); state.roomId = created.room_id; save()
      await wait(() => bob.events.some((event) => event.type === 'batch' && event.batch.rooms.some((room) => room.roomId === state.roomId && room.membership === 'invite')), 'Hosted invitation absent')
      await bob.connection.request({ type: 'room', roomId: state.roomId, action: 'accept' })
      await wait(() => alice.events.some((event) => event.type === 'batch' && event.batch.events.some((event) => event.roomId === state.roomId && event.type === 'm.room.member' && event.stateKey === bob.userId && event.content.membership === 'join')), 'Hosted peer membership not synchronized')
      await text(alice, bob, 'a-to-b'); await text(bob, alice, 'b-to-a'); pass('encryptedTextBothWays')
      await file(alice, bob); await file(bob, alice); pass('encryptedAttachmentsBothWays')
      const recovery = await alice.connection.request<{ recoveryKey?: string; backupComplete?: boolean }>({ type: 'setup-recovery' })
      check(recovery.recoveryKey && recovery.backupComplete === true, 'Hosted recovery did not finish backing up earlier history'); state.recoveryKey = recovery.recoveryKey; save()
      const second = await login(config.userA, config.passwordA)
      await sas(second, alice, true); pass('ownDeviceSas')
      await sas(alice, bob, false); pass('crossUserSas')
    } else if (phase === 'restart') {
      const alice = await open(state.devices[0]), bob = await open(state.devices[1]), second = await open(state.devices[2])
      const ownDevices = await second.connection.request<{ deviceId: string; verified: boolean }[]>({ type: 'devices' })
      check(ownDevices.some((device) => device.deviceId === alice.deviceId && device.verified), 'Own-device trust did not persist across Electron restart')
      for (const item of state.text) { await decrypted(alice, item.id, item.body); await decrypted(bob, item.id, item.body) }
      for (const item of state.files) for (const device of [alice, bob]) { const received = await decrypted(device, item.id); await verifyFile(device, received.content.file as EncryptedFileInfo, item.plaintext) }
      await text(alice, bob, 'restart-a-to-b'); await text(bob, alice, 'restart-b-to-a'); pass('bothDeviceRestarts')
      await lostResponse(alice, bob); pass('lostResponseIdempotency')
    } else if (phase === 'restore') {
      // Old devices are in closed Electron processes, so live key requests cannot supply history.
      const fresh = await login(config.userA, config.passwordA)
      const missing = await wait(() => events(fresh).find((event) => event.eventId === state.text[0].id && event.type === 'm.room.encrypted' && event.decryptionError), 'New device did not demonstrate missing historical keys')
      check(Object.keys(missing.content).length === 0 && state.recoveryKey, 'New device guessed undecryptable content')
      const restored = await fresh.connection.request<{ imported: number }>({ type: 'recovery-key', key: state.recoveryKey })
      check(restored.imported > 0, 'Server backup imported no historical keys')
      for (const item of state.text.slice(0, 2)) await decrypted(fresh, item.id, item.body)
      for (const item of state.files) { const received = await decrypted(fresh, item.id); await verifyFile(fresh, received.content.file as EncryptedFileInfo, item.plaintext) }
      pass('recoveryRestore')
      await stopAll()
      for (const device of [fresh, state.devices[1]]) await matrix(device, `/_matrix/client/v3/rooms/${encodeURIComponent(state.roomId)}/leave`, 'POST', {})
      for (const device of state.devices) await matrix(device, '/_matrix/client/v3/logout', 'POST', {})
    } else if (phase === 'cleanup') {
      // Disposable fixture accounts only; never /logout/all or delete other devices.
      for (const device of state.devices) await matrix(device, '/_matrix/client/v3/logout', 'POST', {})
    } else throw Error('Unknown acceptance phase')
    return { sdk: CHAT_SDK_VERSION, electron: process.versions.electron, homeserver: config.homeserver, checkedAt: new Date().toISOString(), versions: state.versions, capabilities: state.capabilities, checks: state.checks.map((id) => ({ id, passed: true })) }
  } catch { throw Error(`Hosted acceptance failed during ${stage}; no interoperability evidence may be emitted`) }
  finally { await stopAll() }
}

void app.whenReady().then(async () => {
  host = new ChatServiceHost({ serviceDirectory: join(root, 'dist-electron/chat-service'), preload: join(root, 'dist-electron/preload/chat-service-preload.cjs'), electron: {
    createView: ({ partition, preload }) => { const view = new WebContentsView({ webPreferences: { partition, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, devTools: true } }); views.set(partition, view.webContents); return view },
    fromPartition: (partition) => session.fromPartition(partition) as never, ipcMain
  } })
  const control = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await control.loadURL('data:text/html,<title>Aerio hosted Matrix acceptance</title>')
  ;(globalThis as any).__matrixHostedAcceptance = { run, probe: async () => { assertSecureCredentialStorage(safeStorage); check(host.available(), 'Shipped service missing'); const result = await host.selfTest(); return { passed: result.passed, sdk: CHAT_SDK_VERSION, electron: process.versions.electron } } }
})
