import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatCacheCipher } from './cache-crypto'
import { ChatStore, DEFAULT_CHAT_PREFERENCES, type ChatAccountRecord } from './chat-store'
import { projectTimeline, relationOf, searchableText, stripReplyFallback, type ChatOutboxRecord, type ChatStoredEvent } from './projection'

let directory: string
let store: ChatStore
const keys = new Map<string, Buffer>()
const cipherFor = (accountId: string) => {
  if (!keys.has(accountId)) keys.set(accountId, ChatCacheCipher.generateKey())
  return new ChatCacheCipher(accountId, keys.get(accountId)!)
}
const account = (id = 'acc', userId = '@me:example.org'): ChatAccountRecord => ({
  id, transport: 'matrix', homeserver: 'https://example.org', userId, deviceId: 'DEV1', status: 'ready', trust: 'unknown', recovery: 'unknown',
  preferences: DEFAULT_CHAT_PREFERENCES, createdAt: '2026-10-01T00:00:00.000Z'
})
let clock = 1_000
const event = (partial: Partial<ChatStoredEvent> & { eventId: string }): ChatStoredEvent => ({
  roomId: '!room:example.org', sender: '@bob:example.org', type: 'm.room.message', ts: clock++, content: { msgtype: 'm.text', body: partial.eventId },
  encrypted: true, redacted: false, ...partial
})
const room = { roomId: '!room:example.org', name: 'Planning', encrypted: true, membership: 'join' as const, isDirect: false }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-chat-store-'))
  store = new ChatStore(join(directory, 'chat.sqlite'), cipherFor)
  store.insertAccount(account())
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('ChatStore', () => {
  it('keys accounts by transport, homeserver and exact user ID', () => {
    expect(() => store.insertAccount({ ...account('dup') })).toThrow()
    store.insertAccount(account('other', '@me:other.org'))
    expect(store.findAccount('https://example.org', '@me:example.org')?.id).toBe('acc')
    expect(store.accounts().map((item) => item.id)).toEqual(['acc', 'other'])
    expect(store.updateAccount('acc', { status: 'offline', preferences: { ...DEFAULT_CHAT_PREFERENCES, notificationPreviews: true } })).toMatchObject({ status: 'offline', preferences: { notificationPreviews: true, retention: { historyDays: 30 } } })
    expect(() => store.updateAccount('missing', {})).toThrow('not found')
  })

  it('seals message content and room names at rest', () => {
    store.applySyncBatch('acc', { rooms: [room], events: [event({ eventId: '$secret', content: { msgtype: 'm.text', body: 'launch codes' } })] })
    store.saveDraft('acc', room.roomId, 'unsent draft')
    store.close()
    const raw = readFileSync(join(directory, 'chat.sqlite'))
    expect(raw.includes(Buffer.from('launch codes'))).toBe(false)
    expect(raw.includes(Buffer.from('Planning'))).toBe(false)
    expect(raw.includes(Buffer.from('unsent draft'))).toBe(false)
    store = new ChatStore(join(directory, 'chat.sqlite'), cipherFor)
    expect(store.getEvent('acc', '$secret')?.content.body).toBe('launch codes')
    expect(store.room('acc', room.roomId)?.name).toBe('Planning')
    expect(store.draft('acc', room.roomId)).toBe('unsent draft')
    store.saveDraft('acc', room.roomId, '')
    expect(store.draft('acc', room.roomId)).toBe('')
  })

  it('tolerates replayed sync batches and upgrades undecryptable events once keys arrive', () => {
    const batch = { rooms: [room], events: [event({ eventId: '$a' }), event({ eventId: '$u', type: 'm.room.encrypted', content: {}, decryptionError: 'Missing room key' })] }
    expect(store.applySyncBatch('acc', batch)).toHaveLength(2)
    expect(store.applySyncBatch('acc', batch)).toHaveLength(0)
    expect(store.roomEvents('acc', room.roomId)).toHaveLength(2)
    store.applySyncBatch('acc', { rooms: [], events: [event({ eventId: '$u', content: { msgtype: 'm.text', body: 'now readable' } })] })
    expect(store.getEvent('acc', '$u')).toMatchObject({ type: 'm.room.message', content: { body: 'now readable' }, decryptionError: undefined })
    expect(store.room('acc', room.roomId)?.unread).toBe(2)
    store.setRoomFlags('acc', room.roomId, { readTs: clock })
    expect(store.room('acc', room.roomId)?.unread).toBe(0)
  })

  it('removes decrypted copies on redaction and holds writes after losing membership', () => {
    store.applySyncBatch('acc', { rooms: [room], events: [event({ eventId: '$a', content: { msgtype: 'm.text', body: 'oops' } })] })
    store.insertMedia({ id: 'm1', accountId: 'acc', roomId: room.roomId, eventId: '$a', name: 'a.png', mime: 'image/png', size: 3, encrypted: true, state: 'cached', localPath: '/x' })
    store.applySyncBatch('acc', { rooms: [], events: [event({ eventId: '$r', type: 'm.room.redaction', content: { redacts: '$a' } })] })
    expect(store.getEvent('acc', '$a')).toMatchObject({ redacted: true, content: {} })
    expect(store.media('m1')?.state).toBe('orphan')
    expect(store.orphanedMedia('acc').map((item) => item.id)).toEqual(['m1'])
    store.applySyncBatch('acc', { rooms: [{ ...room, membership: 'leave' }], events: [] })
    expect(store.room('acc', room.roomId)?.held).toMatch(/no longer a member/)
    store.setRoomFlags('acc', room.roomId, { held: null, muted: true, previews: true })
    expect(store.room('acc', room.roomId)).toMatchObject({ held: undefined, muted: true, previews: true })
    store.applySyncBatch('acc', { rooms: [], events: [event({ eventId: '$b', redacted: true })] })
    store.applySyncBatch('acc', { rooms: [], events: [event({ eventId: '$b', redacted: true })] })
    expect(store.getEvent('acc', '$b')?.redacted).toBe(true)
  })

  it('resolves the outbox from the sync echo by device-scoped transaction ID', () => {
    const now = new Date().toISOString()
    const item: ChatOutboxRecord = { id: 'o1', accountId: 'acc', roomId: room.roomId, txnId: 'aerio-1', userId: '@me:example.org', deviceId: 'DEV1', kind: 'message', eventType: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' }, state: 'running', attempts: 1, createdAt: now, updatedAt: now }
    store.insertOutbox(item)
    store.insertOutbox({ ...item, id: 'o2', deviceId: 'OLD', state: 'pending' })
    store.applySyncBatch('acc', { rooms: [room], events: [event({ eventId: '$echo', sender: '@me:example.org', txnId: 'aerio-1' })] })
    expect(store.outboxItem('o1')).toMatchObject({ state: 'sent', eventId: '$echo' })
    expect(store.outboxItem('o2')?.state).toBe('pending')
    expect(store.interruptedToReview()).toBe(0)
  })

  it('prunes expired history but keeps outbox targets, checkpoints and the media budget', () => {
    const now = Date.now()
    store.applySyncBatch('acc', { rooms: [room], events: [
      event({ eventId: '$old', ts: now - 40 * 86_400_000 }), event({ eventId: '$target', ts: now - 40 * 86_400_000, sender: '@me:example.org' }), event({ eventId: '$new', ts: now })
    ], reachedStart: [room.roomId] })
    expect(store.reachedStart('acc', room.roomId)).toBe(true)
    const stamp = new Date().toISOString()
    store.insertOutbox({ id: 'edit', accountId: 'acc', roomId: room.roomId, txnId: 't', userId: '@me:example.org', deviceId: 'DEV1', kind: 'edit', eventType: 'm.room.message', content: {}, targetEventId: '$target', state: 'pending', attempts: 0, createdAt: stamp, updatedAt: stamp })
    store.insertMedia({ id: 'old-media', accountId: 'acc', roomId: room.roomId, eventId: '$old', name: 'o', mime: 'text/plain', size: 1, encrypted: true, state: 'cached', localPath: '/old' })
    store.insertMedia({ id: 'big', accountId: 'acc', roomId: room.roomId, eventId: '$new', name: 'b', mime: 'text/plain', size: 300 * 1024 * 1024, encrypted: true, state: 'cached', localPath: '/big' })
    store.setNotificationCheckpoint('acc', room.roomId, now, '$new')
    expect(store.pruneRetention('acc', now).sort()).toEqual(['/big', '/old'])
    expect(store.roomEvents('acc', room.roomId).map((item) => item.eventId)).toEqual(['$target', '$new'])
    expect(store.reachedStart('acc', room.roomId)).toBe(false)
    expect(store.media('big')).toMatchObject({ state: 'remote', localPath: undefined })
    expect(store.notificationCheckpoint('acc', room.roomId)).toEqual({ ts: now, eventId: '$new' })
    expect(store.pruneRetention('missing')).toEqual([])
  })

  it('clears history without touching identity or queued messages, and purges an account completely', () => {
    store.applySyncBatch('acc', { rooms: [room], events: [event({ eventId: '$a' })] })
    const stamp = new Date().toISOString()
    store.insertOutbox({ id: 'q', accountId: 'acc', roomId: room.roomId, txnId: 't', userId: '@me:example.org', deviceId: 'DEV1', kind: 'media', eventType: 'm.room.message', content: { body: 'f' }, mediaId: 'staged', state: 'pending', attempts: 0, createdAt: stamp, updatedAt: stamp })
    store.insertMedia({ id: 'staged', accountId: 'acc', roomId: room.roomId, outboxId: 'q', name: 'f', mime: 'text/plain', size: 1, encrypted: true, state: 'staged', localPath: '/staged' })
    store.insertMedia({ id: 'cache', accountId: 'acc', roomId: room.roomId, eventId: '$a', name: 'c', mime: 'text/plain', size: 1, encrypted: true, state: 'cached', localPath: '/cache' })
    expect(store.clearHistory('acc')).toEqual(['/cache'])
    expect(store.roomEvents('acc', room.roomId)).toEqual([])
    expect(store.outbox('acc')).toHaveLength(1)
    expect(store.mediaReferences('acc', room.roomId).get('outbox:q')?.name).toBe('f')
    expect(store.getAccount('acc')).toBeDefined()
    expect(store.removeAccount('acc')).toEqual(['/staged'])
    expect(store.getAccount('acc')).toBeUndefined()
    expect(store.rooms()).toEqual([])
  })
})

describe('timeline projection', () => {
  const me = '@me:example.org'
  it('applies only valid edits, replies, reactions and redactions', () => {
    const events = [
      event({ eventId: '$m1', content: { msgtype: 'm.text', body: 'original' } }),
      event({ eventId: '$forged', sender: '@mallory:example.org', content: { msgtype: 'm.text', body: '* hacked', 'm.new_content': { msgtype: 'm.text', body: 'hacked' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$m1' } } }),
      event({ eventId: '$e1', content: { msgtype: 'm.text', body: '* first', 'm.new_content': { msgtype: 'm.text', body: 'first edit' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$m1' } } }),
      event({ eventId: '$e2', content: { msgtype: 'm.text', body: '* second', 'm.new_content': { msgtype: 'm.text', body: 'second edit' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$m1' } } }),
      event({ eventId: '$orphan-edit', content: { msgtype: 'm.text', body: '* x', 'm.new_content': { body: 'x' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$not-yet' } } }),
      event({ eventId: '$reply', sender: me, content: { msgtype: 'm.text', body: '> <@bob:example.org> original\n\nagreed', 'm.relates_to': { 'm.in_reply_to': { event_id: '$m1' } } } }),
      event({ eventId: '$reply-missing', content: { msgtype: 'm.text', body: 'what?', 'm.relates_to': { 'm.in_reply_to': { event_id: '$older' } } } }),
      event({ eventId: '$r1', type: 'm.reaction', sender: me, content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m1', key: '👍' } } }),
      event({ eventId: '$r2', type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m1', key: '👍' } } }),
      event({ eventId: '$r3', type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$m1', key: '👍' } } }),
      event({ eventId: '$r-redacted', type: 'm.reaction', redacted: true, content: {} }),
      event({ eventId: '$gone', redacted: true, content: {} }),
      event({ eventId: '$utd', type: 'm.room.encrypted', content: {}, decryptionError: 'Missing room key' }),
      event({ eventId: '$join', type: 'm.room.member', stateKey: '@carol:example.org', sender: '@carol:example.org', content: { membership: 'join' } }),
      event({ eventId: '$topic', type: 'm.room.topic', stateKey: '', content: { topic: 'x' } }),
      event({ eventId: '$img', content: { msgtype: 'm.image', body: 'cat.png' } })
    ]
    const media = new Map([['$img', { mediaId: 'm', name: 'cat.png', size: 10, mime: 'image/png', encrypted: true }]])
    const items = projectTimeline(events, { ownUserId: me, media })
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('$m1')).toMatchObject({ body: 'second edit', edited: true, reactions: [{ key: '👍', count: 2, mine: true }] })
    expect(byId.has('$forged')).toBe(false)
    expect(byId.has('$e1')).toBe(false)
    expect(byId.get('$reply')).toMatchObject({ body: 'agreed', own: true, replyTo: { eventId: '$m1', body: 'second edit', missing: false } })
    expect(byId.get('$reply-missing')?.replyTo).toMatchObject({ missing: true })
    expect(byId.get('$gone')).toMatchObject({ kind: 'redacted', body: undefined })
    expect(byId.get('$utd')).toMatchObject({ kind: 'undecryptable', decryptionError: 'Missing room key', body: undefined })
    expect(byId.get('$join')).toMatchObject({ kind: 'membership', body: '@carol:example.org joined' })
    expect(byId.has('$topic')).toBe(false)
    expect(byId.get('$img')).toMatchObject({ kind: 'media', media: { name: 'cat.png' } })
    // A late-arriving target gets its waiting edit.
    const late = projectTimeline([...events, event({ eventId: '$not-yet', ts: 1, content: { msgtype: 'm.text', body: 'late' } })], { ownUserId: me })
    expect(late.find((item) => item.id === '$not-yet')).toMatchObject({ body: 'x', edited: true })
    expect(searchableText(events).map((item) => item.body)).toEqual(['second edit', 'agreed', 'what?', 'cat.png'])
  })

  it('shows pending local echoes once and merges them with their confirmed event', () => {
    const now = new Date(5_000).toISOString()
    const outbox: ChatOutboxRecord[] = [
      { id: 'o1', accountId: 'acc', roomId: '!room:example.org', txnId: 't1', userId: me, deviceId: 'D', kind: 'message', eventType: 'm.room.message', content: { msgtype: 'm.text', body: 'queued' }, state: 'pending', attempts: 0, createdAt: now, updatedAt: now },
      { id: 'o2', accountId: 'acc', roomId: '!room:example.org', txnId: 't2', userId: me, deviceId: 'D', kind: 'message', eventType: 'm.room.message', content: { msgtype: 'm.text', body: 'echoed' }, state: 'running', attempts: 1, createdAt: now, updatedAt: now },
      { id: 'o3', accountId: 'acc', roomId: '!room:example.org', txnId: 't3', userId: me, deviceId: 'D', kind: 'reaction', eventType: 'm.reaction', content: {}, state: 'pending', attempts: 0, createdAt: now, updatedAt: now }
    ]
    const items = projectTimeline([event({ eventId: '$echo', sender: me, txnId: 't2', content: { msgtype: 'm.text', body: 'echoed' } })], { ownUserId: me, outbox })
    expect(items.map((item) => [item.body, item.delivery])).toEqual([['echoed', 'sent'], ['queued', 'pending']])
  })

  it('parses relations defensively', () => {
    expect(relationOf({})).toEqual({})
    expect(relationOf({ 'm.relates_to': 'bad' })).toEqual({})
    expect(stripReplyFallback('> quoted\n> more\n\nreply')).toBe('reply')
    expect(stripReplyFallback('plain')).toBe('plain')
  })
})
