import { describe, expect, it } from 'vitest'
import { formatMailArrival, formatMailArrivalTooltip, formatMailDateHeading, formatMailListTime, mailDateGroupKey } from './mail-date'

describe('mail arrival timestamps', () => {
  const arrival = new Date(2026, 7, 7, 12, 1, 9)

  it('shows the short weekday and omits seconds in the visible label', () => {
    expect(formatMailArrival(arrival)).toBe('Fri 07/08/2026 12:01')
  })

  it('keeps seconds in the hover label', () => {
    expect(formatMailArrivalTooltip(arrival)).toBe('Friday 07/08/2026 12:01:09')
  })

  it('groups mail by local calendar date and shows only the arrival time on rows', () => {
    expect(mailDateGroupKey(arrival)).toBe('2026-08-07')
    expect(formatMailDateHeading(arrival, new Date(2026, 7, 9))).toBe('7th August')
    expect(formatMailListTime(arrival)).toBe('12:01')
  })

  it('uses friendly headings for today and yesterday', () => {
    expect(formatMailDateHeading(arrival, new Date(2026, 7, 7, 18))).toBe('Today')
    expect(formatMailDateHeading(arrival, new Date(2026, 7, 8, 9))).toBe('Yesterday')
  })

  it('includes the year on headings outside the current year', () => {
    expect(formatMailDateHeading(arrival, new Date(2027, 0, 1))).toBe('7th August 2026')
  })
})
