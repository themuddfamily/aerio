import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DiagnosticRecord {
  timestamp: string
  level: DiagnosticLevel
  component: 'app' | 'mail-worker' | 'provider' | 'database' | 'ui'
  event: string
  message?: string
  accountId?: string
  details?: Record<string, unknown>
}

const PRIVATE_KEY = /token|password|secret|credential|authorization|cookie|raw|html|body|content|attachmentpath|subject|snippet|sender|recipient|signature|display.?name|email|address/i
const EMAIL = /([a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})@([a-z0-9.-]+\.[a-z]{2,})/gi

function scrubText(value: string) {
  return value
    .replace(EMAIL, (_match, local: string, domain: string) => `${local.slice(0, 1)}***@${domain}`)
    .slice(0, 2_000)
}

function scrub(value: unknown, key = '', depth = 0): unknown {
  if (PRIVATE_KEY.test(key)) return '[redacted]'
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([childKey, child]) => [childKey, scrub(child, childKey, depth + 1)]))
  }
  return String(value)
}

export class DiagnosticLogger {
  private readonly maximumBytes = 5 * 1024 * 1024

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  log(record: Omit<DiagnosticRecord, 'timestamp'>) {
    try {
      this.rotateIfNeeded()
      const safe: DiagnosticRecord = {
        ...record,
        timestamp: new Date().toISOString(),
        message: record.message ? scrubText(record.message) : undefined,
        details: record.details ? scrub(record.details) as Record<string, unknown> : undefined
      }
      appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Diagnostics must never make the mail client fail.
    }
  }

  exportBundle(targetPath: string, metadata: Record<string, unknown>, health: unknown) {
    const logs = [this.previousPath(), this.path]
      .filter((path) => existsSync(path))
      .flatMap((path) => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line) as unknown } catch { return { malformed: true } }
      }))
    writeFileSync(targetPath, JSON.stringify({
      exportedAt: new Date().toISOString(),
      privacy: 'Credentials, message bodies, HTML, raw messages, attachment paths, and most email addresses are redacted.',
      metadata: scrub(metadata),
      health: scrub(health),
      logs
    }, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  private previousPath() {
    return `${this.path}.1`
  }

  private rotateIfNeeded() {
    if (!existsSync(this.path) || statSync(this.path).size < this.maximumBytes) return
    rmSync(this.previousPath(), { force: true })
    renameSync(this.path, this.previousPath())
  }
}
