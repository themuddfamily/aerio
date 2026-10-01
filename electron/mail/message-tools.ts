import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MailMessageDetail, MailMessageLocalData, MailMessageRef, MailThreadDetail, MessageToolsApi } from '../../src/mail-types'
import type { LocalModuleSnapshot } from '../../src/productivity-types'
import type { MailWorkerClient } from './worker-client'
import type { ProductivityStore } from '../productivity/store'
import { MessageLocalStore } from './message-local-store'
import { sanitizeMessageHtml } from './message-security'

export function safeMessageFilename(value: string) {
  const name = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'message'
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name
}
export function availableAttachmentPath(directory: string, filename: string, taken: Set<string>) {
  const name = safeMessageFilename(filename)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  for (let index = 2; taken.has(candidate.toLowerCase()) || existsSync(join(directory, candidate)); index++) candidate = `${stem} (${index})${extension}`
  taken.add(candidate.toLowerCase())
  return join(directory, candidate)
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
export function messagePrintDocument(message: MailMessageDetail, format: MailMessageLocalData['format']) {
  const plain = format === 'plain' || !message.html
  const body = plain ? `<pre>${escapeHtml(message.text)}</pre>` : sanitizeMessageHtml(message.html)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeHtml(message.subject)}</title><style>body{font:14px Arial,sans-serif;color:#111;padding:24px}h1{font-size:22px}header{border-bottom:1px solid #ccc;margin-bottom:24px;padding-bottom:16px}pre{white-space:pre-wrap;font:inherit}img{max-width:100%}table{max-width:100%}</style></head><body><header><h1>${escapeHtml(message.subject)}</h1><p>From: ${escapeHtml(message.fromName)} &lt;${escapeHtml(message.fromEmail)}&gt;</p><p>To: ${escapeHtml(message.to.join(', '))}</p>${message.cc.length ? `<p>Cc: ${escapeHtml(message.cc.join(', '))}</p>` : ''}<p>Date: ${escapeHtml(message.date)}</p></header>${body}</body></html>`
}

export async function translateMessageText(text: string, input: Parameters<MessageToolsApi['translate']>[1]) {
  const url = new URL(input.endpoint)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for translation, or a local LibreTranslate server')
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter a translation server URL without credentials or query parameters')
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(input.target) || (input.source !== 'auto' && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(input.source))) throw new Error('Enter a valid language code')
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/translate$/, '')}/translate`
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: text, source: input.source, target: input.target, format: 'text', ...(input.apiKey ? { api_key: input.apiKey } : {}) }), signal: AbortSignal.timeout(60_000) })
  const result = await response.json() as { translatedText?: string; error?: string }
  if (!response.ok || typeof result.translatedText !== 'string') throw new Error(result.error || `Translation failed (${response.status})`)
  return result.translatedText
}

export function registerMessageTools(options: { worker(): MailWorkerClient; productivity(): ProductivityStore; local: MessageLocalStore; changed(snapshot: LocalModuleSnapshot): void }) {
  const { local } = options
  const messageFor = async (ref: MailMessageRef) => {
    if (!ref || ![ref.accountId, ref.threadId, ref.messageId].every((id) => typeof id === 'string' && id.length > 0 && id.length < 1024)) throw new Error('Invalid message reference')
    const thread = await options.worker().request<MailThreadDetail>({ type: 'mail:thread', payload: { accountId: ref.accountId, threadId: ref.threadId } })
    const message = thread.messages.find((item) => item.id === ref.messageId)
    if (!message) throw new Error('Message not found in this conversation')
    return message
  }
  const announce = (ref: MailMessageRef) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('mail:event', { type: 'mail-changed', payload: { accountId: ref.accountId, threadIds: [ref.threadId] } })
  }
  ipcMain.handle('mail:message:local', async (_event, ref: MailMessageRef, updates: Parameters<MessageToolsApi['updateLocal']>[1]) => {
    await messageFor(ref)
    const result = local.update(ref, { categories: updates.categories, format: updates.format, fontSize: updates.fontSize })
    announce(ref)
    return result
  })
  ipcMain.handle('mail:message:save', async (event, ref: MailMessageRef) => {
    const message = await messageFor(ref)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const settings = { title: 'Save email', defaultPath: `${safeMessageFilename(message.subject)}.eml`, filters: [{ name: 'Email message', extensions: ['eml'] }] }
    const result = owner ? await dialog.showSaveDialog(owner, settings) : await dialog.showSaveDialog(settings)
    if (result.canceled || !result.filePath) return {}
    await options.worker().request({ type: 'mail:export', payload: { accountId: ref.accountId, messageId: ref.messageId, targetPath: result.filePath } })
    return { savedPath: result.filePath }
  })
  ipcMain.handle('mail:message:save-attachments', async (event, ref: MailMessageRef) => {
    const message = await messageFor(ref)
    if (!message.attachments.length) return { count: 0 }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const settings: Electron.OpenDialogOptions = { title: 'Save all attachments to folder', properties: ['openDirectory', 'createDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, settings) : await dialog.showOpenDialog(settings)
    if (result.canceled || !result.filePaths[0]) return { count: 0 }
    const directory = result.filePaths[0]
    mkdirSync(directory, { recursive: true })
    const taken = new Set<string>()
    let count = 0
    for (const attachment of message.attachments) {
      const targetPath = availableAttachmentPath(directory, attachment.filename, taken)
      try {
        await options.worker().request({ type: 'attachment:extract', payload: { accountId: ref.accountId, messageId: ref.messageId, attachmentId: attachment.id, targetPath } })
        count++
      } catch (error) { throw new Error(`Saved ${count} of ${message.attachments.length} attachments. ${error instanceof Error ? error.message : 'Saving failed'}`) }
    }
    return { savedPath: directory, count }
  })
  ipcMain.handle('mail:message:copy', async (_event, ref: MailMessageRef, destination: string) => {
    await messageFor(ref)
    if (typeof destination !== 'string' || !destination) throw new Error('Choose a destination folder')
    await options.worker().request({ type: 'mail:copy', payload: { ...ref, destination } })
  })
  ipcMain.handle('mail:message:print', async (event, ref: MailMessageRef, format: MailMessageLocalData['format']) => {
    const message = await messageFor(ref)
    if (!['auto', 'plain', 'html'].includes(format)) throw new Error('Unknown message format')
    const printWindow = new BrowserWindow({ show: false, parent: BrowserWindow.fromWebContents(event.sender) ?? undefined, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(messagePrintDocument(message, format))}`)
      await new Promise<void>((resolve, reject) => printWindow.webContents.print({ silent: false, printBackground: true }, (success, reason) => success || /cancel/i.test(reason) ? resolve() : reject(new Error(reason || 'Printing failed'))))
    } finally { if (!printWindow.isDestroyed()) printWindow.destroy() }
  })
  ipcMain.handle('mail:message:create-task', async (_event, ref: MailMessageRef, input: Parameters<MessageToolsApi['createTask']>[1]) => {
    const message = await messageFor(ref)
    if (typeof input.title !== 'string' || !input.title.trim() || typeof input.notes !== 'string') throw new Error('Enter a task title and notes')
    if (input.due && Number.isNaN(Date.parse(input.due))) throw new Error('Choose a valid due date')
    const id = crypto.randomUUID()
    const store = options.productivity()
    const snapshot = store.localSnapshot()
    snapshot.tasks.unshift({ id, listId: 'Today', title: input.title.trim(), notes: `${input.notes}\n\nEmail: ${message.subject}\nFrom: ${message.fromEmail}\nMessage ID: ${message.messageIdHeader ?? message.id}`, due: input.due, completed: false, priority: 'normal', subtasks: [] })
    store.saveLocal(snapshot)
    local.update(ref, { taskIds: [id] })
    options.changed(snapshot)
    announce(ref)
  })
  ipcMain.handle('mail:message:add-note', async (_event, ref: MailMessageRef, input: Parameters<MessageToolsApi['addNote']>[1]) => {
    await messageFor(ref)
    if (typeof input.title !== 'string' || !input.title.trim() || typeof input.content !== 'string' || !input.content.trim()) throw new Error('Enter a note title and content')
    const id = crypto.randomUUID()
    const store = options.productivity()
    const snapshot = store.localSnapshot()
    snapshot.notes.unshift({ id, folder: 'Email', title: input.title.trim(), content: input.content, tags: [], pinned: false, archived: false, updatedAt: new Date().toISOString() })
    store.saveLocal(snapshot)
    local.update(ref, { noteIds: [id] })
    options.changed(snapshot)
    announce(ref)
  })
  ipcMain.handle('mail:message:notes', async (_event, ref: MailMessageRef) => {
    await messageFor(ref)
    const ids = local.get(ref).noteIds
    return options.productivity().localSnapshot().notes.filter((note) => ids.includes(note.id))
  })
  ipcMain.handle('mail:message:translate', async (_event, ref: MailMessageRef, input: Parameters<MessageToolsApi['translate']>[1]) => translateMessageText((await messageFor(ref)).text, input))
}
