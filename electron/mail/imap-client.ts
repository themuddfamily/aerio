import { createHash } from 'node:crypto'
import { ImapFlow, type ListResponse } from 'imapflow'
import nodemailer from 'nodemailer'
import PostalMime from 'postal-mime'
import type { ImapAccountInput, MailActionKind, MailSendOptions } from '../../src/mail-types'
import { FolderConflictError, FolderNotEmptyError } from './folder-errors'

export interface ImapFolder {
  path: string
  name: string
  specialUse?: string
  delimiter?: string
}

export interface ImapMessageRef {
  id: string
  threadId: string
  folder: string
  uid: number
  uidValidity: string
  labels: string[]
}

function localId(folder: string, uidValidity: string, uid: number) {
  return createHash('sha256').update(`${folder}\0${uidValidity}\0${uid}`).digest('base64url').slice(0, 32)
}

export function imapMessageLabels(folder: ImapFolder, flags: Set<string>) {
  const labels = [`folder:${folder.path}`]
  const use = folder.specialUse?.toLowerCase()
  if (folder.path.toUpperCase() === 'INBOX' || use === '\\inbox') labels.push('INBOX')
  if (use === '\\sent') labels.push('SENT')
  if (use === '\\drafts') labels.push('DRAFT')
  if (use === '\\junk') labels.push('SPAM')
  if (use === '\\trash') labels.push('TRASH')
  if (use === '\\archive' || use === '\\all') labels.push('ARCHIVE')
  if (!flags.has('\\Seen')) labels.push('UNREAD')
  if (flags.has('\\Flagged')) labels.push('STARRED')
  if (flags.has('$Important') || flags.has('Important')) labels.push('IMPORTANT')
  for (const flag of flags) {
    if (flag.startsWith('\\') || flag === '$Important' || flag === 'Important') continue
    labels.push('keyword:' + flag)
  }
  return labels
}

export class ImapSmtpClient {
  constructor(private readonly config: ImapAccountInput) {}

