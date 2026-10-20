import { describe, expect, it, vi } from 'vitest'
import type { NotificationConstructorOptions } from 'electron'
import { MailNotificationService, type MailNotificationDependencies } from './mail-notifications'
import { defaultMailNotifications } from '../src/lib/mail-notifications'

const payload = { accountId: 'a', count: 1, threadId: 'thread', sender: 'Private sender', subject: 'Private subject', category: 'primary' }
function setup() {
  const notices: { options: NotificationConstructorOptions; events: Map<string, (...args: any[]) => void>; close: ReturnType<typeof vi.fn> }[] = []
  let prefs = defaultMailNotifications(); let locked = false; let focused = false; let enabled = true; let now = new Date(2026, 9, 20, 12)
  const perform = vi.fn().mockResolvedValue(undefined); const open = vi.fn(); const failed = vi.fn()
  const deps: MailNotificationDependencies = {
    platform: 'win32', supported: () => true, enabled: () => enabled, preferences: () => prefs, locked: () => locked, focused: () => focused, now: () => now, perform, open, failed,
    create: (options) => {
      const events = new Map<string, (...args: any[]) => void>(); const close = vi.fn()
      notices.push({ options, events, close })
      return { on: (name, callback) => events.set(name, callback), show: vi.fn(), close }
    }
  }
  return { service: new MailNotificationService(deps), deps, notices, perform, open, failed,
    preferences: (value: Partial<typeof prefs>) => { prefs = { ...prefs, ...value } }, lock: () => { locked = true }, focus: () => { focused = true }, disable: () => { enabled = false }, advance: () => { now = new Date(now.getTime() + 25 * 3600000) } }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
describe('native mail notification bindings', () => {
  it('binds ordered actions to the exact trusted conversation and consumes an activation once', async () => {
    const context = setup(); context.preferences({ actions: ['read', 'archive', 'trash'] })
    context.service.show(payload)
    const notice = context.notices[0]
    expect(notice.options.actions?.map((action) => action.text)).toEqual(['Mark as read', 'Archive', 'Move to Trash'])
    notice.events.get('action')!({ actionIndex: -1 }); notice.events.get('action')!({ actionIndex: '1' }); notice.events.get('action')!({ actionIndex: 100 })
    expect(context.perform).not.toHaveBeenCalled()
    notice.events.get('close')!({ reason: 'timedOut' })
    notice.events.get('action')!({ actionIndex: 1 }); notice.events.get('click')!(); notice.events.get('action')!({}, 2)
    await flush()
    expect(context.perform).toHaveBeenCalledExactlyOnceWith('archive', payload)
    expect(context.open).not.toHaveBeenCalled()
  })
  it('supports macOS legacy indexes and Linux click-to-open fallback without arbitrary commands', async () => {
    const mac = setup(); mac.deps.platform = 'darwin'; mac.preferences({ actions: ['star'] }); mac.service.show(payload)
    mac.notices[0].events.get('action')!({}, 0); await flush()
    expect(mac.perform).toHaveBeenCalledExactlyOnceWith('star', payload)
    const linux = setup(); linux.deps.platform = 'linux'; linux.service.show(payload)
    expect(linux.notices[0].options.actions).toBeUndefined()
    linux.notices[0].events.get('action')!({ actionIndex: 0 }); linux.notices[0].events.get('click')!()
    expect(linux.open).toHaveBeenCalledExactlyOnceWith(payload)
    expect(linux.perform).not.toHaveBeenCalled()
  })
  it('redacts locked messages, removes buttons, and revokes existing notifications on lock', async () => {
    const context = setup(); context.preferences({ actions: ['trash'] }); context.service.show(payload)
    const previous = context.notices[0]
    context.lock(); context.service.clear()
    expect(previous.close).toHaveBeenCalledOnce()
    previous.events.get('action')!({ actionIndex: 0 }); await flush()
    expect(context.perform).not.toHaveBeenCalled()
    context.service.show(payload)
    expect(context.notices[1].options.actions).toBeUndefined()
    expect(JSON.stringify(context.notices[1].options)).not.toContain('Private')
  })
  it('blocks actions when locking races a click or preferences mute an existing notification', async () => {
    const context = setup(); context.preferences({ actions: ['archive'] }); context.service.show(payload)
    context.notices[0].events.get('action')!({ actionIndex: 0 }); context.lock(); await flush()
    expect(context.perform).not.toHaveBeenCalled()
    const muted = setup(); muted.preferences({ actions: ['read'] }); muted.service.show(payload); muted.preferences({ accounts: { a: false } })
    muted.notices[0].events.get('action')!({ actionIndex: 0 }); await flush()
    expect(muted.perform).not.toHaveBeenCalled()
  })
  it('filters focus, quiet hours, account/category preferences, global switch and platform support', () => {
    const focus = setup(); focus.focus(); focus.preferences({ onlyWhenUnfocused: true }); focus.service.show(payload); expect(focus.notices).toHaveLength(0)
    const quiet = setup(); quiet.preferences({ quietHours: { enabled: true, start: '11:00', end: '13:00' } }); quiet.service.show(payload); expect(quiet.notices).toHaveLength(0)
    const muted = setup(); muted.preferences({ accounts: { a: false } }); muted.service.show(payload); expect(muted.notices).toHaveLength(0)
    const category = setup(); category.preferences({ categories: ['promotions'] }); category.service.show(payload); expect(category.notices).toHaveLength(0)
    const disabled = setup(); disabled.disable(); disabled.service.show(payload); expect(disabled.notices).toHaveLength(0)
    const unsupported = setup(); unsupported.deps.supported = () => false; unsupported.service.show(payload); expect(unsupported.notices).toHaveLength(0)
  })
  it('keeps aggregate notifications non-mutating, expires bindings and catches failed actions', async () => {
    const aggregate = setup(); aggregate.service.show({ ...payload, count: 2, threadId: undefined }); expect(aggregate.notices[0].options.actions).toBeUndefined()
    const expired = setup(); expired.preferences({ actions: ['read'] }); expired.service.show(payload); expired.advance(); expired.notices[0].events.get('action')!({ actionIndex: 0 }); await flush(); expect(expired.perform).not.toHaveBeenCalled()
    const failure = setup(); failure.preferences({ actions: ['archive'] }); failure.perform.mockRejectedValue(new Error('Offline destination missing')); failure.service.show(payload); failure.notices[0].events.get('action')!({ actionIndex: 0 }); await flush(); expect(failure.failed).toHaveBeenCalledOnce()
  })
})
