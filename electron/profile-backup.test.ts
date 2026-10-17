import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPendingProfileRestore, createProfileBackup, finalizeProfileRestore, lastProfileRestoreOutcome, listProfileBackups, nextProfileBackupAt,
  parseProfileManifest, previewProfileBackup, profileBackupDue, pruneProfileBackups, readProfileBackupState, rebaseProfilePaths,
  stageProfileRestore, validateProfileBackupSchedule, verifyProfileBackup, PROFILE_BACKUP_FORMAT, PROFILE_RESTORE_DIRECTORY,
  type ProfileBackupLayout, type ProfileBackupState
} from './profile-backup'
import { createHash } from 'node:crypto'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

function temporary(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `aerio-profile-${name}-`))
  directories.push(directory)
  return directory
}

const layout: ProfileBackupLayout = {
  databases: [
    {
      file: 'state.sqlite',
      label: 'State',
      scrubBackup: (db) => db.exec('DELETE FROM secrets'),
      summarize: (db) => [{ label: 'Items', count: Number((db.prepare('SELECT COUNT(*) count FROM items').get() as { count: number }).count) }]
    },
    { file: 'other.sqlite', label: 'Other' }
  ],
  directories: [{ name: 'files', label: 'Files' }]
}

function makeProfile(items: string[] = ['one', 'two']) {
  const profile = temporary('live')
  const db = new DatabaseSync(join(profile, 'state.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE items(name TEXT, path TEXT); CREATE TABLE secrets(value TEXT)')
  for (const item of items) db.prepare('INSERT INTO items VALUES(?,?)').run(item, join(profile, 'files', `${item}.txt`))
  db.prepare('INSERT INTO secrets VALUES(?)').run('verifier-secret-value')
  db.close()
  mkdirSync(join(profile, 'files', 'nested'), { recursive: true })
  writeFileSync(join(profile, 'files', 'nested', 'a.bin'), Buffer.from([0, 1, 2, 255]))
  writeFileSync(join(profile, 'files', 'empty.txt'), '')
  // Never part of a backup even when it appears inside a managed folder.
  writeFileSync(join(profile, 'files', 'oauth-vault.dat'), 'token')
  writeFileSync(join(profile, 'oauth-vault.dat'), 'refresh-token')
  return profile
}

const backup = (profile: string, directory: string, now = new Date('2026-10-01T10:00:00Z')) =>
  createProfileBackup({ userData: profile, directory, layout, appVersion: '0.6.0', trigger: 'manual', now })
const items = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return (db.prepare('SELECT name FROM items ORDER BY name').all() as { name: string }[]).map((row) => row.name) } finally { db.close() } }
const manifestOf = (path: string) => JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))
const resign = (manifest: Record<string, unknown>) => {
  const { digest: _digest, ...rest } = manifest
  return { ...manifest, digest: createHash('sha256').update(JSON.stringify(rest)).digest('hex') }
}

