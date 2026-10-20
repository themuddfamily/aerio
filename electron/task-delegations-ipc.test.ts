import { describe, expect, it, vi } from 'vitest'
import { registerTaskDelegations } from './task-delegations-ipc'
describe('task delegation IPC lock boundary', () => {
  it('blocks assignment and inspection while locked and forwards exact explicit actions when unlocked', async () => {
    const handlers = new Map<string, (...args: any[]) => any>(), request = vi.fn(async () => [])
    let locked = true
    registerTaskDelegations({ handle: (channel: string, handler: any) => { handlers.set(channel, handler) } }, () => ({ request }) as any, () => { if (locked) throw new Error('Unlock first') })
    for (const method of ['assign', 'respond', 'inspect', 'retry', 'update', 'list']) expect(() => handlers.get(`task-delegations:${method}`)!({}, {})).toThrow('Unlock first')
    expect(request).not.toHaveBeenCalled()
    locked = false
    const payload = { id: 'assignment', expectedUpdatedAt: 'revision', response: 'accept' }
    await handlers.get('task-delegations:respond')!({}, payload)
    expect(request).toHaveBeenCalledWith({ type: 'task-delegations:respond', payload })
  })
})
