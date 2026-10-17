import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailTemplateStore, parseMailTemplateBackup, sanitizeTemplateHtml, templateTextFromHtml } from './template-store'

let root: string
let stores: MailTemplateStore[]
const approved = new Set<string>()
const open = (name = 'templates.sqlite') => {
  const store = new MailTemplateStore(join(root, name), join(root, 'template-attachments'), (path) => approved.has(path))
  stores.push(store)
  return store
}
const userFile = (name: string, contents: string) => {
  const path = join(root, 'user', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  approved.add(path)
  return path
}
const managedFiles = () => existsSync(join(root, 'template-attachments')) ? readdirSync(join(root, 'template-attachments')) : []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aerio-templates-'))
  stores = []
  approved.clear()
})
afterEach(() => {
  for (const store of stores) { try { store.close() } catch { /* already closed */ } }
  rmSync(root, { recursive: true, force: true })
})

describe('template HTML', () => {
  it('strips scripts, handlers, and unsafe links while keeping composer formatting', () => {
    const html = sanitizeTemplateHtml('<p onclick="x()">Hi <b>there</b><script>alert(1)</script> <a href="javascript:alert(1)">bad</a> <a href="https://example.test">ok</a><img src="http://tracker.test/a.png"><img src="data:image/png;base64,AAAA"></p>')
    expect(html).toBe('<p>Hi <b>there</b> <a>bad</a> <a href="https://example.test">ok</a><img /><img src="data:image/png;base64,AAAA" /></p>')
    // Rich signatures keep allowlisted styles; anything that could fetch is dropped.
    expect(sanitizeTemplateHtml('<table style="border-collapse: collapse; position: absolute"><tr><td style="border: 1px solid #ccc; background: url(https://t.test)">Ada</td><td style="color: #123456; font-family: Georgia, serif">CEO</td></tr></table>'))
      .toBe('<table style="border-collapse: collapse"><tr><td>Ada</td><td style="color: #123456; font-family: Georgia, serif">CEO</td></tr></table>')
    expect(templateTextFromHtml('<div>Line &amp; one</div><div>Two<br>Three</div>')).toBe('Line & one\nTwo\nThree')
  })
})

