import { describe, expect, it } from 'vitest'
import {
  describeQuickActionStep, quickActionDestinations, quickActionTargets,
  summarizeQuickActionRun, validateMailQuickAction, validateMailQuickActionTargets
} from './mail-quick-actions'
import { defaultKeymap, matchKeymapCommand, quickActionCommandId, shortcutLabel } from './keymap'

describe('mail quick actions', () => {
  it('normalizes valid quick actions and rejects unsafe or incomplete ones', () => {
    expect(validateMailQuickAction({ name: ' Done ', steps: [{ action: 'read', labelId: 'drop' }, { action: 'archive' }], shortcut: 0, showInToolbar: 'yes' }))
      .toEqual({ name: 'Done', steps: [{ action: 'read' }, { action: 'archive' }], showInToolbar: false })
    expect(validateMailQuickAction({ id: 'q', name: 'File', accountId: 'a', steps: [{ action: 'label', labelId: 'L' }], shortcut: 9, showInToolbar: true }))
      .toEqual({ id: 'q', name: 'File', accountId: 'a', steps: [{ action: 'label', labelId: 'L' }], shortcut: 9, showInToolbar: true })
    expect(() => validateMailQuickAction({ name: '', steps: [{ action: 'read' }] })).toThrow(/name/)
    expect(() => validateMailQuickAction({ name: 'x', steps: [] })).toThrow(/at least one step/)
    expect(() => validateMailQuickAction({ name: 'x', steps: Array.from({ length: 11 }, () => ({ action: 'read' })) })).toThrow(/up to 10/)
    expect(() => validateMailQuickAction({ name: 'x', steps: [null] })).toThrow(/unknown action/)
    expect(() => validateMailQuickAction({ name: 'x', accountId: 'a', steps: [{ action: 'move' }] })).toThrow(/destination for step 1/)
    expect(() => validateMailQuickAction({ name: 'x', steps: [{ action: 'move', labelId: 'L' }] })).toThrow(/choose an account/)
    expect(() => validateMailQuickAction({ name: 'x', steps: [{ action: 'read' }], shortcut: 1.5 })).toThrow(/shortcut/)
  })

  it('validates and de-duplicates run targets', () => {
    expect(validateMailQuickActionTargets([{ accountId: 'a', threadIds: ['1', '1', '2'] }])).toEqual([{ accountId: 'a', threadIds: ['1', '2'] }])
    expect(() => validateMailQuickActionTargets('a')).toThrow(/at least one/)
    expect(() => validateMailQuickActionTargets([{ accountId: 'a', threadIds: [] }])).toThrow(/conversations are invalid/)
    expect(() => validateMailQuickActionTargets([{ accountId: 'a', threadIds: Array.from({ length: 1001 }, (_, index) => String(index)) }])).toThrow(/up to 1,000/)
    expect(quickActionTargets([{ accountId: 'a', id: '1' }, { accountId: 'b', id: '2' }, { accountId: 'a', id: '3' }]))
      .toEqual([{ accountId: 'a', threadIds: ['1', '3'] }, { accountId: 'b', threadIds: ['2'] }])
  })

  it('offers provider-appropriate destinations', () => {
    const labels = [
      { accountId: 'g', id: 'Label_1', name: 'Receipts', type: 'user' as const },
      { accountId: 'g', id: 'SENT', name: 'Sent', type: 'system' as const },
      { accountId: 'i', id: 'folder:Done', name: 'Done', type: 'user' as const },
      { accountId: 'i', id: 'folder:Sent', name: 'Sent Items', type: 'system' as const }
    ]
    expect(quickActionDestinations('move', { id: 'g', provider: 'gmail' }, labels).map((label) => label.id)).toEqual(['INBOX', 'Label_1', 'SPAM', 'TRASH'])
    expect(quickActionDestinations('label', { id: 'g', provider: 'gmail' }, labels).map((label) => label.id)).toEqual(['Label_1'])
    expect(quickActionDestinations('label', { id: 'i', provider: 'imap' }, labels)).toEqual([])
    expect(quickActionDestinations('move', { id: 'i', provider: 'imap' }, labels).map((label) => label.id)).toEqual(['folder:Done'])
    expect(quickActionDestinations('read', { id: 'g', provider: 'gmail' }, labels)).toEqual([])
    expect(describeQuickActionStep({ action: 'label', labelId: 'Label_1' }, labels, 'g')).toBe('Apply label: Receipts')
    expect(describeQuickActionStep({ action: 'move', labelId: 'INBOX' })).toBe('Move to folder or label: Inbox')
  })

  it('maps Ctrl/Cmd+Shift+digit to shortcut slots through the default keymap', () => {
    const pc = defaultKeymap('windows')
    const mac = defaultKeymap('mac')
    const key = (code: string, extra = {}) => ({ key: '#', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, code, target: null, ...extra })
    const slot = (keymap: typeof pc, event: ReturnType<typeof key>) => matchKeymapCommand(keymap, event, { context: 'mail' })
    expect(slot(pc, key('Digit3'))).toBe(quickActionCommandId(3))
    expect(slot(mac, key('Numpad9', { ctrlKey: false, metaKey: true }))).toBe(quickActionCommandId(9))
    expect(slot(pc, key('Digit0'))).toBeUndefined()
    expect(slot(pc, key('Digit3', { shiftKey: false, key: '3' }))).toBeUndefined()
    expect(slot(pc, key('Digit3', { altKey: true }))).toBeUndefined()
    expect(shortcutLabel(pc, quickActionCommandId(4))).toBe('Ctrl+Shift+4')
    expect(shortcutLabel(mac, quickActionCommandId(4))).toBe('Cmd+Shift+4')
  })

  it('summarizes successes, skipped accounts, and partial failures', () => {
    const accounts = [{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com' }]
    const action = { name: 'Done', steps: [{ action: 'read' as const }, { action: 'archive' as const }] }
    expect(summarizeQuickActionRun(action, { operations: [], updatedThreads: 0, failures: [] })).toBe('“Done” made no changes')
    expect(summarizeQuickActionRun(action, {
      operations: [], updatedThreads: 3, failures: [
        { accountId: 'b', threadCount: 1, appliedSteps: 0, error: 'Disconnected accounts are read-only' },
        { accountId: 'a', threadCount: 2, step: 1, appliedSteps: 1, error: 'Network' },
        { accountId: 'x', threadCount: 1, step: 0, appliedSteps: 0, error: 'Gone' }
      ]
    }, accounts)).toBe('“Done” applied to 3 conversations · 1 conversation in b@example.com skipped: Disconnected accounts are read-only'
      + ' · 2 conversations in a@example.com partly updated, step 2 failed after 1 step (Undo reverts them): Network'
      + ' · 1 conversation in an account not updated, step 1 failed: Gone')
  })
})
