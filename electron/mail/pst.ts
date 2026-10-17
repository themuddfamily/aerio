import { PSTFile, type PSTAttachment, type PSTFolder, type PSTMessage } from 'pst-extractor'
import { PST_HIGH_ENCRYPTION_REASON, PST_INVALID_REASON, pstHeaderProblem } from './pst-header'
import { isMailMessageClass, type PstAttachmentSource, type PstMessageSource } from './pst-mime'

// Reads Outlook data files (.pst/.ost) through pst-extractor, which reads
// the file on demand rather than loading it into memory. It handles ANSI and
// Unicode PSTs, the Outlook 2013+ 4 KB-page format used by OST files, and
// "compressible" (permutation) encryption; "high" (cyclic) encryption is
// refused. Everything here runs synchronously inside the mail worker.

const NID_TYPE_SEARCH_FOLDER = 0x03
const PR_IPM_SUBTREE_ENTRYID = 0x35e0
const PR_RTF_COMPRESSED = 0x1009
const PR_FLAG_STATUS = 0x1090
const PR_INTERNET_REFERENCES = 0x1039
const PR_SENDER_SMTP_ADDRESS = 0x5d01
const PR_SENT_REPRESENTING_SMTP_ADDRESS = 0x5d02
const MAX_FOLDERS = 10_000

export interface PstFolderEntry {
  /** Folder names below the top of the mailbox, outermost first. */
  path: string[]
  /** Item count recorded by Outlook (PidTagContentCount). */
  count: number
}

export interface PstMessageRecord {
  /** Position of the item in its folder's contents table. */
  index: number
  message?: PstMessageSource
  /** Node id of the item, stable for a given file. */
  nodeId?: number
  error?: string
}

interface Limits {
  maxDepth: number
}

// Only protected accessors expose these MAPI properties.
interface PropertyAccess {
  getIntItem(identifier: number, defaultValue?: number): number
  getStringItem(identifier: number): string
  getBinaryItem(identifier: number): Buffer | null
  getNodeType(identifier?: number): number
}
const props = (object: PSTMessage | PSTFolder | PSTAttachment) => object as unknown as PropertyAccess

function safe<T>(read: () => T, fallback: T): T {
  try {
    const value = read()
    return value ?? fallback
  } catch {
    return fallback
  }
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error)

export class PstArchive {
  private readonly file: PSTFile
  private folderList?: { entry: PstFolderEntry; folder: PSTFolder }[]
  /** Items in calendar, contact, task and other non-mail folders, which are not imported. */
  nonMailItems = 0
  /** Folders whose subfolders could not be read. */
  readonly problems: string[] = []

  constructor(path: string) {
    const problem = pstHeaderProblem(path)
    if (problem) throw new Error(problem)
    try {
      this.file = new PSTFile(path)
    } catch (error) {
      if (/encrypted/i.test(describe(error))) throw new Error(PST_HIGH_ENCRYPTION_REASON)
      throw new Error(PST_INVALID_REASON)
    }
  }

  close() {
    try { this.file.close() } catch { /* Already closed. */ }
  }

  // The mail folders sit under the IPM subtree ("Top of Personal Folders" in
  // a PST, "IPM_SUBTREE" in an OST). Search folders and the hidden folders
  // beside the IPM subtree are never imported.
  private topFolder(): PSTFolder {
    const root = this.file.getRootFolder()
    const entryId = safe(() => props(this.file.getMessageStore() as unknown as PSTMessage).getBinaryItem(PR_IPM_SUBTREE_ENTRYID), null)
    const wanted = entryId && entryId.length >= 24 ? entryId.readUInt32LE(20) : undefined
    const children = (folder: PSTFolder) => safe(() => folder.hasSubfolders ? folder.getSubFolders() : [], [] as PSTFolder[])
    const isFolder = (folder: PSTFolder) => safe(() => props(folder).getNodeType() !== NID_TYPE_SEARCH_FOLDER, false)
    const queue: { folder: PSTFolder; depth: number }[] = [{ folder: root, depth: 0 }]
    let byName: PSTFolder | undefined
    while (queue.length) {
      const { folder, depth } = queue.shift()!
      if (wanted !== undefined && safe(() => folder.descriptorNodeId.toNumber(), -1) === wanted) return folder
      if (!byName && depth > 0 && /^(IPM_SUBTREE|Top of (Personal Folders|Outlook data file|Information Store))$/i.test(safe(() => folder.displayName, ''))) byName = folder
      if (depth < 2) for (const child of children(folder)) if (isFolder(child) && !/^(Root - Public|Search Root)$/i.test(safe(() => child.displayName, ''))) queue.push({ folder: child, depth: depth + 1 })
    }
    return byName ?? root
  }

