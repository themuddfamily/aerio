import { Worker } from 'node:worker_threads'
import type { GmailWorkerEvent } from '../../src/gmail-types'
import type {
  MailWorkerCommand,
  MailWorkerResult,
  WorkerEventMessage,
  WorkerResponse,
  WorkerTokenRequest
} from '../mail-protocol'

type WorkerMessage = WorkerResponse | WorkerEventMessage | WorkerTokenRequest

export class MailWorkerClient {
  private readonly worker: Worker
  private pending = new Map<string, { resolve: (value: MailWorkerResult) => void; reject: (error: Error) => void }>()

  constructor(
    workerPath: string,
    private readonly tokenProvider: (accountId: string) => Promise<string>,
    private readonly eventHandler: (event: GmailWorkerEvent) => void
  ) {
    this.worker = new Worker(workerPath)
    this.worker.on('message', (message: WorkerMessage) => void this.onMessage(message))
    this.worker.on('error', (error) => {
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
    this.worker.on('exit', (code) => {
      if (code === 0) return
      const error = new Error(`The mail worker stopped unexpectedly (${code})`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
  }

  private async onMessage(message: WorkerMessage) {
    if (message.kind === 'event') {
      this.eventHandler(message.event)
      return
    }
    if (message.kind === 'token-request') {
      try {
        const token = await this.tokenProvider(message.accountId)
        this.worker.postMessage({ kind: 'token-response', id: message.id, token })
      } catch (error) {
        this.worker.postMessage({ kind: 'token-response', id: message.id, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  }

  request<T extends MailWorkerResult = void>(command: MailWorkerCommand) {
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      })
      this.worker.postMessage({ kind: 'request', id, command })
    })
  }

  async close() {
    try { await this.request({ type: 'shutdown' }) } finally { await this.worker.terminate() }
  }
}
