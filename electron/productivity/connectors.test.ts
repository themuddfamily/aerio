import { describe, expect, it } from 'vitest'
import type { SyncedCalendar } from '../../src/productivity-types'
import { mapGoogleContact, mapGoogleEvent } from './google-connector'
import { mapMicrosoftContact, mapMicrosoftEvent } from './microsoft-connector'

const googleCalendar: SyncedCalendar = {
  id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#6558e8', primary: true, canWrite: true
}
const microsoftCalendar: SyncedCalendar = {
  id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Main', color: '#3b6fd8', primary: true, canWrite: true
}

describe('productivity connector mapping', () => {
  it('normalizes Google events and contacts into Aerio records', () => {
    expect(mapGoogleEvent('a', googleCalendar, {
      id: 'event-1', summary: 'Design review', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' },
      attendees: [{ email: 'person@example.com' }], recurrence: ['RRULE:FREQ=WEEKLY']
    })).toMatchObject({ title: 'Design review', recurrence: 'weekly', attendees: ['person@example.com'], provider: 'gmail' })
    expect(mapGoogleContact('a', {
      resourceName: 'people/1', names: [{ displayName: 'Grace Hopper' }], emailAddresses: [{ value: 'grace@example.com' }],
      organizations: [{ name: 'Navy', title: 'Rear admiral' }]
    })).toMatchObject({ name: 'Grace Hopper', email: 'grace@example.com', company: 'Navy', provider: 'gmail' })
  })

  it('normalizes Microsoft dates as UTC and keeps read-only event state', () => {
    expect(mapMicrosoftEvent('b', { ...microsoftCalendar, canWrite: false }, {
      id: 'event-2', subject: 'Roadmap', start: { dateTime: '2026-08-01T11:00:00.0000000' }, end: { dateTime: '2026-08-01T12:00:00.0000000' },
      attendees: [{ emailAddress: { address: 'team@example.com' } }]
    })).toMatchObject({ start: '2026-08-01T11:00:00.0000000Z', readOnly: true, provider: 'microsoft' })
    expect(mapMicrosoftContact('b', {
      id: 'contact-2', givenName: 'Katherine', surname: 'Johnson', emailAddresses: [{ address: 'kj@example.com' }]
    })).toMatchObject({ name: 'Katherine Johnson', email: 'kj@example.com', provider: 'microsoft' })
  })
})
