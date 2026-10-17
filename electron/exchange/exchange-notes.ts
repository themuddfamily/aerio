import type { XmlElement } from '../productivity/dav-xml'
import {
  attachmentIdFor, changedFields, inlinePicture, normalizeServerBody, NoteAuthError, NoteConflictError, noteHtmlForServer, NoteMissingError,
  NoteRejectedError, NoteTransientError, titleFromBody, type AttachmentReader, type DiscoveredNoteFolder, type NotePullResult, type NotesAdapter,
  type RemoteNote, type RemoteNoteAttachment
} from '../productivity/server-notes-adapter'
import type { NoteDraft, ServerNoteCopy, ServerNoteFolderRecord, StoredNoteFields } from '../productivity/server-notes-store'
import { deleteItemField, EwsClient, EwsError, setItemField, TRANSIENT_CODES } from './ews-client'
import { EwsAuthError, EwsHttpError, EwsNetworkError } from './ews-transport'
import { attr, element, m, readItemId, t, tBool, tNumber, ts, tText, xmlText } from './ews-xml'

// Exchange Notes (the "notes" distinguished folder and other IPF.StickyNote folders) over EWS.
// Notes are Message items with ItemClass IPM.StickyNote: Subject ↔ title, Body (HTML or text) ↔
// the note body, Categories ↔ tags, and FileAttachments ↔ attachments (inline pictures carry their
// Aerio id as ContentId and are referenced from the HTML body as cid: URLs).
//
// Reads use SyncFolderItems with the folder's SyncState, then GetItem and GetAttachment. Writes
// change only the fields the user edited (UpdateItem with the cached ChangeKey and
// ConflictResolution=NeverOverwrite), so the note color (PidLidNoteColor), position, and every
// other extended property Outlook keeps on the item are never touched.

const NOTE_PROPERTIES = ['item:ItemClass', 'item:Subject', 'item:Body', 'item:Categories', 'item:Attachments', 'item:Sensitivity', 'item:DateTimeCreated', 'item:LastModifiedTime']
const GET_BATCH = 50
const ATTACHMENT_BATCH = 20
/** Notes with attachments are uploaded inline in the SOAP request, so the total is limited per note. */
export const EXCHANGE_NOTE_ATTACHMENT_LIMIT = 15 * 1024 * 1024
const SENSITIVITY: Record<string, StoredNoteFields['classification']> = { Normal: 'PUBLIC', Personal: 'PRIVATE', Private: 'PRIVATE', Confidential: 'CONFIDENTIAL' }
const SENSITIVITY_OUT: Record<NonNullable<StoredNoteFields['classification']>, string> = { PUBLIC: 'Normal', PRIVATE: 'Private', CONFIDENTIAL: 'Confidential' }

const isStickyNote = (item: XmlElement) => (tText(item, 'ItemClass') ?? '').toLowerCase().startsWith('ipm.stickynote')

function mapError(error: unknown): Error {
  if (error instanceof NoteConflictError || error instanceof NoteMissingError || error instanceof NoteRejectedError || error instanceof NoteAuthError || error instanceof NoteTransientError) return error
  if (error instanceof EwsAuthError) return new NoteAuthError('Exchange rejected the saved credentials. Enter the password (or a new token) again.')
  if (error instanceof EwsNetworkError) return new NoteTransientError(error.message)
  if (error instanceof EwsHttpError) return error.status >= 500 || error.status === 429 || error.status === 408 ? new NoteTransientError(error.message) : new NoteRejectedError(error.message)
  if (error instanceof EwsError) {
    if (TRANSIENT_CODES.has(error.code)) return new NoteTransientError(error.message)
    if (error.code === 'ErrorIrresolvableConflict' || error.code === 'ErrorStaleObject' || error.code === 'ErrorChangeKeyRequiredForWriteOperations') return new NoteConflictError()
    if (error.code === 'ErrorItemNotFound') return new NoteMissingError()
    if (error.code === 'ErrorAccessDenied') return new NoteRejectedError('Exchange refused this change; the notes folder may be read-only')
    return new NoteRejectedError(error.message || `Exchange refused this change (${error.code})`)
  }
  return error instanceof Error ? error : new Error('The Exchange request failed')
}

function fileAttachmentXml(attachment: NoteDraft['attachments'][number], bytes: Buffer) {
  return `<t:FileAttachment>${element('Name', attachment.name)}${element('ContentType', attachment.mime || 'application/octet-stream')}${element('ContentId', attachment.id)}${element('IsInline', attachment.inline)}<t:Content>${bytes.toString('base64')}</t:Content></t:FileAttachment>`
}

