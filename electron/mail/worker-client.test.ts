import { beforeEach, describe, expect, it, vi } from 'vitest'

const workerMock = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = []
    readonly path: string
    readonly handlers = new Map<string, Array<(value: unknown) => void>>()
    postMessage = vi.fn()
    terminate = vi.fn().mockResolvedValue(0)

    constructor(path: string) {
      this.path = path
      FakeWorker.instances.push(this)
    }

    on(event: string, handler: (value: unknown) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    emit(event: string, value: unknown) {
      for (const handler of this.handlers.get(event) ?? []) handler(value)
    }
  }
  return { FakeWorker }
})

vi.mock('node:worker_threads', () => ({ Worker: workerMock.FakeWorker }))

import { MailWorkerClient } from './worker-client'

function latestWorker() {
  const worker = workerMock.FakeWorker.instances.at(-1)
  if (!worker) throw new Error('No fake worker was created')
  return worker
}

describe('MailWorkerClient', () => {
  beforeEach(() => {
    workerMock.FakeWorker.instances.length = 0
  })

  it('starts the requested worker and resolves successful responses', async () => {
    const subject = new MailWorkerClient('mail-worker.js', vi.fn(), vi.fn())
    const result = subject.request({ type: 'accounts:list' })
    const worker = latestWorker()
    expect(worker.path).toBe('mail-worker.js')
    expect(worker.postMessage).toHaveBeenCalledWith({
      kind: 'request', id: expect.any(String), command: { type: 'accounts:list' }
    })
    const request = worker.postMessage.mock.calls[0][0]
    worker.emit('message', { kind: 'response', id: request.id, result: [{ id: 'account-1' }] })
    await expect(result).resolves.toEqual([{ id: 'account-1' }])
  })

  it('rejects provider errors and ignores unknown response IDs', async () => {
    const subject = new MailWorkerClient('mail-worker.js', vi.fn(), vi.fn())
    latestWorker().emit('message', { kind: 'response', id: 'unknown', result: true })
    const result = subject.request({ type: 'storage:stats' })
    const request = latestWorker().postMessage.mock.calls[0][0]
    latestWorker().emit('message', { kind: 'response', id: request.id, error: { code: 'FAILED', message: 'Database failed' } })
    await expect(result).rejects.toThrow('Database failed')
  })

  it('forwards worker events to the renderer handler', () => {
    const eventHandler = vi.fn()
    new MailWorkerClient('mail-worker.js', vi.fn(), eventHandler)
    const event = { type: 'account-changed', accountId: 'account-1' }
    latestWorker().emit('message', { kind: 'event', event })
    expect(eventHandler).toHaveBeenCalledWith(event)
  })

  it('answers credential requests from the configured provider', async () => {
    const credential = { type: 'oauth' as const, accessToken: 'access-token' }
    const credentialProvider = vi.fn().mockResolvedValue(credential)
    new MailWorkerClient('mail-worker.js', credentialProvider, vi.fn())
    const worker = latestWorker()
    worker.emit('message', { kind: 'credential-request', id: 'credential-1', accountId: 'account-1' })
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({
      kind: 'credential-response', id: 'credential-1', credential
    }))
    expect(credentialProvider).toHaveBeenCalledWith('account-1')
  })

  it.each([
    [new Error('Vault locked'), 'Vault locked'],
    ['credential unavailable', 'credential unavailable']
  ])('returns a serializable credential error for %p', async (failure, message) => {
    new MailWorkerClient('mail-worker.js', vi.fn().mockRejectedValue(failure), vi.fn())
    const worker = latestWorker()
    worker.emit('message', { kind: 'credential-request', id: 'credential-1', accountId: 'account-1' })
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({
      kind: 'credential-response', id: 'credential-1', error: message
    }))
  })

  it.each([
    [new Error('worker crashed'), 'worker crashed'],
    ['native crash', 'native crash']
  ])('rejects every pending request when the worker errors with %p', async (failure, message) => {
    const subject = new MailWorkerClient('mail-worker.js', vi.fn(), vi.fn())
    const first = subject.request({ type: 'accounts:list' })
    const second = subject.request({ type: 'labels:list', payload: {} })
    latestWorker().emit('error', failure)
    await expect(first).rejects.toThrow(message)
    await expect(second).rejects.toThrow(message)

    // The pending map was cleared, so a late response cannot settle a new request.
    latestWorker().emit('message', { kind: 'response', id: latestWorker().postMessage.mock.calls[0][0].id, result: [] })
  })

  it('rejects pending requests after a non-zero exit but ignores a clean exit', async () => {
    const subject = new MailWorkerClient('mail-worker.js', vi.fn(), vi.fn())
    const cleanRequest = subject.request({ type: 'accounts:list' })
    const worker = latestWorker()
    worker.emit('exit', 0)
    const cleanMessage = worker.postMessage.mock.calls[0][0]
    worker.emit('message', { kind: 'response', id: cleanMessage.id, result: [] })
    await expect(cleanRequest).resolves.toEqual([])

    const failedRequest = subject.request({ type: 'accounts:list' })
    worker.emit('exit', 9)
    await expect(failedRequest).rejects.toThrow('stopped unexpectedly (9)')
  })

  it('requests graceful shutdown and always terminates the worker', async () => {
    const subject = new MailWorkerClient('mail-worker.js', vi.fn(), vi.fn())
    const closing = subject.close()
    const worker = latestWorker()
    const shutdown = worker.postMessage.mock.calls[0][0]
    expect(shutdown.command).toEqual({ type: 'shutdown' })
    worker.emit('message', { kind: 'response', id: shutdown.id })
    await closing
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates the worker when graceful shutdown fails', async () => {
    const subject = new MailWorkerClient('mail-worker.js', vi.fn(), vi.fn())
    const closing = subject.close()
    const worker = latestWorker()
    worker.emit('error', new Error('shutdown failed'))
    await expect(closing).rejects.toThrow('shutdown failed')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
