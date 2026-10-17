// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DuplicateCleanupEntry, DuplicateGroup, DuplicateScanResult, DuplicateScopeOwner } from '../duplicate-cleanup-types'
import DuplicateCleanupModal from './DuplicateCleanupModal'

const item = (id: string, overrides: Partial<DuplicateGroup['items'][number]> = {}) => ({
  id, title: 'Quarterly report', ownerLabel: 'ada@example.com', containerLabel: 'All Mail', summary: 'Ada',
  details: [{ label: 'From', value: 'ada@example.com' }, { label: 'Size', value: id === 'mail:b' ? '12 KB' : '10 KB' }], completeness: 1, removable: true, ...overrides
})
const group = (id: string, items = [item('mail:a'), item('mail:b'), item('mail:c', { removable: false, blockedReason: 'Read-only copy' })]): DuplicateGroup => ({
  id, kind: 'mail', confidence: 'high', reasons: [{ code: 'message-id', label: 'Same Message-ID in the same folder' }], items, keeperId: items[0].id, notes: ['Compare before removing.']
})
const owners: DuplicateScopeOwner[] = [
  { id: 'acc', label: 'ada@example.com', readOnly: false, containers: [{ id: 'INBOX', label: 'Inbox', readOnly: false }, { id: 'Label_1', label: 'Projects', readOnly: false }] },
  { id: 'old', label: 'old@example.com', readOnly: true, readOnlyReason: 'Archived accounts are read-only.', containers: [] }
]
const scanResult = (): DuplicateScanResult => ({ scanId: 'scan-1', kind: 'mail', scannedAt: '2026-10-17T12:00:00.000Z', scanned: 40, groups: [group('g1'), group('g2', [item('mail:x', { title: 'Invoice' }), item('mail:y', { title: 'Invoice' })])], excluded: [{ label: 'old@example.com', reason: 'Archived accounts are read-only.' }], dismissed: 1 })
const entry: DuplicateCleanupEntry = { id: 'entry-1', kind: 'mail', createdAt: '2026-10-17T12:01:00.000Z', removed: 1, titles: ['Quarterly report'] }

const api = {
  scopes: vi.fn(async () => owners),
  scan: vi.fn(async () => scanResult()),
  remove: vi.fn(async () => ({ entry, results: [
    { groupId: 'g1', itemId: 'mail:a', title: 'Quarterly report', outcome: 'removed' as const },
    { groupId: 'g2', itemId: 'mail:y', title: 'Invoice', outcome: 'stale' as const, message: 'This message changed since the scan; scan again to review it' }
  ] })),
  dismiss: vi.fn(async () => []),
  dismissals: vi.fn(async () => []),
  removeDismissal: vi.fn(async () => []),
  history: vi.fn(async (): Promise<DuplicateCleanupEntry[]> => []),
  undo: vi.fn(async () => ({ entry: { ...entry, undoneAt: '2026-10-17T12:02:00.000Z' }, results: [{ itemId: 'mail:a', title: 'Quarterly report', outcome: 'restored' as const }] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { duplicates: api } })
})

async function scanMail() {
  const user = userEvent.setup()
  render(<DuplicateCleanupModal onClose={vi.fn()} />)
  await user.click(await screen.findByRole('checkbox', { name: 'All folders in ada@example.com' }))
  await user.click(screen.getByRole('button', { name: 'Find duplicates' }))
  await screen.findByText(/Scanned 40 items/)
  return user
}

describe('DuplicateCleanupModal', () => {
  it('scans the chosen scope and explains read-only owners', async () => {
    const user = userEvent.setup()
    render(<DuplicateCleanupModal onClose={vi.fn()} />)
    expect(await screen.findByText('Archived accounts are read-only.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Find duplicates' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('checkbox', { name: /Projects/ }))
    await user.click(screen.getByRole('button', { name: 'Find duplicates' }))
    expect(api.scan).toHaveBeenCalledWith({ kind: 'mail', scopes: [{ accountId: 'acc', labelIds: ['Label_1'] }] })
    expect(await screen.findByText(/Not scanned: old@example.com/)).toBeTruthy()
    expect(screen.getByText(/1 marked “Not duplicates” earlier/)).toBeTruthy()
  })

  it('compares copies side by side, lets the keeper change, and removes the selected copies', async () => {
    const user = await scanMail()
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4)
    expect(within(table).getByRole('row', { name: /Size/ }).className).toBe('duplicate-differs')
    expect((screen.getByRole('radio', { name: 'Keep copy 1' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Remove copy 2' }) as HTMLInputElement).checked).toBe(true)
    // The read-only copy cannot be removed.
    expect((screen.getByRole('checkbox', { name: 'Remove copy 3' }) as HTMLInputElement).disabled).toBe(true)
    await user.click(screen.getByRole('radio', { name: 'Keep copy 2' }))
    expect((screen.getByRole('checkbox', { name: 'Remove copy 1' }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
    expect(api.remove).toHaveBeenCalledWith({ scanId: 'scan-1', groups: [
      { groupId: 'g1', keeperId: 'mail:b', removeIds: ['mail:a'] },
      { groupId: 'g2', keeperId: 'mail:x', removeIds: ['mail:y'] }
    ] })
    const results = await screen.findByRole('region', { name: 'Results' })
    expect(within(results).getByText(/scan again to review it/)).toBeTruthy()
    expect(within(results).getAllByText('Removed')).toHaveLength(1)
    expect(api.history).toHaveBeenCalledTimes(2)
  })

  it('skips a group for this review and persists "Not duplicates"', async () => {
    const user = await scanMail()
    await user.click(screen.getByRole('button', { name: 'Skip group' }))
    expect(screen.queryByRole('button', { name: /Quarterly report/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove selected (1)' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Not duplicates' }))
    expect(api.dismiss).toHaveBeenCalledWith('scan-1', 'g2')
    await waitFor(() => expect(screen.getByText('No duplicates to review.')).toBeTruthy())
  })

  it('undoes a recent cleanup', async () => {
    api.history.mockResolvedValue([entry])
    const user = userEvent.setup()
    render(<DuplicateCleanupModal onClose={vi.fn()} />)
    const journal = await screen.findByRole('region', { name: 'Recent cleanups' })
    await user.click(within(journal).getByRole('button', { name: 'Undo' }))
    expect(api.undo).toHaveBeenCalledWith('entry-1')
    expect(await screen.findByText('Restored')).toBeTruthy()
    api.history.mockResolvedValue([])
  })

  it('scans calendars per calendar', async () => {
    api.scopes.mockResolvedValueOnce(owners).mockResolvedValueOnce([{ id: 'acc', label: 'ada@example.com', readOnly: false, containers: [
      { id: 'work', label: 'Work', readOnly: false }, { id: 'shared', label: 'Shared', readOnly: true, readOnlyReason: 'Reconnect this account to allow calendar changes.' }
    ] }])
    const user = userEvent.setup()
    render(<DuplicateCleanupModal onClose={vi.fn()} />)
    await user.click(await screen.findByRole('tab', { name: 'Calendar' }))
    await user.click(await screen.findByRole('checkbox', { name: 'Every calendar in ada@example.com' }))
    await user.click(screen.getByRole('button', { name: 'Find duplicates' }))
    expect(api.scan).toHaveBeenLastCalledWith({ kind: 'event', calendarIds: ['work'] })
  })
})
