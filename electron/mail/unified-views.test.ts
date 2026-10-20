import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MailUnifiedViewsStore, registerMailUnifiedViews } from './unified-views'
import { unifiedViewAccountIds } from '../../src/lib/mail-unified-views'

const directories: string[] = [], stores: MailUnifiedViewsStore[] = []
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-unified-')); directories.push(directory)
  const path = join(directory, 'views.sqlite'), store = new MailUnifiedViewsStore(path); stores.push(store)
  return { path, store }
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const input = { name: 'Work', accountIds: ['a', 'b'], folderAccountIds: { inbox: ['a'], sent: [] } }

describe('saved unified account views', () => {
  it('persists named membership, per-folder overrides and selection across restart', () => {
    const { store, path } = setup()
    const created = store.save(input, ['a', 'b', 'c']).views[0]
    store.select(created.id)
    const reopened = new MailUnifiedViewsStore(path); stores.push(reopened)
    expect(reopened.snapshot()).toEqual({ selectedId: created.id, views: [{ id: created.id, ...input }] })
    expect(unifiedViewAccountIds(created, 'inbox', ['a', 'b', 'c'])).toEqual(['a'])
    expect(unifiedViewAccountIds(created, 'sent', ['a', 'b', 'c'])).toEqual([])
    expect(unifiedViewAccountIds(created, 'archive', ['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(unifiedViewAccountIds(created, 'archive', ['c'])).toEqual([])
    expect(unifiedViewAccountIds(undefined, 'archive', ['c'])).toBeUndefined()
  })

  it('updates/deletes views and refuses invalid or widening membership', () => {
    const { store } = setup()
    for (const value of [{ ...input, name: '' }, { ...input, accountIds: [] }, { ...input, accountIds: ['a', 'a'] }, { ...input, accountIds: ['missing'] }, { ...input, folderAccountIds: { inbox: ['c'] } }, { ...input, folderAccountIds: { invalid: ['a'] } }]) expect(() => store.save(value, ['a', 'b', 'c'])).toThrow()
    const view = store.save(input, ['a', 'b']).views[0]
    expect(() => store.save({ ...input, name: 'WORK' }, ['a', 'b'])).toThrow(/already exists/)
    expect(() => store.select('missing')).toThrow(/not found/)
    store.select(view.id)
    expect(store.save({ ...view, name: 'Business' }, ['a', 'b']).views[0].name).toBe('Business')
    expect(store.remove(view.id)).toEqual({ views: [] })
  })

  it('checks lock state and current account membership at IPC boundaries and broadcasts changes', async () => {
    const { store } = setup(), handlers = new Map<string, (...args: any[]) => any>(), changed: unknown[] = []
    let locked = true
    registerMailUnifiedViews({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } }, store, accounts: async () => [{ id: 'a' }, { id: 'b' }], locked: () => locked, changed: (value) => changed.push(value) })
    expect(() => handlers.get('mail:unified-views:snapshot')!({})).toThrow(/Unlock/)
    await expect(handlers.get('mail:unified-views:save')!({}, input)).rejects.toThrow(/Unlock/)
    locked = false
    const snapshot = await handlers.get('mail:unified-views:save')!({}, input)
    handlers.get('mail:unified-views:select')!({}, snapshot.views[0].id)
    expect(changed).toHaveLength(2)
    await expect(handlers.get('mail:unified-views:save')!({}, { name: 'Other', accountIds: ['c'] })).rejects.toThrow(/available account/)
  })
})