function readAttachments(draft: NoteDraft, read: AttachmentReader, only?: Set<string>) {
  let total = 0
  return draft.attachments.filter((attachment) => !only || only.has(attachment.id)).map((attachment) => {
    const bytes = read(attachment)
    total += bytes.byteLength
    if (total > EXCHANGE_NOTE_ATTACHMENT_LIMIT) throw new NoteRejectedError('This note has more than 15 MB of attachments, which is more than Aerio uploads to Exchange')
    return { attachment, bytes }
  })
}

const bodyXml = (draft: NoteDraft) => draft.html
  ? `<t:Body BodyType="HTML">${xmlText(noteHtmlForServer(draft.html))}</t:Body>`
  : `<t:Body BodyType="Text">${xmlText(draft.content)}</t:Body>`
const categoriesXml = (tags: string[]) => `<t:Categories>${tags.map((tag) => `<t:String>${xmlText(tag)}</t:String>`).join('')}</t:Categories>`

export class ExchangeNotesAdapter implements NotesAdapter {
  constructor(private readonly client: EwsClient) {}

  close() { this.client.close() }

  private async guard<T>(work: () => Promise<T>) {
    try { return await work() } catch (error) { throw mapError(error) }
  }

  listFolders(): Promise<DiscoveredNoteFolder[]> {
    return this.guard(async () => {
      const found = new Map<string, DiscoveredNoteFolder>()
      const [notes] = await this.client.getFolders([{ id: 'notes' }])
      if (!(notes instanceof EwsError) && notes) found.set(notes.id, { remoteId: notes.id, name: notes.displayName || 'Notes', readOnly: notes.canCreateContents === false || notes.canModify === false })
      try {
        for (const folder of await this.client.findFolders({ id: 'msgfolderroot' }, 'Deep')) {
          if (!folder.folderClass?.toLowerCase().startsWith('ipf.stickynote') || found.has(folder.id)) continue
          found.set(folder.id, { remoteId: folder.id, name: folder.displayName || 'Notes', readOnly: folder.canCreateContents === false || folder.canModify === false })
        }
      } catch (error) {
        if (error instanceof EwsAuthError || error instanceof EwsNetworkError) throw error
        // Listing subfolders is optional; the default Notes folder still synchronizes.
      }
      return [...found.values()]
    })
  }

