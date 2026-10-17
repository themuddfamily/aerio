import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as sqlite from 'node:sqlite'
import { DatabaseSync } from 'node:sqlite'
import type {
  ProfileBackupCount, ProfileBackupPreview, ProfileBackupSchedule, ProfileBackupSummary, ProfileBackupTrigger,
  ProfileRestoreOutcome, ProfileRestoreReport
} from '../src/profile-backup-types'

export const PROFILE_BACKUP_FORMAT = 'aerio-profile-backup'
export const PROFILE_BACKUP_SCHEMA_VERSION = 1
export const PROFILE_BACKUP_PREFIX = 'aerio-profile-'
/** Restore staging, rollback copies, and the swap journal live here inside the profile. */
export const PROFILE_RESTORE_DIRECTORY = '.profile-restore'
const MANIFEST = 'manifest.json'
const PARTIAL_PREFIX = '.partial-'
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024
const MAX_FILES = 5_000_000
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal']

/**
 * Never copied into a profile backup. The layout is an allowlist, so these are
 * documentation and a defence-in-depth check rather than the only safeguard.
 */
export const PROFILE_BACKUP_EXCLUSIONS = [
  'oauth-vault.dat (OAuth access/refresh tokens, IMAP/SMTP passwords, and their secure-storage encryption)',
  'openpgp-keyring.dat (OpenPGP public and passphrase-protected private keys; export keys explicitly to move them)',
  'smime-certificates.dat (S/MIME certificates, trust choices, and passphrase-protected private keys; export a password-protected PKCS#12 to move them)',
  'meeting-host-vault.dat (Zoom and Webex OAuth tokens and app registrations; reconnect them in Settings › Online meetings)',
  'App-lock passphrase verifier (the current device keeps its own app lock)',
  'directory.sqlite (organization directory / offline address book cache; rebuilt from the server after a restore)',
  'Diagnostic logs, window bounds, and update caches',
  'Earlier restore staging and rollback copies'
]
const FORBIDDEN_NAMES = new Set(['oauth-vault.dat', 'openpgp-keyring.dat', 'smime-certificates.dat', 'meeting-host-vault.dat'])

export interface ProfileRestoreContext {
  userData: string
  /** The live database this staged copy will replace, if one exists. */
  livePath: string
  report: ProfileRestoreReport
}

export interface ProfileDatabaseSpec {
  /** File name inside the profile folder. */
  file: string
  label: string
  /** Removes credential-adjacent rows from the backup copy; never runs on live data. */
  scrubBackup?(db: DatabaseSync): void
  /** Migrates the staged copy to the current schema and holds anything that could act on its own. */
  prepareRestore?(path: string, context: ProfileRestoreContext): void
  summarize?(db: DatabaseSync): ProfileBackupCount[]
}

export interface ProfileBackupLayout {
  databases: ProfileDatabaseSpec[]
  /** Managed directories inside the profile folder, copied file by file. */
  directories: { name: string; label: string }[]
}

interface ManifestEntry { path: string; size: number; sha256: string }

export interface ProfileBackupManifest {
  format: typeof PROFILE_BACKUP_FORMAT
  schemaVersion: number
  createdAt: string
  appVersion: string
  trigger: ProfileBackupTrigger
  /** Absolute profile folder the backup came from, used to rebase managed file paths. */
  sourceProfile: string
  databases: (ManifestEntry & { label: string })[]
  directories: string[]
  files: ManifestEntry[]
  counts: ProfileBackupCount[]
  excluded: string[]
  /** SHA-256 over every other manifest field, so a truncated or edited manifest is rejected. */
  digest: string
}

export class ProfileBackupError extends Error {}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const nowIso = () => new Date().toISOString()

function manifestDigest(manifest: Omit<ProfileBackupManifest, 'digest'> & { digest?: string }) {
  const { digest: _digest, ...rest } = manifest
  return sha(JSON.stringify(rest))
}

