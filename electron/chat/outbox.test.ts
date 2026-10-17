import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatCacheCipher } from './cache-crypto'
import { ChatStore, DEFAULT_CHAT_PREFERENCES } from './chat-store'
import { ChatEncryptionFailure, ChatOutbox, ChatSendRejected, type ChatDispatcher } from './outbox'

let directory: string
let store: ChatStore
const key = ChatCacheCipher.generateKey()
const ROOM = '!room:example.org'
const scope = { userId: '@me:example.org', deviceId: 'DEV1', canSend: true }
const message = (body: string) => ({ accountId: 'acc', roomId: ROOM, userId: scope.userId, deviceId: scope.deviceId, kind: 'message' as const, eventType: 'm.room.message', content: { msgtype: 'm.text', body } })

function openStore() {
  store = new ChatStore(join(directory, 'chat.sqlite'), (id) => new ChatCacheCipher(id, key))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-chat-outbox-'))
  openStore()
  store.insertAccount({ id: 'acc', transport: 'matrix', homeserver: 'https://example.org', userId: scope.userId, deviceId: 'DEV1', status: 'ready', trust: 'unknown', recovery: 'unknown', preferences: DEFAULT_CHAT_PREFERENCES, createdAt: '2026-10-01T00:00:00Z' })
  store.applySyncBatch('acc', { rooms: [{ roomId: ROOM, name: 'R', encrypted: true, membership: 'join', isDirect: false }], events: [] })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function dispatcher(overrides: Partial<ChatDispatcher> = {}): ChatDispatcher & { sent: { txnId: string; content: Record<string, unknown> }[] } {
  const sent: { txnId: string; content: Record<string, unknown> }[] = []
  return {
    sent,
    send: vi.fn(async (_account, _room, _type, content, txnId) => { sent.push({ txnId, content }); return `$${txnId}` }),
    redact: vi.fn(async (_account, _room, eventId, txnId) => `$redaction-${eventId}-${txnId}`),
    ...overrides
  }
}

describe('ChatOutbox', () => {
  it('persists before echo and sends in order with stable transaction IDs', async () => {
    const changed = vi.fn()
    const send = dispatcher()
    const outbox = new ChatOutbox(store, send, changed)
    const first = outbox.enqueue(message('one'))
    const second = outbox.enqueue(message('two'))
    expect(store.outboxItem(first.id)?.state).toBe('pending')
    expect(changed).toHaveBeenCalledWith('acc', ROOM)
    await outbox.dispatch('acc', scope)
    expect(send.sent.map((item) => item.content.body)).toEqual(['one', 'two'])
    expect(store.outboxItem(first.id)).toMatchObject({ state: 'sent', eventId: `$${first.txnId}`, attempts: 1 })
    expect(store.outboxItem(second.id)?.state).toBe('sent')
    expect(() => outbox.enqueue(message('x'.repeat(40_000)))).toThrow('too long')
  })

  it('retries a lost response with the same transaction ID', async () => {
    let fail = true
    const send = dispatcher({ send: vi.fn(async (_a, _r, _t, _c, txnId: string) => { if (fail) { fail = false; throw new TypeError('socket hang up') } return `$${txnId}` }) })
    const outbox = new ChatOutbox(store, send)
    const item = outbox.enqueue(message('hello'))
    await expect(outbox.dispatch('acc', scope)).rejects.toThrow('socket hang up')
    expect(store.outboxItem(item.id)).toMatchObject({ state: 'pending', attempts: 1, error: 'socket hang up' })
    await outbox.dispatch('acc', scope)
    const calls = (send.send as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][4]).toBe(calls[1][4])
    expect(store.outboxItem(item.id)).toMatchObject({ state: 'sent', attempts: 2 })
  })

  it('does not dispatch while sending is not allowed, and shares one run per account', async () => {
    const send = dispatcher()
    const outbox = new ChatOutbox(store, send)
    outbox.enqueue(message('locked'))
    await outbox.dispatch('acc', { ...scope, canSend: false })
    expect(send.send).not.toHaveBeenCalled()
    const a = outbox.dispatch('acc', scope); const b = outbox.dispatch('acc', scope)
    expect(a).toBe(b)
    await a
    expect(send.send).toHaveBeenCalledTimes(1)
  })

  it('moves interrupted sends to review after restart and resolves them from the sync echo', async () => {
    const outbox = new ChatOutbox(store, dispatcher())
    const interrupted = outbox.enqueue(message('interrupted'))
    const echoed = outbox.enqueue(message('echoed'))
    store.updateOutbox(interrupted.id, { state: 'running' })
    store.updateOutbox(echoed.id, { state: 'running' })
    store.close(); openStore()
    const restarted = new ChatOutbox(store, dispatcher())
    expect(restarted.recover()).toBe(2)
    store.applySyncBatch('acc', { rooms: [], events: [{ eventId: '$seen', roomId: ROOM, sender: scope.userId, type: 'm.room.message', ts: 1, content: { body: 'echoed' }, encrypted: true, redacted: false, txnId: echoed.txnId }] })
    expect(store.outboxItem(echoed.id)).toMatchObject({ state: 'sent', eventId: '$seen' })
    expect(store.outboxItem(interrupted.id)?.state).toBe('review')
    // A review item holds later messages in the same room until resolved.
    const later = restarted.enqueue(message('later'))
    await restarted.dispatch('acc', scope)
    expect(store.outboxItem(later.id)?.state).toBe('pending')
    expect(() => restarted.retry(interrupted.id, { deviceId: 'OTHER' })).toThrow('different device')
    restarted.retry(interrupted.id, scope)
    await restarted.dispatch('acc', scope)
    expect(store.outboxItem(interrupted.id)?.state).toBe('sent')
    expect(store.outboxItem(later.id)?.state).toBe('sent')
    expect(() => restarted.retry(later.id, scope)).toThrow('Only failed')
  })

  it('holds the room on encryption failure and never falls back to plaintext', async () => {
    const send = dispatcher({ send: vi.fn(async () => { throw new ChatEncryptionFailure('A recipient device is unverified') }) })
    const outbox = new ChatOutbox(store, send)
    const item = outbox.enqueue(message('secret'))
    outbox.enqueue(message('next'))
    await outbox.dispatch('acc', scope)
    expect(store.outboxItem(item.id)).toMatchObject({ state: 'failed', error: 'A recipient device is unverified' })
    expect(store.room('acc', ROOM)?.held).toMatch(/Encryption or device trust/)
    expect(send.send).toHaveBeenCalledTimes(1)
  })

  it('fails definitive rejections and reviews items queued for another device', async () => {
    const outbox = new ChatOutbox(store, dispatcher({ send: vi.fn(async () => { throw new ChatSendRejected('Forbidden') }) }))
    const rejected = outbox.enqueue(message('no'))
    await outbox.dispatch('acc', scope)
    expect(store.outboxItem(rejected.id)?.state).toBe('failed')
    outbox.cancel(rejected.id)
    const stale = outbox.enqueue({ ...message('old device'), deviceId: 'OLD' })
    await outbox.dispatch('acc', scope)
    expect(store.outboxItem(stale.id)).toMatchObject({ state: 'review', error: expect.stringMatching(/different device/) })
  })

  it('serializes dependent edits, reactions and redactions on the confirmed event', async () => {
    const send = dispatcher()
    const outbox = new ChatOutbox(store, send)
    const original = outbox.enqueue(message('typo'))
    const edit = outbox.enqueue({ ...message('fixed'), kind: 'edit', dependsOn: original.id, content: { msgtype: 'm.text', body: '* fixed', 'm.new_content': { msgtype: 'm.text', body: 'fixed' }, 'm.relates_to': { rel_type: 'm.replace' } } })
    const reaction = outbox.enqueue({ ...message(''), kind: 'reaction', eventType: 'm.reaction', dependsOn: original.id, content: { 'm.relates_to': { rel_type: 'm.annotation', key: '✅' } } })
    const redaction = outbox.enqueue({ ...message(''), kind: 'redaction', dependsOn: original.id, content: {} })
    await outbox.dispatch('acc', scope)
    const eventId = `$${original.txnId}`
    expect(send.sent[1].content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: eventId })
    expect(send.sent[2].content['m.relates_to']).toEqual({ rel_type: 'm.annotation', key: '✅', event_id: eventId })
    expect(send.redact).toHaveBeenCalledWith('acc', ROOM, eventId, redaction.txnId)
    expect([edit, reaction, redaction].map((item) => store.outboxItem(item.id)?.state)).toEqual(['sent', 'sent', 'sent'])
  })

  it('edits or cancels undispatched messages, cascading to dependents and tracking orphan uploads', async () => {
    const outbox = new ChatOutbox(store, dispatcher())
    const queued = outbox.enqueue(message('draft'))
    outbox.editPending(queued.id, { msgtype: 'm.text', body: 'better' })
    expect(store.outboxItem(queued.id)?.content.body).toBe('better')
    const dependent = outbox.enqueue({ ...message(''), kind: 'reaction', eventType: 'm.reaction', dependsOn: queued.id, content: { 'm.relates_to': { rel_type: 'm.annotation', key: 'x' } } })
    outbox.cancel(queued.id)
    expect(store.outboxItem(queued.id)).toBeUndefined()
    expect(store.outboxItem(dependent.id)).toBeUndefined()
    outbox.cancel('missing')
    const media = outbox.enqueue({ ...message('file.txt'), kind: 'media', mediaId: 'mid' })
    store.insertMedia({ id: 'mid', accountId: 'acc', roomId: ROOM, outboxId: media.id, name: 'file.txt', mime: 'text/plain', size: 4, encrypted: true, state: 'uploaded', mxc: 'mxc://example.org/abc' })
    outbox.cancel(media.id)
    expect(store.media('mid')?.state).toBe('orphan')
    const sent = outbox.enqueue(message('sent'))
    await outbox.dispatch('acc', scope)
    expect(() => outbox.cancel(sent.id)).toThrow('already sent')
    expect(() => outbox.editPending(sent.id, {})).toThrow('has not been sent')
    store.updateOutbox(sent.id, { state: 'running' })
    expect(() => outbox.cancel(sent.id)).toThrow('being sent')
  })

  it('uploads staged media before sending the message that references it', async () => {
    const send = dispatcher({ upload: vi.fn(async () => ({ file: { url: 'mxc://example.org/enc', v: 'v2' } })) })
    const outbox = new ChatOutbox(store, send)
    const item = outbox.enqueue({ ...message('photo.png'), kind: 'media', mediaId: 'm2', content: { msgtype: 'm.image', body: 'photo.png' } })
    store.insertMedia({ id: 'm2', accountId: 'acc', roomId: ROOM, outboxId: item.id, name: 'photo.png', mime: 'image/png', size: 4, encrypted: true, state: 'staged' })
    await outbox.dispatch('acc', scope)
    expect(send.sent[0].content).toMatchObject({ msgtype: 'm.image', file: { url: 'mxc://example.org/enc' } })
    expect(store.media('m2')).toMatchObject({ state: 'sent', eventId: `$${item.txnId}` })
    const noUpload = new ChatOutbox(store, dispatcher())
    const other = noUpload.enqueue({ ...message('x'), kind: 'media', mediaId: 'none' })
    await noUpload.dispatch('acc', scope)
    expect(store.outboxItem(other.id)?.state).toBe('failed')
  })
})
