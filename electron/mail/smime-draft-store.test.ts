import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase } from './database'
import { assertSingleProtection, normalizeSmimeOptions } from './smime-draft-store'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))
const FINGERPRINT = 'A'.repeat(64)

describe('draft S/MIME options', () => {
  it('normalizes choices and rejects malformed certificate selections', () => {
    expect(normalizeSmimeOptions(undefined)).toBeUndefined()
    expect(normalizeSmimeOptions({ sign: false, encrypt: false })).toBeUndefined()
    expect(normalizeSmimeOptions({ sign: 'yes', encrypt: true, extra: 1 })).toEqual({ encrypt: true })
    expect(normalizeSmimeOptions({ encrypt: true, recipientCerts: { ' Ada@Example.test ': FINGERPRINT.toLowerCase() } })).toEqual({ encrypt: true, recipientCerts: { 'ada@example.test': FINGERPRINT } })
    expect(() => normalizeSmimeOptions({ encrypt: true, recipientCerts: { 'a@example.test': 'A'.repeat(40) } })).toThrow(/recipient certificates/)
    expect(() => normalizeSmimeOptions('sign')).toThrow(/invalid/)
  })

  it('refuses a message that asks for OpenPGP and S/MIME at once', () => {
    expect(() => assertSingleProtection({ openPgp: { sign: true }, smime: { encrypt: true } })).toThrow(/either OpenPGP or S\/MIME.*not sent/)
    expect(() => assertSingleProtection({ openPgp: { sign: true }, smime: undefined })).not.toThrow()
    expect(() => assertSingleProtection({ smime: { sign: true } })).not.toThrow()
  })

  it('stores the choice with the draft, survives reopening, and is removed with it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-smime-draft-'))
    directories.push(directory)
    const path = join(directory, 'aerio.sqlite')
    let database = new MailDatabase(path, join(directory, 'mail'))
    database.upsertAccount({ id: 'account', provider: 'imap', email: 'a@example.test', displayName: 'A', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true } as never)
    const input = { id: 'draft', accountId: 'account', to: ['b@example.test'], cc: [], bcc: [], subject: 'S', text: 'T', attachmentPaths: [], smime: { sign: true, encrypt: true, recipientCerts: { 'b@example.test': FINGERPRINT } } }
    database.saveDraft(input)
    expect(database.getDraftRecord('draft')?.smime).toEqual(input.smime)
    database.close()
    database = new MailDatabase(path, join(directory, 'mail'))
    expect(database.getDraftRecord('draft')?.smime).toEqual(input.smime)
    database.saveDraft({ ...input, smime: undefined })
    expect(database.getDraftRecord('draft')?.smime).toBeUndefined()
    database.saveDraft(input)
    database.deleteDraftRecord('draft')
    expect(database.smime.get('draft')).toEqual({})
    database.close()
  })
})
