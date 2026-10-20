import { createHash } from 'node:crypto'
import type { MeetingHostAccount } from '../../src/meeting-host-types'
import type { SyncedCalendar } from '../../src/productivity-types'
import { hostedConferenceCapability } from '../../src/lib/online-meetings'
import { MeetingHostHttp, MeetingHostRequestError } from './meeting-host-http'
import type { HostedMeeting, OnlineMeetingConnector, OnlineMeetingRequest } from './online-meetings'

interface GoToMeeting { meetingid?: number | string; meetingId?: number | string; joinURL?: string; subject?: string }
const marker = (requestId: string) => `[aerio:${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}]`
const failure = (message: string) => new MeetingHostRequestError(message, undefined, true)
export function mapGoToMeeting(value: GoToMeeting): HostedMeeting {
  const rawId = value.meetingId ?? value.meetingid
  if ((typeof rawId !== 'string' && typeof rawId !== 'number') || typeof rawId === 'number' && !Number.isSafeInteger(rawId) || !/^\d{1,20}$/.test(String(rawId))) throw failure('GoToMeeting did not return a valid meeting identity')
  let url: URL
  try { url = new URL(value.joinURL ?? '') } catch { throw failure('GoToMeeting did not return its participant link') }
  if (url.protocol !== 'https:' || url.username || url.password || !['gotomeeting.com', 'goto.com'].some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) throw failure('GoToMeeting did not return a valid participant link')
  return { provider: 'goto', meetingId: String(rawId), meetingNumber: String(rawId), joinUrl: url.href }
}
/** Official GoTo Meeting v1 API. A short subject marker permits recovery after uncertain creation. */
export class GoToMeetingConnector implements OnlineMeetingConnector {
  readonly provider = 'goto' as const
  readonly requiredScopes: readonly string[] = [] // Product access is granted by the OAuth client's GoTo Meeting registration.
  constructor(private readonly http: MeetingHostHttp, private readonly account: () => MeetingHostAccount | undefined, private readonly now: () => number = Date.now) {}
  capability(calendar: SyncedCalendar) { return hostedConferenceCapability('goto', calendar, this.account()) }
  private schedule(request: OnlineMeetingRequest) {
    const start = Date.parse(request.start), end = Date.parse(request.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= this.now() || end <= start) throw new MeetingHostRequestError('GoToMeeting needs a future start and a later end time.', undefined, false)
    const suffix = ' ' + marker(request.requestId)
    let subject = ''
    for (const character of request.title.replace(/[\x00-\x1f\x7f]/g, ' ')) {
      const encoded = character === '<' ? '&lt;' : character === '>' ? '&gt;' : character === '&' ? '&amp;' : character
      if (subject.length + encoded.length + suffix.length > 100) break
      subject += encoded
    }
    return { subject: subject.trimEnd() + suffix, starttime: new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'), endtime: new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z'), passwordrequired: false, conferencecallinfo: 'VoIP', timezonekey: '', meetingtype: 'scheduled' }
  }
  async createMeeting(request: OnlineMeetingRequest): Promise<HostedMeeting> {
    const result = await this.http.request<GoToMeeting[]>('POST', this.http.url('/meetings'), this.schedule(request))
    if (!Array.isArray(result) || result.length !== 1) throw failure('GoToMeeting did not identify the newly created meeting')
    return mapGoToMeeting(result[0])
  }
  async findMeeting(request: OnlineMeetingRequest): Promise<HostedMeeting | undefined> {
    const list = await this.http.request<GoToMeeting[]>('GET', this.http.url('/upcomingMeetings'))
    if (!Array.isArray(list) || list.length > 10_000) throw failure('GoToMeeting returned an incomplete or invalid upcoming-meeting list; review the host account before retrying')
    const matches = list.filter((meeting) => typeof meeting?.subject === 'string' && meeting.subject.includes(marker(request.requestId)))
    if (matches.length > 1) throw failure('More than one GoToMeeting has this Aerio reference. Review them in GoToMeeting before retrying')
    if (!matches.length) return undefined
    const match = matches[0], id = match.meetingId ?? match.meetingid
    if ((typeof id !== 'number' && typeof id !== 'string') || !/^\d{1,20}$/.test(String(id))) throw failure('GoToMeeting returned an invalid recovered meeting identity')
    const detail = await this.http.request<GoToMeeting[]>('GET', this.http.url(`/meetings/${encodeURIComponent(String(id))}`))
    if (!Array.isArray(detail) || detail.length !== 1) throw failure('GoToMeeting could not confirm the recovered participant link')
    const recovered = mapGoToMeeting(detail[0])
    if (recovered.meetingId !== String(id)) throw failure('GoToMeeting returned a different recovered meeting identity')
    return recovered
  }
  async updateMeeting(meeting: HostedMeeting, request: OnlineMeetingRequest): Promise<HostedMeeting> {
    await this.http.request('PUT', this.http.url(`/meetings/${encodeURIComponent(meeting.meetingId)}`), this.schedule(request))
    return meeting
  }
  async deleteMeeting(meeting: HostedMeeting): Promise<void> { await this.http.request('DELETE', this.http.url(`/meetings/${encodeURIComponent(meeting.meetingId)}`), undefined, { allowNotFound: true }) }
}