function safeRelative(value: unknown, roots: Set<string>) {
  if (typeof value !== 'string' || !value || value.length > 4_096 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const parts = value.split('/')
  return parts.length >= 2 && roots.has(parts[0]) && parts.every((part) => part && part !== '.' && part !== '..')
}

const entryValid = (entry: unknown): entry is ManifestEntry => Boolean(entry) && typeof entry === 'object' &&
  Number.isSafeInteger((entry as ManifestEntry).size) && (entry as ManifestEntry).size >= 0 && /^[a-f0-9]{64}$/.test(String((entry as ManifestEntry).sha256))

/**
 * Validates a manifest and upgrades older supported schemas. Only schema 1
 * exists today; newer manifests are rejected rather than half-restored.
 */
export function parseProfileManifest(value: unknown, layout: ProfileBackupLayout): ProfileBackupManifest {
  const invalid = (reason: string): never => { throw new ProfileBackupError(`This profile backup is invalid: ${reason}`) }
  if (!value || typeof value !== 'object') return invalid('the manifest is unreadable')
  const manifest = value as ProfileBackupManifest
  if (manifest.format !== PROFILE_BACKUP_FORMAT) return invalid('it is not an Aerio profile backup')
  if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) return invalid('the format version is unknown')
  if (manifest.schemaVersion > PROFILE_BACKUP_SCHEMA_VERSION) throw new ProfileBackupError('This profile backup was created by a newer version of Aerio. Update Aerio before restoring it.')
  if (typeof manifest.digest !== 'string' || manifestDigest(manifest) !== manifest.digest) return invalid('the manifest checksum does not match (it was edited or truncated)')
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) return invalid('the creation time is missing')
  if (typeof manifest.appVersion !== 'string' || manifest.appVersion.length > 100) return invalid('the Aerio version is missing')
  if (manifest.trigger !== 'manual' && manifest.trigger !== 'scheduled') return invalid('the backup trigger is unknown')
  if (typeof manifest.sourceProfile !== 'string' || !isAbsolute(manifest.sourceProfile)) return invalid('the source profile is missing')
  const knownDatabases = new Map(layout.databases.map((database) => [database.file, database]))
  if (!Array.isArray(manifest.databases) || !manifest.databases.every((entry) => entryValid(entry) && knownDatabases.has(entry.path) && !FORBIDDEN_NAMES.has(entry.path)) ||
      new Set(manifest.databases.map((entry) => entry.path)).size !== manifest.databases.length) return invalid('it lists an unknown database')
  const knownDirectories = new Set(layout.directories.map((directory) => directory.name))
  if (!Array.isArray(manifest.directories) || !manifest.directories.every((name) => knownDirectories.has(name))) return invalid('it lists an unknown folder')
  const roots = new Set(manifest.directories)
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || !manifest.files.every((entry) => entryValid(entry) && safeRelative(entry.path, roots) && !FORBIDDEN_NAMES.has(entry.path.split('/').at(-1)!))) return invalid('it lists an unsafe file path')
  if (new Set(manifest.files.map((entry) => entry.path.toLowerCase())).size !== manifest.files.length) return invalid('it lists a file twice')
  if (!Array.isArray(manifest.counts)) manifest.counts = []
  if (!Array.isArray(manifest.excluded)) manifest.excluded = []
  return manifest
}

function readManifest(backupPath: string, layout: ProfileBackupLayout) {
  const path = join(backupPath, MANIFEST)
  let size: number
  try { size = statSync(path).size } catch { throw new ProfileBackupError('Choose a folder that contains an Aerio profile backup (manifest.json was not found)') }
  if (size > MAX_MANIFEST_BYTES) throw new ProfileBackupError('This profile backup manifest is too large')
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new ProfileBackupError('This profile backup is invalid: the manifest is unreadable') }
  return parseProfileManifest(parsed, layout)
}

