import { isIP } from 'node:net'
export const HOSTED_CHECKS = Object.freeze(['secureStorage', 'isolatedShippedService', 'cryptoPersistence', 'passwordLogin', 'ownDeviceSas', 'crossUserSas', 'encryptedTextBothWays', 'encryptedAttachmentsBothWays', 'bothDeviceRestarts', 'recoveryRestore', 'lostResponseIdempotency'])
export function publicAddress(value) {
  if (isIP(value) === 4) {
    const [a, b, c] = value.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
  }
  return isIP(value) === 6 && !/^(?:f[cd]|fe[89ab]|::|2001:db8)/i.test(value)
}
export function validateHostedConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['homeserver', 'userA', 'passwordA', 'userB', 'passwordB', 'disposableAccounts', 'acceptServerMutations'].includes(key))) throw Error('Invalid hosted acceptance configuration')
  if (value.disposableAccounts !== true || value.acceptServerMutations !== true) throw Error('Explicit disposable-account and server-mutation consent are required')
  let url
  try { url = new URL(value.homeserver) } catch { throw Error('A public HTTPS homeserver is required') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443' || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(url.hostname) || isIP(url.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw Error('A public HTTPS homeserver is required')
  for (const user of [value.userA, value.userB]) if (typeof user !== 'string' || user.length > 255 || !/^@[a-z0-9._=\-/+]+:[A-Za-z0-9.\-[\]:]+$/i.test(user)) throw Error('Two full Matrix user IDs are required')
  if (value.userA.toLowerCase() === value.userB.toLowerCase()) throw Error('The two Matrix accounts must differ')
  for (const password of [value.passwordA, value.passwordB]) if (typeof password !== 'string' || !password || password.length > 1024) throw Error('Both account passwords are required')
  return { ...value, homeserver: url.href.replace(/\/+$/, '') }
}
export function validateReport(report, expected) {
  if (!report || report.sdk !== expected.sdk || report.electron !== expected.electron || report.homeserver !== expected.homeserver || !Number.isFinite(Date.parse(report.checkedAt)) || !Array.isArray(report.checks) || report.checks.length !== HOSTED_CHECKS.length) throw Error('Hosted report is incomplete or version mismatched')
  for (const name of HOSTED_CHECKS) if (report.checks.filter((check) => check.id === name && check.passed === true).length !== 1) throw Error('Every hosted acceptance check must pass')
  if (!Array.isArray(report.versions) || !report.versions.length || report.versions.length > 100 || report.versions.some((version) => typeof version !== 'string' || !/^[rv]\d+(?:\.\d+)*$/.test(version) || version.length > 30)) throw Error('Hosted API versions were not recorded')
  if (report.capabilities?.password !== true || !Array.isArray(report.capabilities.names) || report.capabilities.names.length > 100 || report.capabilities.names.some((name) => typeof name !== 'string' || !/^[a-z0-9._-]{1,100}$/.test(name))) throw Error('Hosted capabilities were not recorded')
  // Whitelist fields: raw device/user/event IDs, message bodies and keys never leave the harness.
  return { schema: 1, sdk: report.sdk, electron: report.electron, homeserver: report.homeserver, checkedAt: new Date(report.checkedAt).toISOString(), versions: [...report.versions], capabilities: { password: true, names: [...report.capabilities.names] }, passwordLogin: true, checks: HOSTED_CHECKS.map((id) => ({ id, passed: true })) }
}
