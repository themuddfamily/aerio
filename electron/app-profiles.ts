import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppProfile, AppProfileSnapshot } from '../src/app-profile-types'

interface Registry { version: 1; selectedId: string; profiles: AppProfile[] }
const validId = (id: unknown): id is string => id === 'default' || typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
function profileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) throw new Error('Profile names must contain 1–80 characters without control characters.')
  return value.trim()
}
function readRegistry(root: string): Registry | undefined {
  const path = join(root, 'app-profiles.json')
  if (!existsSync(path)) return
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Registry
  if (parsed.version !== 1 || !Array.isArray(parsed.profiles) || !parsed.profiles.length || parsed.profiles.length > 50 || !parsed.profiles.some((profile) => profile.id === 'default')) throw new Error('The application profile registry is invalid. Restore app-profiles.json from backup before starting Aerio.')
  const ids = new Set<string>()
  for (const profile of parsed.profiles) {
    if (!validId(profile.id) || ids.has(profile.id) || !Number.isFinite(Date.parse(profile.createdAt))) throw new Error('The application profile registry is invalid.')
    profileName(profile.name); ids.add(profile.id)
  }
  if (!ids.has(parsed.selectedId)) throw new Error('The selected application profile does not exist.')
  return parsed
}
export function profileDirectory(root: string, id: string): string {
  if (!validId(id)) throw new Error('Invalid application profile ID.')
  return id === 'default' ? resolve(root) : resolve(root, 'profiles', id)
}
export function requestedProfile(argv: string[]): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--aerio-profile='))
  if (!flag) return
  const id = flag.slice('--aerio-profile='.length)
  if (!validId(id)) throw new Error('Invalid --aerio-profile value.')
  return id
}
export function profileLaunchArgs(argv: string[], id: string): string[] {
  if (!validId(id)) throw new Error('Invalid application profile ID.')
  return [...argv.slice(1).filter((arg) => !arg.startsWith('--aerio-profile=')), `--aerio-profile=${id}`]
}
/** Read-only routing for the MCP bridge; never creates or changes a profile. */
export function selectedProfileDirectory(root: string, argv: string[]): string {
  const registry = readRegistry(root)
  const id = requestedProfile(argv) ?? registry?.selectedId ?? 'default'
  if (id !== 'default' && !registry?.profiles.some((profile) => profile.id === id)) throw new Error('The requested application profile does not exist.')
  return profileDirectory(root, id)
}
export class AppProfileRegistry {
  private registry: Registry
  readonly currentId: string
  readonly directory: string
  constructor(readonly root: string, argv: string[] = []) {
    mkdirSync(root, { recursive: true })
    this.registry = readRegistry(root) ?? { version: 1, selectedId: 'default', profiles: [{ id: 'default', name: 'Personal', createdAt: new Date().toISOString() }] }
    this.currentId = requestedProfile(argv) ?? this.registry.selectedId
    if (!this.registry.profiles.some((profile) => profile.id === this.currentId)) throw new Error('The requested application profile does not exist.')
    this.directory = profileDirectory(root, this.currentId)
    mkdirSync(this.directory, { recursive: true })
    this.registry.selectedId = this.currentId
    this.persist()
  }
  snapshot(): AppProfileSnapshot { return { currentId: this.currentId, profiles: this.registry.profiles.map((profile) => ({ ...profile })) } }
  create(name: unknown): AppProfileSnapshot {
    if (this.registry.profiles.length >= 50) throw new Error('You can create up to 50 application profiles.')
    const normalized = profileName(name)
    if (this.registry.profiles.some((profile) => profile.name.toLowerCase() === normalized.toLowerCase())) throw new Error('Choose a different profile name.')
    const profile = { id: randomUUID(), name: normalized, createdAt: new Date().toISOString() }
    mkdirSync(profileDirectory(this.root, profile.id), { recursive: true })
    this.replace({ ...this.registry, profiles: [...this.registry.profiles, profile] })
    return this.snapshot()
  }
  rename(id: unknown, name: unknown): AppProfileSnapshot {
    const normalized = profileName(name)
    if (!this.registry.profiles.some((profile) => profile.id === id)) throw new Error('Application profile not found.')
    if (this.registry.profiles.some((profile) => profile.id !== id && profile.name.toLowerCase() === normalized.toLowerCase())) throw new Error('Choose a different profile name.')
    this.replace({ ...this.registry, profiles: this.registry.profiles.map((profile) => profile.id === id ? { ...profile, name: normalized } : profile) })
    return this.snapshot()
  }
  select(id: unknown): void {
    if (!this.registry.profiles.some((profile) => profile.id === id)) throw new Error('Application profile not found.')
    this.replace({ ...this.registry, selectedId: id as string })
  }
  private replace(next: Registry): void {
    const previous = this.registry
    this.registry = next
    try { this.persist() } catch (error) { this.registry = previous; throw error }
  }
  private persist(): void {
    const target = join(this.root, 'app-profiles.json'), temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(this.registry, null, 2), { mode: 0o600 })
    renameSync(temporary, target)
  }
}

export function configureProfilePaths(app: { setPath(name: 'userData' | 'sessionData', path: string): void }, directory: string): void {
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
}
export function registerAppProfiles({ ipcMain, registry, argv, restart, canSwitch, locked, beforeSwitch, switchFailed }: {
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void }
  registry: AppProfileRegistry; argv: string[]; restart(args: string[]): void; canSwitch(): boolean; locked?(): boolean
  beforeSwitch?(): Promise<void>; switchFailed?(): void
}) {
  let switching = false
  const requireUnlocked = () => { if (locked?.()) throw new Error('Unlock Aerio to manage application profiles.') }
  ipcMain.handle('app-profiles:list', () => { requireUnlocked(); return registry.snapshot() })
  ipcMain.handle('app-profiles:create', (_event, name) => { requireUnlocked(); return registry.create(name) })
  ipcMain.handle('app-profiles:rename', (_event, id, name) => { requireUnlocked(); return registry.rename(id, name) })
  ipcMain.handle('app-profiles:switch', (_event, id) => {
    requireUnlocked()
    if (switching) throw new Error('Aerio is already switching application profiles.')
    if (id === registry.currentId) return
    if (!canSwitch()) throw new Error('Close other Aerio windows before switching application profiles.')
    if (!registry.snapshot().profiles.some((profile) => profile.id === id)) throw new Error('Application profile not found.')
    if (beforeSwitch) {
      switching = true
      return Promise.resolve().then(beforeSwitch).then(() => {
        requireUnlocked()
        if (!canSwitch()) throw new Error('Close other Aerio windows before switching application profiles.')
        registry.select(id)
        try { restart(profileLaunchArgs(argv, id as string)) } catch (error) { registry.select(registry.currentId); throw error }
      }).catch((error) => { switching = false; switchFailed?.(); throw error })
    }
    registry.select(id)
    try { restart(profileLaunchArgs(argv, id as string)); switching = true }
    catch (error) { registry.select(registry.currentId); throw error }
  })
}
