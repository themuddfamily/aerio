import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { afterAll, describe, expect, it } from 'vitest'
import { ENRON_PST, OUTLOOK_OST as OST, PDF_OST, pstHeader } from './mail-import.fixtures'
import { isMailContainer, PstArchive } from './pst'
import { looksLikePst, PST_HIGH_ENCRYPTION_REASON, PST_INVALID_REASON, pstHeaderProblem } from './pst-header'
import { pstMessageToMime } from './pst-mime'

const directory = mkdtempSync(join(tmpdir(), 'aerio-pst-test-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function open(path: string) {
  const archive = new PstArchive(path)
  return { archive, folders: archive.folders({ maxDepth: 24 }) }
}

describe('Outlook data file headers', () => {
  it('accepts readable PST/OST headers and explains the rest', () => {
    expect(pstHeaderProblem(ENRON_PST)).toBeUndefined()
    expect(pstHeaderProblem(OST)).toBeUndefined()
    const write = (name: string, content: Buffer | string) => {
      const path = join(directory, name)
      writeFileSync(path, content)
      return path
    }
    expect(pstHeaderProblem(write('ansi.pst', pstHeader({ version: 14, encryption: 1 })))).toBeUndefined()
    expect(pstHeaderProblem(write('ansi-high.pst', pstHeader({ version: 15, encryption: 2 })))).toBe(PST_HIGH_ENCRYPTION_REASON)
    expect(pstHeaderProblem(write('unicode-high.pst', pstHeader({ encryption: 2 })))).toBe(PST_HIGH_ENCRYPTION_REASON)
    expect(pstHeaderProblem(write('future.pst', pstHeader({ version: 99 })))).toBe(PST_INVALID_REASON)
    expect(pstHeaderProblem(write('short.pst', '!BDN'))).toBe(PST_INVALID_REASON)
    expect(() => pstHeaderProblem(join(directory, 'missing.pst'))).toThrow(/ENOENT/)
    expect(looksLikePst(ENRON_PST)).toBe(true)
    expect(looksLikePst(join(directory, 'missing.pst'))).toBe(false)
    expect(() => new PstArchive(join(directory, 'unicode-high.pst'))).toThrow(PST_HIGH_ENCRYPTION_REASON)
    // A valid header with nothing behind it is reported, not crashed on.
    expect(() => new PstArchive(join(directory, 'ansi.pst'))).toThrow(PST_INVALID_REASON)
  })

  it('classifies mail folders', () => {
    expect(['', 'IPF', 'IPF.Note', 'IPF.Note.OutlookHomepage', 'IPF.Imap'].every(isMailContainer)).toBe(true)
    expect(['IPF.Appointment', 'IPF.Contact', 'IPF.Task', 'IPF.StickyNote', 'IPF.Journal', 'IPF.Configuration'].some(isMailContainer)).toBe(false)
  })
})

describe('PstArchive', () => {
  it('reads a Unicode PST with compressible encryption: hierarchy, senders, dates and attachments', async () => {
    const { archive, folders } = open(ENRON_PST)
    try {
      expect(folders.map((folder) => [folder.path.join('/'), folder.count])).toEqual([
        ['', 0],
        ['Deleted Items', 0],
        ['lokay-m', 0],
        ['lokay-m/MLOKAY (Non-Privileged)', 1],
        ['lokay-m/MLOKAY (Non-Privileged)/TW-Commercial Group', 14],
        ['lokay-m/MLOKAY (Non-Privileged)/Systems', 7],
        ['lokay-m/MLOKAY (Non-Privileged)/Sent Items', 2],
        ['lokay-m/MLOKAY (Non-Privileged)/Personal', 47]
      ])
      // Search Root and its search folders are never visited.
      expect(archive.problems).toEqual([])
      const records = folders.flatMap((_folder, index) => [...archive.messages(index, 0)])
      expect(records).toHaveLength(71)
      expect(records.every((record) => record.message && !record.error)).toBe(true)

      const [first] = [...archive.messages(4, 0)]
      expect(first.message).toMatchObject({ subject: "New OBA's", senderEmail: 'Dennis.Lee@ENRON.com', read: true, flagged: false })
      const parsed = await PostalMime.parse(pstMessageToMime(first.message!, { maxBytes: 64 * 1024 * 1024, seed: String(first.nodeId) }))
      expect(parsed).toMatchObject({ subject: "New OBA's", from: { name: 'Lee Dennis', address: 'Dennis.Lee@ENRON.com' }, date: '2001-10-22T20:06:22.000Z', messageId: '<I2OY5JK033YULHIIZG14FWPGKODJHROVB@zlsvr22>' })
      expect(parsed.to?.map((address) => address.address)).toEqual(['Lorraine.Lindberg@ENRON.com', 'Kimberly.Watson@ENRON.com'])
      expect(parsed.cc?.map((address) => address.address)).toEqual(['Dennis.Lee@ENRON.com'])
      expect(parsed.text).toMatch(/^The attached OBA's have been submitted/)
      expect(parsed.attachments).toHaveLength(11)
      expect(parsed.attachments[0]).toMatchObject({ filename: 'OBA_27602_Citizens.doc', mimeType: 'application/msword' })
      expect((parsed.attachments[0].content as ArrayBuffer).byteLength).toBe(53_760)
      // Office documents start with the OLE compound file signature.
      expect(Buffer.from(parsed.attachments[0].content as ArrayBuffer).subarray(0, 4).toString('hex')).toBe('d0cf11e0')
    } finally {
      archive.close()
    }
  })

  it('reads Outlook 2013+ OST files, skipping calendar and contact folders', async () => {
    const { archive, folders } = open(OST)
    try {
      expect(folders.map((folder) => folder.path.join('/'))).toEqual([
        '', 'Deleted Items', 'Inbox', 'Outbox', 'Sent Items', 'Archive', 'Yammer Root', 'Yammer Root/Inbound', 'Yammer Root/Outbound',
        'Yammer Root/Feeds', 'Conversation History', 'Junk Email', 'Drafts', 'Sync Issues', 'Sync Issues/Conflicts',
        'Sync Issues/Local Failures', 'Sync Issues/Server Failures', 'RSS Feeds'
      ])
      expect(archive.nonMailItems).toBe(169)
      const inbox = folders.findIndex((folder) => folder.path.join('/') === 'Inbox')
      const records = [...archive.messages(inbox, 0)]
      expect(records.map((record) => record.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      // Resuming part-way through a folder continues with the same items.
      expect([...archive.messages(inbox, 6)].map((record) => record.nodeId)).toEqual(records.slice(6).map((record) => record.nodeId))
      expect(archive.message(inbox, 3)?.nodeId).toBe(records[3].nodeId)
      expect(archive.message(inbox, 99)).toBeUndefined()

      const welcome = records.find((record) => record.message?.subject === 'Welcome to your new Outlook.com account')!
      const parsed = await PostalMime.parse(pstMessageToMime(welcome.message!, { maxBytes: 64 * 1024 * 1024, seed: String(welcome.nodeId) }))
      expect(parsed.html).toMatch(/^<!DOCTYPE html>/)
      expect(parsed.to?.[0]).toMatchObject({ address: 'pstextractortest@outlook.com' })
      const inline = parsed.attachments.filter((attachment) => attachment.disposition === 'inline')
      expect(inline.length).toBe(10)
      expect(inline.every((attachment) => attachment.contentId && parsed.html!.includes(`cid:${attachment.contentId.slice(1, -1)}`))).toBe(true)
    } finally {
      archive.close()
    }
  })

  it('reads the PDF attachment and unread state from an OST', async () => {
    const { archive, folders } = open(PDF_OST)
    try {
      const inbox = folders.findIndex((folder) => folder.path.join('/') === 'Inbox')
      const [record] = [...archive.messages(inbox, 0)]
      expect(record.message).toMatchObject({ subject: 'single PDF', read: false })
      const parsed = await PostalMime.parse(pstMessageToMime(record.message!, { maxBytes: 64 * 1024 * 1024, seed: String(record.nodeId) }))
      expect(parsed.attachments).toEqual([expect.objectContaining({ filename: 'Clinometer Usage.pdf', mimeType: 'application/pdf', disposition: 'attachment' })])
      expect(Buffer.from(parsed.attachments[0].content as ArrayBuffer).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    } finally {
      archive.close()
    }
  })
})
