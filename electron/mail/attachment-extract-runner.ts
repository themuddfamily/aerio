// Runs attachment parsers in a dedicated worker thread with a heap cap and a
// per-attachment timeout. A job that hangs, runs out of memory, crashes, or is
// cancelled terminates the worker; the next job starts a fresh one, so one
// hostile attachment cannot stall or bloat the mail worker.
import { Worker, type ResourceLimits } from 'node:worker_threads'
import type { AttachmentExtractJob, AttachmentExtractReply } from './attachment-extract-worker'
import { DEFAULT_ATTACHMENT_TEXT_LIMITS, type AttachmentTextInput, type AttachmentTextLimits, type AttachmentTextResult } from './attachment-text-types'

export interface AttachmentExtractRunnerOptions {
  /** Built worker entry (attachment-extract-worker.js). */
  workerPath?: string | URL
  /** Overrides how the worker is started; tests use it to run stand-in scripts. */
  spawn?: (resourceLimits: ResourceLimits, limits: AttachmentTextLimits) => Worker
  timeoutMs?: number
  memoryLimitMb?: number
  limits?: Partial<AttachmentTextLimits>
}

export const ATTACHMENT_EXTRACT_TIMEOUT_MS = 15_000
export const ATTACHMENT_EXTRACT_MEMORY_LIMIT_MB = 256

export class AttachmentExtractCancelledError extends Error {
  constructor() {
    super('Attachment extraction was cancelled')
    this.name = 'AbortError'
  }
}

export class AttachmentExtractRunner {
  private worker?: Worker
  private nextId = 0
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly limits: AttachmentTextLimits
  private readonly timeoutMs: number
  private readonly resourceLimits: ResourceLimits

  constructor(private readonly options: AttachmentExtractRunnerOptions) {
    if (!options.workerPath && !options.spawn) throw new Error('An attachment extractor worker is required')
    this.limits = { ...DEFAULT_ATTACHMENT_TEXT_LIMITS, ...options.limits }
    this.timeoutMs = options.timeoutMs ?? ATTACHMENT_EXTRACT_TIMEOUT_MS
    const memory = options.memoryLimitMb ?? ATTACHMENT_EXTRACT_MEMORY_LIMIT_MB
    this.resourceLimits = { maxOldGenerationSizeMb: memory, maxYoungGenerationSizeMb: Math.max(8, Math.round(memory / 8)), stackSizeMb: 4 }
  }

  /** Extracts one attachment. Jobs run one at a time; rejects with AbortError when cancelled. */
  extract(input: AttachmentTextInput, signal?: AbortSignal): Promise<AttachmentTextResult> {
    const run = this.queue.then(() => this.run(input, signal))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Stops the worker; pending and future jobs are cancelled. */
  async close() {
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    await worker?.terminate()
  }

  private spawn() {
    if (this.options.spawn) return this.options.spawn(this.resourceLimits, this.limits)
    return new Worker(this.options.workerPath!, { resourceLimits: this.resourceLimits, workerData: { limits: this.limits } })
  }

  private run(input: AttachmentTextInput, signal?: AbortSignal) {
    if (this.closed || signal?.aborted) return Promise.reject(new AttachmentExtractCancelledError())
    if (input.content.byteLength > this.limits.maxInputBytes) {
      return Promise.resolve<AttachmentTextResult>({ status: 'too-large', text: '', truncated: false, detail: 'The attachment is larger than the indexing limit' })
    }
    const worker = this.worker ??= this.spawn()
    const id = ++this.nextId
    return new Promise<AttachmentTextResult>((resolve, reject) => {
      let settled = false
      const finish = (outcome: { result: AttachmentTextResult } | { error: Error }, kill: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        worker.off('message', message)
        worker.off('error', error)
        worker.off('exit', exit)
        if (kill) {
          if (this.worker === worker) this.worker = undefined
          void worker.terminate()
        }
        if ('result' in outcome) resolve(outcome.result)
        else reject(outcome.error)
      }
      const failure = (status: AttachmentTextResult['status'], detail: string) => ({ result: { status, text: '', truncated: false, detail } })
      const message = (reply: AttachmentExtractReply) => {
        if (reply?.id === id) finish({ result: reply.result }, false)
      }
      const error = (cause: Error) => {
        const code = (cause as NodeJS.ErrnoException).code
        finish(code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? failure('memory-limit', 'Reading the attachment needed more memory than allowed')
          : failure('failed', 'The attachment could not be read'), true)
      }
      const exit = () => finish(this.closed ? { error: new AttachmentExtractCancelledError() } : failure('failed', 'The attachment reader stopped unexpectedly'), true)
      const abort = () => finish({ error: new AttachmentExtractCancelledError() }, true)
      const timer = setTimeout(() => finish(failure('timeout', 'Reading the attachment took too long'), true), this.timeoutMs)
      worker.on('message', message)
      worker.on('error', error)
      worker.on('exit', exit)
      signal?.addEventListener('abort', abort, { once: true })
      // Copy so the transferred buffer never detaches memory shared with the caller.
      const content = new Uint8Array(input.content)
      worker.postMessage({ id, filename: input.filename, mimeType: input.mimeType, content } satisfies AttachmentExtractJob, [content.buffer])
    })
  }
}
