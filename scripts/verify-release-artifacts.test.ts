import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'

const script = resolve('scripts/verify-release-artifacts.mjs')
const installer = `Aerio-${packageJson.version}-setup-x64.exe`
const portable = `Aerio-${packageJson.version}-portable-x64.exe`
const bytes = Buffer.from('MZ disposable installer fixture')
const hash = createHash('sha512').update(bytes).digest('base64')

function check(mutate: (directory: string, metadata: any) => void = () => undefined, mutateManifest: (directory: string) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-artifacts-test-'))
  const metadata = { version: packageJson.version, files: [{ url: installer, size: bytes.length, sha512: hash }], path: installer, sha512: hash, releaseDate: '2026-10-01T12:00:00Z' }
  try {
    writeFileSync(join(directory, installer), bytes)
    writeFileSync(join(directory, portable), bytes)
    writeFileSync(join(directory, `${installer}.blockmap`), gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [bytes.length], checksums: ['fixture-checksum'] }] })))
    mkdirSync(join(directory, 'win-unpacked/resources'), { recursive: true })
    writeFileSync(join(directory, 'win-unpacked/resources/app-update.yml'), 'provider: github\nowner: themuddfamily\nrepo: aerio\n')
    mutate(directory, metadata)
    writeFileSync(join(directory, 'latest.yml'), JSON.stringify(metadata))
    mutateManifest(directory)
    return spawnSync(process.execPath, [script, directory], { encoding: 'utf8' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('release artifact verification', () => {
  it('accepts complete artifacts with consistent legacy metadata', () => {
    expect(check().status).toBe(0)
  })
  it('accepts modern metadata without legacy checksum fields', () => {
    expect(check((_directory, metadata) => { delete metadata.path; delete metadata.sha512 }).status).toBe(0)
  })
  it('rejects a missing latest.yml', () => {
    expect(check(undefined, (directory) => unlinkSync(join(directory, 'latest.yml'))).status).toBe(1)
  })
  it('rejects malformed YAML', () => {
    expect(check(undefined, (directory) => writeFileSync(join(directory, 'latest.yml'), 'files: [')).status).toBe(1)
  })
  it.each([installer, portable, `${installer}.blockmap`, 'win-unpacked/resources/app-update.yml'])('rejects a missing required artifact: %s', (file) => {
    expect(check((directory) => unlinkSync(join(directory, file))).status).toBe(1)
  })
  it.each(['version', 'size', 'checksum', 'duplicate', 'traversal', 'external', 'omitted', 'legacy', 'date'])('rejects inconsistent manifest data: %s', (kind) => {
    const result = check((_directory, metadata) => {
      if (kind === 'version') metadata.version = '0.0.0'
      if (kind === 'size') metadata.files[0].size += 1
      if (kind === 'checksum') metadata.files[0].sha512 = 'wrong'
      if (kind === 'duplicate') metadata.files.push(metadata.files[0])
      if (kind === 'traversal') metadata.files[0].url = `..%2F${installer}`
      if (kind === 'external') metadata.files[0].url = `https://example.test/${installer}`
      if (kind === 'omitted') metadata.files = []
      if (kind === 'legacy') metadata.sha512 = 'wrong'
      if (kind === 'date') metadata.releaseDate = 'invalid'
    })
    expect(result.status).toBe(1)
  })
  it.each(['empty', 'corrupt', 'size', 'chunks', 'provider', 'modified-installer'])('rejects invalid artifact contents: %s', (kind) => {
    expect(check((directory) => {
      if (kind === 'empty') writeFileSync(join(directory, portable), '')
      if (kind === 'corrupt') writeFileSync(join(directory, `${installer}.blockmap`), 'not gzip')
      if (kind === 'size' || kind === 'chunks') writeFileSync(join(directory, `${installer}.blockmap`), gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [kind === 'size' ? bytes.length + 1 : bytes.length], checksums: kind === 'chunks' ? [] : ['fixture'] }] })))
      if (kind === 'provider') writeFileSync(join(directory, 'win-unpacked/resources/app-update.yml'), 'provider: github\nowner: wrong\nrepo: aerio\n')
      if (kind === 'modified-installer') writeFileSync(join(directory, installer), Buffer.alloc(bytes.length, 1))
    }).status).toBe(1)
  })
})
