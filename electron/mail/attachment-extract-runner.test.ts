import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentExtractRunner } from './attachment-extract-runner'
import { docxFixture } from './attachment-test-fixtures'

// The real worker entry is TypeScript; tsx lets the thread load it directly.
const realWorker = new URL('./attachment-extract-worker.ts', import.meta.url)
const runners: AttachmentExtractRunner[] = []

function runner(options: ConstructorParameters<typeof AttachmentExtractRunner>[0]) {
  const created = new AttachmentExtractRunner(options)
  runners.push(created)
  return created
}

/** A runner whose worker is an inline script, counting how many workers were started. */
function scripted(source: string, options: { timeoutMs?: number; memoryLimitMb?: number } = {}) {
  const spawned: Worker[] = []
  const created = runner({
    ...options,
    spawn: (resourceLimits) => {
      const worker = new Worker(`const { parentPort } = require('node:worker_threads');\n${source}`, { eval: true, resourceLimits })
      spawned.push(worker)
      return worker
    }
  })
  return { runner: created, spawned }
}

const input = (filename = 'note.txt', text = 'hello') => ({ filename, mimeType: 'text/plain', content: Buffer.from(text) })

afterEach(async () => {
  await Promise.all(runners.splice(0).map((item) => item.close()))
})

describe('AttachmentExtractRunner', () => {
  it('extracts text in the real worker thread and reuses it between jobs', async () => {
    const extractor = runner({ spawn: (resourceLimits, limits) => new Worker(realWorker, { execArgv: ['--import', 'tsx'], resourceLimits, workerData: { limits } }), timeoutMs: 20_000 })
    const content = docxFixture(['Isolated parser output'])
    const docx = await extractor.extract({ filename: 'memo.docx', mimeType: '', content })
    expect(docx).toEqual({ status: 'indexed', text: 'Isolated parser output', truncated: false })
    // The caller's buffer is copied, not transferred away.
    expect(content.byteLength).toBeGreaterThan(0)
    await expect(extractor.extract(input('a.txt', 'second job'))).resolves.toMatchObject({ status: 'indexed', text: 'second job' })
  }, 30_000)

  it('passes custom limits to the worker and rejects oversized input before posting it', async () => {
    const extractor = runner({ spawn: (resourceLimits, limits) => new Worker(realWorker, { execArgv: ['--import', 'tsx'], resourceLimits, workerData: { limits } }), limits: { maxTextChars: 5, maxInputBytes: 100 }, timeoutMs: 20_000 })
    await expect(extractor.extract(input('a.txt', 'abcdefghij'))).resolves.toMatchObject({ status: 'indexed', text: 'abcde', truncated: true })
    await expect(extractor.extract(input('a.txt', 'x'.repeat(200)))).resolves.toMatchObject({ status: 'too-large' })
  }, 30_000)

  it('times out a hung parser, terminates it, and starts a fresh worker for the next job', async () => {
    const { runner: extractor, spawned } = scripted(`
      parentPort.on('message', (job) => {
        if (job.filename === 'hang.txt') for (;;) {}
        parentPort.postMessage({ id: job.id, result: { status: 'indexed', text: 'ok', truncated: false } })
      })`, { timeoutMs: 300 })
    await expect(extractor.extract(input('hang.txt'))).resolves.toMatchObject({ status: 'timeout', detail: 'Reading the attachment took too long' })
    await expect(extractor.extract(input('fine.txt'))).resolves.toMatchObject({ status: 'indexed', text: 'ok' })
    expect(spawned).toHaveLength(2)
  }, 20_000)

  it('reports a parser that exceeds its heap limit as a memory-limit failure', async () => {
    const { runner: extractor } = scripted(`
      parentPort.on('message', () => {
        const hoard = []
        for (;;) hoard.push(new Array(100_000).fill(Math.random()))
      })`, { timeoutMs: 15_000, memoryLimitMb: 16 })
    await expect(extractor.extract(input())).resolves.toMatchObject({ status: 'memory-limit' })
  }, 30_000)

  it('reports a crashed parser as failed', async () => {
    const { runner: extractor } = scripted(`parentPort.on('message', () => { throw new Error('boom') })`)
    await expect(extractor.extract(input())).resolves.toMatchObject({ status: 'failed' })
  }, 20_000)

  it('cancels a running job when its signal aborts and when the runner closes', async () => {
    const { runner: extractor, spawned } = scripted(`parentPort.on('message', () => { for (;;) {} })`, { timeoutMs: 15_000 })
    const controller = new AbortController()
    const running = extractor.extract(input(), controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    await expect(extractor.extract(input(), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    const pending = extractor.extract(input())
    setTimeout(() => void extractor.close(), 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(extractor.extract(input())).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned).toHaveLength(2)
  }, 20_000)
})
