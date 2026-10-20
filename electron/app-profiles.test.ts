import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProfileRegistry, configureProfilePaths, profileDirectory, profileLaunchArgs, registerAppProfiles, selectedProfileDirectory } from './app-profiles'
const temporary: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'aerio-profile-unit-')); temporary.push(root); return root }
afterEach(() => { for (const directory of temporary.splice(0)) { expect(relative(tmpdir(), directory)).toMatch(/^aerio-profile-unit-[^\\/]+$/); rmSync(directory, { recursive: true, force: true }) } })
describe('isolated application profiles', () => {
  it('preserves the existing default directory and stores independent databases and vault files', () => {
    const root = temp(), registry = new AppProfileRegistry(root)
    expect(registry.currentId).toBe('default'); expect(registry.directory).toBe(root)
    const work = registry.create('Work').profiles.find((profile) => profile.name === 'Work')!
    const target = profileDirectory(root, work.id)
    for (const [directory, name] of [[root, 'Personal'], [target, 'Work']]) {
      const db = new DatabaseSync(join(directory, 'aerio-state.sqlite'))
      db.exec('CREATE TABLE value (name TEXT)'); db.prepare('INSERT INTO value VALUES (?)').run(name); db.close()
      writeFileSync(join(directory, 'oauth-vault.dat'), name)
    }
    registry.select(work.id)
    const reopened = new AppProfileRegistry(root)
    expect(reopened.currentId).toBe(work.id); expect(reopened.directory).toBe(target)
    const db = new DatabaseSync(join(reopened.directory, 'aerio-state.sqlite'))
    expect(db.prepare('SELECT name FROM value').get()?.name).toBe('Work'); db.close()
    expect(readFileSync(join(root, 'oauth-vault.dat'), 'utf8')).toBe('Personal')
    expect(readFileSync(join(target, 'oauth-vault.dat'), 'utf8')).toBe('Work')
    expect(selectedProfileDirectory(root, ['--aerio-profile=default'])).toBe(root)
  })
  it('sets both Electron storage paths and preserves launch overrides when switching', () => {
    const registry = new AppProfileRegistry(temp())
    const paths = vi.fn(); configureProfilePaths({ setPath: paths }, registry.directory)
    expect(paths.mock.calls).toEqual([['userData', registry.directory], ['sessionData', registry.directory]])
    expect(profileLaunchArgs(['electron', '.', '--user-data-dir=C:/test', '--aerio-profile=default', '--test'], registry.currentId)).toEqual(['.', '--user-data-dir=C:/test', '--test', '--aerio-profile=default'])
  })
  it('validates names/IDs, persists renames, rejects corrupt registries and prevents path traversal', () => {
    const root = temp(), registry = new AppProfileRegistry(root)
    expect(() => registry.create('')).toThrow(/names/)
    expect(() => registry.create('personal')).toThrow(/different/)
    expect(() => profileDirectory(root, '../escape')).toThrow(/Invalid/)
    registry.rename('default', 'Home')
    expect(new AppProfileRegistry(root).snapshot().profiles[0].name).toBe('Home')
    writeFileSync(join(root, 'app-profiles.json'), '{}')
    expect(() => new AppProfileRegistry(root)).toThrow(/registry/)
  })
  it('blocks profile management while locked and rolls back selection if restart fails', () => {
    const root = temp(), registry = new AppProfileRegistry(root), handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const work = registry.create('Work').profiles.find((profile) => profile.name === 'Work')!, locked = vi.fn(() => true)
    registerAppProfiles({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } }, registry, argv: ['electron', '.'], restart: () => { throw new Error('restart failed') }, canSwitch: () => true, locked })
    expect(() => handlers.get('app-profiles:create')!(null, 'Family')).toThrow(/Unlock/)
    locked.mockReturnValue(false)
    expect(() => handlers.get('app-profiles:switch')!(null, work.id)).toThrow('restart failed')
    expect(new AppProfileRegistry(root).currentId).toBe('default')
  })
  it('switches only after closing other windows and verifies the requested profile', () => {
    const registry = new AppProfileRegistry(temp()), handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const work = registry.create('Work').profiles.find((profile) => profile.name === 'Work')!, restart = vi.fn(), canSwitch = vi.fn(() => false)
    registerAppProfiles({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } }, registry, argv: ['electron', '.'], restart, canSwitch })
    expect(() => handlers.get('app-profiles:switch')!(null, work.id)).toThrow(/Close other/)
    expect(restart).not.toHaveBeenCalled()
    canSwitch.mockReturnValue(true)
    expect(() => handlers.get('app-profiles:switch')!(null, 'missing')).toThrow(/not found/)
    handlers.get('app-profiles:switch')!(null, work.id)
    expect(restart).toHaveBeenCalledWith(['.', `--aerio-profile=${work.id}`])
    expect(new AppProfileRegistry(registry.root).currentId).toBe(work.id)
    expect(() => handlers.get('app-profiles:switch')!(null, work.id)).toThrow(/already switching/)
  })
})
