import { createHash } from 'node:crypto'
import { ImapFlow, type ListResponse } from 'imapflow'
import nodemailer from 'nodemailer'
import type { ImapAccountInput, MailActionKind } from '../../src/gmail-types'

export interface ImapFolder {
  path: string
  name: string
  specialUse?: string
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

function systemLabel(folder: ImapFolder, flags: Set<string>) {
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

  async listFolders(client: ImapFlow) {
    const folders = await client.list({ statusQuery: { messages: true, uidNext: true, uidValidity: true, highestModseq: true } })
    return folders
      .filter((folder) => !folder.flags.has('\\Noselect'))
      .map((folder) => ({ path: folder.path, name: folder.name, specialUse: folder.specialUse }))
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
        refs.push({ id: localId(folder.path, uidValidity, message.uid), threadId, folder: folder.path, uid: message.uid, uidValidity, labels: systemLabel(folder, message.flags ?? new Set()) })
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
        labels: systemLabel(folder, message.flags ?? new Set()),
        size: message.size ?? message.source.byteLength
      }
    } finally {
      lock.release()
    }
  }

  private folderFor(folders: ImapFolder[], specialUse: string) {
    return folders.find((folder) => folder.specialUse?.toLowerCase() === specialUse.toLowerCase())?.path
  }

  async applyAction(messages: { folder: string; uid: number }[], action: MailActionKind, labelId?: string) {
    await this.withConnection(async (client) => {
      const folders = await this.listFolders(client)
      const destination = action === 'trash' ? this.folderFor(folders, '\\Trash')
        : action === 'untrash' || action === 'unarchive' ? folders.find((folder) => folder.path.toUpperCase() === 'INBOX')?.path
          : action === 'archive' ? this.folderFor(folders, '\\Archive')
            : action === 'label' && labelId?.startsWith('folder:') ? labelId.slice(7) : undefined
      if (['trash', 'untrash', 'archive', 'unarchive', 'label'].includes(action) && !destination) {
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

  async saveDraft(raw: Buffer, existingId?: string) {
    return this.withConnection(async (client) => {
      const folder = this.folderFor(await this.listFolders(client), '\\Drafts')
      if (!folder) throw new Error('The mail server does not expose a Drafts folder')
      if (existingId && Number.isSafeInteger(Number(existingId))) {
        const lock = await client.getMailboxLock(folder)
        try { await client.messageDelete(Number(existingId), { uid: true }) } finally { lock.release() }
      }
      const result = await client.append(folder, raw, ['\\Draft', '\\Seen'])
      return result && 'uid' in result ? String(result.uid) : crypto.randomUUID()
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

  async send(raw: Buffer, recipients: string[]) {
    const transport = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecurity === 'tls',
      requireTLS: this.config.smtpSecurity === 'starttls',
      auth: { user: this.config.username, pass: this.config.password },
      tls: { rejectUnauthorized: !this.config.allowInvalidCertificates },
      connectionTimeout: 30_000
    })
    await transport.sendMail({ envelope: { from: this.config.email, to: recipients }, raw })
  }
}

export function labelsForImapFolders(accountId: string, folders: ImapFolder[]) {
  return folders.map((folder) => ({ accountId, id: `folder:${folder.path}`, name: folder.path, type: folder.specialUse || folder.path.toUpperCase() === 'INBOX' ? 'system' as const : 'user' as const }))
}

export function normalizeImapFolders(folders: ListResponse[]) {
  return folders.map((folder) => ({ path: folder.path, name: folder.name, specialUse: folder.specialUse }))
}
