import type { SyncedCalendar } from '../../src/productivity-types'
import type { MeetingHostAccount } from '../../src/meeting-host-types'
import { hostedConferenceCapability } from '../../src/lib/online-meetings'
import { MeetingHostHttp, MeetingHostRequestError } from './meeting-host-http'
import { WEBEX_SCOPES, ZOOM_SCOPES } from './meeting-host-providers'
import type { HostedMeeting, OnlineMeetingConnector, OnlineMeetingRequest } from './online-meetings'

// Zoom (REST v2) and Webex (Meetings API) connectors (E47). Each meeting's agenda carries the creation
// request id, which is what findMeeting matches after an uncertain outcome.

export const requestMarker = (requestId: string) => `aerio-${requestId}`
export const meetingAgenda = (requestId: string) => `Scheduled from Aerio (reference ${requestMarker(requestId)})`

const minutesBetween = (start: string, end: string) => Math.max(1, Math.ceil((Date.parse(end) - Date.parse(start)) / 60_000))
const utcSeconds = (value: string) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function formatMeetingNumber(value: string | number | undefined) {
  if (value === undefined) return undefined
  const digits = String(value).replace(/\s+/g, '')
  if (!/^\d+$/.test(digits)) return String(value)
  if (digits.length === 11) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
  return digits
}

const requireLink = (label: string, id: unknown, joinUrl: unknown) => {
  // A success without these cannot be used, and the meeting may still exist: look it up before creating again.
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof joinUrl !== 'string' || !joinUrl.startsWith('https://')) {
    throw new MeetingHostRequestError(`${label} did not return the meeting’s join link`, undefined, true)
  }
  return { meetingId: String(id), joinUrl }
}

// --- Zoom ---

interface ZoomMeeting {
  id?: number | string
  topic?: string
  agenda?: string
  join_url?: string
  password?: string
  pstn_password?: string
  settings?: { global_dial_in_numbers?: { country_name?: string; city?: string; number?: string }[] }
}

export function mapZoomMeeting(meeting: ZoomMeeting): HostedMeeting {
  const { meetingId, joinUrl } = requireLink('Zoom', meeting.id, meeting.join_url)
  const dialIn = (meeting.settings?.global_dial_in_numbers ?? []).filter((item) => item.number).slice(0, 3)
    .map((item) => ({ number: item.number!, ...(item.country_name ? { label: item.city ? `${item.country_name} (${item.city})` : item.country_name } : {}) }))
  const meetingNumber = formatMeetingNumber(meetingId)
  return {
    provider: 'zoom', meetingId, joinUrl,
    ...(meetingNumber ? { meetingNumber } : {}),
    ...(meeting.password ? { passcode: meeting.password } : {}),
    ...(meeting.pstn_password && meeting.pstn_password !== meeting.password ? { phonePasscode: meeting.pstn_password } : {}),
    ...(dialIn.length ? { dialIn } : {})
  }
}

export class ZoomMeetingConnector implements OnlineMeetingConnector {
  readonly provider = 'zoom' as const
  readonly requiredScopes = ZOOM_SCOPES

  constructor(private readonly http: MeetingHostHttp, private readonly account: () => MeetingHostAccount | undefined) {}

  capability(calendar: SyncedCalendar) {
    return hostedConferenceCapability('zoom', calendar, this.account())
  }

  private schedule(request: OnlineMeetingRequest) {
    return {
      topic: request.title.slice(0, 200),
      start_time: utcSeconds(request.start),
      duration: minutesBetween(request.start, request.end),
      ...(request.timeZone ? { timezone: request.timeZone } : {})
    }
  }

  async createMeeting(request: OnlineMeetingRequest) {
    // type 2: a scheduled meeting at a fixed time.
    const created = await this.http.request<ZoomMeeting>('POST', this.http.url('/users/me/meetings'), { ...this.schedule(request), type: 2, agenda: meetingAgenda(request.requestId) })
    return mapZoomMeeting(created ?? {})
  }

