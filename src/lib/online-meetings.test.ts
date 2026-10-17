import { describe, expect, it } from 'vitest'
import { checkJoinLink, conferenceCapabilities, conferenceWrite, newConferenceRequestId, requestConference, validEventConference } from './online-meetings'

describe('online meeting join links', () => {
  it('trusts only https links on known meeting hosts', () => {
    expect(checkJoinLink('https://meet.google.com/abc-defg-hij')).toEqual({ kind: 'trusted', url: 'https://meet.google.com/abc-defg-hij' })
    expect(checkJoinLink('https://teams.microsoft.com/l/meetup-join/19%3a')).toMatchObject({ kind: 'trusted' })
    expect(checkJoinLink('https://teams.live.com/meet/123')).toMatchObject({ kind: 'trusted' })
    expect(checkJoinLink('https://us02web.zoom.us/j/123')).toEqual({ kind: 'trusted', url: 'https://us02web.zoom.us/j/123' })
    expect(checkJoinLink('https://acme.webex.com/acme/j.php?MTID=m1')).toMatchObject({ kind: 'trusted' })
    expect(checkJoinLink('https://zoom.us.evil.example/j/1')).toMatchObject({ kind: 'untrusted', host: 'zoom.us.evil.example' })
    expect(checkJoinLink('https://meet.example.org/room')).toEqual({ kind: 'untrusted', url: 'https://meet.example.org/room', host: 'meet.example.org' })
    expect(checkJoinLink('https://meet.google.com.evil.example/x')).toMatchObject({ kind: 'untrusted', host: 'meet.google.com.evil.example' })
    expect(checkJoinLink('http://meet.google.com/abc')).toEqual({ kind: 'invalid' })
    expect(checkJoinLink('https://user:pw@meet.google.com/abc')).toEqual({ kind: 'invalid' })
    expect(checkJoinLink('javascript:alert(1)')).toEqual({ kind: 'invalid' })
    expect(checkJoinLink(undefined)).toEqual({ kind: 'invalid' })
  })
})

describe('conference write rules', () => {
  const pending = { provider: 'googleMeet' as const, status: 'pending' as const, requestId: 'req-12345678' }
  const ready = { provider: 'googleMeet' as const, status: 'ready' as const, joinUrl: 'https://meet.google.com/abc' }

  it('keeps existing conference details unless removal is explicit', () => {
    expect(conferenceWrite({}, ready)).toEqual({ kind: 'keep' })
    expect(conferenceWrite({ conference: ready }, ready)).toEqual({ kind: 'keep' })
    expect(conferenceWrite({ conference: { ...ready, status: 'removed' } }, ready)).toEqual({ kind: 'remove' })
    expect(conferenceWrite({ conference: { ...ready, status: 'removed' } })).toEqual({ kind: 'keep' })
  })

  it('creates only when the provider has no conference yet, reusing the request id', () => {
    expect(conferenceWrite({ conference: pending })).toEqual({ kind: 'create', provider: 'googleMeet', requestId: 'req-12345678' })
    expect(conferenceWrite({ conference: pending }, ready)).toEqual({ kind: 'keep' })
    // Our own unconfirmed request is resent under the same id; a provider-side pending meeting is left alone.
    expect(conferenceWrite({ conference: pending }, pending)).toEqual({ kind: 'create', provider: 'googleMeet', requestId: 'req-12345678' })
    expect(conferenceWrite({ conference: pending }, { provider: 'teams', status: 'pending' })).toEqual({ kind: 'keep' })
    expect(conferenceWrite({ conference: pending }, { ...ready, status: 'failed' })).toMatchObject({ kind: 'create' })
    expect(conferenceWrite({ conference: { provider: 'googleMeet', status: 'pending' } })).toEqual({ kind: 'keep' })
  })

  it('generates hex request ids and keeps one across re-adding', () => {
    expect(newConferenceRequestId()).toMatch(/^[0-9a-f]{32}$/)
    const first = requestConference('googleMeet')
    expect(requestConference('googleMeet', first).requestId).toBe(first.requestId)
    expect(requestConference('teams', first).requestId).not.toBe(first.requestId)
  })
})

