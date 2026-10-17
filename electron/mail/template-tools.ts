import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { MailTemplate, MailTemplateImportResult, MailTemplateInput } from '../../src/mail-template-types'
import { parseMailTemplateBackup, type MailTemplateStore } from './template-store'

const BACKUP_FILE_MAX_BYTES = 150 * 1024 * 1024
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300

export function registerMailTemplates(options: { store(): MailTemplateStore; approveAttachment(path: string): void }) {
  ipcMain.handle('mail:templates:list', (_event, query?: unknown): MailTemplate[] => {
    if (query !== undefined && (typeof query !== 'string' || query.length > 500)) throw new Error('The template search is too long')
    return options.store().list(query)
  })
  ipcMain.handle('mail:templates:save', (_event, input: MailTemplateInput): MailTemplate => options.store().save(input))
  ipcMain.handle('mail:templates:delete', (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Choose a valid template')
    options.store().delete(id)
  })
  ipcMain.handle('mail:templates:use', (_event, id: unknown): MailTemplate => {
    if (!validId(id)) throw new Error('Choose a valid template')
    const template = options.store().markUsed(id)
    // Drafts copy approved files into their own staging folder on save, so a
    // template's managed attachments survive draft edits, discards, and restarts.
    for (const attachment of template.attachments) options.approveAttachment(attachment.path)
    return template
  })
  ipcMain.handle('mail:templates:export', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const saveOptions: Electron.SaveDialogOptions = {
      title: 'Export mail templates',
      defaultPath: `Aerio-mail-templates-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Aerio mail templates', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, saveOptions) : await dialog.showSaveDialog(saveOptions)
    if (result.canceled || !result.filePath) return {}
    const contents = `${JSON.stringify(options.store().exportBackup(), null, 2)}\n`
    if (Buffer.byteLength(contents, 'utf8') > BACKUP_FILE_MAX_BYTES) throw new Error('Template backups must be smaller than 150 MB')
    writeFileSync(result.filePath, contents, { encoding: 'utf8', mode: 0o600 })
    return { savedPath: result.filePath }
  })
  ipcMain.handle('mail:templates:import', async (event): Promise<MailTemplateImportResult | undefined> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const openOptions: Electron.OpenDialogOptions = { title: 'Restore mail templates', filters: [{ name: 'Aerio mail templates', extensions: ['json'] }], properties: ['openFile'] }
    const result = owner ? await dialog.showOpenDialog(owner, openOptions) : await dialog.showOpenDialog(openOptions)
    const path = result.filePaths[0]
    if (result.canceled || !path) return
    const file = statSync(path)
    if (!file.isFile() || file.size > BACKUP_FILE_MAX_BYTES) throw new Error('Choose an Aerio template backup smaller than 150 MB')
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
    catch { throw new Error('That file is not a readable Aerio template backup') }
    const backup = parseMailTemplateBackup(parsed)
    if (!backup) throw new Error('That template backup is invalid or was created by an unsupported Aerio version')
    // Standalone restores merge so existing local templates are never silently lost.
    return { restored: options.store().restore(backup, 'merge') }
  })
}
