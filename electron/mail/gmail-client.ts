import type { GmailLabel } from '../../src/gmail-types'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message)
    this.name = 'GmailApiError'
  }
}

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
  historyId: string
}

export interface GmailMessageReference {
  id: string
  threadId: string
}

export interface GmailRawMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  raw: string
}

export interface GmailHistory {
  id: string
  messagesAdded?: { message: GmailMessageReference }[]
  messagesDeleted?: { message: GmailMessageReference }[]
  labelsAdded?: { message: GmailMessageReference & { labelIds?: string[] }; labelIds?: string[] }[]
  labelsRemoved?: { message: GmailMessageReference & { labelIds?: string[] }; labelIds?: string[] }[]
}

interface HistoryResponse {
  history?: GmailHistory[]
  nextPageToken?: string
  historyId?: string
}

export class GmailClient {
  constructor(
    private readonly accountId: string,
    private readonly tokenProvider: (accountId: string) => Promise<string>
  ) {}

  private async request<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    const token = await this.tokenProvider(this.accountId)
    const response = await fetch(`${GMAIL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      }
    })
    if (response.ok) {
      if (response.status === 204) return undefined as T
      return await response.json() as T
    }
    let details: { error?: { message?: string; errors?: { reason?: string }[] } } = {}
    try { details = await response.json() as typeof details } catch { /* Fall through to status text. */ }
    const reason = details.error?.errors?.[0]?.reason
    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < 6) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      const delay = retryAfter > 0
        ? retryAfter * 1_000
        : Math.min(64_000, (2 ** attempt) * 1_000 + Math.floor(Math.random() * 1_000))
      await new Promise((resolve) => setTimeout(resolve, delay))
      return this.request<T>(path, init, attempt + 1)
    }
    throw new GmailApiError(details.error?.message ?? `${response.status} ${response.statusText}`, response.status, reason)
  }

  getProfile() {
    return this.request<GmailProfile>('/profile')
  }

  async listLabels(): Promise<GmailLabel[]> {
    const result = await this.request<{ labels?: { id: string; name: string; type: 'system' | 'user'; color?: { backgroundColor?: string } }[] }>('/labels')
    return (result.labels ?? []).map((label) => ({
      accountId: this.accountId,
      id: label.id,
      name: label.name,
      type: label.type.toLowerCase() as GmailLabel['type'],
      color: label.color?.backgroundColor
    }))
  }

  listMessages(pageToken?: string) {
    const params = new URLSearchParams({ maxResults: '500', includeSpamTrash: 'true' })
    if (pageToken) params.set('pageToken', pageToken)
    return this.request<{ messages?: GmailMessageReference[]; nextPageToken?: string; resultSizeEstimate?: number }>(`/messages?${params}`)
  }

  getRawMessage(messageId: string) {
    return this.request<GmailRawMessage>(`/messages/${encodeURIComponent(messageId)}?format=RAW`)
  }

  async getRawMessages(messageIds: string[]) {
    const results: { id: string; message?: GmailRawMessage; error?: Error }[] = []
    let index = 0
    const workers = Array.from({ length: Math.min(4, messageIds.length) }, async () => {
      while (index < messageIds.length) {
        const id = messageIds[index++]
        try {
          results.push({ id, message: await this.getRawMessage(id) })
        } catch (error) {
          results.push({ id, error: error instanceof Error ? error : new Error(String(error)) })
        }
      }
    })
    await Promise.all(workers)
    return results
  }

  getMessageMinimal(messageId: string) {
    return this.request<Pick<GmailRawMessage, 'id' | 'threadId' | 'labelIds' | 'historyId' | 'internalDate'>>(`/messages/${encodeURIComponent(messageId)}?format=MINIMAL`)
  }

  listHistory(startHistoryId: string, pageToken?: string) {
    const params = new URLSearchParams({ startHistoryId, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)
    return this.request<HistoryResponse>(`/history?${params}`)
  }

  modifyThreads(threadIds: string[], addLabelIds: string[], removeLabelIds: string[]) {
    return Promise.all(threadIds.map((threadId) => this.request(`/threads/${encodeURIComponent(threadId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds, removeLabelIds })
    })))
  }

  trashThreads(threadIds: string[]) {
    return Promise.all(threadIds.map((threadId) => this.request(`/threads/${encodeURIComponent(threadId)}/trash`, { method: 'POST', body: '{}' })))
  }

  untrashThreads(threadIds: string[]) {
    return Promise.all(threadIds.map((threadId) => this.request(`/threads/${encodeURIComponent(threadId)}/untrash`, { method: 'POST', body: '{}' })))
  }

  createDraft(raw: string, threadId?: string) {
    return this.request<{ id: string; message: GmailMessageReference }>('/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } })
    })
  }

  updateDraft(draftId: string, raw: string, threadId?: string) {
    return this.request<{ id: string; message: GmailMessageReference }>(`/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } })
    })
  }

  sendDraft(draftId: string, raw?: string) {
    return this.request<GmailMessageReference>('/drafts/send', {
      method: 'POST',
      body: JSON.stringify(raw ? { id: draftId, message: { raw } } : { id: draftId })
    })
  }

  sendMessage(raw: string, threadId?: string) {
    return this.request<GmailMessageReference>('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) })
    })
  }
}

