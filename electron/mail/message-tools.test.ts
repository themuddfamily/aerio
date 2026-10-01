import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailMessageDetail } from '../../src/mail-types'
import { MessageLocalStore } from './message-local-store'
import { ProductivityStore } from '../productivity/store'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), save: vi.fn(), open: vi.fn(), print: vi.fn(), destroy: vi.fn(), send: vi.fn(), load: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => mocks.handlers.set(name, callback) },
  dialog: { showSaveDialog: mocks.save, showOpenDialog: mocks.open },
  BrowserWindow: class {
    static fromWebContents() { return undefined }
    static getAllWindows() { return [{ webContents: { send: mocks.send } }] }
    webContents = { setWindowOpenHandler: vi.fn(), print: mocks.print }
    loadURL = mocks.load
    isDestroyed() { return false }
    destroy = mocks.destroy
  }
}))
import { availableAttachmentPath, messagePrintDocument, registerMessageTools, safeMessageFilename, translateMessageText } from './message-tools'

const ref = { accountId: 'account', threadId: 'thread', messageId: 'one' }
const message: MailMessageDetail = { accountId: 'account', threadId: 'thread', id: 'one', subject: 'Test email', fromName: 'Ada', fromEmail: 'ada@example.test', to: ['me@example.test'], cc: [], date: '2026-10-01T09:00:00Z', text: 'Email body', html: '<p>HTML body</p><script>alert(1)</script><img src="https://tracker.test/image">', sanitizedHtml: '', labelIds: ['INBOX'], attachments: [{ id: 'a1', messageId: 'one', filename: '../report.pdf', mimeType: 'application/pdf', size: 12 }, { id: 'a2', messageId: 'one', filename: '../report.pdf', mimeType: 'application/pdf', size: 12 }] }
let local: MessageLocalStore
let productivity: ProductivityStore
let directory: string
let request: ReturnType<typeof vi.fn>
const invoke = (channel: string, ...args: any[]) => mocks.handlers.get(channel)!({ sender: {} }, ...args)

beforeEach(() => {
  vi.clearAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'aerio-message-tools-'))
  local = new MessageLocalStore(join(directory, 'local.sqlite'))
  productivity = new ProductivityStore(join(directory, 'productivity.sqlite'))
  request = vi.fn(async (command: any) => {
    if (command.type === 'mail:thread') return { ...ref, id: 'thread', subject: message.subject, messages: [message] }
    if (command.type === 'attachment:extract') writeFileSync(command.payload.targetPath, command.payload.attachmentId)
  })
  registerMessageTools({ worker: () => ({ request } as any), productivity: () => productivity, local, changed: (snapshot) => mocks.send('productivity:changed', snapshot) })
  mocks.load.mockResolvedValue(undefined)
  mocks.print.mockImplementation((_options, callback) => callback(true, ''))
})
afterEach(() => { local.close(); productivity.close(); vi.unstubAllGlobals() })

