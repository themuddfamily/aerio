import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailDatabase } from './mail/database'
import { MailTemplateStore } from './mail/template-store'
import { applyPortableSignatures, capturePortableSignatures } from './mail/settings-sync-signatures'
import { settingsSyncAdapter } from './settings-sync-data'
import { createDefaultPreferences } from '../src/preferences'
import { syncDigest } from './settings-sync-crypto'
import type { MailAccountSummary } from '../src/mail-types'
const roots: string[] = [], closers: (() => void)[] = []
function device(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'aerio-sync-data-')); roots.push(root)
  const database = new MailDatabase(join(root, 'mail.sqlite'), join(root, 'mail'))
  const account: MailAccountSummary = { id, provider: 'gmail', email: 'person@example.com', displayName: id, color: '#6558e8', archived: false, status: 'ready', signature: '', notifications: false, syncEnabled: false }
  database.upsertAccount(account)
  const templates = new MailTemplateStore(join(root, 'templates.sqlite'), join(root, 'template-attachments'), () => true)
  closers.push(() => { templates.close(); database.close() })
  let preferences = createDefaultPreferences()
  preferences.settings.launchAtLogin = id === 'second'; preferences.settings.closeToTray = id === 'first'
  let hook: ((command: any, result: any) => Promise<void>) | undefined
  const adapter = settingsSyncAdapter({ load: () => preferences, save: (next) => { preferences = next }, templates: () => templates, worker: () => ({ request: async (command: any) => { const result = command.type === 'settings-sync:signatures-export' ? capturePortableSignatures(database) : applyPortableSignatures(database, command.payload, command.expected); await hook?.(command, result); return result } }) as any, applied: () => {} })
  return { root, account, database, templates, adapter, preferences: () => preferences, hook: (next: typeof hook) => { hook = next } }
}
afterEach(() => { closers.splice(0).forEach((close) => close()); roots.splice(0).forEach((root) => { expect(relative(tmpdir(), root)).toMatch(/^aerio-sync-data-[^\\/]+$/); rmSync(root, { recursive: true, force: true }) }) })
describe('portable settings with real mail stores', () => {
  it('transfers signatures, sender assignments, templates, QuickText and attachment bytes between different account IDs', async () => {
    const a = device('first'), b = device('second')
    a.preferences().settings.theme = 'dark'
    a.preferences().settings.mailNotifications = { actions: ['archive'], preview: 'hidden', silent: true, onlyWhenUnfocused: true, quietHours: { enabled: false, start: '22:00', end: '08:00' }, accounts: { first: true } }
    b.preferences().settings.mailNotifications = { ...a.preferences().settings.mailNotifications!, accounts: { second: false } }
    a.database.updateAccountSettings({ ...a.account, accountId: a.account.id, signature: 'Legacy account signature' })
    const signature = a.database.identities.saveSignature({ name: 'Work', html: '<b>Best wishes</b>' })
    a.database.identities.save(a.account, { id: `${a.account.id}:primary`, accountId: a.account.id, email: a.account.email, name: a.account.displayName, newSignatureId: signature.id, replySignatureId: signature.id })
    const file = join(a.root, 'brief.txt'); writeFileSync(file, 'brief')
    a.templates.save({ kind: 'template', name: 'Brief', subject: 'Status', html: '<p>Report</p>', attachments: [{ name: 'brief.txt', size: 5, path: file }] })
    a.templates.save({ kind: 'snippet', name: 'Thanks', html: '<p>Thank you</p>' })
    const snapshot = await a.adapter.capture()
    expect(JSON.stringify(snapshot)).not.toContain(file)
    expect(snapshot.preferences).not.toHaveProperty('launchAtLogin')
    expect(snapshot.preferences).not.toHaveProperty('closeToTray')
    expect(snapshot.preferences.mailNotifications).not.toHaveProperty('accounts')
    await b.adapter.apply(snapshot, undefined, await b.adapter.capture())
    expect(b.preferences().settings).toMatchObject({ theme: 'dark', launchAtLogin: true, closeToTray: false, mailNotifications: { preview: 'hidden', accounts: { second: false } } })
    expect(b.database.getAccount('second')?.signature).toBe('Legacy account signature')
    expect(b.database.identities.list([b.account])[0]).toMatchObject({ newSignatureId: signature.id, replySignatureId: signature.id })
    const restored = b.templates.list()
    expect(restored.map((item) => item.kind).sort()).toEqual(['snippet', 'template'])
    expect(readFileSync(restored.find((item) => item.kind === 'template')!.attachments[0].path, 'utf8')).toBe('brief')
    expect(syncDigest(await b.adapter.capture())).toBe(syncDigest(snapshot))
    expect(b.database.listAccounts()).toHaveLength(1)
    expect(b.database.getAccount('second')).toMatchObject({ notifications: false, syncEnabled: false })
  })
  it('rejects corrupt snapshots before modifying any settings or signatures', async () => {
    const a = device('first'), before = await a.adapter.capture()
    await expect(a.adapter.apply({ ...before, signatures: { ...before.signatures, definitions: [{ id: 'x', name: 'Invalid', html: 123 }] } } as any)).rejects.toThrow(/signature/)
    expect(syncDigest(await a.adapter.capture())).toBe(syncDigest(before))
  })
  it.each(['export', 'apply'])('preserves preferences and templates edited during signature %s await', async (stage) => {
    const a = device('first'), target = await a.adapter.capture()
    target.preferences.theme = 'dark'
    target.signatures.definitions = [{ id: 'remote', name: 'Remote', html: 'Shared' }]
    let triggered = false
    a.hook(async (command) => {
      if (!triggered && command.type === `settings-sync:signatures-${stage}`) {
        triggered = true
        a.preferences().settings.density = 'compact'
        a.templates.save({ kind: 'snippet', name: 'New local edit', html: 'Keep this' })
      }
    })
    await expect(a.adapter.apply(target)).rejects.toThrow('changed during import')
    expect(a.preferences().settings).toMatchObject({ density: 'compact', theme: 'system' })
    expect(a.templates.list().map((item) => item.name)).toEqual(['New local edit'])
    expect(a.database.identities.listSignatures()).toEqual([])
  })
  it('preserves a newer signature edit instead of rolling it back after a concurrent preference edit', async () => {
    const a = device('first'), target = await a.adapter.capture()
    target.signatures.definitions = [{ id: 'remote', name: 'Remote', html: 'Shared' }]
    let triggered = false
    a.hook(async (command) => {
      if (!triggered && command.type === 'settings-sync:signatures-apply') {
        triggered = true
        a.preferences().settings.density = 'compact'
        a.database.identities.saveSignature({ name: 'Newer local signature', html: 'Keep me' })
      }
    })
    await expect(a.adapter.apply(target)).rejects.toThrow('changed during import')
    expect(a.database.identities.listSignatures().map((item) => item.name)).toContain('Newer local signature')
  })
  it('atomically rejects a signature update if the expected export has changed', async () => {
    const a = device('first'), expected = capturePortableSignatures(a.database)
    a.database.identities.saveSignature({ name: 'Newer signature', html: 'Keep me' })
    expect(() => applyPortableSignatures(a.database, expected, expected)).toThrow('changed during import')
    expect(a.database.identities.listSignatures()[0].name).toBe('Newer signature')
  })

  it('detects signature edits between worker export and apply without replacing them', async () => {
    const a = device('first'), target = await a.adapter.capture()
    let triggered = false
    a.hook(async (command) => {
      if (!triggered && command.type === 'settings-sync:signatures-export') {
        triggered = true
        a.database.identities.saveSignature({ name: 'Between commands', html: 'Keep me' })
      }
    })
    await expect(a.adapter.apply(target)).rejects.toThrow('changed during import')
    expect(a.database.identities.listSignatures()[0].name).toBe('Between commands')
  })
  it('compensates its own preference and signature changes if template commit fails', async () => {
    const a = device('first'), before = await a.adapter.capture(), target = structuredClone(before)
    target.preferences.theme = 'dark'
    target.signatures.definitions = [{ id: 'remote', name: 'Remote', html: 'Shared' }]
    const prepare = a.templates.prepareRestore.bind(a.templates)
    vi.spyOn(a.templates, 'prepareRestore').mockImplementation((...args) => {
      const prepared = prepare(...args)
      return { ...prepared, commit: () => { throw new Error('Disk failed') } }
    })
    await expect(a.adapter.apply(target)).rejects.toThrow('Disk failed')
    expect(syncDigest(await a.adapter.capture())).toBe(syncDigest(before))
  })

  it('compares canonical template order when checking the expected local snapshot', async () => {
    const a = device('first')
    a.templates.save({ kind: 'snippet', name: 'Zed', html: 'Z' })
    a.templates.save({ kind: 'template', name: 'Alpha', subject: '', html: 'A' })
    const expected = await a.adapter.capture()
    // Force the expected order to differ from the template store export order.
    const actual = a.templates.exportBackup().templates.map((item) => item.id)
    expected.templates.templates.sort((left, right) => actual.indexOf(right.id) - actual.indexOf(left.id))
    const canonical = a.adapter.validate(expected)
    await expect(a.adapter.apply(canonical, undefined, canonical)).resolves.toBeDefined()
  })

})
