import { describe, expect, it } from 'vitest'
import { isLocalOnlyMailAction, mailListGroupStart, pendingOperationsMessage, pinActionFor, threadIdsByAccount } from './mail-pins'
import { QUICK_ACTION_STEP_LABELS } from './mail-quick-actions'

const dateKey = (date: string) => date.slice(0, 10)

describe('mail pin helpers', () => {
  it('treats only pin and unpin as local-only actions', () => {
    expect(isLocalOnlyMailAction('pin')).toBe(true)
    expect(isLocalOnlyMailAction('unpin')).toBe(true)
    for (const kind of ['star', 'important', 'archive', 'move']) expect(isLocalOnlyMailAction(kind)).toBe(false)
    expect(QUICK_ACTION_STEP_LABELS.pin).toBe('Pin to top')
  })

  it('pins a mixed selection and unpins only a fully pinned one', () => {
    expect(pinActionFor([])).toBe('pin')
    expect(pinActionFor([{ pinned: true }, { pinned: false }])).toBe('pin')
    expect(pinActionFor([{ pinned: true }, { pinned: true }])).toBe('unpin')
    expect(pinActionFor([{}])).toBe('pin')
  })

  it('groups targets per account so identical thread ids stay separate', () => {
    expect([...threadIdsByAccount([{ accountId: 'a', id: 't1' }, { accountId: 'b', id: 't1' }, { accountId: 'a', id: 't2' }, { accountId: 'a', id: 't1' }])])
      .toEqual([['a', ['t1', 't2']], ['b', ['t1']]])
  })

  it('heads the pinned group once and resumes date headings after it', () => {
    const items = [
      { pinned: true, lastDate: '2026-01-01T00:00:00Z' },
      { pinned: true, lastDate: '2026-05-01T00:00:00Z' },
      { pinned: false, lastDate: '2026-09-02T09:00:00Z' },
      { pinned: false, lastDate: '2026-09-02T08:00:00Z' },
      { pinned: false, lastDate: '2026-09-01T08:00:00Z' }
    ]
    expect(items.map((item, index) => mailListGroupStart(items[index - 1], item, dateKey))).toEqual(['pinned', undefined, 'date', undefined, 'date'])
    expect(mailListGroupStart(undefined, { lastDate: '2026-09-01T00:00:00Z' }, dateKey)).toBe('date')
  })

  it('describes pin changes as applied rather than queued', () => {
    expect(pendingOperationsMessage([{ kind: 'pin' }])).toBe('Pinned to the top of the list')
    expect(pendingOperationsMessage([{ kind: 'unpin' }, { kind: 'unpin' }])).toBe('Unpinned')
    expect(pendingOperationsMessage([{ kind: 'pin' }, { kind: 'archive' }])).toBe('2 mail changes queued')
    expect(pendingOperationsMessage([{ kind: 'archive' }])).toBe('Mail change queued')
  })
})
