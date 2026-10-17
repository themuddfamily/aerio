import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_PREFERENCES, type ChatAccountRecord } from './chat-store'
import { CHAT_SDK_VERSION, evaluateChatGate, readGateEvidence, writeGateEvidence } from './gate'
import {
  assertAttachmentSize, attachmentLimit, CHAT_ATTACHMENT_LIMIT, decryptAttachment, encryptAttachment, mediaDownloadPath,
  parseMxc, readBoundedBody, sanitizeMediaName, sanitizeMime, validEncryptedFile
} from './media'
import { chatNotificationFor } from './notifications'
import type { ChatStoredEvent } from './projection'

describe('attachment policy', () => {
  it('limits files to 25 MiB or the smaller server limit', () => {
    expect(attachmentLimit()).toBe(CHAT_ATTACHMENT_LIMIT)
    expect(attachmentLimit(10 * 1024 * 1024)).toBe(10 * 1024 * 1024)
    expect(attachmentLimit(100 * 1024 * 1024)).toBe(CHAT_ATTACHMENT_LIMIT)
    expect(() => assertAttachmentSize(CHAT_ATTACHMENT_LIMIT + 1)).toThrow('25 MiB')
    expect(() => assertAttachmentSize(2 * 1024 * 1024, 1024 * 1024)).toThrow('1 MiB')
    expect(() => assertAttachmentSize(0)).toThrow('Empty')
    expect(() => assertAttachmentSize(Number.NaN)).toThrow('measured')
    expect(() => assertAttachmentSize(10)).not.toThrow()
  })

  it('sanitizes remote names and types and validates mxc references', () => {
    expect(sanitizeMediaName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeMediaName('C:\\Users\\x\\..\\evil.exe')).toBe('evil.exe')
    expect(sanitizeMediaName('.hidden\u0000name<>.txt')).toBe('hiddenname.txt')
    expect(sanitizeMediaName(42)).toBe('attachment')
    expect(sanitizeMime('image/png')).toBe('image/png')
    expect(sanitizeMime('text/html')).toBe('application/octet-stream')
    expect(sanitizeMime('image/svg+xml')).toBe('application/octet-stream')
    expect(sanitizeMime('not a type')).toBe('application/octet-stream')
    expect(parseMxc('mxc://example.org/abc_DEF-1')).toEqual({ serverName: 'example.org', mediaId: 'abc_DEF-1' })
    expect(mediaDownloadPath('mxc://example.org/abc')).toBe('/_matrix/client/v1/media/download/example.org/abc')
    for (const bad of ['https://example.org/abc', 'mxc://example.org/../x', 'mxc://example.org/a/b', 'mxc:///abc', null]) expect(() => parseMxc(bad)).toThrow('not valid')
  })

  it('round-trips Matrix v2 encrypted attachments and rejects tampering before decryption', async () => {
    const plaintext = new TextEncoder().encode('quarterly numbers')
    const { ciphertext, info } = await encryptAttachment(plaintext)
    expect(validEncryptedFile(info)).toBe(true)
    expect(Buffer.from(ciphertext).includes(Buffer.from('quarterly'))).toBe(false)
    expect(new TextDecoder().decode(await decryptAttachment(ciphertext, info))).toBe('quarterly numbers')
    const tampered = ciphertext.slice(); tampered[0] ^= 1
    await expect(decryptAttachment(tampered, info)).rejects.toThrow('integrity check')
    await expect(decryptAttachment(ciphertext, { ...info, key: { ...info.key, alg: 'A128CTR' } })).rejects.toThrow('encryption details')
    await expect(decryptAttachment(ciphertext, undefined)).rejects.toThrow('encryption details')
  })

  it('enforces streamed size limits regardless of Content-Length', async () => {
    expect(await readBoundedBody(new Response('12345'), 10)).toHaveLength(5)
    await expect(readBoundedBody(new Response('12345678901'), 10)).rejects.toThrow('larger than Aerio allows')
    await expect(readBoundedBody(new Response('1', { headers: { 'Content-Length': '99' } }), 10)).rejects.toThrow('larger than Aerio allows')
    expect(await readBoundedBody(new Response(null), 10)).toHaveLength(0)
  })
})

