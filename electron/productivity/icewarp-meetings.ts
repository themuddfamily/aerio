import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { IceWarpMeetingAccount, IceWarpMeetingConnectInput } from '../../src/meeting-host-types'
import type { SyncedCalendar } from '../../src/productivity-types'
import { hostedConferenceCapability } from '../../src/lib/online-meetings'
import { assertSecureCredentialStorage } from '../mail/secure-storage'
import { IceWarpApi, IceWarpApiError, iceWarpServer, iceWarpText, type IceWarpObject } from '../icewarp-api'
import type { MeetingHostSecretStorage } from './meeting-host-vault'
import { MeetingHostRequestError } from './meeting-host-http'
import type { HostedMeeting, OnlineMeetingConnector, OnlineMeetingRequest } from './online-meetings'

interface Identity { server: string; user: string; userId: string; token: string }
interface Attempt { server: string; userId: string; meeting?: HostedMeeting; scheduled: boolean }
interface Stored { version: 1; identity?: Identity; attempts: Record<string, Attempt> }
const validRequest = (value: string) => /^[A-Za-z0-9_-]{8,200}$/.test(value)
const marker = (requestId: string) => `aerio-${requestId}`
const bindingId = (identity: Identity) => createHash('sha256').update(JSON.stringify([identity.server, identity.userId])).digest('hex')
const opaqueId = (identity: Identity, evnid: string) => `${bindingId(identity)}:${evnid}`
const unknown = (message: string) => new MeetingHostRequestError(message, undefined, true)