describe('conference capability reporting', () => {
  const google = (allowed: string[], canWrite = true) => ({ provider: 'gmail', canWrite, conferences: { allowed, creatable: allowed.includes('hangoutsMeet') && canWrite ? ['googleMeet' as const] : [], canRemove: true } })
  const microsoft = (allowed: string[]) => ({ provider: 'microsoft', canWrite: true, conferences: { allowed, creatable: allowed.includes('teamsForBusiness') ? ['teams' as const] : [], canRemove: false } })

  it('reports Google Meet for Workspace and consumer calendars that allow it', () => {
    expect(conferenceCapabilities(google(['hangoutsMeet']))[0]).toEqual({ provider: 'googleMeet', label: 'Google Meet', available: true })
    expect(conferenceCapabilities(google([]))[0]).toMatchObject({ available: false, reason: expect.stringContaining('administrator') })
    expect(conferenceCapabilities(google(['hangoutsMeet'], false))[0]).toMatchObject({ available: false, reason: expect.stringContaining('Reconnect') })
  })

  it('reports Teams only for work or school calendars', () => {
    expect(conferenceCapabilities(microsoft(['teamsForBusiness']))[0]).toMatchObject({ provider: 'teams', available: true })
    expect(conferenceCapabilities(microsoft(['skypeForConsumer']))[0]).toMatchObject({ available: false, reason: expect.stringContaining('Personal Microsoft accounts') })
    expect(conferenceCapabilities(microsoft([]))[0]).toMatchObject({ available: false, reason: 'This Microsoft calendar does not offer Teams meetings' })
    expect(conferenceCapabilities({ provider: 'microsoft', canWrite: true })[0]).toMatchObject({ available: false, reason: expect.stringContaining('Synchronize') })
  })

  it('lists Zoom and Webex as unavailable until their accounts are connected', () => {
    const [, zoom, webex] = conferenceCapabilities(google(['hangoutsMeet']))
    expect(zoom).toMatchObject({ provider: 'zoom', available: false, reason: 'Connect Zoom in Settings › Online meetings' })
    expect(webex).toMatchObject({ provider: 'webex', available: false })
    expect(conferenceCapabilities({ provider: 'local' })).toEqual([expect.objectContaining({ provider: 'other', available: false })])
  })

  it('offers connected Zoom and Webex accounts on Google and Microsoft calendars and explains the rest', () => {
    const host = (provider: 'zoom' | 'webex', extra = {}) => ({ provider, configured: true, connected: true, redirectUri: '', scopes: [], ...extra })
    const [, zoom, webex] = conferenceCapabilities(microsoft([]), [host('zoom'), host('webex', { needsReconnect: true })])
    expect(zoom).toEqual({ provider: 'zoom', label: 'Zoom', available: true })
    expect(webex).toMatchObject({ available: false, reason: 'Webex access was revoked or expired; reconnect Webex in Settings › Online meetings' })
    expect(conferenceCapabilities(google(['hangoutsMeet']), [host('zoom', { configured: false, connected: false })])[1].reason).toMatch(/no Zoom app registration/)
    expect(conferenceCapabilities(google(['hangoutsMeet'], false), [host('zoom')])[1]).toMatchObject({ available: false, reason: expect.stringContaining('Reconnect this Google account') })
  })
})

describe('conference validation', () => {
  it('accepts well-formed conference values and rejects malformed ones', () => {
    expect(validEventConference(undefined)).toBe(true)
    expect(validEventConference({ provider: 'googleMeet', status: 'pending', requestId: 'abcdef0123456789' })).toBe(true)
    expect(validEventConference({ provider: 'teams', status: 'ready', joinUrl: 'https://teams.microsoft.com/l/x', phone: '+1 555' })).toBe(true)
    expect(validEventConference({ provider: 'skypeish', status: 'ready' })).toBe(false)
    expect(validEventConference({ provider: 'teams', status: 'done' })).toBe(false)
    expect(validEventConference({ provider: 'teams', status: 'pending', requestId: 'bad id with spaces' })).toBe(false)
    expect(validEventConference({ provider: 'teams', status: 'ready', joinUrl: 'x'.repeat(5_000) })).toBe(false)
    expect(validEventConference([])).toBe(false)
  })
})
