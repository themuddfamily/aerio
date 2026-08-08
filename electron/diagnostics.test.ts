import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticLogger } from './diagnostics'

const directories: string[] = []

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

describe('DiagnosticLogger', () => {
  it('redacts credentials, identity fields, message content, and email local parts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-diagnostics-test-'))
    directories.push(directory)
    const logger = new DiagnosticLogger(join(directory, 'logs', 'aerio.jsonl'))
    logger.log({
      level: 'error',
      component: 'mail-worker',
      event: 'sync-error',
      message: 'Account person@example.com could not synchronize',
      details: {
        email: 'person@example.com',
        displayName: 'Private Person',
        signature: 'Private phone 01234',
        subject: 'Private subject',
        accessToken: 'secret-token',
        phase: 'incremental'
      }
    })
    const target = join(directory, 'diagnostics.json')
    logger.exportBundle(target, { ownerEmail: 'person@example.com' }, { integrity: 'ok' })
    const output = readFileSync(target, 'utf8')
    expect(output).not.toContain('Private Person')
    expect(output).not.toContain('Private phone')
    expect(output).not.toContain('Private subject')
    expect(output).not.toContain('secret-token')
    expect(output).not.toContain('person@example.com')
    expect(output).toContain('p***@example.com')
    expect(output).toContain('incremental')
  })

  it('scrubs nested, oversized, array, primitive, and unusual diagnostic values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-diagnostics-test-'))
    directories.push(directory)
    const logger = new DiagnosticLogger(join(directory, 'aerio.jsonl'))
    const nested: Record<string, unknown> = { value: Symbol('diagnostic'), list: Array.from({ length: 55 }, (_, index) => index) }
    let cursor = nested
    for (let depth = 0; depth < 7; depth += 1) cursor = cursor.child = {}
    logger.log({ level: 'debug', component: 'app', event: 'shape', message: 'x'.repeat(2_100), details: nested })
    const output = readFileSync(logger.path, 'utf8')
    expect(output).toContain('[truncated]')
    expect(output).toContain('Symbol(diagnostic)')
    expect(JSON.parse(output).message).toHaveLength(2_000)
    expect(JSON.parse(output).details.list).toHaveLength(50)
  })

  it('rotates full logs, includes malformed records, and never lets logging failures escape', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-diagnostics-test-'))
    directories.push(directory)
    const path = join(directory, 'aerio.jsonl')
    writeFileSync(path, Buffer.alloc(5 * 1024 * 1024))
    const logger = new DiagnosticLogger(path)
    expect(() => logger.log({ level: 'info', component: 'app', event: 'rotated' })).not.toThrow()
    expect(readFileSync(`${path}.1`)).toHaveLength(5 * 1024 * 1024)
    appendFileSync(path, 'not-json\n')
    const target = join(directory, 'bundle.json')
    logger.exportBundle(target, {}, null)
    expect(JSON.parse(readFileSync(target, 'utf8')).logs).toContainEqual({ malformed: true })

    const impossible = new DiagnosticLogger(join(directory, 'missing', 'log.jsonl'))
    rmSync(join(directory, 'missing'), { recursive: true, force: true })
    expect(() => impossible.log({ level: 'error', component: 'app', event: 'write-failed' })).not.toThrow()
  })
})
