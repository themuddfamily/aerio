import type { MailLabel, MailActionKind } from '../../src/mail-types'

interface GraphPage<T> {
  value: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

export interface GraphFolder {
  id: string
  displayName: string
  parentMailFolderId?: string
  childFolderCount?: number
  specialUse?: string
}

export interface GraphMessage {
  id: string
  conversationId?: string
  parentFolderId?: string
  receivedDateTime?: string
  sentDateTime?: string
  isRead?: boolean
  importance?: string
  flag?: { flagStatus?: string }
  isDraft?: boolean
  categories?: string[]
  '@removed'?: { reason?: string }
}

export function microsoftMessageLabels(folder: GraphFolder, message: GraphMessage) {
  const value = folder.displayName.toLowerCase()
  const special = folder.specialUse
  const labels = ['folder:' + folder.id]
  if (special === 'inbox' || value === 'inbox') labels.push('INBOX')
  if (special === 'sentitems' || value.includes('sent')) labels.push('SENT')
  if (special === 'drafts' || value.includes('draft') || message.isDraft) labels.push('DRAFT')
  if (special === 'junkemail' || value.includes('junk') || value.includes('spam')) labels.push('SPAM')
  if (special === 'deleteditems' || value.includes('deleted') || value.includes('trash')) labels.push('TRASH')
  if (special === 'archive' || value.includes('archive')) labels.push('ARCHIVE')
  if (!message.isRead) labels.push('UNREAD')
  if (message.flag?.flagStatus === 'flagged') labels.push('STARRED')
  if (message.importance === 'high') labels.push('IMPORTANT')
  for (const category of message.categories ?? []) if (category.trim()) labels.push('category:' + category.trim())
  return [...new Set(labels)]
}

export class MicrosoftGraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'MicrosoftGraphError'
  }
}

export class MicrosoftGraphClient {
  constructor(private readonly token: () => Promise<string>) {}

  private async response(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const response = await fetch(path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: 'application/json',
        Prefer: 'IdType="ImmutableId"',
        ...init.headers
      }
    })
    if (!response.ok && (response.status === 429 || response.status >= 500) && attempt < 6) {
      const retryHeader = response.headers.get('retry-after')
      const retrySeconds = Number(retryHeader)
      const retryDate = retryHeader && !Number.isFinite(retrySeconds) ? Date.parse(retryHeader) - Date.now() : 0
      const delay = Number.isFinite(retrySeconds) && retrySeconds > 0
        ? retrySeconds * 1_000
        : retryDate > 0 ? retryDate : Math.min(64_000, (2 ** attempt) * 1_000 + Math.floor(Math.random() * 1_000))
      await new Promise((resolve) => setTimeout(resolve, delay))
      return this.response(path, init, attempt + 1)
    }
    return response
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.response(path, init)
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new MicrosoftGraphError(value.error?.message ?? `Microsoft Graph request failed (${response.status})`, response.status)
    }
    if (response.status === 204 || response.status === 202 || response.headers.get('content-length') === '0') return undefined as T
    const text = await response.text()
    return text ? JSON.parse(text) as T : undefined as T
  }

  async listFolders() {
    const all: GraphFolder[] = []
    let next: string | undefined = '/me/mailFolders?$top=100&includeHiddenFolders=true&$select=id,displayName,parentMailFolderId,childFolderCount'
    while (next) {
      const page: GraphPage<GraphFolder> = await this.request(next)
      all.push(...page.value)
      next = page['@odata.nextLink']
    }
    for (let index = 0; index < all.length; index += 1) {
      const parent = all[index]
      if (!parent.childFolderCount) continue
      let childrenNext: string | undefined = `/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders?$top=100&includeHiddenFolders=true&$select=id,displayName,parentMailFolderId,childFolderCount`
      while (childrenNext) {
        const page: GraphPage<GraphFolder> = await this.request(childrenNext)
        for (const child of page.value) if (!all.some((item) => item.id === child.id)) all.push(child)
        childrenNext = page['@odata.nextLink']
      }
    }
    const wellKnown = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'archive', 'junkemail']
    const special = await Promise.all(wellKnown.map(async (name) => {
      try { return { ...(await this.request<GraphFolder>(`/me/mailFolders/${name}?$select=id,displayName,parentMailFolderId,childFolderCount`)), specialUse: name } }
      catch { return undefined }
    }))
    for (const folder of special) {
      if (!folder) continue
      const index = all.findIndex((item) => item.id === folder.id)
      if (index >= 0) all[index] = folder
      else all.push(folder)
    }
    return all
  }

  async delta(folderId: string, deltaLink?: string) {
    const messages: GraphMessage[] = []
    let next: string | undefined = deltaLink ?? `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=id,conversationId,parentFolderId,receivedDateTime,sentDateTime,isRead,importance,flag,isDraft,categories&$top=100`
    let checkpoint: string | undefined
    while (next) {
      const page: GraphPage<GraphMessage> = await this.request(next)
      messages.push(...page.value)
      next = page['@odata.nextLink']
      checkpoint = page['@odata.deltaLink'] ?? checkpoint
    }
    return { messages, deltaLink: checkpoint }
  }

  rawMessage(id: string) {
    return this.request<ArrayBuffer>(`/me/messages/${encodeURIComponent(id)}/$value`, { headers: { Accept: 'message/rfc822' } })
  }

  async messageRaw(id: string) {
    const response = await this.response(`/me/messages/${encodeURIComponent(id)}/$value`, { headers: { Accept: 'message/rfc822' } })
    if (!response.ok) throw new MicrosoftGraphError(`Microsoft could not download a message (${response.status})`, response.status)
    return Buffer.from(await response.arrayBuffer())
  }

  async applyAction(ids: string[], action: MailActionKind, folderId?: string) {
    for (const id of ids) {
      if (action === 'trash' || action === 'archive' || action === 'untrash' || action === 'unarchive' || action === 'label' || action === 'move') {
        if (!folderId) throw new Error('Microsoft did not expose the destination mail folder')
        await this.request(`/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: folderId }) })
      } else {
        const body = action === 'read' ? { isRead: true }
          : action === 'unread' ? { isRead: false }
            : action === 'star' ? { flag: { flagStatus: 'flagged' } }
              : action === 'unstar' ? { flag: { flagStatus: 'notFlagged' } }
                : action === 'important' ? { importance: 'high' }
                  : action === 'unimportant' ? { importance: 'normal' } : undefined
        if (body) await this.request(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      }
    }
  }

  async saveDraft(raw: Buffer, existingId?: string) {
    if (existingId) await this.request(`/me/messages/${encodeURIComponent(existingId)}`, { method: 'DELETE' }).catch(() => undefined)
    const result = await this.request<{ id?: string }>('/me/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: raw.toString('base64')
    })
    if (!result?.id) throw new Error('Microsoft could not save the draft')
    return result.id
  }

  async send(raw: Buffer, draftId?: string) {
    if (draftId) {
      await this.request(`/me/messages/${encodeURIComponent(draftId)}/send`, { method: 'POST' })
      return
    }
    await this.request<void>('/me/sendMail', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: raw.toString('base64')
    })
  }

  deleteDraft(id: string) {
    return this.request<void>(`/me/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}

export function microsoftLabels(accountId: string, folders: GraphFolder[]): MailLabel[] {
  return folders.map((folder) => ({ accountId, id: `folder:${folder.id}`, name: folder.displayName, type: folder.specialUse ? 'system' : 'user' }))
}
