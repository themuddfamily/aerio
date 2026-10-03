import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts/validate-live-provider-matrix.mjs')
const matrix = readFileSync(resolve('docs/live-provider-test-matrix.md'), 'utf8')
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

function check(contents: string, evidence = false) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-matrix-test-'))
  try {
    mkdirSync(join(directory, 'docs'))
    writeFileSync(join(directory, 'docs/live-provider-test-matrix.md'), contents)
    return spawnSync(process.execPath, [script, ...(evidence ? ['--require-evidence'] : [])], { cwd: directory, encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('live-provider release evidence', () => {
  it('accepts the checklist structure including Windows line endings without claiming live validation', () => {
    const result = check(matrix.replace(/\r?\n/g, '\r\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('live results have not been verified')
  })

  it('rejects missing write coverage and downgrading required providers to Beta', () => {
    expect(check(matrix.replaceAll('CAL-WRITE-01', 'MISSING-WRITE')).status).toBe(1)
    expect(check(matrix.replace('| gmail | Required', '| gmail | Beta')).status).toBe(1)
  })

  it('blocks publication with the empty execution log', () => {
    const result = check(matrix, true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('microsoft-consumer:CAL-WRITE-01')
    expect(result.stderr).toContain('microsoft-365:CONTACT-WRITE-01')
  })

  it('requires both Microsoft classes and rejects a newer failure after a pass', () => {
    const row = (alias: string, scenario: string, result = 'Pass', candidate = version) =>
      `| 2026-10-01 | abc1234 / ${candidate} | ${alias}-a | ${scenario} | ${result} | diagnostics.json | reviewed | tester |`
    // Build a complete synthetic log from the checker-generated missing pairs.
    const missing = check(matrix, true).stderr.match(/^- ([\w-]+):([\w-]+)$/gm) ?? []
    expect(missing.length).toBeGreaterThan(100)
    const rows = missing.map((line) => {
      const [alias, scenario] = line.slice(2).split(':')
      return row(alias, scenario)
    }).join('\n')
    const fixture = matrix.replace('## Clean-room procedure', `${rows}\n\n## Clean-room procedure`)
    expect(check(fixture, true).status).toBe(0)
    expect(check(fixture.replaceAll('microsoft-365-a', 'microsoft-consumer-a'), true).status).toBe(1)
    expect(check(fixture.replace('## Clean-room procedure', `${row('gmail', 'SYNC-01', 'Fail')}\n\n## Clean-room procedure`), true).status).toBe(1)
    expect(check(fixture.replaceAll(`abc1234 / ${version}`, 'abc1234 / 0.0.0'), true).status).toBe(1)
  })
})
