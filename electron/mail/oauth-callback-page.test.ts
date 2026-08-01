import { describe, expect, it } from 'vitest'
import { OAUTH_CALLBACK_HEADERS, oauthCallbackPage } from './oauth-callback-page'

describe('oauthCallbackPage', () => {
  it('renders a self-contained branded success page', () => {
    const page = oauthCallbackPage({ kind: 'success', provider: 'Google' })
    expect(page).toContain('Google sign-in')
    expect(page).toContain('You’re all set')
    expect(page).toContain('Authorization received')
    expect(page).toContain('aerio')
    expect(page).toContain('@media(prefers-color-scheme:dark)')
    expect(page).not.toMatch(/<script|https?:\/\//i)
  })

  it('gives denied and invalid callbacks distinct, safe guidance', () => {
    const denied = oauthCallbackPage({ kind: 'denied', provider: 'Microsoft' })
    const invalid = oauthCallbackPage({ kind: 'invalid-state', provider: 'Google' })
    expect(denied).toContain('Connection not completed')
    expect(denied).toContain('Microsoft sign-in')
    expect(invalid).toContain('This request couldn’t be verified')
    expect(invalid).not.toContain('Google returned an invalid OAuth state')
  })

  it('prevents callback pages from being cached or loading remote content', () => {
    expect(OAUTH_CALLBACK_HEADERS['Cache-Control']).toBe('no-store')
    expect(OAUTH_CALLBACK_HEADERS['Content-Security-Policy']).toContain("default-src 'none'")
    expect(OAUTH_CALLBACK_HEADERS['Referrer-Policy']).toBe('no-referrer')
  })
})
