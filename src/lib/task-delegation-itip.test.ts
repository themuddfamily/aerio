import { describe, expect, it } from 'vitest'
import { parseTaskItip, taskItip, type TaskItip } from './task-delegation-itip'
const request: TaskItip = { method: 'REQUEST', uid: 'fixture@example.test', organizer: 'a@example.test', assignee: 'b@example.test', title: 'Review α report', notes: 'First line\nSecond, line; detail', sequence: 0, stamp: '20261020T120000Z', due: '2026-12-01', participation: 'NEEDS-ACTION', status: 'NEEDS-ACTION', percent: 0 }
describe('VTODO scheduling interoperability', () => {
  it('emits required request properties and roundtrips folded Unicode text', () => {
    const ics = taskItip(request)
    expect(ics).toContain('DTSTART;VALUE=DATE:20261020')
    expect(ics).toContain('PRIORITY:0')
    expect(parseTaskItip(ics)).toEqual(request)
  })
  it('accepts standard minimal progress/completed replies without SUMMARY or explicit SEQUENCE', () => {
    const minimal = (partstat: string, percent?: number) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VTODO\r\nUID:fixture@example.test\r\nDTSTAMP:20261020T130000Z\r\nORGANIZER:mailto:a@example.test\r\nATTENDEE;PARTSTAT=${partstat}:mailto:b@example.test\r\n${percent !== undefined ? `PERCENT-COMPLETE:${percent}\r\n` : ''}END:VTODO\r\nEND:VCALENDAR\r\n`
    expect(parseTaskItip(minimal('IN-PROCESS', 75))).toMatchObject({ participation: 'ACCEPTED', status: 'IN-PROCESS', percent: 75, sequence: 0 })
    expect(parseTaskItip(minimal('COMPLETED'))).toMatchObject({ participation: 'ACCEPTED', status: 'COMPLETED', percent: 100 })
    expect(taskItip({ ...request, method: 'REPLY', participation: 'ACCEPTED', status: 'COMPLETED', percent: 100 })).toContain('PARTSTAT=COMPLETED')
  })
  it('rejects ambiguous, malformed and unsupported recurring or multiple-assignee input', () => {
    const ics = taskItip(request)
    for (const addition of ['ATTENDEE:mailto:c@example.test', 'SEQUENCE:2', 'RRULE:FREQ=DAILY', 'DUE;VALUE=DATE:20261202']) expect(parseTaskItip(ics.replace('END:VTODO', `${addition}\r\nEND:VTODO`))).toBeUndefined()
    expect(parseTaskItip(ics.replace('20261201', '20260231'))).toBeUndefined()
    expect(parseTaskItip('BEGIN:VCALENDAR\nEND:VTODO')).toBeUndefined()
  })
})
