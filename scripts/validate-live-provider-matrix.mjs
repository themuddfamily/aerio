import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('docs/live-provider-test-matrix.md')
const matrix = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const providers = ['gmail', 'microsoft', 'icloud', 'yahoo', 'fastmail', 'custom-imap', 'proton-bridge']
const scenarios = [
  'AUTH-01', 'AUTH-02', 'SYNC-01', 'SYNC-02', 'SYNC-03', 'SYNC-04', 'SYNC-05', 'SYNC-06', 'SYNC-07', 'SYNC-08', 'SYNC-09', 'SYNC-10',
  'DRAFT-01', 'DRAFT-02', 'DRAFT-03', 'SEND-01', 'SEND-02', 'MAIL-01', 'MAIL-02', 'DESKTOP-01', 'HEALTH-01',
  'PROD-AUTH-01', 'CAL-01', 'CAL-02', 'CAL-WRITE-01', 'CAL-WRITE-02', 'CONTACT-01',
  'CONTACT-WRITE-01', 'CONTACT-WRITE-02', 'PROD-SYNC-01', 'PROD-FAIL-01', 'DRAFT-04', 'LOCAL-TIME-01'
]
const missing = [
  ...providers.filter((provider) => !matrix.includes(`| ${provider} |`)).map((provider) => `provider:${provider}`),
  ...scenarios.filter((scenario) => !matrix.includes(`\`${scenario}\``)).map((scenario) => `scenario:${scenario}`)
]
if (!matrix.includes('## Execution log')) missing.push('execution-log')
if (!matrix.includes('no secrets')) missing.push('privacy-guidance')

function tableRows(section) {
  const body = matrix.split(`## ${section}\n`)[1]?.split('\n## ')[0] ?? ''
  return body.split('\n').filter((line) => line.startsWith('|')).map((line) =>
    line.split('|').slice(1, -1).map((cell) => cell.trim()))
}

const required = new Map(providers.map((provider) => [provider, new Set()]))
for (const section of ['Provider coverage', 'Calendar and Contacts coverage']) {
  const [header, , ...rows] = tableRows(section)
  if (!header) {
    missing.push(`table:${section}`)
    continue
  }
  const expected = section === 'Provider coverage' ? providers : ['gmail', 'microsoft']
  const expectedScenarios = section === 'Provider coverage' ? scenarios.slice(0, 21) : scenarios.slice(21, -1)
  for (const scenario of expectedScenarios) {
    if (!header.includes(scenario)) missing.push(`coverage-column:${scenario}`)
  }
  for (const provider of expected) {
    const row = rows.find((cells) => cells[0] === provider)
    if (!row || row.length !== header.length) {
      missing.push(`coverage-row:${section}:${provider}`)
      continue
    }
    header.slice(1).forEach((scenario, index) => {
      const status = row[index + 1]
      if (status === 'Required') required.get(provider).add(scenario)
      else if (!(status === 'Beta' && provider === 'proton-bridge') && !/^N\/A:\s*\S/.test(status)) missing.push(`coverage-status:${provider}:${scenario}`)
    })
  }
}
for (const provider of providers.filter((provider) => provider !== 'proton-bridge')) {
  required.get(provider).add('LOCAL-TIME-01')
}
if (missing.length) {
  throw new Error(`Live-provider matrix is incomplete: ${missing.join(', ')}`)
}
console.log(`Live-provider checklist structure covers ${providers.length} providers and ${scenarios.length} scenarios; live results have not been verified.`)

if (process.argv.includes('--require-evidence')) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const [, , ...runs] = tableRows('Execution log')
  const failures = []
  for (const [provider, providerScenarios] of required) {
    const accountClasses = provider === 'microsoft' ? ['microsoft-consumer', 'microsoft-365'] : [provider]
    for (const accountClass of accountClasses) {
      for (const scenario of providerScenarios) {
        const latest = runs.filter((row) => {
          const [date, candidate, alias, id] = row
          return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) &&
            candidate.split(/[\s/]+/).some((part) => part === version || part === `v${version}`) &&
            /\b[0-9a-f]{7,40}\b/i.test(candidate) && alias.startsWith(`${accountClass}-`) && id === scenario
        }).at(-1)
        if (!latest || latest[4] !== 'Pass' || !latest[5] || !latest[7]) failures.push(`${accountClass}:${scenario}`)
      }
    }
  }
  if (failures.length) throw new Error(`Live-provider evidence missing or not passing for ${version}:\n- ${failures.join('\n- ')}`)
  console.log(`Recorded live-provider evidence passes for Aerio ${version}. Review diagnostics and candidate commit before publication.`)
}
