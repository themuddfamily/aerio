import type { ExchangeAccountInput, ExchangeAuthMethod, ExchangeAuthPreference } from '../../src/exchange-types'
import { EwsClient } from './ews-client'
import { assertSecureEndpoint } from './ews-transport'

/**
 * Connection settings for one Exchange account, kept with the password or token in the
 * OS-encrypted credential vault (oauth-vault.dat) and handed to the mail worker on request.
 */
export interface ExchangeAccountConfig {
  email: string
  username: string
  password?: string
  bearerToken?: string
  ewsUrl: string
  auth: ExchangeAuthMethod
  serverVersion?: string
}

/** Settings for a client before the authentication method is known ('auto' during setup). */
export type ExchangeClientConfig = Omit<ExchangeAccountConfig, 'auth'> & { auth: ExchangeAuthPreference }

export function ewsClientFor(config: ExchangeClientConfig) {
  return new EwsClient({ url: config.ewsUrl, credentials: { auth: config.auth, username: config.username, password: config.password, bearerToken: config.bearerToken } })
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Validates renderer input for a new Exchange account; the auth method may still be 'auto'. */
export function validateExchangeInput(input: ExchangeAccountInput) {
  if (!input || typeof input !== 'object') throw new Error('Complete the Exchange account details')
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (!EMAIL.test(email) || email.length > 320) throw new Error('Enter a valid email address')
  const username = typeof input.username === 'string' && input.username.trim() ? input.username.trim() : email
  if (username.length > 320 || /[\r\n]/.test(username)) throw new Error('Enter a valid user name')
  if (!['auto', 'basic', 'ntlm', 'bearer'].includes(input.auth)) throw new Error('Choose an authentication method')
  const password = typeof input.password === 'string' ? input.password : undefined
  const bearerToken = typeof input.bearerToken === 'string' && input.bearerToken.trim() ? input.bearerToken.trim() : undefined
  if (password !== undefined && password.length > 1_000) throw new Error('The password is too long')
  if (bearerToken && (bearerToken.length > 20_000 || /\s/.test(bearerToken))) throw new Error('Paste a valid access token')
  if (input.auth === 'bearer' && !bearerToken) throw new Error('Paste an OAuth access token for EWS')
  if ((input.auth === 'basic' || input.auth === 'ntlm') && !password) throw new Error('Enter the account password')
  if (input.auth === 'auto' && !password && !bearerToken) throw new Error('Enter the account password')
  if (typeof input.ewsUrl !== 'string' || input.ewsUrl.length > 2_000) throw new Error('Enter the EWS URL')
  const url = assertSecureEndpoint(input.ewsUrl.trim(), 'The EWS URL')
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 200) : ''
  return { email, username, password: password || undefined, bearerToken, ewsUrl: url.toString(), auth: input.auth, displayName }
}