  /** Maps a GetItem result; attachment contents are fetched unless the previous copy already has them. */
  private async remote(item: XmlElement, previous?: StoredNoteFields): Promise<RemoteNote | undefined> {
    const id = readItemId(item)
    if (!id || !isStickyNote(item)) return undefined
    const known = new Map((previous?.attachments ?? []).filter((attachment) => attachment.remoteId).map((attachment) => [attachment.remoteId!, attachment]))
    const attachments: RemoteNoteAttachment[] = []
    const fetch: string[] = []
    for (const file of t(item, 'Attachments')?.children ?? []) {
      if (file.name !== 'FileAttachment') continue
      const remoteId = t(file, 'AttachmentId')?.attributes.Id
      if (!remoteId) continue
      const contentId = tText(file, 'ContentId')
      const reused = known.get(remoteId)
      attachments.push({
        id: reused?.id ?? attachmentIdFor(contentId, remoteId), remoteId,
        name: (tText(file, 'Name') || 'Attachment').slice(0, 255), mime: (tText(file, 'ContentType') || 'application/octet-stream').toLowerCase().slice(0, 200),
        inline: tBool(file, 'IsInline') ?? false, ...(tNumber(file, 'Size') !== undefined ? { size: tNumber(file, 'Size') } : {})
      })
      if (!reused) fetch.push(remoteId)
    }
    if (fetch.length) {
      const contents = await this.getAttachments(fetch)
      for (const attachment of attachments) {
        const content = attachment.remoteId ? contents.get(attachment.remoteId) : undefined
        if (content) { attachment.content = content; attachment.size = content.byteLength }
      }
    }
    for (const attachment of attachments) attachment.inline = inlinePicture({ ...attachment, inline: attachment.inline || Boolean(known.get(attachment.remoteId!)?.inline) })
    const body = t(item, 'Body')
    const bodyText = body ? body.text + body.children.map((child) => child.text).join('') : ''
    const html = body?.attributes.BodyType === 'HTML' ? bodyText : undefined
    const inlineIds = new Set(attachments.filter((attachment) => attachment.inline).map((attachment) => attachment.id))
    const normalized = normalizeServerBody(html !== undefined ? { html, inlineIds } : { text: bodyText, inlineIds })
    const shown = new Set(normalized.html ? [...normalized.html.matchAll(/data-aerio-note-image="([^"]+)"/g)].map((match) => match[1]) : [])
    for (const attachment of attachments) if (attachment.inline && !shown.has(attachment.id)) attachment.inline = false
    const subject = (tText(item, 'Subject') ?? '').trim()
    const created = tText(item, 'DateTimeCreated')
    const modified = tText(item, 'LastModifiedTime')
    const classification = SENSITIVITY[tText(item, 'Sensitivity') ?? '']
    return {
      remoteId: id.id, ...(id.changeKey ? { revision: id.changeKey } : {}),
      fields: {
        title: subject.slice(0, 10_000) || titleFromBody(normalized.content), content: normalized.content, ...(normalized.html ? { html: normalized.html } : {}),
        tags: [...new Set(ts(t(item, 'Categories'), 'String').map((value) => value.text.trim()).filter(Boolean))].slice(0, 100),
        attachments, itemType: item.name,
        ...(created ? { created } : {}), ...(modified ? { modified } : {}),
        ...(classification && classification !== 'PUBLIC' ? { classification } : {})
      }
    }
  }

  private async getAttachments(ids: string[]) {
    const contents = new Map<string, Buffer>()
    for (let index = 0; index < ids.length; index += ATTACHMENT_BATCH) {
      const batch = ids.slice(index, index + ATTACHMENT_BATCH)
      const messages = await this.client.call('GetAttachment', `<m:GetAttachment><m:AttachmentIds>${batch.map((id) => `<t:AttachmentId Id="${attr(id)}"/>`).join('')}</m:AttachmentIds></m:GetAttachment>`)
      for (const message of messages) {
        if (message.responseClass === 'Error') continue
        for (const file of m(message.element, 'Attachments')?.children ?? []) {
          const id = t(file, 'AttachmentId')?.attributes.Id
          const content = t(file, 'Content')?.text.replace(/\s+/g, '')
          if (id && content) contents.set(id, Buffer.from(content, 'base64'))
        }
      }
    }
    return contents
  }

  private async read(ids: string[], previous: (remoteId: string) => StoredNoteFields | undefined) {
    const notes: RemoteNote[] = []
    const ignored: NotePullResult['ignored'] = []
    const missing: string[] = []
    for (let index = 0; index < ids.length; index += GET_BATCH) {
      const batch = ids.slice(index, index + GET_BATCH)
      const items = await this.client.getItems(batch, { baseShape: 'IdOnly', properties: NOTE_PROPERTIES, bodyType: 'Best' })
      for (const [position, item] of items.entries()) {
        if (item instanceof EwsError) { if (item.code === 'ErrorItemNotFound') missing.push(batch[position]); continue }
        const note = await this.remote(item, previous(batch[position]))
        if (note) notes.push(note)
        else {
          const id = readItemId(item)
          ignored.push({ remoteId: batch[position], ...(id?.changeKey ? { revision: id.changeKey } : {}) })
        }
      }
    }
    return { notes, ignored, missing }
  }

  pull(folder: ServerNoteFolderRecord, known: Map<string, string | undefined>, previous: (remoteId: string) => StoredNoteFields | undefined): Promise<NotePullResult> {
    return this.guard(async () => {
      let syncState = folder.syncState
      let complete = !syncState
      const changed = new Set<string>()
      const removed = new Set<string>()
      for (let page = 0; page < 10_000; page++) {
        let result
        try {
          result = await this.client.syncFolderItems({ id: folder.remoteId, distinguished: false }, syncState, { maxChanges: 200, shape: { baseShape: 'IdOnly' } })
        } catch (error) {
          if (error instanceof EwsError && error.code === 'ErrorInvalidSyncStateData' && syncState) {
            // Start over: the full listing that follows replaces the cached copy of this folder.
            syncState = undefined
            complete = true
            changed.clear()
            removed.clear()
            continue
          }
          throw error
        }
        for (const change of result.changes) {
          if (change.type === 'delete') { removed.add(change.id); changed.delete(change.id) }
          else if (change.type === 'create' || change.type === 'update') { changed.add(change.id); removed.delete(change.id) }
        }
        syncState = result.syncState
        if (result.includesLastItemInRange) break
      }
      const { notes, ignored, missing } = await this.read([...changed], previous)
      // A listing from an empty state names every item: anything cached but not listed is gone.
      const stale = complete ? [...known.keys()].filter((id) => !changed.has(id)) : []
      return { changed: notes, removed: [...new Set([...removed, ...missing, ...stale])], ignored, complete, ...(syncState ? { syncState } : {}) }
    })
  }

  create(folder: ServerNoteFolderRecord, draft: NoteDraft, read: AttachmentReader) {
    return this.guard(async () => {
      const files = readAttachments(draft, read)
      const xml = `<t:Message><t:ItemClass>IPM.StickyNote</t:ItemClass>${element('Subject', draft.title)}${draft.classification ? element('Sensitivity', SENSITIVITY_OUT[draft.classification]) : ''}${bodyXml(draft)}${files.length ? `<t:Attachments>${files.map(({ attachment, bytes }) => fileAttachmentXml(attachment, bytes)).join('')}</t:Attachments>` : ''}${draft.tags.length ? categoriesXml(draft.tags) : ''}</t:Message>`
      const [created] = await this.client.createItems(xml, { messageDisposition: 'SaveOnly', folder: { id: folder.remoteId, distinguished: false } })
      if (!created) throw new NoteRejectedError('Exchange did not return the new note')
      const stored = await this.fetch(folder, created.id)
      if (!stored) throw new NoteRejectedError('Exchange did not keep the new note')
      return stored
    })
  }

  update(folder: ServerNoteFolderRecord, base: ServerNoteCopy, draft: NoteDraft, read: AttachmentReader) {
    return this.guard(async () => {
      if (!base.revision) throw new NoteConflictError('Exchange did not report a revision for this note, so Aerio cannot update it safely')
      const changed = changedFields(base.fields, draft)
      const type = base.fields.itemType ?? 'Message'
      const updates: string[] = []
      if (changed.title) updates.push(setItemField('item:Subject', type, element('Subject', draft.title)))
      if (changed.body) updates.push(setItemField('item:Body', type, bodyXml(draft)))
      if (changed.tags) updates.push(draft.tags.length ? setItemField('item:Categories', type, categoriesXml(draft.tags)) : deleteItemField('item:Categories'))
      let changeKey = base.revision
      if (updates.length) {
        const [result] = await this.client.updateItems([{ item: { id: base.remoteId, changeKey }, updates: updates.join('') }], { conflictResolution: 'NeverOverwrite', messageDisposition: 'SaveOnly' })
        if (result instanceof EwsError) throw result
        changeKey = result?.changeKey ?? changeKey
      } else {
        // Attachment-only changes do not carry a ChangeKey, so the revision is compared first.
        const current = await this.client.changeKey(base.remoteId)
        if (current !== changeKey) throw new NoteConflictError()
      }
      if (changed.attachments) {
        const kept = new Set(draft.attachments.map((attachment) => attachment.id))
        const removed = base.fields.attachments.filter((attachment) => !kept.has(attachment.id) && attachment.remoteId)
        const baseIds = new Set(base.fields.attachments.map((attachment) => attachment.id))
        const added = readAttachments(draft, read, new Set(draft.attachments.filter((attachment) => !baseIds.has(attachment.id)).map((attachment) => attachment.id)))
        if (removed.length) {
          const messages = await this.client.call('DeleteAttachment', `<m:DeleteAttachment><m:AttachmentIds>${removed.map((attachment) => `<t:AttachmentId Id="${attr(attachment.remoteId!)}"/>`).join('')}</m:AttachmentIds></m:DeleteAttachment>`)
          const failure = messages.find((message) => message.responseClass === 'Error' && message.code !== 'ErrorItemNotFound')
          if (failure) throw new EwsError(failure.message ?? 'Exchange could not remove an attachment', failure.code)
          for (const message of messages) changeKey = m(message.element, 'RootItemId')?.attributes.RootItemChangeKey ?? changeKey
        }
        if (added.length) {
          const messages = await this.client.call('CreateAttachment', `<m:CreateAttachment><m:ParentItemId Id="${attr(base.remoteId)}" ChangeKey="${attr(changeKey)}"/><m:Attachments>${added.map(({ attachment, bytes }) => fileAttachmentXml(attachment, bytes)).join('')}</m:Attachments></m:CreateAttachment>`)
          const failure = messages.find((message) => message.responseClass === 'Error')
          if (failure) throw new EwsError(failure.message ?? 'Exchange could not add an attachment', failure.code)
        }
      }
      const stored = await this.fetch(folder, base.remoteId, base.fields)
      if (!stored) throw new NoteMissingError()
      return stored
    })
  }

  remove(_folder: ServerNoteFolderRecord, base: ServerNoteCopy) {
    return this.guard(async () => {
      if (base.revision) {
        // EWS deletes do not check the ChangeKey, so the revision is compared first.
        try {
          const current = await this.client.changeKey(base.remoteId)
          if (current !== base.revision) throw new NoteConflictError('Changed on the server since you deleted it')
        } catch (error) {
          if (error instanceof EwsError && error.code === 'ErrorItemNotFound') return
          throw error
        }
      }
      const [failure] = await this.client.deleteItems([{ id: base.remoteId }], 'MoveToDeletedItems')
      if (failure && failure.code !== 'ErrorItemNotFound') throw failure
    })
  }

  fetch(_folder: ServerNoteFolderRecord, remoteId: string, previous?: StoredNoteFields) {
    return this.guard(async () => {
      const [item] = await this.client.getItems([remoteId], { baseShape: 'IdOnly', properties: NOTE_PROPERTIES, bodyType: 'Best' })
      if (!item || item instanceof EwsError) {
        if (item instanceof EwsError && item.code !== 'ErrorItemNotFound') throw item
        return undefined
      }
      return this.remote(item, previous)
    })
  }
}