describe('message tools backend', () => {
  it('persists normalized categories and independent display preferences across restarts', async () => {
    await invoke('mail:message:local', ref, { categories: [' Work ', 'Work', 'Personal'], format: 'plain', fontSize: 18 })
    local.close()
    local = new MessageLocalStore(join(directory, 'local.sqlite'))
    expect(local.get(ref)).toMatchObject({ categories: ['Work', 'Personal'], format: 'plain', fontSize: 18 })
    expect(local.get({ ...ref, accountId: 'other' }).categories).toEqual([])
    expect(() => local.update(ref, { fontSize: 90 })).toThrow(/font size/)
    expect(() => local.update(ref, { format: 'unsafe' as any })).toThrow(/format/)
  })
  it('exports the original email through the worker and respects cancelled save dialogs', async () => {
    mocks.save.mockResolvedValueOnce({ canceled: true })
    expect(await invoke('mail:message:save', ref)).toEqual({})
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mail:export' }))
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: join(directory, 'message.eml') })
    await invoke('mail:message:save', ref)
    expect(request).toHaveBeenCalledWith({ type: 'mail:export', payload: { accountId: 'account', messageId: 'one', targetPath: join(directory, 'message.eml') } })
  })
  it('saves every attachment together with safe distinct filenames and preserves existing files', async () => {
    const taken = new Set<string>()
    const existing = availableAttachmentPath(directory, message.attachments[0].filename, taken)
    writeFileSync(existing, 'existing')
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [directory] })
    expect(await invoke('mail:message:save-attachments', ref)).toEqual({ savedPath: directory, count: 2 })
    const extracted = request.mock.calls.filter(([command]) => command.type === 'attachment:extract').map(([command]) => command.payload.targetPath)
    expect(new Set(extracted).size).toBe(2)
    expect(extracted.every((path) => path.startsWith(directory))).toBe(true)
    expect(readFileSync(existing, 'utf8')).toBe('existing')
    expect(extracted.map((path) => readFileSync(path, 'utf8'))).toEqual(['a1', 'a2'])
    expect(safeMessageFilename('CON.txt')).toBe('_CON.txt')
  })
  it('keeps tasks, notes and contacts while attaching new productivity items to the email', async () => {
    productivity.saveLocal({ tasks: [{ id: 'old-task' } as any], notes: [{ id: 'old-note' } as any], contacts: [{ id: 'contact' } as any] })
    await invoke('mail:message:create-task', ref, { title: 'Follow up', notes: 'Email body', due: '2026-10-05T12:00:00Z' })
    await invoke('mail:message:add-note', ref, { title: 'Context', content: 'Remember this' })
    const snapshot = productivity.localSnapshot()
    expect(snapshot.tasks).toHaveLength(2)
    expect(snapshot.notes).toHaveLength(2)
    expect(snapshot.contacts).toHaveLength(1)
    expect(snapshot.tasks[0].notes).toContain('ada@example.test')
    expect(local.get(ref).taskIds).toEqual([snapshot.tasks[0].id])
    expect(await invoke('mail:message:notes', ref)).toEqual([snapshot.notes[0]])
    expect(mocks.send).toHaveBeenCalledWith('productivity:changed', expect.any(Object))
  })
  it('passes copy requests for the selected message and rejects a message outside the conversation', async () => {
    await invoke('mail:message:copy', ref, 'folder:dest')
    expect(request).toHaveBeenCalledWith({ type: 'mail:copy', payload: { ...ref, destination: 'folder:dest' } })
    await expect(invoke('mail:message:copy', { ...ref, messageId: 'missing' }, 'folder:dest')).rejects.toThrow(/not found/)
  })
  it('prints only the chosen email safely and destroys the print window on success and failure', async () => {
    const html = messagePrintDocument({ ...message, subject: '<unsafe>' }, 'html')
    expect(html).toContain('&lt;unsafe&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('src="https://tracker.test')
    expect(messagePrintDocument(message, 'plain')).toContain('Email body')
    expect(messagePrintDocument(message, 'plain')).not.toContain('HTML body')
    await invoke('mail:message:print', ref, 'plain')
    expect(mocks.print).toHaveBeenCalledWith({ silent: false, printBackground: true }, expect.any(Function))
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
    mocks.print.mockImplementationOnce((_options, callback) => callback(false, 'Printer unavailable'))
    await expect(invoke('mail:message:print', ref, 'plain')).rejects.toThrow('Printer unavailable')
    expect(mocks.destroy).toHaveBeenCalledTimes(2)
  })
  it('translates actual text through LibreTranslate and reports endpoint and provider errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ translatedText: 'Bonjour' })))
    vi.stubGlobal('fetch', fetchMock)
    const input = { endpoint: 'https://translate.example.test', target: 'fr', source: 'auto', apiKey: 'secret' }
    expect(await invoke('mail:message:translate', ref, input)).toBe('Bonjour')
    expect(fetchMock.mock.calls[0]).toMatchObject([expect.any(URL), { method: 'POST', body: JSON.stringify({ q: 'Email body', source: 'auto', target: 'fr', format: 'text', api_key: 'secret' }) }])
    await expect(translateMessageText('text', { ...input, endpoint: 'http://external.test' })).rejects.toThrow(/HTTPS/)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 403 }))
    await expect(translateMessageText('text', input)).rejects.toThrow('Invalid API key')
  })
})