  async findMeeting(request: OnlineMeetingRequest) {
    const marker = requestMarker(request.requestId)
    let pageToken: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const list = await this.http.request<{ meetings?: ZoomMeeting[]; next_page_token?: string }>('GET', this.http.url('/users/me/meetings', { type: 'scheduled', page_size: 300, next_page_token: pageToken }))
      const match = list?.meetings?.find((item) => item.agenda?.includes(marker))
      if (match?.id !== undefined) {
        // The list omits passcodes and dial-in numbers.
        const full = await this.http.request<ZoomMeeting>('GET', this.http.url(`/meetings/${encodeURIComponent(String(match.id))}`), undefined, { allowNotFound: true })
        return full ? mapZoomMeeting(full) : undefined
      }
      pageToken = list?.next_page_token || undefined
      if (!pageToken) return undefined
    }
    return undefined
  }

  async updateMeeting(meeting: HostedMeeting, request: OnlineMeetingRequest) {
    await this.http.request<void>('PATCH', this.http.url(`/meetings/${encodeURIComponent(meeting.meetingId)}`), this.schedule(request))
    return meeting
  }

  async deleteMeeting(meeting: HostedMeeting) {
    await this.http.request<void>('DELETE', this.http.url(`/meetings/${encodeURIComponent(meeting.meetingId)}`), undefined, { allowNotFound: true })
  }
}

// --- Webex ---

interface WebexMeeting {
  id?: string
  meetingNumber?: string
  title?: string
  agenda?: string
  password?: string
  phoneAndVideoSystemPassword?: string
  webLink?: string
  sipAddress?: string
  telephony?: { accessCode?: string; callInNumbers?: { label?: string; callInNumber?: string }[] }
}

export function mapWebexMeeting(meeting: WebexMeeting): HostedMeeting {
  const { meetingId, joinUrl } = requireLink('Webex', meeting.id, meeting.webLink)
  const dialIn = (meeting.telephony?.callInNumbers ?? []).filter((item) => item.callInNumber).slice(0, 3)
    .map((item) => ({ number: item.callInNumber!, ...(item.label ? { label: item.label } : {}) }))
  const meetingNumber = formatMeetingNumber(meeting.meetingNumber)
  return {
    provider: 'webex', meetingId, joinUrl,
    ...(meetingNumber ? { meetingNumber } : {}),
    ...(meeting.password ? { passcode: meeting.password } : {}),
    ...(meeting.phoneAndVideoSystemPassword ? { phonePasscode: meeting.phoneAndVideoSystemPassword } : {}),
    ...(meeting.sipAddress ? { sipAddress: meeting.sipAddress } : {}),
    ...(dialIn.length ? { dialIn } : {})
  }
}

export class WebexMeetingConnector implements OnlineMeetingConnector {
  readonly provider = 'webex' as const
  readonly requiredScopes = WEBEX_SCOPES

  constructor(private readonly http: MeetingHostHttp, private readonly account: () => MeetingHostAccount | undefined) {}

  capability(calendar: SyncedCalendar) {
    return hostedConferenceCapability('webex', calendar, this.account())
  }

  private schedule(request: OnlineMeetingRequest) {
    return {
      title: request.title.slice(0, 128),
      agenda: meetingAgenda(request.requestId),
      start: utcSeconds(request.start),
      end: utcSeconds(request.end),
      ...(request.timeZone ? { timezone: request.timeZone } : {})
    }
  }

  async createMeeting(request: OnlineMeetingRequest) {
    const created = await this.http.request<WebexMeeting>('POST', this.http.url('/meetings'), this.schedule(request))
    return mapWebexMeeting(created ?? {})
  }

  async findMeeting(request: OnlineMeetingRequest) {
    const marker = requestMarker(request.requestId)
    const day = 24 * 60 * 60_000
    const list = await this.http.request<{ items?: WebexMeeting[] }>('GET', this.http.url('/meetings', {
      from: utcSeconds(new Date(Date.parse(request.start) - day).toISOString()),
      to: utcSeconds(new Date(Date.parse(request.end) + day).toISOString()),
      max: 100
    }))
    const match = list?.items?.find((item) => item.agenda?.includes(marker))
    return match ? mapWebexMeeting(match) : undefined
  }

  async updateMeeting(meeting: HostedMeeting, request: OnlineMeetingRequest) {
    const url = this.http.url(`/meetings/${encodeURIComponent(meeting.meetingId)}`)
    // PUT replaces the schedule and requires the meeting password.
    const password = meeting.passcode ?? (await this.http.request<WebexMeeting>('GET', url))?.password
    const updated = await this.http.request<WebexMeeting>('PUT', url, { ...this.schedule(request), ...(password ? { password } : {}) })
    return updated?.id ? mapWebexMeeting(updated) : meeting
  }

  async deleteMeeting(meeting: HostedMeeting) {
    await this.http.request<void>('DELETE', this.http.url(`/meetings/${encodeURIComponent(meeting.meetingId)}`), undefined, { allowNotFound: true })
  }
}
