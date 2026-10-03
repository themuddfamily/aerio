import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxLoginEntry, setLinuxLoginItem } from './linux-login'

const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'aerio-login-test-'))
  roots.push(home)
  return { home, executable: join(home, 'App with spaces', 'aerio') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Linux XDG startup registration', () => {
  it('creates an owned entry, updates the executable, and removes only that entry', () => {
    const options = fixture()
    const directory = join(options.home, '.config', 'autostart')
    const target = join(directory, 'aerio.desktop')
    setLinuxLoginItem(true, options)
    expect(readFileSync(target, 'utf8')).toContain(`Exec=/usr/bin/env "${options.executable.replace(/\\/g, '\\\\\\\\')}" --aerio-login`)
    expect(readFileSync(target, 'utf8')).toContain('X-Aerio-Autostart=com.aerio.desktop')
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
    writeFileSync(join(directory, 'other.desktop'), 'unrelated')
    const next = { ...options, executable: join(options.home, 'next', 'aerio') }
    setLinuxLoginItem(true, next)
    expect(readFileSync(target, 'utf8')).toBe(linuxLoginEntry(next))
    expect(readdirSync(directory).sort()).toEqual(['aerio.desktop', 'other.desktop'])
    setLinuxLoginItem(false, next)
    setLinuxLoginItem(false, next)
    expect(readFileSync(join(directory, 'other.desktop'), 'utf8')).toBe('unrelated')
    expect(existsSync(target)).toBe(false)
  })

  it('honors an absolute XDG config directory and ignores a relative one', () => {
    const options = fixture()
    const custom = join(options.home, 'separate config')
    setLinuxLoginItem(true, { ...options, configHome: custom })
    expect(existsSync(join(custom, 'autostart', 'aerio.desktop'))).toBe(true)
    expect(existsSync(join(options.home, '.config'))).toBe(false)
    setLinuxLoginItem(true, { ...options, configHome: 'relative' })
    expect(existsSync(join(options.home, '.config', 'autostart', 'aerio.desktop'))).toBe(true)
  })

  it('keeps disabling a never-enabled preference free of filesystem changes', () => {
    const options = fixture()
    setLinuxLoginItem(false, options)
    expect(readdirSync(options.home)).toEqual([])
  })

  it('uses the persistent AppImage instead of its temporary mounted executable', () => {
    const options = fixture()
    const appImage = join(options.home, 'Aerio.AppImage')
    expect(linuxLoginEntry({ ...options, appImage })).toBe(linuxLoginEntry({ ...options, executable: appImage }))
  })

  it('quotes reserved characters and escapes desktop field codes without a shell', () => {
    const options = fixture()
    // Use forward slashes to make this exact Desktop Entry fixture portable.
    const executable = process.platform === 'win32' ? 'C:/apps/Aerio "`$\\%;.exe' : '/apps/Aerio "`$\\%;'
    const entry = linuxLoginEntry({ ...options, executable })
    const escaped = String.fromCharCode(92, 92)
    const expected = (process.platform === 'win32' ? 'C:/apps/' : '/apps/') +
      'Aerio ' + escaped + '"' + escaped + '`' + escaped + '$' + escaped + escaped + '%%;' +
      (process.platform === 'win32' ? '.exe' : '')
    expect(entry.split('\n').find((line) => line.startsWith('Exec='))).toBe(`Exec=/usr/bin/env "${expected}" --aerio-login`)
    expect(entry.split('\n')).toHaveLength(9)
  })

  it.each(['relative/aerio', '/apps/inject\nName=Other', '/apps/inject\rExec=Other', '/apps/a=b', '/apps/null\0'])('rejects invalid executable paths: %j', (executable) => {
    const options = fixture()
    expect(() => setLinuxLoginItem(true, { ...options, executable })).toThrow('absolute executable path')
    expect(readdirSync(options.home)).toEqual([])
  })

  it('refuses to overwrite or delete an unowned entry', () => {
    const options = fixture()
    const directory = join(options.home, '.config', 'autostart')
    mkdirSync(directory, { recursive: true })
    const target = join(directory, 'aerio.desktop')
    writeFileSync(target, '[Desktop Entry]\nExec=other\n')
    for (const enabled of [true, false]) expect(() => setLinuxLoginItem(enabled, options)).toThrow('does not own')
    expect(readFileSync(target, 'utf8')).toBe('[Desktop Entry]\nExec=other\n')
  })

  it('refuses hard-linked entries without changing the referenced content', () => {
    const options = fixture()
    setLinuxLoginItem(true, options)
    const target = join(options.home, '.config', 'autostart', 'aerio.desktop')
    linkSync(target, join(options.home, 'preserve.desktop'))
    for (const enabled of [true, false]) expect(() => setLinuxLoginItem(enabled, options)).toThrow('does not own')
    expect(readFileSync(target, 'utf8')).toBe(linuxLoginEntry(options))
  })

  it.skipIf(process.platform === 'win32')('refuses linked entries and autostart directories', () => {
    const options = fixture()
    const config = join(options.home, '.config')
    const directory = join(config, 'autostart')
    mkdirSync(directory, { recursive: true })
    const other = join(options.home, 'other.desktop')
    writeFileSync(other, linuxLoginEntry(options))
    symlinkSync(other, join(directory, 'aerio.desktop'))
    for (const enabled of [true, false]) expect(() => setLinuxLoginItem(enabled, options)).toThrow('does not own')
    expect(readFileSync(other, 'utf8')).toBe(linuxLoginEntry(options))
    rmSync(directory, { recursive: true })
    symlinkSync(options.home, directory)
    expect(() => setLinuxLoginItem(true, options)).toThrow('autostart directory')
  })
})
