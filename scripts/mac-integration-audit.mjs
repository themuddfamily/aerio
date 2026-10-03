import assert from 'node:assert/strict'

export async function auditMacIntegration(application, page, preferences) {
  try {
    const registration = await page.evaluate(async (value) => {
      try { await window.aerio.savePreferences({ ...value, settings: { ...value.settings, launchAtLogin: true } }); return { saved: true } }
      catch (error) { return { saved: false, message: error.message } }
    }, preferences)
    const native = await application.evaluate(({ app }) => app.getLoginItemSettings())
    if (registration.saved) {
      assert.equal(native.openAtLogin, true)
      assert.equal(native.status, 'enabled')
      assert.equal((await page.evaluate(() => window.aerio.loadPreferences())).settings.launchAtLogin, true)
    } else {
      assert.match(registration.message, /macOS has not enabled Aerio at login/)
      assert.equal((await page.evaluate(() => window.aerio.loadPreferences())).settings.launchAtLogin, false)
    }
  } finally {
    // This runs only on the disposable native runner; remove any fixture item.
    await application.evaluate(({ app }) => app.setLoginItemSettings({ openAtLogin: false }))
    await page.evaluate((value) => window.aerio.savePreferences(value), preferences)
  }
  assert.equal(await application.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin), false)
  const roles = await application.evaluate(({ Menu }) => {
    const collect = (menu) => menu.items.flatMap((item) => [String(item.role ?? '').toLowerCase(), ...(item.submenu ? collect(item.submenu) : [])])
    return collect(Menu.getApplicationMenu())
  })
  for (const role of ['about', 'hide', 'quit', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectall', 'minimize', 'close']) assert.ok(roles.includes(role), `Missing native menu role: ${role}`)
  const title = page.getByRole('textbox', { name: 'Note title', exact: true })
  const original = await title.inputValue()
  await title.focus()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+c')
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), original)
  await page.keyboard.press('ArrowRight')
  const window = await application.browserWindow(page)
  await page.evaluate((value) => window.aerio.savePreferences({ ...value, settings: { ...value.settings, closeToTray: true } }), preferences)
  await page.evaluate(() => window.aerio.appLock.enable('mac-native-fixture-passphrase'))
  await window.evaluate((window) => window.close())
  assert.equal(await window.evaluate((window) => window.isVisible()), false)
  assert.equal((await page.evaluate(() => window.aerio.appLock.status())).locked, true)
  await application.evaluate(({ app }) => app.emit('activate'))
  assert.equal(await window.evaluate((window) => window.isVisible()), true)
  assert.equal((await page.evaluate(() => window.aerio.appLock.status())).locked, true)
  await page.evaluate(() => window.aerio.appLock.unlock('mac-native-fixture-passphrase'))
  await page.evaluate(() => window.aerio.appLock.disable('mac-native-fixture-passphrase'))
  await page.evaluate((value) => window.aerio.savePreferences(value), preferences)
  const workArea = await application.evaluate(({ screen }, bounds) => screen.getDisplayMatching(bounds).workArea, await window.evaluate((window) => window.getBounds()))
  const [minimumWidth, minimumHeight] = await window.evaluate((window) => window.getMinimumSize())
  const expectedSize = {
    width: Math.min(workArea.width, Math.max(minimumWidth, Math.min(1140, workArea.width - 24))),
    height: Math.min(workArea.height, Math.max(minimumHeight, Math.min(760, workArea.height - 24)))
  }
  await window.evaluate((window, bounds) => window.setBounds(bounds), { ...expectedSize, x: workArea.x, y: workArea.y })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(await window.evaluate((window) => ({ width: window.getBounds().width, height: window.getBounds().height })), expectedSize)
  const closed = page.waitForEvent('close')
  await window.evaluate((window) => window.close())
  await closed
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0)
  const activated = application.waitForEvent('window')
  await application.evaluate(({ app }) => app.emit('activate'))
  page = await activated
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.aerio.loadPreferences()), preferences)
  assert.deepEqual(await (await application.browserWindow(page)).evaluate((window) => ({ width: window.getBounds().width, height: window.getBounds().height })), expectedSize)
  const menuClosed = page.waitForEvent('close')
  await (await application.browserWindow(page)).evaluate((window) => window.close())
  await menuClosed
  const reopened = application.waitForEvent('window')
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('aerio-open').click())
  page = await reopened
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await (await application.browserWindow(page)).evaluate((window) => { window.show(); window.focus() })
  const exited = application.waitForEvent('close', { timeout: 10_000 })
  // Renderer-injected keys do not establish native application-menu shortcut behavior.
  // Exercise Cocoa's Quit action through the application's real responder chain.
  await application.evaluate(({ Menu }) => Menu.sendActionToFirstResponder('terminate:')).catch((error) => {
    if (!/closed/i.test(error.message)) throw error
  })
  await exited
  console.log('Native macOS menus/editing, lock-preserving tray/Dock reopening, last-window lifecycle, saved bounds and Cocoa Quit action passed; physical Cmd+Q is unverified.')
}
