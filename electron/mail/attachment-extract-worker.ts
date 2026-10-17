// Worker-thread entry for attachment text extraction. It has no database or
// network access: it receives one attachment's bytes, runs the bounded parsers,
// and posts back the result. The parent enforces the heap limit and timeout and
// terminates this thread to cancel a job.
import { parentPort, workerData } from 'node:worker_threads'
import { extractAttachmentText } from './attachment-text-extract'
import { DEFAULT_ATTACHMENT_TEXT_LIMITS, type AttachmentTextLimits, type AttachmentTextResult } from './attachment-text-types'

export interface AttachmentExtractJob {
  id: number
  filename: string
  mimeType: string
  content: Uint8Array
}

export interface AttachmentExtractReply {
  id: number
  result: AttachmentTextResult
}

const port = parentPort
if (!port) throw new Error('The attachment extractor must run in a worker thread')
const limits: AttachmentTextLimits = { ...DEFAULT_ATTACHMENT_TEXT_LIMITS, ...(workerData as { limits?: Partial<AttachmentTextLimits> } | undefined)?.limits }

port.on('message', (job: AttachmentExtractJob) => {
  let result: AttachmentTextResult
  try {
    const content = Buffer.from(job.content.buffer, job.content.byteOffset, job.content.byteLength)
    result = extractAttachmentText({ filename: job.filename, mimeType: job.mimeType, content }, limits)
  } catch {
    result = { status: 'failed', text: '', truncated: false, detail: 'The attachment could not be read' }
  }
  port.postMessage({ id: job.id, result } satisfies AttachmentExtractReply)
})
