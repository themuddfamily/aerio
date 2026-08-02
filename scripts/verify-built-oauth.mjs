import { readFile } from 'node:fs/promises'

if (process.env.AERIO_REQUIRE_BUILTIN_OAUTH !== '1') {
  console.log('Built-in OAuth bundle verification skipped for this development build.')
  process.exit(0)
}

const clientId = process.env.MAIN_VITE_GOOGLE_CLIENT_ID || '409593140252-du36j5ojpe8q2tfpvb46nprmgdfuck5k.apps.googleusercontent.com'
const clientSecret = process.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
if (!clientSecret) {
  console.error('Built-in OAuth bundle verification failed: GOOGLE_OAUTH_CLIENT_SECRET is unavailable.')
  process.exit(1)
}

const mainBundle = await readFile(new URL('../dist-electron/main/main.js', import.meta.url), 'utf8')
const missing = []
if (!mainBundle.includes(clientId)) missing.push('Google client ID')
if (!mainBundle.includes(clientSecret)) missing.push('Google client secret')

if (missing.length) {
  console.error(`Built-in OAuth bundle verification failed: compiled main process is missing ${missing.join(' and ')}.`)
  process.exit(1)
}

console.log('Built-in Google OAuth configuration is present in the compiled main process.')