describe('chat notifications', () => {
  const account: ChatAccountRecord = { id: 'acc', transport: 'matrix', homeserver: 'https://example.org', userId: '@me:example.org', deviceId: 'D', status: 'ready', trust: 'verified', recovery: 'available', preferences: { ...DEFAULT_CHAT_PREFERENCES, notificationPreviews: true }, createdAt: '' }
  const room = { accountId: 'acc', roomId: '!r', name: 'Family', encrypted: true, membership: 'join' as const, isDirect: false, unread: 1, muted: false, previews: true }
  const event: ChatStoredEvent = { eventId: '$1', roomId: '!r', sender: '@bob:example.org', type: 'm.room.message', ts: 2_000, content: { msgtype: 'm.text', body: 'Dinner at   seven' }, encrypted: true, redacted: false }
  const context = { account, room, globalEnabled: true, locked: false, notBefore: 1_000 }

  it('shows a preview only when unlocked and allowed by account and room', () => {
    expect(chatNotificationFor(event, context)).toMatchObject({ title: 'Family', body: 'Dinner at seven' })
    expect(chatNotificationFor(event, { ...context, locked: true })).toMatchObject({ title: 'New chat message', body: 'Open Aerio to read it' })
    expect(chatNotificationFor(event, { ...context, room: { ...room, previews: false } })?.title).toBe('New chat message')
    expect(chatNotificationFor(event, { ...context, account: { ...account, preferences: DEFAULT_CHAT_PREFERENCES } })?.title).toBe('New chat message')
    expect(chatNotificationFor({ ...event, decryptionError: 'no key', type: 'm.room.encrypted', content: {} }, context)?.title).toBe('New chat message')
    expect(chatNotificationFor({ ...event, content: { body: 'x'.repeat(200) } }, context)?.body).toHaveLength(140)
  })

  it('suppresses muted, own, redacted, replayed, edited and non-member events', () => {
    expect(chatNotificationFor(event, { ...context, globalEnabled: false })).toBeUndefined()
    expect(chatNotificationFor(event, { ...context, room: { ...room, muted: true } })).toBeUndefined()
    expect(chatNotificationFor(event, { ...context, room: undefined })).toBeUndefined()
    expect(chatNotificationFor(event, { ...context, account: { ...account, status: 'paused' } })).toBeUndefined()
    expect(chatNotificationFor({ ...event, sender: account.userId }, context)).toBeUndefined()
    expect(chatNotificationFor({ ...event, redacted: true }, context)).toBeUndefined()
    expect(chatNotificationFor({ ...event, ts: 500 }, context)).toBeUndefined()
    expect(chatNotificationFor(event, { ...context, checkpoint: { ts: 2_000, eventId: '$1' } })).toBeUndefined()
    expect(chatNotificationFor(event, { ...context, checkpoint: { ts: 3_000, eventId: '$0' } })).toBeUndefined()
    expect(chatNotificationFor({ ...event, content: { body: '* x', 'm.relates_to': { rel_type: 'm.replace', event_id: '$0' } } }, context)).toBeUndefined()
    expect(chatNotificationFor({ ...event, type: 'm.reaction' }, context)).toBeUndefined()
    expect(chatNotificationFor(event, { ...context, room: { ...room, membership: 'leave' } })).toBeUndefined()
  })

  it('announces invitations generically', () => {
    const invite = { ...event, type: 'm.room.member', stateKey: account.userId, content: { membership: 'invite' } }
    expect(chatNotificationFor(invite, { ...context, room: { ...room, membership: 'invite' } })).toMatchObject({ title: 'New chat invitation' })
    expect(chatNotificationFor(event, { ...context, room: { ...room, membership: 'invite' } })).toBeUndefined()
  })
})

describe('chat gate', () => {
  const pass = { passed: true, detail: 'ok', checkedAt: '2026-10-17T00:00:00Z' }
  const inputs = { secureStorage: () => {}, serviceRuntime: () => true, electronVersion: '43.7.7', preview: false }

  it('stays closed without crypto persistence or interoperability evidence', () => {
    const none = evaluateChatGate({ ...inputs, evidence: undefined })
    expect(none.enabled).toBe(false)
    expect(none.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(['crypto-persistence', 'interoperability'])
    expect(none.message).toMatch(/encrypted crypto-store persistence, two-device interoperability/)
    const persistOnly = evaluateChatGate({ ...inputs, evidence: { sdk: CHAT_SDK_VERSION, electron: '43.7.7', cryptoPersistence: pass } })
    expect(persistOnly.enabled).toBe(false)
  })

  it('opens fully with all evidence, or as a preview that waives only interoperability', () => {
    const all = evaluateChatGate({ ...inputs, evidence: { sdk: CHAT_SDK_VERSION, electron: '43.7.7', cryptoPersistence: pass, interoperability: { ...pass, homeserver: 'https://hs.example' } } })
    expect(all).toMatchObject({ enabled: true, preview: false, message: 'Chat is available.' })
    const preview = evaluateChatGate({ ...inputs, preview: true, evidence: { sdk: CHAT_SDK_VERSION, electron: '43.7.7', cryptoPersistence: pass } })
    expect(preview).toMatchObject({ enabled: true, preview: true })
    expect(evaluateChatGate({ ...inputs, preview: true, evidence: undefined }).enabled).toBe(false)
    expect(evaluateChatGate({ ...inputs, preview: true, secureStorage: () => { throw new Error('basic_text') }, evidence: { sdk: CHAT_SDK_VERSION, electron: '43.7.7', cryptoPersistence: pass } })).toMatchObject({ enabled: false })
    expect(evaluateChatGate({ ...inputs, preview: true, serviceRuntime: () => false, evidence: { sdk: CHAT_SDK_VERSION, electron: '43.7.7', cryptoPersistence: pass } }).enabled).toBe(false)
  })

  it('ignores evidence recorded for another SDK or Electron version', () => {
    const stale = evaluateChatGate({ ...inputs, preview: true, evidence: { sdk: 'matrix-js-sdk 1.0.0', electron: '43.7.7', cryptoPersistence: pass } })
    expect(stale.enabled).toBe(false)
    const directory = mkdtempSync(join(tmpdir(), 'aerio-chat-gate-'))
    try {
      const path = join(directory, 'chat-gate.json')
      expect(readGateEvidence(path)).toBeUndefined()
      writeGateEvidence(path, { sdk: CHAT_SDK_VERSION, electron: '1', cryptoPersistence: pass })
      expect(readGateEvidence(path)?.cryptoPersistence?.passed).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
