import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('docs/live-provider-test-matrix.md')
const matrix = readFileSync(path, 'utf8')
const providers = ['gmail', 'microsoft', 'icloud', 'yahoo', 'fastmail', 'custom-imap', 'proton-bridge']
const scenarios = [
  'AUTH-01', 'AUTH-02', 'SYNC-01', 'SYNC-02', 'SYNC-03', 'SYNC-04', 'SYNC-05', 'SYNC-06', 'SYNC-07', 'SYNC-08', 'SYNC-09', 'SYNC-10',
  'DRAFT-01', 'DRAFT-02', 'DRAFT-03', 'SEND-01', 'SEND-02', 'MAIL-01', 'MAIL-02', 'DESKTOP-01', 'HEALTH-01',
  'PROD-AUTH-01', 'CAL-01', 'CAL-02', 'CONTACT-01', 'PROD-FAIL-01'
]
const missing = [
  ...providers.filter((provider) => !matrix.includes(`| ${provider} |`)).map((provider) => `provider:${provider}`),
  ...scenarios.filter((scenario) => !matrix.includes(`\`${scenario}\``)).map((scenario) => `scenario:${scenario}`)
]
if (!matrix.includes('## Execution log')) missing.push('execution-log')
if (!matrix.includes('no secrets')) missing.push('privacy-guidance')
if (missing.length) {
  throw new Error(`Live-provider matrix is incomplete: ${missing.join(', ')}`)
}
console.log(`Live-provider matrix covers ${providers.length} providers and ${scenarios.length} scenarios.`)