describe('profile backup creation', () => {
  it('snapshots databases and managed files with checksums, never credentials', async () => {
    const profile = makeProfile()
    const target = temporary('target')
    const summary = await backup(profile, target)
    expect(summary.path).toBe(join(target, 'aerio-profile-2026-10-01T10-00-00-000Z'))
    const manifest = manifestOf(summary.path)
    expect(manifest.databases.map((entry: { path: string }) => entry.path)).toEqual(['state.sqlite'])
    expect(manifest.files.map((entry: { path: string }) => entry.path).sort()).toEqual(['files/empty.txt', 'files/nested/a.bin'])
    expect(manifest.counts).toEqual([{ label: 'Items', count: 2 }])
    expect(manifest.excluded.join(' ')).toContain('oauth-vault.dat')
    const allFiles = readdirSync(summary.path, { recursive: true }).map(String)
    expect(allFiles.some((file) => file.includes('oauth-vault'))).toBe(false)
    expect(allFiles.some((file) => /-wal$|-shm$/.test(file))).toBe(false)
    // Scrubbed rows are gone and their freed pages are vacuumed away.
    expect(readFileSync(join(summary.path, 'data', 'state.sqlite')).includes('verifier-secret-value')).toBe(false)
    expect(items(join(summary.path, 'data', 'state.sqlite'))).toEqual(['one', 'two'])
    await expect(verifyProfileBackup(summary.path, layout)).resolves.toMatchObject({ format: PROFILE_BACKUP_FORMAT })
    expect(readdirSync(target)).toEqual(['aerio-profile-2026-10-01T10-00-00-000Z'])
  })

  it('takes a consistent snapshot while another connection holds an open write', async () => {
    const profile = makeProfile()
    const writer = new DatabaseSync(join(profile, 'state.sqlite'))
    writer.exec("BEGIN IMMEDIATE; INSERT INTO items VALUES('uncommitted', '')")
    try {
      const summary = await backup(profile, temporary('target'))
      expect(items(join(summary.path, 'data', 'state.sqlite'))).toEqual(['one', 'two'])
    } finally { writer.exec('ROLLBACK'); writer.close() }
  })

  it('refuses to store backups inside managed profile folders and removes partial output on failure', async () => {
    const profile = makeProfile()
    await expect(backup(profile, join(profile, 'files', 'backups'))).rejects.toThrow('managed data folders')
    const target = temporary('target')
    const failing: ProfileBackupLayout = { ...layout, databases: [{ ...layout.databases[0], scrubBackup: () => { throw new Error('scrub failed') } }] }
    await expect(createProfileBackup({ userData: profile, directory: target, layout: failing, appVersion: '1', trigger: 'manual' })).rejects.toThrow('scrub failed')
    expect(readdirSync(target)).toEqual([])
  })
})

describe('profile backup verification', () => {
  it('detects corrupted, missing, edited, unsafe, and newer-format backups', async () => {
    const profile = makeProfile()
    const { path } = await backup(profile, temporary('target'))
    const file = join(path, 'data', 'files', 'nested', 'a.bin')
    writeFileSync(file, Buffer.from([0, 1, 2, 254]))
    await expect(verifyProfileBackup(path, layout)).rejects.toThrow('files/nested/a.bin does not match its checksum')
    rmSync(file)
    await expect(verifyProfileBackup(path, layout)).rejects.toThrow('incomplete')
    const manifest = manifestOf(path)
    expect(() => parseProfileManifest({ ...manifest, appVersion: '9.9.9' }, layout)).toThrow('checksum does not match')
    expect(() => parseProfileManifest(resign({ ...manifest, schemaVersion: 2 }), layout)).toThrow('newer version of Aerio')
    expect(() => parseProfileManifest(resign({ ...manifest, files: [{ path: 'files/../../escape', size: 0, sha256: '0'.repeat(64) }] }), layout)).toThrow('unsafe file path')
    expect(() => parseProfileManifest(resign({ ...manifest, files: [{ path: 'files/oauth-vault.dat', size: 0, sha256: '0'.repeat(64) }] }), layout)).toThrow('unsafe file path')
    expect(() => parseProfileManifest(resign({ ...manifest, databases: [{ ...manifest.databases[0], path: 'oauth-vault.dat' }] }), layout)).toThrow('unknown database')
    writeFileSync(join(path, 'manifest.json'), '{"format":')
    await expect(verifyProfileBackup(path, layout)).rejects.toThrow('unreadable')
    await expect(verifyProfileBackup(temporary('empty'), layout)).rejects.toThrow('manifest.json was not found')
  })

  it('previews counts, held items, and warnings without changing the profile', async () => {
    const profile = makeProfile()
    const { path } = await backup(profile, temporary('target'))
    const preview = await previewProfileBackup(path, profile, layout)
    expect(preview).toMatchObject({ counts: [{ label: 'Items', count: 2 }], differentProfile: false, schemaVersion: 1, fileCount: 3 })
    expect(preview.warnings.join('\n')).toContain('Not in this backup (reset to empty): Other')
    const elsewhere = await previewProfileBackup(path, temporary('other-profile'), layout)
    expect(elsewhere.differentProfile).toBe(true)
  })
})