  /** Mail folders in a stable depth-first order; the same file always gives the same list. */
  folders(limits: Limits): PstFolderEntry[] {
    if (this.folderList) return this.folderList.map((item) => item.entry)
    const list: { entry: PstFolderEntry; folder: PSTFolder }[] = []
    this.nonMailItems = 0
    const visit = (folder: PSTFolder, path: string[]) => {
      if (list.length >= MAX_FOLDERS) throw new Error(`An Outlook data file can contain at most ${MAX_FOLDERS.toLocaleString('en-US')} folders`)
      list.push({ entry: { path, count: Math.max(0, safe(() => folder.contentCount, 0)) }, folder })
      if (!safe(() => folder.hasSubfolders, false)) return
      let children: PSTFolder[]
      try {
        children = folder.getSubFolders()
      } catch (error) {
        this.problems.push(`${path.join('/') || 'Top folder'}: its subfolders could not be read (${describe(error)})`)
        return
      }
      for (const child of children) {
        if (safe(() => props(child).getNodeType(), NID_TYPE_SEARCH_FOLDER) === NID_TYPE_SEARCH_FOLDER) continue
        const name = safe(() => child.displayName, '') || 'Untitled'
        if (!isMailContainer(safe(() => child.containerClass, ''))) {
          this.nonMailItems += countItems(child)
          continue
        }
        if (path.length + 1 > limits.maxDepth) {
          this.problems.push(`${[...path, name].join('/')}: nested too deeply to import`)
          continue
        }
        visit(child, [...path, name])
      }
    }
    visit(this.topFolder(), [])
    this.folderList = list
    return list.map((item) => item.entry)
  }

  /**
   * Reads the items of one folder from `start`, converting each to a
   * message source. Non-mail items (contacts, appointments …) are reported
   * with neither a message nor an error.
   */
  *messages(folderIndex: number, start: number): Generator<PstMessageRecord> {
    const item = this.folderList?.[folderIndex]
    if (!item) return
    const { folder } = item
    const total = item.entry.count
    let index = start
    while (index < total) {
      folder.moveChildCursorTo(index)
      let child: PSTMessage | null
      try {
        child = folder.getNextChild() as PSTMessage | null
      } catch (error) {
        yield { index, error: `This Outlook item could not be read (${describe(error)})` }
        index += 1
        continue
      }
      if (!child) return
      // pst-extractor silently steps over items it cannot load.
      const position = Math.max(index, cursorOf(folder) - 1)
      index = position + 1
      const nodeId = safe(() => child!.descriptorNodeId.toNumber(), undefined)
      if (!isMailMessageClass(safe(() => child.messageClass, ''))) {
        yield { index: position, nodeId }
        continue
      }
      yield { index: position, nodeId, message: messageSource(child) }
    }
  }

  /** Re-reads one item for duplicate review. */
  message(folderIndex: number, index: number): PstMessageRecord | undefined {
    for (const record of this.messages(folderIndex, index)) return record.index === index ? record : undefined
    return undefined
  }
}

const cursorOf = (folder: PSTFolder) => (folder as unknown as { currentEmailIndex: number }).currentEmailIndex

// Mail folders have no class, IPF, or an IPF.Note/IPF.Imap class. Calendar,
// contact, task, note and journal folders are skipped.
export function isMailContainer(containerClass: string) {
  const value = containerClass.toUpperCase()
  return !value || value === 'IPF' || value.startsWith('IPF.NOTE') || value.startsWith('IPF.IMAP')
}