describe('MailTemplateStore', () => {
  it('saves, searches, edits, and persists snippets and templates across a restart', () => {
    const store = open()
    const snippet = store.save({ kind: 'snippet', name: ' Thanks ', html: '<p>Thanks for <b>reaching out</b>!</p>' })
    expect(snippet).toMatchObject({ kind: 'snippet', name: 'Thanks', subject: '', text: 'Thanks for reaching out!', attachments: [] })
    const template = store.save({ kind: 'template', name: 'Weekly report', subject: 'Status for the week', html: '<div>Highlights:</div><ul><li>Shipped</li></ul>' })
    expect(store.list().map((item) => item.name)).toEqual(['Thanks', 'Weekly report'])
    expect(store.list('status week').map((item) => item.id)).toEqual([template.id])
    expect(store.list('REACHING').map((item) => item.id)).toEqual([snippet.id])
    expect(store.list('missing')).toEqual([])

    const edited = store.save({ id: snippet.id, kind: 'snippet', name: 'Thanks', html: 'Thank you!', expectedUpdatedAt: snippet.updatedAt })
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(snippet.updatedAt))
    expect(edited.createdAt).toBe(snippet.createdAt)
    expect(() => store.save({ id: snippet.id, kind: 'snippet', name: 'Thanks', html: 'stale', expectedUpdatedAt: snippet.updatedAt })).toThrow(/changed in another window/)
    expect(() => store.save({ kind: 'snippet', name: 'thanks', html: 'duplicate' })).toThrow(/already exists/)
    expect(() => store.save({ id: snippet.id, kind: 'template', name: 'Thanks', html: '' })).toThrow(/cannot be converted/)
    expect(() => store.save({ kind: 'snippet', name: 'Files', html: '', attachments: [{ name: 'a', size: 1, path: 'C:/a' }] })).toThrow(/Snippets cannot contain attachments/)
    store.close()

    const reopened = open()
    expect(reopened.get(snippet.id)).toMatchObject({ html: 'Thank you!', updatedAt: edited.updatedAt })
    expect(reopened.markUsed(template.id).lastUsedAt).toBeTruthy()
    expect(reopened.get(template.id)?.lastUsedAt).toBeTruthy()
  })

  it('copies attachments into managed storage so templates outlive the original file and draft discards', () => {
    const store = open()
    const source = userFile('brief.txt', 'hello')
    expect(() => store.save({ kind: 'template', name: 'Bad', html: '', attachments: [{ name: 'x', size: 1, path: join(root, 'secret.txt') }] })).toThrow(/not selected through Aerio/)
    const template = store.save({ kind: 'template', name: 'Brief', subject: 'Brief', html: 'See attached', attachments: [{ name: 'brief.txt', size: 5, path: source }] })
    const [attachment] = template.attachments
    expect(attachment).toMatchObject({ name: 'brief.txt', size: 5, mime: 'txt' })
    expect(store.isManagedPath(attachment.path)).toBe(true)
    rmSync(source)
    expect(readFileSync(attachment.path, 'utf8')).toBe('hello')

    // Re-saving keeps the managed copy; removing it deletes the unreferenced file.
    const resaved = store.save({ id: template.id, kind: 'template', name: 'Brief', subject: 'Brief', html: 'See attached', attachments: template.attachments })
    expect(resaved.attachments[0].path).toBe(attachment.path)
    // A managed file from another template is copied rather than shared.
    const copy = store.save({ kind: 'template', name: 'Copy', html: '', attachments: [{ name: 'brief.txt', size: 5, path: attachment.path }] })
    expect(copy.attachments[0].path).not.toBe(attachment.path)
    store.save({ id: template.id, kind: 'template', name: 'Brief', html: 'No files', attachments: [] })
    expect(existsSync(attachment.path)).toBe(false)
    store.delete(copy.id)
    expect(managedFiles()).toEqual([])

    writeFileSync(join(root, 'template-attachments', 'orphan.bin'), 'x')
    expect(store.cleanupOrphanedFiles()).toBe(1)
  })

  it('rejects oversize template attachments and reports missing managed files on use', () => {
    const store = open()
    const big = userFile('big.bin', '')
    writeFileSync(big, Buffer.alloc(21 * 1024 * 1024))
    expect(() => store.save({ kind: 'template', name: 'Big', html: '', attachments: [{ name: 'big.bin', size: 0, path: big }] })).toThrow(/20 MB/)
    expect(managedFiles()).toEqual([])
    const template = store.save({ kind: 'template', name: 'Small', html: '', attachments: [{ name: 'small.txt', size: 2, path: userFile('small.txt', 'hi') }] })
    rmSync(template.attachments[0].path)
    expect(() => store.markUsed(template.id)).toThrow(/no longer available/)
  })

  it('round-trips a portable backup with embedded attachments and merges or replaces on restore', () => {
    const source = open('source.sqlite')
    source.save({ kind: 'snippet', name: 'Sign-off', html: 'Cheers,<br>Ada' })
    source.save({ kind: 'template', name: 'Invoice', subject: 'Invoice', html: '<p>Attached</p>', attachments: [{ name: 'invoice.pdf', size: 3, path: userFile('invoice.pdf', 'pdf') }] })
    const backup = JSON.parse(JSON.stringify(source.exportBackup()))
    expect(backup.templates.every((template: { attachments: object[] }) => template.attachments.every((attachment) => !('path' in attachment)))).toBe(true)
    expect(parseMailTemplateBackup(backup)).toBeTruthy()
    source.close()
    rmSync(join(root, 'template-attachments'), { recursive: true })

    const target = open('target.sqlite')
    target.save({ kind: 'snippet', name: 'Sign-off', html: 'Local sign-off' })
    target.save({ kind: 'snippet', name: 'Local only', html: 'Keep me' })
    expect(target.restore(parseMailTemplateBackup(backup)!, 'merge')).toBe(2)
    expect(target.list().map((item) => item.name)).toEqual(['Local only', 'Sign-off', 'Sign-off (2)', 'Invoice'])
    const invoice = target.list('invoice')[0]
    expect(readFileSync(invoice.attachments[0].path, 'utf8')).toBe('pdf')
    expect(resolve(dirname(invoice.attachments[0].path))).toBe(resolve(root, 'template-attachments'))

    expect(target.restore(parseMailTemplateBackup(backup)!, 'replace')).toBe(2)
    expect(target.list().map((item) => item.name)).toEqual(['Sign-off', 'Invoice'])
    // The previous restored copy was replaced; only the new file remains.
    expect(managedFiles()).toHaveLength(1)

    const prepared = target.prepareRestore(parseMailTemplateBackup(backup)!, 'replace')
    expect(managedFiles()).toHaveLength(2)
    prepared.rollback()
    expect(managedFiles()).toHaveLength(1)
  })

  it('rejects tampered backups before writing files', () => {
    const store = open()
    store.save({ kind: 'template', name: 'Files', html: '', attachments: [{ name: 'a.txt', size: 1, path: userFile('a.txt', 'a') }] })
    const backup = store.exportBackup()
    const [template] = backup.templates
    const invalid = [
      { ...backup, format: 'other' },
      { ...backup, schemaVersion: 2 },
      { ...backup, attachments: [] },
      { ...backup, attachments: [...backup.attachments, { ...backup.attachments[0], id: 'extra' }] },
      { ...backup, attachments: [{ ...backup.attachments[0], name: 'b.txt' }] },
      { ...backup, attachments: [{ ...backup.attachments[0], dataBase64: 'not base64!' }] },
      { ...backup, templates: [template, template] },
      { ...backup, templates: [{ ...template, id: 'x', attachments: [] }, { ...template, attachments: [] }], attachments: [] },
      { ...backup, templates: [{ ...template, kind: 'snippet' }] },
      { ...backup, templates: [{ ...template, name: '' }] }
    ]
    for (const candidate of invalid) expect(parseMailTemplateBackup(candidate)).toBeUndefined()
    const sizeMismatch = { ...backup, attachments: [{ ...backup.attachments[0], dataBase64: Buffer.from('ab').toString('base64') }] }
    const parsed = parseMailTemplateBackup(sizeMismatch)!
    const before = managedFiles().length
    expect(() => store.restore(parsed, 'merge')).toThrow(/invalid/)
    expect(managedFiles()).toHaveLength(before)
  })

  it('sanitizes restored HTML instead of trusting the backup', () => {
    const store = open()
    const backup = {
      format: 'aerio-mail-templates', schemaVersion: 1, exportedAt: '2026-10-01T00:00:00Z', attachments: [],
      templates: [{ id: 't', kind: 'snippet', name: 'Hostile', subject: '', html: '<img src=x onerror=alert(1)>Hi', text: '', attachments: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }]
    }
    store.restore(parseMailTemplateBackup(backup)!, 'merge')
    expect(store.get('t')).toMatchObject({ html: '<img />Hi', text: 'Hi' })
  })
})
