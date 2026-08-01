import type { GmailLabel, MailActionKind } from '../../src/gmail-types'

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
  '@removed'?: { reason?: string }
}

export class MicrosoftGraphClient {
  constructor(private readonly token: () => Promise<string>) {}

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: 'application/json',
        Prefer: 'IdType="ImmutableId"',
        ...init.headers
      }
    })
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(value.error?.message ?? `Microsoft Graph request failed (${response.status})`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
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
    let next: string | undefined = deltaLink ?? `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=id,conversationId,parentFolderId,receivedDateTime,sentDateTime,isRead,importance,flag,isDraft&$top=100`
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
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/$value`, {
      headers: { Authorization: `Bearer ${await this.token()}`, Prefer: 'IdType="ImmutableId"', Accept: 'message/rfc822' }
    })
    if (!response.ok) throw new Error(`Microsoft could not download a message (${response.status})`)
    return Buffer.from(await response.arrayBuffer())
  }

  async applyAction(ids: string[], action: MailActionKind, folderId?: string) {
    for (const id of ids) {
      if (action === 'trash' || action === 'archive' || action === 'untrash' || action === 'unarchive' || action === 'label') {
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
    const response = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'text/plain', Prefer: 'IdType="ImmutableId"' },
      body: raw.toString('base64')
    })
    const result = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } }
    if (!response.ok || !result.id) throw new Error(result.error?.message ?? 'Microsoft could not save the draft')
    return result.id
  }

  async send(raw: Buffer, draftId?: string) {
    if (draftId) {
      await this.request(`/me/messages/${encodeURIComponent(draftId)}/send`, { method: 'POST' })
      return
    }
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'text/plain' },
      body: raw.toString('base64')
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(result.error?.message ?? `Microsoft could not send the message (${response.status})`)
    }
  }
}

export function microsoftLabels(accountId: string, folders: GraphFolder[]): GmailLabel[] {
  return folders.map((folder) => ({ accountId, id: `folder:${folder.id}`, name: folder.displayName, type: folder.specialUse ? 'system' : 'user' }))
}
