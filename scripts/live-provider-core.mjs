const classes = { gmail: ['gmail'], microsoft: ['microsoft-consumer', 'microsoft-365'], icloud: ['icloud'], yahoo: ['yahoo'], fastmail: ['fastmail'], imap: ['custom-imap'], 'proton-bridge': ['proton-bridge'] }
const counters = ['messages', 'threads', 'pendingDownloads', 'failedDownloads', 'queuedOperations', 'failedOperations', 'editableDrafts', 'failedDrafts']
const anomalies = ['orphanedMessages', 'orphanedAttachments', 'missingRawFiles']

export function parseConfig(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.accounts) || !value.accounts.length || value.accounts.length > 20 || Object.keys(value).some((key) => !['schemaVersion', 'accounts', 'timeoutMs'].includes(key))) throw new Error('Invalid live test configuration')
  const timeoutMs = value.timeoutMs ?? 180_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error('Invalid live test timeout')
  const aliases = new Set()
  return { timeoutMs, accounts: value.accounts.map((account) => {
    if (!account || Object.keys(account).some((key) => !['alias', 'provider', 'accountClass', 'credentialEnv'].includes(key)) || !Object.hasOwn(classes, account.provider) || !classes[account.provider].includes(account.accountClass) || typeof account.alias !== 'string' || !/^[a-z0-9-]{1,64}$/.test(account.alias) || !account.alias.startsWith(`${account.accountClass}-`) || account.alias.length <= account.accountClass.length + 1 || aliases.has(account.alias) || typeof account.credentialEnv !== 'string' || !/^AERIO_LIVE_[A-Z0-9_]{1,80}$/.test(account.credentialEnv)) throw new Error('Invalid live test account configuration')
    aliases.add(account.alias)
    return { alias: account.alias, provider: account.provider, accountClass: account.accountClass, credentialEnv: account.credentialEnv }
  }) }
}

export function readCredential(account, environment) {
  let value
  try { value = JSON.parse(environment[account.credentialEnv] ?? '') } catch { throw new Error('Live test credential unavailable') }
  if (!value || typeof value.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(value.email)) throw new Error('Invalid live test credential')
  if (account.provider === 'gmail' || account.provider === 'microsoft') {
    if (value.type !== 'oauth' || typeof value.accessToken !== 'string' || !value.accessToken) throw new Error('Invalid live test credential')
    return { email: value.email, credential: { type: 'oauth', accessToken: value.accessToken } }
  }
  const config = value.config
  if (value.type !== 'imap' || !config || config.provider !== account.provider || config.email !== value.email || (config.allowInvalidCertificates !== undefined && typeof config.allowInvalidCertificates !== 'boolean') || ['username', 'password', 'imapHost', 'smtpHost'].some((field) => typeof config[field] !== 'string' || !config[field]) || ['imapPort', 'smtpPort'].some((field) => !Number.isSafeInteger(config[field]) || config[field] < 1 || config[field] > 65535) || ['imapSecurity', 'smtpSecurity'].some((field) => !['tls', 'starttls'].includes(config[field]))) throw new Error('Invalid live test credential')
  return { email: value.email, credential: { type: 'imap', config } }
}

export function failureCode(error) {
  if (error?.authenticationFailed || /credential|authentication|unauthorized|401|403/i.test(String(error?.message ?? ''))) return 'authentication'
  if (/timeout|timed out/i.test(String(error?.message ?? ''))) return 'timeout'
  if (/certificate|TLS/i.test(String(error?.message ?? ''))) return 'tls'
  return 'check-failed'
}

export function sanitizeHealth(health, accountId) {
  const account = health?.accounts?.find((item) => item.accountId === accountId)
  if (!account || !['ok', 'error'].includes(health.integrity)) throw new Error('Invalid diagnostics')
  const result = { integrity: health.integrity }
  for (const field of counters) {
    if (!Number.isSafeInteger(account[field]) || account[field] < 0) throw new Error('Invalid diagnostics')
    result[field] = account[field]
  }
  for (const field of anomalies) {
    if (!Number.isSafeInteger(health[field]) || health[field] < 0) throw new Error('Invalid diagnostics')
    result[field] = health[field]
  }
  return result
}

