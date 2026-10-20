import { randomUUID } from 'node:crypto'
import type { MailAccountSummary, MailPage, MailThreadDetail } from '../src/mail-types'
import type { MessageWindowRequest } from '../src/types'
import type { SpotlightSettings, SpotlightStatus } from '../src/spotlight-types'
import type { MailWorkerCommand, MailWorkerResult } from './mail-protocol'
import { SpotlightStore } from './spotlight-store'

export interface SpotlightNative { available: boolean; perform(operation: 'delete' | 'index' | 'query', json: string): Promise<string> }
export interface SpotlightOptions {
  store: SpotlightStore; native?: SpotlightNative; unavailableReason?: string
  inactiveDomains?: string[]
  worker(): { request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T> }
  locked(): boolean; changed(status: SpotlightStatus): void; openMainWindow(): void; openMessage(input: MessageWindowRequest): void
}
const LIMIT = 10_000
export function spotlightIdFromUrl(value: unknown) {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); if (url.protocol === 'aerio:' && url.hostname === 'spotlight' && !url.search && !url.hash && /^\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(url.pathname)) return url.pathname.slice(1) } catch { /* Ignore unrelated links. */ }
}
export class SpotlightRuntime {
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0
  private closed = false
  private syncing = false
  private error?: string
  private lastIndexed?: string
  private timer?: ReturnType<typeof setInterval>
  private debounce?: ReturnType<typeof setTimeout>
  private pendingId?: string
  private switchingProfile = false
  private readonly inactivePending: Set<string>
  constructor(private readonly options: SpotlightOptions) {
    this.inactivePending = new Set((options.inactiveDomains ?? []).filter((domain) => domain !== options.store.domain))
    this.error = options.store.cleanupPending() ? 'Previously indexed Spotlight metadata may remain. Refresh to retry removal.' : options.unavailableReason
  }
  status(): SpotlightStatus { const settings = this.options.store.settings(), locked = this.options.locked(); return { platformSupported: true, available: Boolean(this.options.native?.available), settings: locked ? { ...settings, accountIds: [], includePreview: false } : settings, indexed: locked ? 0 : this.options.store.count(), limit: LIMIT, syncing: this.syncing, lastIndexed: this.lastIndexed, error: this.error } }
  private publish() { if (!this.closed) this.options.changed(this.status()) }
  private guard() { if (this.closed) throw new Error('Spotlight integration is closed'); if (this.options.locked()) throw new Error('Unlock Aerio to change Spotlight indexing') }
  private current(generation: number) { return !this.closed && !this.switchingProfile && this.generation === generation && !this.options.locked() && this.options.store.settings().enabled }
  private async purge() {
    if (!this.options.native?.available) { if (this.options.store.cleanupPending()) throw new Error('Native Spotlight cleanup is unavailable'); return }
    await this.options.native.perform('delete', JSON.stringify({ domain: this.options.store.domain }))
    this.options.store.markCleanupPending(false)
  }
  private async purgeInactive() {
    if (!this.inactivePending.size) return
    if (!this.options.native?.available) throw new Error('Inactive profile cleanup is unavailable')
    for (const domain of this.inactivePending) {
      await this.options.native.perform('delete', JSON.stringify({ domain }))
      this.inactivePending.delete(domain)
    }
  }
  start() {
    void this.reconcile(); this.timer = setInterval(() => { void this.reconcile() }, 5 * 60_000); this.timer.unref?.()
  }
  async beforeProfileSwitch() {
    this.guard(); this.switchingProfile = true; this.generation++
    if (this.options.store.cleanupPending() && !this.options.native?.available) { this.switchingProfile = false; throw new Error('The native Spotlight component is unavailable, so indexed metadata cannot be removed before switching profiles.') }
    try { await this.queue; await this.purgeInactive(); await this.purge() } catch { this.switchingProfile = false; throw new Error('Spotlight metadata could not be removed before switching profiles. Retry when macOS Spotlight is available.') }
  }
  profileSwitchCancelled() { this.switchingProfile = false; this.generation++; void this.reconcile() }
  mailChanged() { if (this.closed) return; clearTimeout(this.debounce); this.debounce = setTimeout(() => { void this.reconcile() }, 2000); this.debounce.unref?.() }
  async save(value: SpotlightSettings) {
    this.guard()
    if (value?.enabled && !this.options.native?.available) throw new Error('macOS Spotlight indexing is unavailable in this build or system')
    this.options.store.save(value); this.generation++
    if (!value.enabled) { this.pendingId = undefined; this.options.store.clear() }
    return this.reconcile()
  }
  refresh() { this.guard(); return this.reconcile() }
  lockChanged() {
    if (this.closed) return
    this.generation++
    if (!this.options.locked() && this.pendingId) { const id = this.pendingId; this.pendingId = undefined; void this.open(id).catch(() => {}) }
    void this.reconcile()
  }
  private reconcile(): Promise<SpotlightStatus> {
    const generation = this.generation
    const action = async () => {
      if (this.closed) return this.status()
      this.syncing = true; this.publish()
      try {
        try { await this.purgeInactive() } catch (error) {
          // Failure in another profile must not prevent this profile's lock/disable cleanup.
          if (!this.current(generation)) await this.purge().catch(() => {})
          throw error
        }
        await (async () => {
          if (!this.options.native?.available) { await this.purge(); return }
          if (!this.current(generation)) { await this.purge(); this.error = undefined; return }
          const settings = this.options.store.settings()
          const accounts = await this.options.worker().request<MailAccountSummary[]>({ type: 'accounts:list' })
          if (!this.current(generation)) { await this.purge(); return }
          const accountIds = settings.accountIds.filter((id) => accounts.some((account) => account.id === id && !account.archived))
          const token = randomUUID(), items: { id: string; title: string; sender: string; preview?: string }[] = []
          let cursor: string | undefined
          const seen = new Set<string>()
          if (accountIds.length) do {
            const page: MailPage = await this.options.worker().request<MailPage>({ type: 'mail:list', payload: { accountIds, folder: 'all', pageSize: 200, ...(cursor ? { cursor } : {}) } })
            if (!this.current(generation)) { await this.purge(); return }
            for (const thread of page.items) {
              if (!accountIds.includes(thread.accountId) || thread.draft || thread.trashed || seen.has(`${thread.accountId}\0${thread.id}`)) continue
              seen.add(`${thread.accountId}\0${thread.id}`)
              items.push({ id: this.options.store.link(thread.accountId, thread.id, token), title: (thread.subject || '(No subject)').slice(0, 500), sender: thread.senderEmail.slice(0, 320), ...(settings.includePreview ? { preview: thread.snippet.slice(0, 500) } : {}) })
              if (items.length >= LIMIT) break
            }
            if (page.nextCursor && page.nextCursor === cursor) throw new Error('Mail pagination did not advance')
            cursor = page.nextCursor
          } while (cursor && items.length < LIMIT)
          if (!this.current(generation)) { await this.purge(); return }
          // Serial replacement removes deleted/moved-out-of-scope items, including when accountIds is empty.
          await this.purge()
          for (let offset = 0; offset < items.length; offset += 250) {
            if (!this.current(generation)) { await this.purge(); return }
            this.options.store.markCleanupPending(true)
            await this.options.native.perform('index', JSON.stringify({ domain: this.options.store.domain, items: items.slice(offset, offset + 250) }))
          }
          if (!this.current(generation)) { await this.purge(); return }
          this.options.store.prune(token); this.lastIndexed = new Date().toISOString(); this.error = undefined
        })()
      } catch { this.error = this.inactivePending.size ? 'Inactive profile Spotlight metadata could not be removed. Refresh to retry before using system search.' : 'Spotlight could not refresh its index. Previously indexed metadata may remain until a successful removal. Retry or check macOS Spotlight availability.' }
      finally { this.syncing = false; this.publish() }
      return this.status()
    }
    const next = this.queue.then(action, action); this.queue = next; return next
  }
  async open(id: string) {
    if (this.closed || !/^[\da-f-]{36}$/i.test(id) || !this.options.store.settings().enabled) return
    if (this.options.locked()) { this.pendingId = id; this.options.openMainWindow(); return }
    const link = this.options.store.resolve(id)
    if (!link || !this.options.store.settings().accountIds.includes(link.accountId)) return
    const accounts = await this.options.worker().request<MailAccountSummary[]>({ type: 'accounts:list' })
    if (!accounts.some((account) => account.id === link.accountId && !account.archived) || this.closed) return
    const thread = await this.options.worker().request<MailThreadDetail>({ type: 'mail:thread', payload: link })
    if (this.closed || this.options.locked() || !this.options.store.settings().enabled || !this.options.store.settings().accountIds.includes(link.accountId)) { if (this.options.locked()) this.pendingId = id; return }
    if (thread.accountId !== link.accountId || thread.id !== link.threadId || !thread.messages.length) return
    this.options.openMainWindow(); this.options.openMessage({ source: 'connected', accountId: link.accountId, threadId: link.threadId, title: thread.subject || 'Message' })
  }
  async close() { this.closed = true; this.generation++; clearInterval(this.timer); clearTimeout(this.debounce); this.pendingId = undefined; await this.queue.catch(() => {}); if (this.options.locked() || !this.options.store.settings().enabled) await this.purge().catch(() => {}); this.options.store.close() }
}
