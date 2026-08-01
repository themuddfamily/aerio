import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
})