/** Credentials and provisioning journal share OS-encrypted storage; pending attempts survive restarts. */
export class IceWarpMeetingStore {
  private data: Stored = { version: 1, attempts: {} }
  private fault?: string
  private connectionEpoch = 0
  constructor(private readonly path: string, private readonly storage: MeetingHostSecretStorage, private readonly locked = () => false, readonly fetcher: typeof fetch = fetch) {
    if (existsSync(path)) {
      try { assertSecureCredentialStorage(storage); const saved = JSON.parse(storage.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64'))); if (saved.version !== 1 || !saved.attempts || typeof saved.attempts !== 'object' || Array.isArray(saved.attempts)) throw Error(); this.data = saved }
      catch { this.fault = 'The IceWarp meeting account or recovery journal cannot be decrypted. Restore its original profile before provisioning more conferences.' }
    }
  }
  private secure() { try { assertSecureCredentialStorage(this.storage); return true } catch { return false } }
  private save() {
    assertSecureCredentialStorage(this.storage)
    writeFileSync(this.path + '.partial', this.storage.encryptString(JSON.stringify(this.data)).toString('base64'), { mode: 0o600 })
    renameSync(this.path + '.partial', this.path)
  }
  status(): IceWarpMeetingAccount { return { provider: 'icewarp', configured: true, connected: Boolean(this.data.identity), secureStorage: this.secure(), ...(this.fault ? { error: this.fault } : {}), ...(this.data.identity ? { server: this.data.identity.server, email: this.data.identity.user } : {}) } }
  identity(): Identity { if (this.fault) throw new Error(this.fault); if (this.locked()) throw new Error('Unlock Aerio to manage IceWarp meetings'); assertSecureCredentialStorage(this.storage); if (!this.data.identity) throw new Error('Connect IceWarp in Settings › Online meetings'); return { ...this.data.identity } }
  async connect(input: IceWarpMeetingConnectInput) {
    const epoch = ++this.connectionEpoch
    if (this.fault) throw new Error(this.fault)
    if (!input || typeof input.server !== 'string' || typeof input.token !== 'string' || !input.token.trim()) throw new Error('Enter the IceWarp server and a TeamChat API token')
    if (this.locked()) throw new Error('Unlock Aerio to connect IceWarp')
    assertSecureCredentialStorage(this.storage)
    const server = iceWarpServer(input.server), token = input.token.trim()
    const result = await new IceWarpApi(server, token, this.fetcher).request('auth.test')
    if (epoch !== this.connectionEpoch) throw new Error('This IceWarp connection request was superseded or disconnected')
    if (typeof result.user !== 'string' || !result.user || typeof result.user_id !== 'string' || !/^[\w.-]{1,200}$/.test(result.user_id)) throw new Error('IceWarp did not identify the connected user')
    if (this.locked()) throw new Error('Unlock Aerio to connect IceWarp')
    this.data.identity = { server, token, user: iceWarpText(result.user, 320), userId: result.user_id }; this.save()
    return this.status()
  }
  disconnect() {
    ++this.connectionEpoch
    if (this.fault) throw new Error(this.fault)
    if (this.locked()) throw new Error('Unlock Aerio to disconnect IceWarp')
    assertSecureCredentialStorage(this.storage)
    delete this.data.identity; this.save()
  }
  attempt(requestId: string) { const value = Object.hasOwn(this.data.attempts, requestId) ? this.data.attempts[requestId] : undefined; return value ? structuredClone(value) : undefined }
  remember(requestId: string, value: Attempt) {
    if (!validRequest(requestId)) throw new Error('Invalid IceWarp meeting request')
    if (!Object.hasOwn(this.data.attempts, requestId) && Object.keys(this.data.attempts).length >= 2000) throw new Error('The IceWarp provisioning journal is full. Review existing meetings before provisioning more.')
    Object.defineProperty(this.data.attempts, requestId, { value: structuredClone(value), configurable: true, writable: true, enumerable: true }); this.save()
  }
}

const escapeIcs = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
const utc = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
/** Preserve IceWarp's server-generated UID/meeting linkage; never add conference attendees or join it. */
export function rescheduleIceWarpVcalendar(value: unknown, request: OnlineMeetingRequest): string {
  if (typeof value !== 'string' || value.length > 200_000 || !validRequest(request.requestId) || !Number.isFinite(Date.parse(request.start)) || !Number.isFinite(Date.parse(request.end)) || Date.parse(request.end) <= Date.parse(request.start)) throw new Error('IceWarp returned an invalid conference calendar or schedule')
  const lines = value.replace(/\r\n[ \t]|\n[ \t]/g, '').split(/\r?\n/)
  if (lines.filter((line) => line === 'BEGIN:VEVENT').length !== 1 || !lines.includes('END:VEVENT') || !lines.some((line) => line.startsWith('X-ICEWARP-MEETING:')) || !lines.some((line) => line.startsWith('UID:')) || lines.some((line) => /^(?:ATTENDEE|RRULE|RDATE|EXDATE)(?:[:;])/.test(line))) throw new Error('IceWarp returned a conference with unsupported attendees, recurrence or linkage. Review it in IceWarp.')
  let inside = false; const output: string[] = []
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') inside = true
    if (inside && /^(?:SUMMARY|DTSTART|DTEND|DTSTAMP|LAST-MODIFIED|SEQUENCE)(?:[:;])/.test(line)) continue
    if (line === 'END:VEVENT') {
      output.push(`SUMMARY:${escapeIcs(iceWarpText(request.title, 200))}`, `DTSTART:${utc(request.start)}`, `DTEND:${utc(request.end)}`, `DTSTAMP:${utc(new Date().toISOString())}`, `LAST-MODIFIED:${utc(new Date().toISOString())}`, `SEQUENCE:${Math.min(1_000_000, Number(lines.find((item) => /^SEQUENCE:/.test(item))?.slice(9)) || 0) + 1}`, `X-AERIO-REQUEST:${marker(request.requestId)}`)
      inside = false
    }
    if (!/^X-AERIO-REQUEST:/.test(line)) output.push(line)
  }
  return output.join('\r\n').replace(/\r\n*$/, '') + '\r\n'
}

export class IceWarpMeetingConnector implements OnlineMeetingConnector {
  readonly provider = 'icewarp' as const
  readonly requiredScopes: readonly string[] = []
  constructor(private readonly store: IceWarpMeetingStore) {}
  capability(calendar: SyncedCalendar) { return hostedConferenceCapability('icewarp', calendar, this.store.status()) }
  private assertIdentity(expected: Identity, mutation = false) {
    try {
      const current = this.store.identity()
      if (current.server !== expected.server || current.userId !== expected.userId || current.user !== expected.user || current.token !== expected.token) throw Error()
    } catch { throw new MeetingHostRequestError('The IceWarp account changed or was locked during this operation. Reconnect the original account and review its conference before continuing.', undefined, mutation) }
  }
  private async api(identity: Identity, method: string, parameters: Record<string, unknown> = {}, mutation = false) {
    this.assertIdentity(identity)
    try {
      const result = await new IceWarpApi(identity.server, identity.token, this.store.fetcher).request(method, parameters, mutation)
      this.assertIdentity(identity, mutation)
      return result
    }
    catch (error) { if (error instanceof IceWarpApiError) throw new MeetingHostRequestError(error.message, undefined, error.kind === 'uncertain'); throw error }
  }
  private evnid(identity: Identity, meeting: HostedMeeting) {
    try { const [binding, id, extra] = meeting.meetingId.split(':'); if (binding !== bindingId(identity) || extra !== undefined || !/^[\w.-]{1,200}$/.test(id)) throw Error(); return id }
    catch { throw new Error('This IceWarp conference belongs to another server or user. Reconnect its original account.') }
  }
  private map(identity: Identity, value: IceWarpObject): HostedMeeting {
    let link: URL
    try { link = new URL(value.meeting_url); if (link.protocol !== 'https:' || link.username || link.password || link.search || link.hash) throw Error() } catch { throw unknown('IceWarp did not return a safe public conference link. Review the provisioned conference before retrying.') }
    if (typeof value.evnid !== 'string' || !/^[\w.-]{1,200}$/.test(value.evnid)) throw unknown('IceWarp did not return the conference event identifier. Review it before retrying.')
    return { provider: 'icewarp', meetingId: opaqueId(identity, value.evnid), joinUrl: link.href, ...(typeof value.meeting_id === 'string' ? { meetingNumber: iceWarpText(value.meeting_id, 200) } : {}) }
  }
  private validate(request: OnlineMeetingRequest) { if (!validRequest(request.requestId) || !request.title.trim() || request.title.length > 2000 || !Number.isFinite(Date.parse(request.start)) || !Number.isFinite(Date.parse(request.end)) || Date.parse(request.end) <= Date.parse(request.start)) throw new Error('Choose a valid IceWarp conference title, start and end') }
  private binding(identity: Identity, attempt: Attempt) { if (attempt.server !== identity.server || attempt.userId !== identity.userId) throw new Error('This IceWarp request belongs to another server or user') }
  async createMeeting(request: OnlineMeetingRequest): Promise<HostedMeeting> {
    this.validate(request)
    const identity = this.store.identity()
    const existing = this.store.attempt(request.requestId)
    if (existing) { const found = await this.findWithIdentity(identity, request); this.assertIdentity(identity); if (found) return found; throw unknown('Review this previous IceWarp provisioning attempt before trying another.') }
    this.store.remember(request.requestId, { server: identity.server, userId: identity.userId, scheduled: false })
    const result = await this.api(identity, 'conferences.meetNow', { name: `${request.title.slice(0, 100)} [${marker(request.requestId)}]`, autorecording: false, autolobby: true }, true)
    this.assertIdentity(identity, true)
    const meeting = this.map(identity, result.conference ?? {})
    this.store.remember(request.requestId, { server: identity.server, userId: identity.userId, meeting, scheduled: false })
    try { const scheduled = await this.updateWithIdentity(identity, meeting, request); this.assertIdentity(identity, true); return scheduled }
    catch { throw unknown('IceWarp provisioned the conference but did not confirm its requested schedule. It was retained for recovery; review it in IceWarp or save again. No calendar invitation was saved.') }
  }
  async findMeeting(request: OnlineMeetingRequest): Promise<HostedMeeting | undefined> {
    this.validate(request)
    return this.findWithIdentity(this.store.identity(), request)
  }
  private async findWithIdentity(identity: Identity, request: OnlineMeetingRequest): Promise<HostedMeeting | undefined> {
    this.assertIdentity(identity)
    const attempt = this.store.attempt(request.requestId)
    if (attempt) { this.binding(identity, attempt); if (attempt.meeting) return this.updateWithIdentity(identity, attempt.meeting, request) }
    // Lookup is bounded and non-authoritative when absent: an existing pending attempt is never replayed.
    const matches: IceWarpObject[] = []
    for (const type of [1, 0]) {
      for (let page = 1; page <= (type === 0 ? 10 : 1); page++) {
        const result = await this.api(identity, 'conferences.list', { type: String(type), count: 100, page, ...(type === 1 ? { days_future: Math.max(92, Math.ceil((Date.parse(request.end) - Date.now()) / 86_400_000) + 1) } : {}) })
        this.assertIdentity(identity)
        if (!Array.isArray(result.conferences) || result.conferences.length > 2000) throw new Error('IceWarp returned an invalid conference list')
        matches.push(...result.conferences.filter((item: IceWarpObject) => typeof item?.title === 'string' && item.title.includes(`[${marker(request.requestId)}]`) && Array.isArray(item.organizer_parsed) && item.organizer_parsed.some((organizer: IceWarpObject) => organizer.email?.toLowerCase() === identity.user.toLowerCase())))
        if (type === 1 || result.conferences.length < 100) break
      }
    }
    const unique = [...new Map(matches.map((item) => [item.evnid, item])).values()]
    if (unique.length > 1) throw unknown('Several IceWarp conferences match this request. Review them before continuing.')
    if (unique.length === 1) { this.assertIdentity(identity); const meeting = this.map(identity, unique[0]); this.store.remember(request.requestId, { server: identity.server, userId: identity.userId, meeting, scheduled: false }); return this.updateWithIdentity(identity, meeting, request) }
    if (attempt) throw unknown('The previous IceWarp creation is still unconfirmed. Review conferences on the original server; Aerio will not create a duplicate automatically.')
    return undefined
  }
  async updateMeeting(meeting: HostedMeeting, request: OnlineMeetingRequest): Promise<HostedMeeting> {
    this.validate(request)
    return this.updateWithIdentity(this.store.identity(), meeting, request)
  }
  private async updateWithIdentity(identity: Identity, meeting: HostedMeeting, request: OnlineMeetingRequest): Promise<HostedMeeting> {
    this.assertIdentity(identity)
    const evnid = this.evnid(identity, meeting)
    const result = await this.api(identity, 'events.get', { evnid })
    this.assertIdentity(identity)
    const item = rescheduleIceWarpVcalendar(result.vcalendar, request)
    await this.api(identity, 'events.add', { evnid, item }, true)
    this.assertIdentity(identity, true)
    this.store.remember(request.requestId, { server: identity.server, userId: identity.userId, meeting, scheduled: true })
    return meeting
  }
  async deleteMeeting(meeting: HostedMeeting) { const identity = this.store.identity(); await this.api(identity, 'events.delete', { evnid: this.evnid(identity, meeting) }, true); this.assertIdentity(identity, true) }
}
