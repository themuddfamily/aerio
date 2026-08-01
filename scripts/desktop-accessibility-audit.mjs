import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-accessibility-audit-'))
const findings = []
let application

async function audit(page, surface) {
  const result = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  for (const violation of result.violations) {
    for (const node of violation.nodes) {
      findings.push({
        surface,
        rule: violation.id,
        impact: violation.impact ?? 'unknown',
        help: violation.help,
        target: node.target.join(' '),
        summary: node.failureSummary?.replace(/\s+/g, ' ').trim() ?? ''
      })
    }
  }
}

try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })
  const page = await application.firstWindow()
  await page.waitForSelector('.app')

  const moduleRail = page.locator('.module-rail')
  for (const name of ['Mail', 'Calendar', 'Contacts', 'Tasks', 'Notes', 'Chat']) {
    await moduleRail.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(50)
    await audit(page, name)
  }

  const settingsButton = page.getByRole('button', { name: 'Settings' })
  await settingsButton.click()
  const settingsDialog = page.getByRole('dialog', { name: 'Aerio settings' })
  await settingsDialog.waitFor()
  assert.equal(await settingsDialog.evaluate((dialog) => dialog.contains(document.activeElement)), true, 'Settings should take focus when opened')
  const focusable = settingsDialog.locator('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  const firstFocusable = focusable.first()
  const lastFocusable = focusable.last()
  await firstFocusable.focus()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await lastFocusable.evaluate((element) => element === document.activeElement), true, 'Shift+Tab should wrap to the end of a dialog')
  await audit(page, 'Settings dialog')
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden' })
  assert.equal(await settingsButton.evaluate((button) => button === document.activeElement), true, 'Closing a dialog should restore focus to its opener')

  if (findings.length) {
    const report = findings.map((finding) =>
      `[${finding.impact}] ${finding.surface} · ${finding.rule} · ${finding.help}\n  ${finding.target}\n  ${finding.summary}`
    ).join('\n')
    assert.fail(`Accessibility audit found ${findings.length} violation target(s):\n${report}`)
  }
  console.log('Desktop accessibility audit passed across all modules and Settings.')
} finally {
  if (application) await application.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
