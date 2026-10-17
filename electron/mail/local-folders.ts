import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { MailLocalTransferInput, MailLocalTransferResult } from '../../src/mail-types'
import { isSystemMailFolder } from '../../src/lib/mail-folders'
import type { MailDatabase } from './database'
import { importMetadata, importThreadId, sha256 } from './import-headers'
import type { ImportedMessageInput } from './mail-import'

export interface LocalTransferDeps {
  database: MailDatabase
  store(accountId: string, message: ImportedMessageInput): Promise<unknown>
  readRaw?(path: string): Buffer
}

/**
 * Copies downloaded messages from any account into a Local Folders folder.
 * The original MIME source is copied byte for byte, so headers, dates and
 * attachments are kept; read and starred state carry over. A move copies
 * first and only then queues the normal (undoable) Trash action on the
 * source account, so nothing is removed unless every copy succeeded.
 */
export async function transferToLocalFolders(deps: LocalTransferDeps, input: MailLocalTransferInput & { messageIds?: string[] }): Promise<MailLocalTransferResult> {
  const { database } = deps
  const local = database.localMail.account()
  if (!local) throw new Error('Create Local Folders before copying messages into them')
  const source = database.getAccount(input.sourceAccountId)
  if (!source) throw new Error('Account not found')
  const destination = database.listLabels([local.id]).find((label) => label.id === input.destinationLabelId)
  if (!destination || isSystemMailFolder(destination)) throw new Error('Choose a Local Folders folder as the destination')
  if (input.mode === 'move' && source.id === local.id) throw new Error('Use Move to move messages between Local Folders')
  if (input.mode === 'move' && source.archived) throw new Error('Messages in an offline archive can be copied but not moved')
  if (!input.threadIds.length) throw new Error('Select at least one conversation')
  const read = deps.readRaw ?? ((path: string) => readFileSync(path))
  const wanted = input.messageIds ? new Set(input.messageIds) : undefined
  const messages = database.remoteMessagesForThreads(source.id, input.threadIds).filter((message) => !wanted || wanted.has(message.id))
  const result: MailLocalTransferResult = { copied: 0, skipped: 0, missing: 0 }
  for (const message of messages) {
    const path = database.getMessageRaw(source.id, message.id)
    if (!path || !database.rawExists(path)) {
      result.missing += 1
      continue
    }
    const raw = read(path)
    const hash = sha256(raw)
    // Copying the same message into the same folder twice is a no-op.
    if (database.localMail.messagesWithHash(local.id, hash).some((item) => item.labelIds.includes(destination.id))) {
      result.skipped += 1
      continue
    }
    const metadata = importMetadata(raw)
    const id = createHash('sha256').update(`copy:${source.id}:${message.id}:${destination.id}:${hash}`).digest('hex').slice(0, 32)
    await deps.store(local.id, {
      id,
      threadId: importThreadId(metadata.threadRoot ?? `local:${id}`),
      historyId: `copy:${source.id}`,
      raw,
      labelIds: [destination.id, ...message.labelIds.filter((label) => label === 'UNREAD' || label === 'STARRED')],
      internalDate: database.localMail.internalDate(source.id, message.id) ?? metadata.date,
      sizeEstimate: raw.length
    })
    database.localMail.addFingerprint(local.id, id, hash, metadata.messageId)
    result.copied += 1
  }
  if (input.mode === 'move' && messages.length && result.missing === 0) {
    result.trashOperation = database.applyLocalAction({ accountId: source.id, threadIds: input.threadIds, action: 'trash' })
  }
  return result
}
