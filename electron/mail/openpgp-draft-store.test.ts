import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase } from './database'
import { normalizeOpenPgpOptions } from './openpgp-draft-store'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))
const FINGERPRINT = 'A'.repeat(40)

describe('draft OpenPGP options', () => {
  it('normalizes choices and rejects malformed key selections', () => {
    expect(normalizeOpenPgpOptions(undefined)).toBeUndefined()
    expect(normalizeOpenPgpOptions({ sign: false, encrypt: false })).toBeUndefined()
    expect(normalizeOpenPgpOptions({ sign: 'yes', encrypt: true, extra: 1 })).toEqual({ encrypt: true })
    expect(normalizeOpenPgpOptions({ encrypt: true, recipientKeys: { ' Ada@Example.test ': FINGERPRINT.toLowerCase() } })).toEqual({ encrypt: true, recipientKeys: { 'ada@example.test': FINGERPRINT } })
    expect(() => normalizeOpenPgpOptions({ encrypt: true, recipientKeys: { 'a@example.test': 'short' } })).toThrow(/recipient keys/)
    expect(() => normalizeOpenPgpOptions('sign')).toThrow(/invalid/)
  })

  it('stores the choice with the draft, survives reopening, and is removed with it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-openpgp-draft-'))
    directories.push(directory)
    const path = join(directory, 'aerio.sqlite')
    let database = new MailDatabase(path, join(directory, 'mail'))
    database.upsertAccount({ id: 'account', provider: 'imap', email: 'a@example.test', displayName: 'A', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true } as never)
    const input = { id: 'draft', accountId: 'account', to: ['b@example.test'], cc: [], bcc: [], subject: 'S', text: 'T', attachmentPaths: [], openPgp: { sign: true, encrypt: true, recipientKeys: { 'b@example.test': FINGERPRINT } } }
    database.saveDraft(input)
    expect(database.getDraftRecord('draft')?.openPgp).toEqual(input.openPgp)
    database.close()
    // Reopening applies the idempotent schema again.
    database = new MailDatabase(path, join(directory, 'mail'))
    expect(database.getDraftRecord('draft')?.openPgp).toEqual(input.openPgp)
    database.saveDraft({ ...input, openPgp: undefined })
    expect(database.getDraftRecord('draft')?.openPgp).toBeUndefined()
    database.saveDraft(input)
    database.deleteDraftRecord('draft')
    expect(database.openPgp.get('draft')).toEqual({})
    database.close()
  })
})
