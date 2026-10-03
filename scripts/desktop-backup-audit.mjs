import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { ProductivityStore } from '../electron/productivity/store.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const temporaryRoot = realpathSync(tmpdir())
const profile = mkdtempSync(join(temporaryRoot, 'aerio-backup-audit-'))
const attachmentsDirectory = join(profile, 'note-attachments'), backupPath = join(profile, 'backup.json')
const bytes = Buffer.from([0, 1, 2, 255, 13, 10])
mkdirSync(attachmentsDirectory)
const file = { id: 'shared-file', name: '资料.bin', size: bytes.length, mime: 'bin', path: join(attachmentsDirectory, 'original.bin') }
writeFileSync(file.path, bytes)
const empty = { id: 'empty-file', name: 'empty.txt', size: 0, mime: 'txt', path: join(attachmentsDirectory, 'empty.txt') }
writeFileSync(empty.path, '')
const note = (id) => ({ id, folder: 'Work', title: id, content: 'Preserve text', tags: ['backup'], pinned: false, archived: false, updatedAt: '2026-10-01T09:00:00Z', attachments: [file] })
const snapshot = { tasks: [{ id: 'task', listId: 'Work', title: 'Recurring task', priority: 'high', completed: false, recurrence: 'weekly', subtasks: [{ id: 'step', title: 'Keep subtask', completed: true }] }], notes: [note('one'), { ...note('two'), attachments: [file, empty] }], contacts: [{ id: 'contact', name: 'Ada', email: 'ada@example.test', group: 'Friends', favorite: true, color: '#6558e8', source: 'local' }] }
const store = new ProductivityStore(join(profile, 'productivity.sqlite'))
store.saveLocal(snapshot); store.close()
let application
try {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  const page = await application.firstWindow()
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile, 'Fixture attachment paths must use the native user-data directory')
  page.on('dialog', (dialog) => dialog.accept())
  await page.waitForSelector('.app')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, backupPath)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Aerio settings' })
  await settings.getByRole('button', { name: 'Export backup' }).click()
  await settings.getByText('Tasks, Notes, and Contacts backup exported.').waitFor().catch(async (error) => {
    throw new Error(`Backup export did not complete: ${await settings.innerText()}`, { cause: error })
  })
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
  assert.deepEqual(backup.data, snapshot)
  assert.equal(backup.attachments.length, 2)
  assert.deepEqual(Buffer.from(backup.attachments.find((attachment) => attachment.id === file.id).dataBase64, 'base64'), bytes)
  await settings.getByRole('button', { name: 'Restore backup' }).click()
  await settings.getByText('Restored 1 task, 2 notes, and 1 contact.').waitFor()
  // Verify restored paths survive the renderer's autosave interval.
  await new Promise((resolve) => setTimeout(resolve, 450))
  const restored = await page.evaluate(() => window.aerio.productivity.localSnapshot())
  assert.deepEqual(restored.tasks, snapshot.tasks)
  assert.deepEqual(restored.contacts, snapshot.contacts)
  assert.equal(restored.notes[0].attachments[0].path, restored.notes[1].attachments[0].path)
  assert.deepEqual(readFileSync(restored.notes[0].attachments[0].path), bytes)
  assert.equal(readFileSync(restored.notes[1].attachments[1].path).length, 0)
  assert.equal(existsSync(file.path), false)
  assert.equal(existsSync(empty.path), false)
  console.log('✓ portable backup preserves Contacts, recurring Tasks, Notes, binary/Unicode/empty attachments, and shared references')

  const retainedFiles = readdirSync(attachmentsDirectory).sort()
  // The second attachment passes metadata validation but fails decoded-byte validation.
  const invalid = { ...backup, attachments: backup.attachments.map((attachment) => attachment.id === empty.id ? { ...attachment, dataBase64: 'AA==' } : attachment) }
  writeFileSync(backupPath, JSON.stringify(invalid))
  await assert.rejects(page.evaluate(() => window.aerio.productivity.importLocalData()), /invalid/)
  assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), restored)
  assert.deepEqual(readdirSync(attachmentsDirectory).sort(), retainedFiles)
  console.log('✓ invalid later attachment rolls back all staged files and retains existing data')

  writeFileSync(backupPath, JSON.stringify(backup))
  const sqlite = new DatabaseSync(join(profile, 'productivity.sqlite'))
  try {
    sqlite.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON local_module_state BEGIN SELECT RAISE(ABORT, 'restore fixture storage failure'); END")
    await assert.rejects(page.evaluate(() => window.aerio.productivity.importLocalData()), /restore fixture storage failure/)
    assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), restored)
    assert.deepEqual(readdirSync(attachmentsDirectory).sort(), retainedFiles)
  } finally { sqlite.exec('DROP TRIGGER reject_restore'); sqlite.close() }
  console.log('✓ database restore failure retains original records and attachments without orphan files')
} finally {
  if (application) await application.close().catch(() => undefined)
  assert.equal(dirname(profile), temporaryRoot)
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
