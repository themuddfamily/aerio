import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OFFLINE_POLICY,
  combineWanted,
  describeWindow,
  earliestStart,
  folderViewLocation,
  gmailAfterQuery,
  isDefaultScope,
  messageLocations,
  normalizeOverride,
  normalizePolicy,
  normalizeWindow,
  resolveLocationPolicy,
  scaledWindow,
  startForLocations,
  stateSatisfies,
  strongestMode,
  uniformPolicy,
  wantedContent,
  windowStart,
  type OfflinePolicyContext
} from './offline-sync'

const now = new Date('2026-10-17T12:00:00.000Z')
const context = (overrides: Partial<OfflinePolicyContext> = {}): OfflinePolicyContext => ({ defaults: DEFAULT_OFFLINE_POLICY, overrides: [], extensions: [], now, ...overrides })
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

describe('offline sync policy', () => {
  it('validates policies, windows and overrides', () => {
    expect(normalizePolicy({ downloadMode: 'headers', window: { unit: 'days', amount: 30 } })).toEqual({ downloadMode: 'headers', window: { unit: 'days', amount: 30 } })
    expect(normalizeWindow({ unit: 'all', amount: 9 })).toEqual({ unit: 'all', amount: 0 })
    expect(() => normalizePolicy({ downloadMode: 'everything', window: { unit: 'all' } })).toThrow('Choose what to download')
    expect(() => normalizeWindow({ unit: 'days', amount: 0 })).toThrow('Enter between 1 and 3650 days')
    expect(() => normalizeWindow({ unit: 'months', amount: 2.5 })).toThrow('Enter between 1 and 120 months')
    expect(() => normalizeWindow({ unit: 'weeks', amount: 2 })).toThrow('Choose how much mail')
    expect(() => normalizeOverride({})).toThrow('Choose a download mode or date window')
    expect(normalizeOverride({ window: { unit: 'months', amount: 3 } })).toEqual({ window: { unit: 'months', amount: 3 } })
  })

  it('computes window starts, Load more steps and descriptions', () => {
    expect(windowStart({ unit: 'all', amount: 0 }, now)).toBeUndefined()
    expect(windowStart({ unit: 'days', amount: 30 }, now)?.toISOString()).toBe(daysAgo(30))
    expect(windowStart({ unit: 'months', amount: 2 }, now)?.toISOString()).toBe('2026-08-17T12:00:00.000Z')
    expect(scaledWindow({ unit: 'days', amount: 30 }, 2)).toEqual({ unit: 'days', amount: 90 })
    expect(scaledWindow({ unit: 'months', amount: 60 }, 1)).toEqual({ unit: 'all', amount: 0 })
    expect(describeWindow({ unit: 'months', amount: 24 })).toBe('Last 2 years')
    expect(describeWindow({ unit: 'days', amount: 1 })).toBe('Last day')
    expect(gmailAfterQuery(new Date('2026-01-01T00:00:00Z'))).toBe('after:1767225600')
    expect(gmailAfterQuery(undefined)).toBeUndefined()
  })

  it('maps folder views and labels to policy locations', () => {
    expect(folderViewLocation('inbox')).toBe('INBOX')
    expect(folderViewLocation('drafts')).toBe('DRAFT')
    expect(folderViewLocation('all')).toBe('')
    expect(folderViewLocation('inbox', 'Label_7')).toBe('Label_7')
    expect(messageLocations(['INBOX', 'UNREAD', 'STARRED', 'keyword:$Work', 'Label_1'])).toEqual(['INBOX', 'Label_1'])
    expect(messageLocations(['UNREAD'])).toEqual([''])
  })

  it('resolves overrides, Load more and Load all for a location', () => {
    const value = context({
      defaults: { downloadMode: 'headers', window: { unit: 'days', amount: 30 } },
      overrides: [{ labelId: 'INBOX', downloadMode: 'full' }],
      extensions: [{ labelId: 'INBOX', extraSteps: 1 }, { labelId: 'Label_1', extraSteps: 0, loadAllUntil: '2026-10-18T00:00:00.000Z' }, { labelId: 'Label_2', extraSteps: 0, loadAllUntil: '2026-10-01T00:00:00.000Z' }]
    })
    expect(resolveLocationPolicy(value, 'INBOX')).toMatchObject({ policy: { downloadMode: 'full', window: { unit: 'days', amount: 60 } }, extraSteps: 1 })
    expect(resolveLocationPolicy(value, 'Label_1')).toMatchObject({ policy: { downloadMode: 'headers', window: { unit: 'all' } }, start: undefined, loadAllUntil: '2026-10-18T00:00:00.000Z' })
    // An expired Load all no longer widens the window.
    expect(resolveLocationPolicy(value, 'Label_2').policy.window).toEqual({ unit: 'days', amount: 30 })
    expect(earliestStart(value)).toBeUndefined()
    expect(startForLocations(value, ['INBOX'])?.toISOString()).toBe(daysAgo(60))
    expect(startForLocations(value, ['INBOX', 'Label_1'])).toBeUndefined()
  })

  it('keeps the most complete content any location of a shared message wants', () => {
    const value = context({
      defaults: { downloadMode: 'headers', window: { unit: 'days', amount: 7 } },
      overrides: [{ labelId: 'Label_projects', downloadMode: 'full', window: { unit: 'all', amount: 0 } }, { labelId: 'SPAM', window: { unit: 'days', amount: 1 } }]
    })
    expect(wantedContent(value, daysAgo(3), ['INBOX'])).toBe('headers')
    expect(wantedContent(value, daysAgo(30), ['INBOX'])).toBe('outside')
    // Filed under a label that keeps everything in full, the Inbox copy is kept in full too.
    expect(wantedContent(value, daysAgo(30), ['INBOX', 'Label_projects'])).toBe('full')
    expect(wantedContent(value, daysAgo(3), ['SPAM'])).toBe('outside')
    expect(combineWanted(['outside', 'headers', 'bodies'])).toBe('bodies')
    expect(strongestMode(value)).toBe('full')
    expect(stateSatisfies('body', 'headers')).toBe(true)
    expect(stateSatisfies('body', 'full')).toBe(false)
  })

  it('detects uniform and default scopes', () => {
    expect(isDefaultScope(context())).toBe(true)
    expect(uniformPolicy(context({ overrides: [{ labelId: 'INBOX', downloadMode: 'full' }] }))?.policy.downloadMode).toBe('full')
    expect(uniformPolicy(context({ overrides: [{ labelId: 'INBOX', downloadMode: 'headers' }] }))).toBeUndefined()
    expect(isDefaultScope(context({ defaults: { downloadMode: 'full', window: { unit: 'days', amount: 5 } } }))).toBe(false)
  })
})
