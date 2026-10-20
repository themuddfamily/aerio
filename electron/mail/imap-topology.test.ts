import { expect, it, vi } from 'vitest'
import { ImapTopology } from './imap-topology'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
it('waits for a concurrent folder mutation and repeats an invalidated inventory before publishing its result', async () => {
  const topology = new ImapTopology(), reading = deferred(), changing = deferred()
  const read = vi.fn().mockImplementationOnce(async () => { await reading.promise; throw new Error('SELECT removed mailbox') }).mockResolvedValueOnce('stable snapshot')
  const result = topology.stable('account', read)
  const mutation = topology.mutate('account', () => changing.promise)
  reading.resolve(); await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1)
  changing.resolve(); await mutation
  await expect(result).resolves.toBe('stable snapshot'); expect(read).toHaveBeenCalledTimes(2)
})
it('repeats successful but outdated reads, isolates accounts, and preserves ordinary provider failures', async () => {
  const topology = new ImapTopology(), reading = deferred()
  const read = vi.fn().mockImplementationOnce(async () => { await reading.promise; return 'old' }).mockResolvedValue('new')
  const result = topology.stable('account', read)
  await topology.mutate('account', async () => {}); reading.resolve()
  await expect(result).resolves.toBe('new')
  const failure = vi.fn(async () => { throw new Error('authentication rejected') })
  await topology.mutate('another-account', async () => {})
  await expect(topology.stable('account', failure)).rejects.toThrow('authentication rejected'); expect(failure).toHaveBeenCalledOnce()
})
it('serializes folder mutations and releases inventory after failed mutations', async () => {
  const topology = new ImapTopology(), changing = deferred(), second = vi.fn(async () => { throw new Error('guard denied') })
  const first = topology.mutate('account', () => changing.promise)
  const failed = topology.mutate('account', second); const failure = expect(failed).rejects.toThrow('guard denied')
  const read = vi.fn(async () => 'snapshot'), result = topology.stable('account', read)
  expect(second).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  changing.resolve(); await first; await failure
  await expect(result).resolves.toBe('snapshot')
})