async function paginate(worker, accountId) {
  const ids = new Set(), cursors = new Set()
  let cursor, total
  do {
    const page = await worker.request({ type: 'mail:list', payload: { accountIds: [accountId], folder: 'all', pageSize: 50, cursor } })
    if (!page || !Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.items) || (total !== undefined && total !== page.total)) throw new Error('Inconsistent pagination')
    total = page.total
    for (const item of page.items) {
      if (typeof item.id !== 'string' || ids.has(item.id)) throw new Error('Duplicate or invalid pagination identity')
      ids.add(item.id)
    }
    cursor = page.nextCursor
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || !page.items.length)) throw new Error('Repeated pagination cursor')
    if (cursor) cursors.add(cursor)
    if (ids.size > total) throw new Error('Pagination count mismatch')
  } while (cursor)
  if (ids.size !== total) throw new Error('Pagination count mismatch')
  return ids
}

export async function runAccounts(config, factory, metadata) {
  const runs = []
  for (const account of config.accounts) {
    const run = { alias: account.alias, provider: account.provider, accountClass: account.accountClass, startedAt: new Date().toISOString(), checks: [], phases: {} }
    const id = 'live-test-account'
    let worker
    const record = async (name, callback) => {
      try { await callback(); run.checks.push({ name, result: 'Pass' }); return true }
      catch (error) { run.checks.push({ name, result: 'Fail', reason: failureCode(error) }); return false }
    }
    try {
      worker = await factory(account, config.timeoutMs)
      await worker.request({ type: 'network', payload: { online: false } })
      if (!await record('credential-verification', () => worker.request({ type: 'accounts:verify', payload: { accountId: id } }))) continue
      let syncError, complete = false
      const unsubscribe = worker.onEvent((event) => {
        if (event.type !== 'sync-progress' || event.payload.accountId !== id) return
        const phase = event.payload.phase
        if (['inventory', 'downloading', 'complete', 'error', 'paused', 'idle', 'checking'].includes(phase)) run.phases[phase] = (run.phases[phase] ?? 0) + 1
        if (phase === 'error') syncError = new Error(event.payload.message ?? 'Sync failed')
        if (phase === 'complete') complete = true
      })
      const synced = await record('sync-completion', async () => {
        await worker.request({ type: 'network', payload: { online: true } })
        await worker.request({ type: 'sync:start', payload: { accountId: id } })
        const deadline = Date.now() + config.timeoutMs
        while (!complete) {
          if (syncError) throw syncError
          if (Date.now() >= deadline) throw new Error('Sync timeout')
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      })
      unsubscribe()
      await worker.request({ type: 'network', payload: { online: false } })
      if (!synced) continue
      await record('diagnostics', async () => {
        run.health = sanitizeHealth(await worker.request({ type: 'diagnostics:health' }), id)
        if (run.health.integrity !== 'ok' || [...anomalies, 'pendingDownloads', 'failedDownloads', 'queuedOperations', 'failedOperations', 'failedDrafts'].some((field) => run.health[field] !== 0)) throw new Error('Unhealthy diagnostics')
      })
      await record('offline-pagination-restart', async () => {
        const before = await paginate(worker, id)
        await worker.close(); worker = undefined
        worker = await factory(account, config.timeoutMs, true)
        await worker.request({ type: 'network', payload: { online: false } })
        const after = await paginate(worker, id)
        if (before.size !== after.size || [...before].some((key) => !after.has(key))) throw new Error('Restart cache mismatch')
        run.cachedThreads = after.size
      })
    } catch (error) { run.checks.push({ name: 'runner', result: 'Fail', reason: failureCode(error) }) }
    finally {
      if (worker) await worker.close().catch(() => { run.checks.push({ name: 'cleanup', result: 'Fail', reason: 'check-failed' }) })
      run.finishedAt = new Date().toISOString()
      runs.push(run)
    }
  }
  return { schemaVersion: 1, ...metadata, runs }
}

export function evidenceRows(report, diagnosticFilename) {
  const scenarios = { 'credential-verification': ['AUTH-01', 'Preconfigured credentials only; first connection enrollment not tested'], 'sync-completion': ['SYNC-01', 'Sync completed; independent server inventory not compared'], 'offline-pagination-restart': ['MAIL-02', 'Offline pagination/restart checked; seeded search corpus not tested'], diagnostics: ['HEALTH-01', 'Allowlisted diagnostic counters and sanitized export checked'] }
  return report.runs.flatMap((run) => run.checks.filter((check) => scenarios[check.name]).map((check) => {
    const [scenario, note] = scenarios[check.name]
    const result = check.result === 'Fail' ? 'Fail' : scenario === 'HEALTH-01' && !report.dirty ? 'Pass' : 'Partial'
    return `| ${run.finishedAt.slice(0, 10)} | ${report.commit} / ${report.version} | ${run.alias} | ${scenario} | ${result} | ${diagnosticFilename} | ${check.result === 'Fail' ? check.reason : note}${report.dirty ? '; working tree differs from commit' : ''} | automated-runner |`
  })).join('\n')
}