  private imap(verifyOnly = false) {
    return new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapSecurity === 'tls',
      doSTARTTLS: this.config.imapSecurity === 'starttls',
      auth: { user: this.config.username, pass: this.config.password },
      tls: { rejectUnauthorized: !this.config.allowInvalidCertificates },
      logger: false,
      verifyOnly,
      includeMailboxes: verifyOnly,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000
    })
  }

  async verify() {
    const imap = this.imap(true)
    await imap.connect()
    await nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecurity === 'tls',
      requireTLS: this.config.smtpSecurity === 'starttls',
      auth: { user: this.config.username, pass: this.config.password },
      tls: { rejectUnauthorized: !this.config.allowInvalidCertificates },
      connectionTimeout: 30_000
    }).verify()
  }

  async withConnection<T>(callback: (client: ImapFlow) => Promise<T>) {
    const client = this.imap()
    await client.connect()
    try {
      return await callback(client)
    } finally {
      await client.logout().catch(() => undefined)
    }
  }

  async listFolders(client: ImapFlow): Promise<ImapFolder[]> {
    const folders = await client.list({ statusQuery: { messages: true, uidNext: true, uidValidity: true, highestModseq: true } })
    return folders
      .filter((folder) => !folder.flags.has('\\Noselect'))
      .map((folder) => ({ path: folder.path, name: folder.name, specialUse: folder.specialUse, delimiter: folder.delimiter || undefined }))
  }

  private async folderDelimiter(client: ImapFlow, path?: string) {
    const folders = await client.list()
    const match = folders.find((folder) => folder.path === path) ?? folders.find((folder) => folder.path.toUpperCase() === 'INBOX') ?? folders[0]
    return { folders, delimiter: match?.delimiter || undefined }
  }

  async createFolder(parentPath: string | undefined, name: string) {
    return this.withConnection(async (client) => {
      const { folders, delimiter } = await this.folderDelimiter(client, parentPath)
      if (parentPath && !folders.some((folder) => folder.path === parentPath)) throw new FolderConflictError('The parent folder no longer exists on the mail server')
      if (parentPath && !delimiter) throw new Error('This mail server does not support nested folders')
      if (delimiter && name.includes(delimiter)) throw new Error(`The name cannot contain the folder separator “${delimiter}”`)
      // An array lets ImapFlow add the server's personal namespace prefix
      // (for example "INBOX.") to new top-level folders.
      const result = await client.mailboxCreate(parentPath ? `${parentPath}${delimiter}${name}` : [name])
      if (!result?.created && !result?.path) throw new Error('The mail server could not create the folder')
      if (result.created === false) throw new FolderConflictError('A folder with that name already exists on the mail server')
      return { path: result.path, delimiter }
    })
  }

  async renameFolder(path: string, newParentPath: string | undefined, newName: string) {
    return this.withConnection(async (client) => {
      const { folders, delimiter } = await this.folderDelimiter(client, path)
      if (!folders.some((folder) => folder.path === path)) throw new FolderConflictError('The folder was renamed or removed on the mail server')
      if (newParentPath && !folders.some((folder) => folder.path === newParentPath)) throw new FolderConflictError('The destination parent folder no longer exists on the mail server')
      if (newParentPath && !delimiter) throw new Error('This mail server does not support nested folders')
      if (delimiter && newName.includes(delimiter)) throw new Error(`The name cannot contain the folder separator “${delimiter}”`)
      const target = newParentPath ? `${newParentPath}${delimiter}${newName}` : newName
      if (target === path) return { path, delimiter }
      if (folders.some((folder) => folder.path.toLowerCase() === target.toLowerCase())) throw new FolderConflictError('A folder with that name already exists on the mail server')
      // As with create, an array target lets ImapFlow keep the namespace prefix.
      const result = await client.mailboxRename(path, newParentPath ? target : [newName])
      return { path: result?.newPath ?? target, delimiter }
    })
  }

  // Deleting an IMAP mailbox expunges its messages on most servers, so
  // non-empty folders are first emptied into Trash and verified empty.
  async deleteFolder(path: string, allowNonEmpty: boolean) {
    return this.withConnection(async (client) => {
      const { folders, delimiter } = await this.folderDelimiter(client, path)
      const folder = folders.find((item) => item.path === path)
      if (!folder) throw new FolderConflictError('The folder was renamed or removed on the mail server')
      if (delimiter && folders.some((item) => item.path.startsWith(`${path}${delimiter}`))) throw new Error('Delete or move this folder’s subfolders first')
      const status = await client.status(path, { messages: true })
      const count = status.messages ?? 0
      let movedTo: string | undefined
      if (count > 0) {
        if (!allowNonEmpty) throw new FolderNotEmptyError(count)
        movedTo = this.folderFor(normalizeImapFolders(folders), '\\Trash')
        if (!movedTo || movedTo === path) throw new Error('The mail server does not expose a Trash folder. Move the messages out of this folder before deleting it.')
        const lock = await client.getMailboxLock(path)
        try {
          const moved = await client.messageMove('1:*', movedTo)
          if (!moved) throw new Error('The mail server could not move the messages to Trash')
        } finally { lock.release() }
        const remaining = (await client.status(path, { messages: true })).messages ?? 0
        if (remaining > 0) throw new Error(`${remaining} message${remaining === 1 ? '' : 's'} could not be moved to Trash, so the folder was kept`)
      }
      await client.mailboxDelete(path)
      return { moved: count, movedTo }
    })
  }

  async inventoryFolder(client: ImapFlow, folder: ImapFolder) {
    const lock = await client.getMailboxLock(folder.path)
    try {
      if (!client.mailbox) throw new Error(`Could not open ${folder.path}`)
      const uidValidity = client.mailbox.uidValidity.toString()
      const uids = await client.search({ all: true }, { uid: true }) || []
      const refs: ImapMessageRef[] = []
      if (!uids.length) return { refs, uidValidity, highestModseq: client.mailbox.highestModseq?.toString(), uidNext: client.mailbox.uidNext }
      for await (const message of client.fetch(uids, { uid: true, envelope: true, threadId: true, flags: true }, { uid: true })) {
        const headerThread = message.envelope?.inReplyTo ?? message.envelope?.messageId
        const threadId = message.threadId ?? createHash('sha256').update(headerThread || `${folder.path}:${message.uid}`).digest('base64url').slice(0, 32)
        refs.push({ id: localId(folder.path, uidValidity, message.uid), threadId, folder: folder.path, uid: message.uid, uidValidity, labels: imapMessageLabels(folder, message.flags ?? new Set()) })
      }
      return { refs, uidValidity, highestModseq: client.mailbox.highestModseq?.toString(), uidNext: client.mailbox.uidNext }
    } finally {
      lock.release()
    }
  }

  async fetchRaw(client: ImapFlow, folder: ImapFolder, ref: ImapMessageRef) {
    const lock = await client.getMailboxLock(folder.path)
    try {
      const message = await client.fetchOne(ref.uid, { source: true, flags: true, internalDate: true, size: true }, { uid: true })
      if (!message || !message.source) throw new Error(`Message UID ${ref.uid} is no longer available in ${folder.path}`)
      return {
        raw: message.source,
        internalDate: new Date(message.internalDate ?? Date.now()).toISOString(),
        labels: imapMessageLabels(folder, message.flags ?? new Set()),
        size: message.size ?? message.source.byteLength
      }
    } finally {
      lock.release()
    }
  }

  private folderFor(folders: ImapFolder[], specialUse: string) {
    return folders.find((folder) => folder.specialUse?.toLowerCase() === specialUse.toLowerCase())?.path
  }

  async copyMessage(folder: string, uid: number, destination: string) {
    await this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const result = await client.messageCopy(uid, destination, { uid: true })
        if (!result) throw new Error('The mail server could not copy the message')
      } finally { lock.release() }
    })
  }

  async applyAction(messages: { folder: string; uid: number }[], action: MailActionKind, labelId?: string) {
    await this.withConnection(async (client) => {
      const folders = await this.listFolders(client)
      const destination = action === 'trash' ? this.folderFor(folders, '\\Trash')
        : action === 'untrash' || action === 'unarchive' ? folders.find((folder) => folder.path.toUpperCase() === 'INBOX')?.path
          : action === 'archive' ? this.folderFor(folders, '\\Archive')
        : (action === 'label' || action === 'move') && labelId?.startsWith('folder:') ? labelId.slice(7) : undefined
      if (['trash', 'untrash', 'archive', 'unarchive', 'label', 'move'].includes(action) && !destination) {
        throw new Error(`The mail server does not expose a destination folder for ${action}`)
      }
      const grouped = new Map<string, { folder: string; uid: number }[]>()
      for (const message of messages) grouped.set(message.folder, [...(grouped.get(message.folder) ?? []), message])
      for (const [folder, rows] of grouped) {
        const lock = await client.getMailboxLock(folder)
        try {
          const uids = rows.map((row) => row.uid)
          if (destination && destination !== folder) await client.messageMove(uids, destination, { uid: true })
          else if (action === 'read') await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
          else if (action === 'unread') await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true })
          else if (action === 'star') await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true })
          else if (action === 'unstar') await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true })
          else if (action === 'important') await client.messageFlagsAdd(uids, ['$Important'], { uid: true })
          else if (action === 'unimportant') await client.messageFlagsRemove(uids, ['$Important'], { uid: true })
        } finally {
          lock.release()
        }
      }
    })
  }

  /** Permanently deletes individual messages by UID (flag \Deleted and expunge those UIDs). */
  async deleteMessages(messages: { folder: string; uid: number }[]) {
    await this.withConnection(async (client) => {
      const grouped = new Map<string, number[]>()
      for (const message of messages) grouped.set(message.folder, [...(grouped.get(message.folder) ?? []), message.uid])
      for (const [folder, uids] of grouped) {
        const lock = await client.getMailboxLock(folder)
        try {
          await client.messageDelete(uids, { uid: true })
        } finally {
          lock.release()
        }
      }
    })
  }

  async saveDraft(raw: Buffer, existingId?: string) {
    return this.withConnection(async (client) => {
      const folder = this.folderFor(await this.listFolders(client), '\\Drafts')
      if (!folder) throw new Error('The mail server does not expose a Drafts folder')
      // Selecting the folder lets ImapFlow resolve the appended UID even when
      // the server does not support UIDPLUS. A fabricated ID cannot be used
      // to replace or delete that remote draft later.
      const lock = await client.getMailboxLock(folder)
      try {
        const result = await client.append(folder, raw, ['\\Draft', '\\Seen'])
        let uid = result && result.uid
        if (result && !uid) {
          const messageId = (await PostalMime.parse(raw)).messageId
          const matches = messageId ? await client.search({ header: { 'Message-ID': messageId } }, { uid: true }) : false
          if (matches && matches.length === 1) uid = matches[0]
        }
        if (!uid || !Number.isSafeInteger(uid) || uid <= 0) throw new Error('The mail server did not identify the saved draft')
        // Preserve the previous draft if uploading its replacement fails.
        if (existingId && Number.isSafeInteger(Number(existingId)) && Number(existingId) !== uid) {
          await client.messageDelete(Number(existingId), { uid: true })
        }
        return String(uid)
      } finally { lock.release() }
    })
  }

  async deleteDraft(existingId: string) {
    if (!Number.isSafeInteger(Number(existingId))) return
    await this.withConnection(async (client) => {
      const folder = this.folderFor(await this.listFolders(client), '\\Drafts')
      if (!folder) return
      const lock = await client.getMailboxLock(folder)
      try { await client.messageDelete(Number(existingId), { uid: true }) } finally { lock.release() }
    })
  }

  /** `envelopeFrom` lets an alias identity use its own SMTP sender; the server decides whether it is allowed. */
  async send(raw: Buffer, recipients: string[], options?: MailSendOptions, envelopeFrom = this.config.email) {
    const transport = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecurity === 'tls',
      requireTLS: this.config.smtpSecurity === 'starttls',
      auth: { user: this.config.username, pass: this.config.password },
      tls: { rejectUnauthorized: !this.config.allowInvalidCertificates },
      connectionTimeout: 30_000
    })
    // Nodemailer only adds DSN parameters when the SMTP server advertises DSN.
    const dsn = options?.requestDeliveryReceipt ? { return: 'headers' as const, notify: ['success', 'failure', 'delay'] as ('success' | 'failure' | 'delay')[], recipient: envelopeFrom } : undefined
    await transport.sendMail({ envelope: { from: envelopeFrom, to: recipients }, raw, ...(dsn ? { dsn } : {}) })
  }
}

export function labelsForImapFolders(accountId: string, folders: ImapFolder[]) {
  const paths = new Set(folders.map((folder) => folder.path))
  return folders.map((folder) => {
    const split = folder.delimiter ? folder.path.lastIndexOf(folder.delimiter) : -1
    const parent = split > 0 ? folder.path.slice(0, split) : undefined
    return {
      accountId,
      id: `folder:${folder.path}`,
      name: folder.path,
      type: folder.specialUse || folder.path.toUpperCase() === 'INBOX' ? 'system' as const : 'user' as const,
      ...(parent && paths.has(parent) ? { parentId: `folder:${parent}` } : {})
    }
  })
}

export function normalizeImapFolders(folders: ListResponse[]) {
  return folders.map((folder) => ({ path: folder.path, name: folder.name, specialUse: folder.specialUse, delimiter: folder.delimiter || undefined }))
}