/** Streams a file, hashing it on the way, optionally writing a copy. */
async function hashFile(source: string, target?: string) {
  const hash = createHash('sha256')
  let size = 0
  const tap = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk) } })
  if (target) {
    mkdirSync(dirname(target), { recursive: true })
    await pipeline(createReadStream(source), tap, createWriteStream(target, { mode: 0o600 }))
  } else {
    await pipeline(createReadStream(source), tap, async function* (chunks) { for await (const _chunk of chunks) { /* drain */ } })
  }
  return { size, sha256: hash.digest('hex') }
}

function* walkFiles(root: string, prefix: string): Generator<{ absolute: string; relative: string }> {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(root, entry.name)
    const nested = `${prefix}/${entry.name}`
    // Symlinks and devices are skipped so a backup can never follow a link out of the profile.
    if (entry.isDirectory()) yield* walkFiles(absolute, nested)
    else if (entry.isFile()) yield { absolute, relative: nested }
  }
}

const tableExists = (db: DatabaseSync, table: string) => Boolean(db.prepare(`SELECT 1 found FROM sqlite_master WHERE type='table' AND name=?`).get(table))
export const countRows = (db: DatabaseSync, table: string, where = '1=1') => tableExists(db, table) ? Number((db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${where}`).get() as { count: number }).count) : 0
export { tableExists as profileTableExists }

function checkIntegrity(db: DatabaseSync, label: string) {
  const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new ProfileBackupError(`${label} failed the SQLite integrity check`)
}

/** Leaves a self-contained rollback-journal file so checksums cover the whole database. */
function settle(path: string) {
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA journal_mode=DELETE') } finally { db.close() }
  for (const suffix of SQLITE_SIDECARS) rmSync(`${path}${suffix}`, { force: true })
}

async function snapshotDatabase(source: string, target: string) {
  const reader = new DatabaseSync(source, { readOnly: true, timeout: 10_000 })
  try {
    // The online backup API copies every page in one step on Node's thread
    // pool, so the copy is a single consistent read transaction even while the
    // mail worker keeps writing. VACUUM INTO is the fallback for older runtimes.
    if (typeof sqlite.backup === 'function') await sqlite.backup(reader, target, { rate: 2_147_483_647 })
    else reader.prepare('VACUUM INTO ?').run(target)
  } finally { reader.close() }
}

function stamp(date: Date) { return date.toISOString().replaceAll(':', '-').replace('.', '-') }

export interface CreateProfileBackupOptions {
  userData: string
  directory: string
  layout: ProfileBackupLayout
  appVersion: string
  trigger: ProfileBackupTrigger
  now?: Date
}

export function assertBackupDirectoryAllowed(directory: string, userData: string, layout: ProfileBackupLayout) {
  if (!isAbsolute(directory)) throw new ProfileBackupError('Choose an absolute folder for profile backups')
  const target = resolve(directory)
  const inside = (root: string) => { const nested = relative(resolve(root), target); return !nested || (!nested.startsWith('..') && !isAbsolute(nested)) }
  if ([...layout.directories.map((item) => join(userData, item.name)), join(userData, PROFILE_RESTORE_DIRECTORY)].some(inside)) {
    throw new ProfileBackupError('Profile backups cannot be stored inside Aerio’s managed data folders')
  }
}

export async function createProfileBackup(options: CreateProfileBackupOptions): Promise<ProfileBackupSummary> {
  const { userData, layout } = options
  assertBackupDirectoryAllowed(options.directory, userData, layout)
  const createdAt = options.now ?? new Date()
  mkdirSync(options.directory, { recursive: true })
  const partial = join(options.directory, `${PARTIAL_PREFIX}${stamp(createdAt)}-${randomUUID().slice(0, 8)}`)
  const finalPath = join(options.directory, `${PROFILE_BACKUP_PREFIX}${stamp(createdAt)}`)
  if (existsSync(finalPath)) throw new ProfileBackupError('A profile backup with the same time already exists')
  mkdirSync(join(partial, 'data'), { recursive: true })
  try {
    const databases: ProfileBackupManifest['databases'] = []
    const counts: ProfileBackupCount[] = []
    for (const spec of layout.databases) {
      const live = join(userData, spec.file)
      if (!existsSync(live)) continue
      const target = join(partial, 'data', spec.file)
      await snapshotDatabase(live, target)
      const db = new DatabaseSync(target)
      try {
        if (spec.scrubBackup) {
          db.exec('PRAGMA secure_delete=ON')
          spec.scrubBackup(db)
          db.exec('VACUUM')
        }
        checkIntegrity(db, spec.label)
        counts.push(...(spec.summarize?.(db) ?? []))
      } finally { db.close() }
      settle(target)
      databases.push({ path: spec.file, label: spec.label, ...await hashFile(target) })
    }
    const files: ManifestEntry[] = []
    const directories: string[] = []
    for (const directory of layout.directories) {
      const root = join(userData, directory.name)
      if (!existsSync(root)) continue
      directories.push(directory.name)
      for (const file of walkFiles(root, directory.name)) {
        if (FORBIDDEN_NAMES.has(file.relative.split('/').at(-1)!)) continue
        try { files.push({ path: file.relative, ...await hashFile(file.absolute, join(partial, 'data', ...file.relative.split('/'))) }) }
        catch (error) {
          // Mail can delete cached files after the database snapshot; the
          // restored mail store re-downloads anything it cannot find.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (files.length > MAX_FILES) throw new ProfileBackupError('The profile contains too many files to back up')
      }
    }
    const body: Omit<ProfileBackupManifest, 'digest'> = {
      format: PROFILE_BACKUP_FORMAT, schemaVersion: PROFILE_BACKUP_SCHEMA_VERSION, createdAt: createdAt.toISOString(), appVersion: options.appVersion,
      trigger: options.trigger, sourceProfile: resolve(userData), databases, directories, files, counts, excluded: PROFILE_BACKUP_EXCLUSIONS
    }
    const manifest: ProfileBackupManifest = { ...body, digest: manifestDigest(body) }
    writeFileSync(join(partial, MANIFEST), `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
    // A backup only appears under its final name once every file and the manifest exist.
    renameSync(partial, finalPath)
    return summaryFor(finalPath, manifest)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
}

function summaryFor(path: string, manifest: ProfileBackupManifest): ProfileBackupSummary {
  const entries = [...manifest.databases, ...manifest.files]
  return { path, createdAt: manifest.createdAt, trigger: manifest.trigger, appVersion: manifest.appVersion, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0), fileCount: entries.length }
}

