import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailAccountSummary, MailDraftInput } from '../../src/mail-types'
import { MailDatabase } from './database'
import { normalizeReplyTo } from './identity-store'

const directories: string[] = []
const account: MailAccountSummary = {
  id: 'account-1', provider: 'gmail', email: 'person@example.com', displayName: 'Person', color: '#6558e8', status: 'ready',
  archived: false, signature: 'Legacy', notifications: true, syncEnabled: true
}
const draft = (overrides: Partial<MailDraftInput> = {}): MailDraftInput => ({
  id: 'draft-1', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Hello', text: 'Body', attachmentPaths: [], ...overrides
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-identity-test-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  database.upsertAccount(account)
  return { database, store: database.identities, path, directory }
}

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

describe('MailIdentityStore', () => {
  it('creates a default primary identity that follows the account address and name', () => {
    const { database, store } = setup()
    const [primary] = store.list([account])
    expect(primary).toMatchObject({ id: 'account-1:primary', email: 'person@example.com', name: 'Person', source: 'primary', status: 'verified', isDefault: true })
    const renamed = { ...account, displayName: 'Renamed', email: 'new@example.com' }
    expect(store.list([renamed])[0]).toMatchObject({ email: 'new@example.com', name: 'Renamed' })
    expect(store.list([renamed], ['other'])).toEqual([])
    database.close()
  })

  it('adds, edits, defaults, validates, and removes manual aliases', () => {
    const { database, store } = setup()
    const alias = store.save(account, { accountId: 'account-1', email: 'sales@example.com', name: 'Sales\r\nTeam', replyTo: ['desk@example.com'] })
    expect(alias).toMatchObject({ source: 'manual', status: 'unverified', name: 'Sales Team', replyTo: ['desk@example.com'], isDefault: false })
    expect(() => store.save(account, { accountId: 'account-1', email: 'SALES@example.com', name: 'Dup' })).toThrow(/already a sender address/)
    expect(() => store.save(account, { accountId: 'account-1', email: 'not-an-address', name: 'Bad' })).toThrow(/complete sender email/)
    expect(() => store.save(account, { accountId: 'other', email: 'x@example.com', name: 'X' })).toThrow(/valid mail account/)
    expect(() => store.save(account, { id: 'missing', accountId: 'account-1', email: 'x@example.com', name: 'X' })).toThrow(/no longer exists/)
    expect(() => store.save(account, { accountId: 'account-1', email: 'x@example.com', name: 'X', replyTo: ['half'] })).toThrow(/Reply-To/)
    expect(() => store.save(account, { accountId: 'account-1', email: 'x@example.com', name: 'X', newSignatureId: 'missing' })).toThrow(/signature no longer exists/)

    const defaulted = store.save(account, { id: alias.id, accountId: 'account-1', email: 'ignored@example.com', name: 'Sales', isDefault: true })
    expect(defaulted).toMatchObject({ email: 'ignored@example.com', isDefault: true, replyTo: ['desk@example.com'] })
    expect(store.list([account]).find((item) => item.source === 'primary')?.isDefault).toBe(false)
    // The primary identity keeps the account name and address.
    expect(store.save(account, { id: 'account-1:primary', accountId: 'account-1', email: 'evil@example.com', name: 'Evil' })).toMatchObject({ email: 'person@example.com', name: 'Person' })

    store.delete(alias.id)
    store.delete('missing')
    expect(store.list([account])).toHaveLength(1)
    expect(store.list([account])[0].isDefault).toBe(true)
    expect(() => store.delete('account-1:primary')).toThrow(/managed by the provider/)
    database.close()
  })

  it('stores sanitized signatures, assigns them per identity, and clears assignments on delete', () => {
    const { database, store } = setup()
    const signature = store.saveSignature({ name: ' Work ', html: '<p>Ada <b>Lovelace</b><script>x()</script><img src="http://tracker.test/a.png"><a href="javascript:x">x</a></p>' })
    expect(signature.name).toBe('Work')
    expect(signature.html).not.toMatch(/script|tracker|javascript/)
    expect(signature.text).toBe('Ada Lovelacex')
    expect(() => store.saveSignature({ name: 'work', html: '' })).toThrow(/already exists/)
    expect(() => store.saveSignature({ name: '', html: '' })).toThrow(/name/)
    expect(() => store.saveSignature({ name: 'Big', html: 'x'.repeat(1_000_001) })).toThrow(/too large/)
    const renamed = store.saveSignature({ id: signature.id, name: 'Work 2', html: '<i>Hi</i>' })
    expect(renamed).toMatchObject({ id: signature.id, name: 'Work 2', html: '<i>Hi</i>', createdAt: signature.createdAt })
    const primary = store.save(account, { id: 'account-1:primary', accountId: 'account-1', email: account.email, name: '', newSignatureId: signature.id, replySignatureId: signature.id })
    expect(primary).toMatchObject({ newSignatureId: signature.id, replySignatureId: signature.id })
    expect(store.save(account, { id: primary.id, accountId: 'account-1', email: account.email, name: '', replySignatureId: '' }).replySignatureId).toBeUndefined()
    store.deleteSignature(signature.id)
    expect(store.listSignatures()).toEqual([])
    expect(store.get(primary.id)?.newSignatureId).toBeUndefined()
    database.close()
  })

  it('replaces provider identities while keeping local choices, and imports provider signatures', () => {
    const { database, store } = setup()
    const manual = store.save(account, { accountId: 'account-1', email: 'alias@example.com', name: 'Mine', replyTo: ['keep@example.com'] })
    store.replaceProviderIdentities(account, 'gmail', [
      { email: 'person@example.com', status: 'verified', replyTo: ['primary-reply@example.com'], signatureHtml: '<b>Primary sig</b>' },
      { email: 'alias@example.com', name: 'Alias', status: 'verified', replyTo: ['provider@example.com'] },
      { email: 'pending@example.com', status: 'pending' },
      { email: 'pending@example.com', status: 'pending' },
      { email: 'bad', status: 'verified' },
      { email: 'odd@example.com', status: 'verified', replyTo: ['not valid'] }
    ])
    let list = store.list([account])
    expect(list.map((item) => item.email)).toEqual(['person@example.com', 'alias@example.com', 'odd@example.com', 'pending@example.com'])
    const primary = list[0]
    expect(primary.replyTo).toEqual(['primary-reply@example.com'])
    expect(primary.newSignatureId).toBe('gmail:account-1:person@example.com')
    expect(store.getSignature(primary.newSignatureId!)?.html).toBe('<b>Primary sig</b>')
    expect(list[1]).toMatchObject({ id: manual.id, source: 'gmail', name: 'Alias', replyTo: ['keep@example.com'] })
    expect(list[2]).toMatchObject({ name: 'Person', replyTo: [] })
    expect(list[3]).toMatchObject({ status: 'pending' })
    expect(store.refreshedAt('account-1')).toBeTruthy()

    const pending = list[3]
    store.save(account, { id: pending.id, accountId: 'account-1', email: pending.email, name: pending.name, isDefault: true })
    store.replaceProviderIdentities(account, 'gmail', [{ email: 'alias@example.com', status: 'verified' }])
    list = store.list([account])
    expect(list.map((item) => item.email)).toEqual(['person@example.com', 'alias@example.com'])
    expect(list[0].isDefault).toBe(true)
    expect(() => store.delete(list[1].id)).toThrow(/managed by the provider/)
    database.close()
  })

  it('persists the draft sender next to the draft and removes it with the draft or account', () => {
    const { database, store, path, directory } = setup()
    const alias = store.save(account, { accountId: 'account-1', email: 'alias@example.com', name: 'Alias' })
    database.saveDraft(draft({ fromIdentityId: alias.id, replyTo: ['desk@example.com'] }))
    expect(database.getDraftRecord('draft-1')).toMatchObject({ fromIdentityId: alias.id, replyTo: ['desk@example.com'] })
    expect(database.listDrafts()[0]).toMatchObject({ fromIdentityId: alias.id })
    database.saveDraft(draft())
    expect(database.getDraftRecord('draft-1')?.fromIdentityId).toBeUndefined()
    database.saveDraft(draft({ replyTo: ['desk@example.com'] }))
    expect(store.draftSender('draft-1')).toEqual({ replyTo: ['desk@example.com'] })
    database.deleteDraftRecord('draft-1')
    expect(store.draftSender('draft-1')).toEqual({})
    database.close()

    // Migrations are idempotent across restarts.
    const reopened = new MailDatabase(path, join(directory, 'mail'))
    expect(reopened.identities.list([account]).map((item) => item.email)).toEqual(['person@example.com', 'alias@example.com'])
    reopened.disconnectAccount('account-1', 'delete')
    expect(reopened.identities.get(alias.id)).toBeUndefined()
    reopened.close()
  })

  it('normalizes Reply-To lists', () => {
    expect(normalizeReplyTo(undefined)).toEqual([])
    expect(normalizeReplyTo([' a@example.com\r\n', ''])).toEqual(['a@example.com'])
    expect(() => normalizeReplyTo('a@example.com')).toThrow(/at most/)
    expect(() => normalizeReplyTo(Array(11).fill('a@example.com'))).toThrow(/at most/)
  })
})