describe('profile backup retention', () => {
  it('keeps the newest backups, removes abandoned partials, and never touches foreign folders', async () => {
    const profile = makeProfile()
    const target = temporary('target')
    for (const day of [1, 2, 3]) await backup(profile, target, new Date(`2026-10-0${day}T10:00:00Z`))
    mkdirSync(join(target, '.partial-stale'))
    mkdirSync(join(target, 'aerio-profile-not-a-backup'))
    mkdirSync(join(target, 'Holiday photos'))
    const removed = pruneProfileBackups(target, 2, layout)
    expect(removed).toEqual([join(target, 'aerio-profile-2026-10-01T10-00-00-000Z')])
    expect(readdirSync(target).sort()).toEqual(['Holiday photos', 'aerio-profile-2026-10-02T10-00-00-000Z', 'aerio-profile-2026-10-03T10-00-00-000Z', 'aerio-profile-not-a-backup'])
    expect(listProfileBackups(target, layout).map((item) => item.createdAt)).toEqual(['2026-10-03T10:00:00.000Z', '2026-10-02T10:00:00.000Z'])
  })
})

describe('profile restore', () => {
  it('stages, then swaps in on the next launch, replacing stale SQLite sidecars and finalizing', async () => {
    const profile = makeProfile(['backed-up'])
    const { path } = await backup(profile, temporary('target'))
    const db = new DatabaseSync(join(profile, 'state.sqlite'))
    db.exec("INSERT INTO items VALUES('after-backup','')")
    db.close()
    writeFileSync(join(profile, 'files', 'new-after-backup.txt'), 'later')
    writeFileSync(join(profile, 'state.sqlite-wal'), 'stale wal from the old database')
    writeFileSync(join(profile, 'other.sqlite'), 'not in backup')

    await stageProfileRestore({ backupPath: path, userData: profile, layout })
    // Staging alone never modifies live data.
    expect(items(join(profile, 'state.sqlite'))).toEqual(['after-backup', 'backed-up'])

    const outcome = applyPendingProfileRestore(profile)
    expect(outcome).toMatchObject({ status: 'applied', backupCreatedAt: '2026-10-01T10:00:00.000Z' })
    expect(items(join(profile, 'state.sqlite'))).toEqual(['backed-up'])
    expect(existsSync(join(profile, 'state.sqlite-wal'))).toBe(false)
    expect(existsSync(join(profile, 'other.sqlite'))).toBe(false)
    expect(existsSync(join(profile, 'files', 'new-after-backup.txt'))).toBe(false)
    expect(readFileSync(join(profile, 'files', 'nested', 'a.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    // Credentials on this device are left exactly as they were.
    expect(readFileSync(join(profile, 'oauth-vault.dat'), 'utf8')).toBe('refresh-token')
    expect(applyPendingProfileRestore(profile)).toMatchObject({ status: 'applied' })
    finalizeProfileRestore(profile)
    expect(readdirSync(join(profile, PROFILE_RESTORE_DIRECTORY))).toEqual(['last-restore.json'])
    expect(lastProfileRestoreOutcome(profile)).toMatchObject({ status: 'applied' })
    expect(applyPendingProfileRestore(profile)).toBeUndefined()
  })

  it('rejects a backup corrupted after preview without touching live data', async () => {
    const profile = makeProfile(['original'])
    const { path } = await backup(profile, temporary('target'))
    writeFileSync(join(path, 'data', 'files', 'empty.txt'), 'tampered')
    await expect(stageProfileRestore({ backupPath: path, userData: profile, layout })).rejects.toThrow('does not match its checksum')
    expect(applyPendingProfileRestore(profile)).toBeUndefined()
    expect(existsSync(join(profile, PROFILE_RESTORE_DIRECTORY, 'staging'))).toBe(false)
  })

  it('rolls back every entry when the swap fails part way', async () => {
    const profile = makeProfile(['backed-up'])
    const { path } = await backup(profile, temporary('target'))
    const db = new DatabaseSync(join(profile, 'state.sqlite'))
    db.exec("INSERT INTO items VALUES('current','')")
    db.close()
    await stageProfileRestore({ backupPath: path, userData: profile, layout })
    const outcome = applyPendingProfileRestore(profile, { beforeSwapEntry: (entry) => { if (entry === 'files') throw new Error('disk full') } })
    expect(outcome).toMatchObject({ status: 'rolled-back' })
    expect(outcome?.error).toContain('disk full')
    expect(items(join(profile, 'state.sqlite'))).toEqual(['backed-up', 'current'])
    expect(readFileSync(join(profile, 'oauth-vault.dat'), 'utf8')).toBe('refresh-token')
    expect(existsSync(join(profile, 'files', 'oauth-vault.dat'))).toBe(true)
  })

  it('recovers the original profile after a crash in the middle of the swap', async () => {
    const profile = makeProfile(['backed-up'])
    const { path } = await backup(profile, temporary('target'))
    writeFileSync(join(profile, 'files', 'current-only.txt'), 'current')
    const db = new DatabaseSync(join(profile, 'state.sqlite'))
    db.exec("INSERT INTO items VALUES('current','')")
    db.close()
    await stageProfileRestore({ backupPath: path, userData: profile, layout })
    // Capture the on-disk state at the instant the process would have died.
    const crashed = temporary('crashed')
    applyPendingProfileRestore(profile, { beforeSwapEntry: (entry) => { if (entry === 'files') cpSync(profile, crashed, { recursive: true }) } })
    expect(JSON.parse(readFileSync(join(crashed, PROFILE_RESTORE_DIRECTORY, 'restore.json'), 'utf8')).state).toBe('swapping')
    expect(existsSync(join(crashed, 'state.sqlite'))).toBe(true)
    const outcome = applyPendingProfileRestore(crashed)
    expect(outcome).toMatchObject({ status: 'rolled-back' })
    expect(outcome?.error).toContain('closed while restoring')
    expect(items(join(crashed, 'state.sqlite'))).toEqual(['backed-up', 'current'])
    expect(readFileSync(join(crashed, 'files', 'current-only.txt'), 'utf8')).toBe('current')
  })

  it('creates databases missing from the backup through prepareRestore and reports counts', async () => {
    const profile = makeProfile()
    const { path } = await backup(profile, temporary('target'))
    const prepared: string[] = []
    const preparing: ProfileBackupLayout = {
      ...layout,
      databases: layout.databases.map((spec) => ({ ...spec, prepareRestore: (stagedPath, context) => {
        prepared.push(spec.file)
        if (!existsSync(stagedPath)) { const db = new DatabaseSync(stagedPath); db.exec('CREATE TABLE created(x)'); db.close() }
        context.report.heldSends += 1
      } }))
    }
    const report = await stageProfileRestore({ backupPath: path, userData: profile, layout: preparing })
    expect(prepared).toEqual(['state.sqlite', 'other.sqlite'])
    expect(report).toMatchObject({ heldSends: 2, rebasedPaths: false })
    applyPendingProfileRestore(profile)
    expect(existsSync(join(profile, 'other.sqlite'))).toBe(true)
  })

  it('rebases managed file paths when restoring into a different profile folder', async () => {
    const profile = makeProfile(['one'])
    const { path } = await backup(profile, temporary('target'))
    const destination = temporary('destination')
    await stageProfileRestore({ backupPath: path, userData: destination, layout })
    applyPendingProfileRestore(destination)
    const db = new DatabaseSync(join(destination, 'state.sqlite'), { readOnly: true })
    expect((db.prepare('SELECT path FROM items').get() as { path: string }).path).toBe(join(destination, 'files', 'one.txt'))
    db.close()
  })
})

describe('path rebasing', () => {
  it('rewrites raw and JSON-escaped paths in ordinary tables but not full-text shadow tables', () => {
    const db = new DatabaseSync(':memory:')
    const from = 'C:\\Users\\old\\Aerio', to = 'D:\\Profiles\\new\\Aerio'
    db.exec('CREATE TABLE messages(raw_path TEXT, attachments_json TEXT, size INTEGER); CREATE VIRTUAL TABLE search USING fts5(body)')
    db.prepare('INSERT INTO messages VALUES(?,?,?)').run(`${from}\\mail\\a.eml`, JSON.stringify([`${from}\\mail\\drafts\\x.pdf`]), 5)
    db.prepare('INSERT INTO search VALUES(?)').run(`${from}\\mail`)
    expect(rebaseProfilePaths(db, from, to)).toBe(2)
    const row = db.prepare('SELECT * FROM messages').get() as { raw_path: string; attachments_json: string }
    expect(row.raw_path).toBe(`${to}\\mail\\a.eml`)
    expect(JSON.parse(row.attachments_json)).toEqual([`${to}\\mail\\drafts\\x.pdf`])
    expect((db.prepare('SELECT body FROM search').get() as { body: string }).body).toBe(`${from}\\mail`)
    db.close()
  })
})

describe('backup schedule', () => {
  const state = (overrides: Partial<ProfileBackupState> = {}): ProfileBackupState => ({ schedule: { enabled: true, intervalHours: 24, keep: 7, directory: 'C:\\Backups' }, ...overrides })

  it('is due immediately when never run, then after each interval, and retries failures hourly', () => {
    const now = new Date('2026-10-02T12:00:00Z')
    expect(profileBackupDue(state(), now)).toBe(true)
    expect(profileBackupDue(state({ schedule: { ...state().schedule, enabled: false } }), now)).toBe(false)
    expect(profileBackupDue(state({ lastBackupAt: '2026-10-02T00:00:00Z' }), now)).toBe(false)
    expect(nextProfileBackupAt(state({ lastBackupAt: '2026-10-02T00:00:00Z' }))?.toISOString()).toBe('2026-10-03T00:00:00.000Z')
    expect(profileBackupDue(state({ lastBackupAt: '2026-10-01T11:00:00Z' }), now)).toBe(true)
    expect(profileBackupDue(state({ lastBackupAt: '2026-10-01T00:00:00Z', lastError: 'disk', lastAttemptAt: '2026-10-02T11:30:00Z' }), now)).toBe(false)
    expect(profileBackupDue(state({ lastBackupAt: '2026-10-01T00:00:00Z', lastError: 'disk', lastAttemptAt: '2026-10-02T10:30:00Z' }), now)).toBe(true)
  })

  it('validates schedules and normalizes unreadable state to safe defaults', () => {
    const directory = temporary('state')
    expect(validateProfileBackupSchedule({ enabled: true, intervalHours: 168, keep: 3, directory })).toEqual({ enabled: true, intervalHours: 168, keep: 3, directory })
    expect(() => validateProfileBackupSchedule({ enabled: true, intervalHours: 5, keep: 3, directory })).toThrow('interval')
    expect(() => validateProfileBackupSchedule({ enabled: true, intervalHours: 24, keep: 0, directory })).toThrow('Keep between')
    expect(() => validateProfileBackupSchedule({ enabled: true, intervalHours: 24, keep: 3, directory: 'relative' })).toThrow('folder')
    writeFileSync(join(directory, 'state.json'), '{"schedule":{"enabled":"yes","keep":999}}')
    expect(readProfileBackupState(join(directory, 'state.json'), directory).schedule).toEqual({ enabled: false, intervalHours: 24, keep: 7, directory })
    expect(readProfileBackupState(join(directory, 'missing.json'), directory).lastBackupAt).toBeUndefined()
  })
})