/** Lists finished backups (newest first). Folders that are not valid Aerio backups are ignored, never deleted. */
export function listProfileBackups(directory: string, layout: ProfileBackupLayout): ProfileBackupSummary[] {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return [] }
  const backups: ProfileBackupSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROFILE_BACKUP_PREFIX)) continue
    const path = join(directory, entry.name)
    try { backups.push(summaryFor(path, readManifest(path, layout))) } catch { /* Corrupt or foreign folders stay untouched. */ }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Keeps the newest `keep` backups and removes abandoned partial folders. */
export function pruneProfileBackups(directory: string, keep: number, layout: ProfileBackupLayout) {
  const removed: string[] = []
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(PARTIAL_PREFIX)) {
        rmSync(join(directory, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  } catch { return removed }
  for (const backup of listProfileBackups(directory, layout).slice(Math.max(1, Math.floor(keep)))) {
    rmSync(backup.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    removed.push(backup.path)
  }
  return removed
}

/** Re-hashes every file against the manifest. */
export async function verifyProfileBackup(backupPath: string, layout: ProfileBackupLayout) {
  const manifest = readManifest(backupPath, layout)
  for (const entry of [...manifest.databases, ...manifest.files]) {
    const path = join(backupPath, 'data', ...entry.path.split('/'))
    let actual
    try { actual = await hashFile(path) } catch { throw new ProfileBackupError(`This profile backup is incomplete: ${entry.path} is missing`) }
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new ProfileBackupError(`This profile backup is corrupted: ${entry.path} does not match its checksum`)
  }
  return manifest
}

const HELD_SEND_LABEL = 'Outgoing or scheduled sends'
const HELD_TASK_LABEL = 'Pending connected task changes'
const ACCOUNT_LABEL = 'Mail accounts'
export const PROFILE_PREVIEW_LABELS = { heldSends: HELD_SEND_LABEL, heldTaskWrites: HELD_TASK_LABEL, accounts: ACCOUNT_LABEL }

export async function previewProfileBackup(backupPath: string, userData: string, layout: ProfileBackupLayout): Promise<ProfileBackupPreview> {
  const manifest = await verifyProfileBackup(backupPath, layout)
  const counts: ProfileBackupCount[] = []
  for (const entry of manifest.databases) {
    const spec = layout.databases.find((database) => database.file === entry.path)!
    const db = new DatabaseSync(join(backupPath, 'data', entry.path), { readOnly: true })
    try {
      checkIntegrity(db, spec.label)
      counts.push(...(spec.summarize?.(db) ?? []))
    } finally { db.close() }
  }
  const count = (label: string) => counts.filter((item) => item.label === label).reduce((sum, item) => sum + item.count, 0)
  const differentProfile = resolve(manifest.sourceProfile) !== resolve(userData)
  const warnings = [
    'Restoring replaces this profile’s mail cache, drafts, rules, templates, local Tasks/Notes/Contacts, and preferences. Aerio restarts to finish.',
    'Sign-in credentials are never stored in backups; reconnect accounts that cannot sign in automatically.'
  ]
  if (count(HELD_SEND_LABEL)) warnings.push(`${count(HELD_SEND_LABEL).toLocaleString()} outgoing or scheduled message${count(HELD_SEND_LABEL) === 1 ? '' : 's'} will be held for review instead of sending.`)
  if (differentProfile) warnings.push('This backup came from a different profile folder; Aerio will update stored file locations.')
  if (manifest.schemaVersion < PROFILE_BACKUP_SCHEMA_VERSION) warnings.push('This backup uses an older format and will be upgraded during restore.')
  const missing = layout.databases.filter((database) => !manifest.databases.some((entry) => entry.path === database.file))
  if (missing.length) warnings.push(`Not in this backup (reset to empty): ${missing.map((database) => database.label).join(', ')}.`)
  return {
    ...summaryFor(backupPath, manifest), schemaVersion: manifest.schemaVersion, counts,
    heldSends: count(HELD_SEND_LABEL), heldTaskWrites: count(HELD_TASK_LABEL), accountsToReauthorize: count(ACCOUNT_LABEL), differentProfile, warnings
  }
}

interface RestoreJournal {
  state: 'staged' | 'swapping' | 'applied' | 'rolled-back'
  backupPath: string
  backupCreatedAt: string
  stagedAt: string
  entries: string[]
  previouslyMissing?: string[]
  report: ProfileRestoreReport
  outcome?: ProfileRestoreOutcome
}

const restoreRoot = (userData: string) => join(userData, PROFILE_RESTORE_DIRECTORY)
const journalPath = (userData: string) => join(restoreRoot(userData), 'restore.json')
const outcomePath = (userData: string) => join(restoreRoot(userData), 'last-restore.json')

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function readJournal(userData: string): RestoreJournal | undefined {
  try { return JSON.parse(readFileSync(journalPath(userData), 'utf8')) as RestoreJournal } catch { return undefined }
}

/** Every top-level profile entry a restore owns, including SQLite sidecar files. */
function restoreEntries(layout: ProfileBackupLayout) {
  return [...layout.databases.flatMap((database) => [database.file, ...SQLITE_SIDECARS.map((suffix) => `${database.file}${suffix}`)]), ...layout.directories.map((directory) => directory.name)]
}

/** Replaces the backup's profile folder with this one in every text column of ordinary tables. */
export function rebaseProfilePaths(db: DatabaseSync, from: string, to: string) {
  if (resolve(from) === resolve(to)) return 0
  const forms = [[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]].filter(([a, b], index, all) => a !== b && all.findIndex(([c]) => c === a) === index)
  const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; sql: string }[]
  const virtual = tables.filter((table) => /^CREATE\s+VIRTUAL/i.test(table.sql ?? '')).map((table) => table.name)
  let changed = 0
  for (const table of tables) {
    // Full-text indexes and their shadow tables are rebuilt from content, not edited directly.
    if (virtual.some((name) => table.name === name || table.name.startsWith(`${name}_`))) continue
    const columns = (db.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all() as { name: string; type: string }[])
      .filter((column) => !column.type || /TEXT|CHAR|CLOB/i.test(column.type))
    for (const column of columns) {
      const name = `"${column.name.replaceAll('"', '""')}"`
      for (const [a, b] of forms) {
        changed += Number(db.prepare(`UPDATE "${table.name.replaceAll('"', '""')}" SET ${name}=REPLACE(${name},?,?) WHERE typeof(${name})='text' AND instr(${name},?)>0`).run(a, b, a).changes)
      }
    }
  }
  return changed
}

export interface StageProfileRestoreOptions {
  backupPath: string
  userData: string
  layout: ProfileBackupLayout
}

/**
 * Copies a verified backup into staging, upgrades and sanitizes the copies,
 * and records a journal. Live data is untouched until the next launch swaps
 * the staged entries in with `applyPendingProfileRestore`.
 */
export async function stageProfileRestore(options: StageProfileRestoreOptions) {
  const { backupPath, userData, layout } = options
  const existing = readJournal(userData)
  if (existing?.state === 'swapping') throw new ProfileBackupError('An earlier restore has not finished recovering. Restart Aerio first.')
  const manifest = readManifest(backupPath, layout)
  const root = restoreRoot(userData)
  const staging = join(root, 'staging')
  rmSync(journalPath(userData), { force: true })
  rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(join(root, 'rollback'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(staging, { recursive: true })
  const report: ProfileRestoreReport = { heldSends: 0, heldTaskWrites: 0, accountsToReauthorize: 0, rebasedPaths: resolve(manifest.sourceProfile) !== resolve(userData) }
  try {
    // Copying while hashing proves the staged bytes, not just the source, match the manifest.
    for (const entry of [...manifest.databases, ...manifest.files]) {
      const segments = entry.path.split('/')
      let actual
      try { actual = await hashFile(join(backupPath, 'data', ...segments), join(staging, ...segments)) }
      catch { throw new ProfileBackupError(`This profile backup is incomplete: ${entry.path} is missing`) }
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new ProfileBackupError(`This profile backup is corrupted: ${entry.path} does not match its checksum`)
    }
    for (const directory of layout.directories) mkdirSync(join(staging, directory.name), { recursive: true })
    for (const spec of layout.databases) {
      const path = join(staging, spec.file)
      const present = manifest.databases.some((entry) => entry.path === spec.file)
      if (present && report.rebasedPaths) {
        const db = new DatabaseSync(path)
        try { rebaseProfilePaths(db, manifest.sourceProfile, resolve(userData)) } finally { db.close() }
      }
      // A database absent from the backup is created empty so the restored profile is internally consistent.
      spec.prepareRestore?.(path, { userData, livePath: join(userData, spec.file), report })
      if (!existsSync(path)) continue
      const db = new DatabaseSync(path)
      try { checkIntegrity(db, spec.label) } finally { db.close() }
      settle(path)
    }
    // Stores may leave helper files (for example a one-time schema backup); only owned entries swap in.
    const owned = new Set(restoreEntries(layout))
    for (const name of readdirSync(staging)) if (!owned.has(name)) rmSync(join(staging, name), { recursive: true, force: true })
    writeJson(journalPath(userData), {
      state: 'staged', backupPath, backupCreatedAt: manifest.createdAt, stagedAt: nowIso(), entries: restoreEntries(layout), report
    } satisfies RestoreJournal)
    return report
  } catch (error) {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
}

function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Windows can briefly hold files from the previous process; retry before giving up. */
function renameWithRetry(from: string, to: string, attempts = 20) {
  for (let attempt = 1; ; attempt += 1) {
    try { renameSync(from, to); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error
      sleepSync(250)
    }
  }
}

function rollbackSwap(userData: string, journal: RestoreJournal) {
  const rollback = join(restoreRoot(userData), 'rollback')
  const missing = new Set(journal.previouslyMissing ?? [])
  for (const entry of journal.entries) {
    const saved = join(rollback, entry)
    const live = join(userData, entry)
    if (existsSync(saved)) {
      rmSync(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      renameWithRetry(saved, live)
    } else if (missing.has(entry)) {
      rmSync(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}

function finish(userData: string, journal: RestoreJournal, outcome: ProfileRestoreOutcome) {
  writeJson(journalPath(userData), { ...journal, state: outcome.status, outcome } satisfies RestoreJournal)
  return outcome
}

/**
 * Runs at startup before any profile database is opened. A staged restore is
 * swapped in with renames (each entry's original moved aside first); any
 * failure, or a journal left mid-swap by a crash, puts every original back.
 */
export function applyPendingProfileRestore(userData: string, options: { beforeSwapEntry?(entry: string): void } = {}): ProfileRestoreOutcome | undefined {
  const journal = readJournal(userData)
  if (!journal) return undefined
  const root = restoreRoot(userData)
  const staging = join(root, 'staging')
  const rollback = join(root, 'rollback')
  const outcome = (status: ProfileRestoreOutcome['status'], error?: string): ProfileRestoreOutcome => ({ status, backupCreatedAt: journal.backupCreatedAt, completedAt: nowIso(), report: journal.report, ...(error ? { error } : {}) })
  if (journal.state === 'applied' || journal.state === 'rolled-back') return journal.outcome
  if (journal.state === 'swapping') {
    rollbackSwap(userData, journal)
    return finish(userData, journal, outcome('rolled-back', 'Aerio closed while restoring the profile backup, so the previous data was kept.'))
  }
  if (journal.state !== 'staged' || !Array.isArray(journal.entries)) {
    rmSync(journalPath(userData), { force: true })
    return undefined
  }
  const swapping: RestoreJournal = { ...journal, state: 'swapping', previouslyMissing: journal.entries.filter((entry) => !existsSync(join(userData, entry))) }
  rmSync(rollback, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(rollback, { recursive: true })
  writeJson(journalPath(userData), swapping)
  try {
    for (const entry of journal.entries) {
      options.beforeSwapEntry?.(entry)
      const live = join(userData, entry)
      if (existsSync(live)) renameWithRetry(live, join(rollback, entry))
      const staged = join(staging, entry)
      if (existsSync(staged)) renameWithRetry(staged, live)
    }
  } catch (error) {
    try { rollbackSwap(userData, swapping) } catch { return { ...outcome('rolled-back', 'The restore failed and the previous data could not be fully put back; it remains in the .profile-restore folder.') } }
    return finish(userData, swapping, outcome('rolled-back', `The restore could not replace the profile, so the previous data was kept: ${error instanceof Error ? error.message : String(error)}`))
  }
  return finish(userData, swapping, outcome('applied'))
}

/** After a successful launch on restored data, drop the rollback copy and keep only the outcome for display. */
export function finalizeProfileRestore(userData: string) {
  const journal = readJournal(userData)
  if (!journal || (journal.state !== 'applied' && journal.state !== 'rolled-back')) return journal?.outcome
  const root = restoreRoot(userData)
  if (journal.outcome) writeJson(outcomePath(userData), journal.outcome)
  rmSync(journalPath(userData), { force: true })
  for (const name of ['staging', 'rollback']) rmSync(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return journal.outcome
}

export function lastProfileRestoreOutcome(userData: string): ProfileRestoreOutcome | undefined {
  try { return JSON.parse(readFileSync(outcomePath(userData), 'utf8')) as ProfileRestoreOutcome } catch { return readJournal(userData)?.outcome }
}

export function dismissProfileRestoreOutcome(userData: string) { rmSync(outcomePath(userData), { force: true }) }

export interface ProfileBackupState {
  schedule: ProfileBackupSchedule
  lastBackupAt?: string
  lastBackupPath?: string
  lastAttemptAt?: string
  lastError?: string
}

export const PROFILE_BACKUP_INTERVALS = [24, 72, 168] as const
export const PROFILE_BACKUP_KEEP_MAX = 50

export function normalizeProfileBackupSchedule(value: unknown, defaultDirectory: string): ProfileBackupSchedule {
  const input = value && typeof value === 'object' ? value as Partial<ProfileBackupSchedule> : {}
  return {
    enabled: input.enabled === true,
    intervalHours: PROFILE_BACKUP_INTERVALS.includes(input.intervalHours as 24) ? Number(input.intervalHours) : 24,
    keep: Number.isSafeInteger(input.keep) && input.keep! >= 1 && input.keep! <= PROFILE_BACKUP_KEEP_MAX ? input.keep! : 7,
    directory: typeof input.directory === 'string' && input.directory.length <= 32_767 && isAbsolute(input.directory) ? input.directory : defaultDirectory
  }
}

export function validateProfileBackupSchedule(value: unknown): ProfileBackupSchedule {
  const input = value as Partial<ProfileBackupSchedule> | undefined
  if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean') throw new ProfileBackupError('The backup schedule is invalid')
  if (!PROFILE_BACKUP_INTERVALS.includes(input.intervalHours as 24)) throw new ProfileBackupError('Choose a supported backup interval')
  if (!Number.isSafeInteger(input.keep) || input.keep! < 1 || input.keep! > PROFILE_BACKUP_KEEP_MAX) throw new ProfileBackupError(`Keep between 1 and ${PROFILE_BACKUP_KEEP_MAX} backups`)
  if (typeof input.directory !== 'string' || !input.directory || input.directory.length > 32_767 || !isAbsolute(input.directory)) throw new ProfileBackupError('Choose a folder for profile backups')
  return { enabled: input.enabled, intervalHours: input.intervalHours!, keep: input.keep!, directory: input.directory }
}

export function readProfileBackupState(path: string, defaultDirectory: string): ProfileBackupState {
  let raw: Partial<ProfileBackupState> = {}
  try { raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProfileBackupState> } catch { /* Defaults. */ }
  const text = (value: unknown) => typeof value === 'string' && value.length <= 32_767 ? value : undefined
  return {
    schedule: normalizeProfileBackupSchedule(raw.schedule, defaultDirectory),
    lastBackupAt: text(raw.lastBackupAt), lastBackupPath: text(raw.lastBackupPath), lastAttemptAt: text(raw.lastAttemptAt), lastError: text(raw.lastError)
  }
}

export function writeProfileBackupState(path: string, state: ProfileBackupState) { writeJson(path, state) }

/** When the next scheduled backup is due; failed attempts retry after an hour rather than every tick. */
export function nextProfileBackupAt(state: ProfileBackupState): Date | undefined {
  if (!state.schedule.enabled) return undefined
  const last = Date.parse(state.lastBackupAt ?? '')
  const due = Number.isFinite(last) ? last + state.schedule.intervalHours * 3_600_000 : 0
  const attempt = Date.parse(state.lastAttemptAt ?? '')
  const retry = state.lastError && Number.isFinite(attempt) ? attempt + 3_600_000 : 0
  return new Date(Math.max(due, retry))
}

export function profileBackupDue(state: ProfileBackupState, now = new Date()) {
  const next = nextProfileBackupAt(state)
  return Boolean(next && next.getTime() <= now.getTime())
}

