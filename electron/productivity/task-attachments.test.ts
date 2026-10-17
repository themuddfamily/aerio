import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relinkAttachments, TaskAttachmentFiles } from './task-attachments'

let directory: string
let root: string
let files: TaskAttachmentFiles
const source = (name: string, contents: string) => { const path = join(directory, 'source', name); writeFileSync(path, contents); return path }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-files-'))
  mkdirSync(join(directory, 'source'))
  root = join(directory, 'profile', 'task-attachments')
  files = new TaskAttachmentFiles(root)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('managed task attachments', () => {
  it('copies chosen files into managed storage and recognizes only direct children as managed', () => {
    const [attachment] = files.copyIn([source('plan.pdf', 'plan')])
    expect(attachment).toMatchObject({ name: 'plan.pdf', size: 4, mime: 'pdf' })
    expect(readFileSync(attachment.path!, 'utf8')).toBe('plan')
    expect(files.isManaged(attachment.path!)).toBe(true)
    for (const outside of [join(directory, 'source', 'plan.pdf'), join(root, '..', 'escape.txt'), join(root, 'nested', 'file.txt'), root, '']) expect(files.isManaged(outside)).toBe(false)
  })

  it('removes every copy when one chosen file is invalid', () => {
    expect(() => files.copyIn([source('ok.txt', 'ok'), join(directory, 'source')])).toThrow('no larger than 25 MB')
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it('sweeps unreferenced files while keeping shared references and unsaved copies', () => {
    const [kept, removed, shared] = files.copyIn([source('a.txt', 'a'), source('b.txt', 'b'), source('c.txt', 'c')])
    const [unsaved] = files.copyIn([source('d.txt', 'd')])
    // a and c are saved; b and c were referenced before; d is still open in an editor.
    files.sweep([kept.path!, removed.path!, shared.path!, shared.path!])
    expect(files.sweep([kept.path!, shared.path!])).toEqual([expect.stringContaining(removed.path!.split(/[\\/]/).at(-1)!)])
    expect(existsSync(unsaved.path!)).toBe(true)
    // Once saved and later removed from its task, the formerly pending copy is cleaned up too.
    files.sweep([kept.path!, shared.path!, unsaved.path!])
    files.sweep([kept.path!])
    expect(readdirSync(root).length).toBe(1)
    expect(existsSync(kept.path!)).toBe(true)
  })

  it('archives referenced files once and restores them to fresh managed paths', () => {
    const [attachment] = files.copyIn([source('notes.txt', 'hello')])
    const archived = files.archive([attachment, { ...attachment }])
    expect(archived).toEqual([{ id: attachment.id, name: 'notes.txt', size: 5, mime: 'txt', dataBase64: 'aGVsbG8=' }])
    const target = new TaskAttachmentFiles(join(directory, 'other-profile', 'task-attachments'))
    const { paths, created } = target.materialize(archived)
    expect(created).toHaveLength(1)
    expect(readFileSync(paths.get(attachment.id)!, 'utf8')).toBe('hello')
    expect(relinkAttachments({ attachments: [attachment] }, paths).attachments![0].path).toBe(paths.get(attachment.id))
    expect(() => relinkAttachments({ attachments: [{ ...attachment, id: 'missing' }] }, paths)).toThrow('missing the attachment')
  })

  it('rejects changed, conflicting, oversized, or corrupt archives and rolls back partial restores', () => {
    const [attachment] = files.copyIn([source('notes.txt', 'hello')])
    expect(() => files.archive([{ ...attachment, size: 4 }])).toThrow('changed or is too large')
    expect(() => files.archive([attachment, { ...attachment, name: 'other.txt' }])).toThrow('conflicting')
    expect(() => files.archive([{ ...attachment, path: join(directory, 'source', 'notes.txt') }])).toThrow('unavailable')
    expect(() => files.archive([attachment], 4)).toThrow('100 MB')
    const target = new TaskAttachmentFiles(join(directory, 'restore', 'task-attachments'))
    const good = { id: 'one', name: 'one.txt', size: 5, dataBase64: 'aGVsbG8=' }
    expect(() => target.materialize([good, { id: 'two', name: 'two.txt', size: 9, dataBase64: 'aGVsbG8=' }])).toThrow('is invalid')
    expect(readdirSync(join(directory, 'restore', 'task-attachments'))).toEqual([])
  })
})