function countItems(folder: PSTFolder, depth = 0): number {
  let total = Math.max(0, safe(() => folder.contentCount, 0))
  if (depth < 24 && safe(() => folder.hasSubfolders, false)) {
    for (const child of safe(() => folder.getSubFolders(), [] as PSTFolder[])) total += countItems(child, depth + 1)
  }
  return total
}

function messageSource(message: PSTMessage): PstMessageSource {
  const access = props(message)
  return {
    messageClass: safe(() => message.messageClass, ''),
    subject: safe(() => message.subject, ''),
    senderName: safe(() => message.senderName, ''),
    senderEmail: safe(() => message.senderEmailAddress, ''),
    senderAddrType: safe(() => message.senderAddrtype, ''),
    senderSmtp: safe(() => access.getStringItem(PR_SENDER_SMTP_ADDRESS), ''),
    representingName: safe(() => message.sentRepresentingName, ''),
    representingEmail: safe(() => message.sentRepresentingEmailAddress, ''),
    representingAddrType: safe(() => message.sentRepresentingAddressType, ''),
    representingSmtp: safe(() => access.getStringItem(PR_SENT_REPRESENTING_SMTP_ADDRESS), ''),
    recipients: safe(() => {
      const recipients: PstMessageSource['recipients'] = []
      const count = Math.min(message.numberOfRecipients, 10_000)
      for (let index = 0; index < count; index += 1) {
        const recipient = safe(() => message.getRecipient(index), null)
        if (!recipient) continue
        recipients.push({
          type: safe(() => recipient.recipientType, 1),
          name: safe(() => recipient.displayName, ''),
          email: safe(() => recipient.emailAddress, ''),
          addrType: safe(() => recipient.addrType, ''),
          smtp: safe(() => recipient.smtpAddress, '')
        })
      }
      return recipients
    }, []),
    displayTo: safe(() => message.displayTo, ''),
    displayCc: safe(() => message.displayCC, ''),
    submitTime: safe(() => message.clientSubmitTime, null),
    deliveryTime: safe(() => message.messageDeliveryTime, null),
    creationTime: safe(() => message.creationTime, null),
    internetMessageId: safe(() => message.internetMessageId, ''),
    inReplyTo: safe(() => message.inReplyToId, ''),
    references: safe(() => access.getStringItem(PR_INTERNET_REFERENCES), ''),
    transportHeaders: safe(() => message.transportMessageHeaders, ''),
    body: safe(() => message.body, ''),
    html: safe(() => message.bodyHTML, ''),
    rtfCompressed: safe(() => access.getBinaryItem(PR_RTF_COMPRESSED), null),
    importance: safe(() => message.importance, 1),
    read: safe(() => message.isRead, true),
    flagged: safe(() => access.getIntItem(PR_FLAG_STATUS), 0) === 2,
    size: safe(() => message.messageSize.toNumber(), 0),
    attachments: () => {
      const attachments: PstAttachmentSource[] = []
      const count = safe(() => Math.min(message.numberOfAttachments, 10_000), 0)
      for (let index = 0; index < count; index += 1) {
        const attachment = safe(() => message.getAttachment(index), null)
        if (attachment) attachments.push(attachmentSource(attachment))
      }
      return attachments
    }
  }
}

function attachmentSource(attachment: PSTAttachment): PstAttachmentSource {
  return {
    method: safe(() => attachment.attachMethod, 1),
    filename: safe(() => attachment.longFilename || attachment.filename || attachment.displayName, ''),
    mimeType: safe(() => attachment.mimeTag, ''),
    contentId: safe(() => attachment.contentId, ''),
    size: safe(() => attachment.filesize, 0),
    data: () => {
      const stream = attachment.fileInputStream
      if (!stream) return null
      const data = Buffer.alloc(stream.length.toNumber())
      stream.readCompletely(data)
      return data
    },
    embedded: () => {
      const embedded = safe(() => attachment.embeddedPSTMessage, null)
      return embedded ? messageSource(embedded) : null
    }
  }
}
