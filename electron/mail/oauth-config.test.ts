import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GOOGLE_CLIENT_ID,
  DEFAULT_MICROSOFT_CLIENT_ID,
  parseDesktopOAuthConfig,
  parseOAuthEnvironment
} from './oauth-config'

describe('parseDesktopOAuthConfig', () => {
  it('accepts Google Desktop app credentials', () => {
    expect(parseDesktopOAuthConfig({
      installed: {
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        redirect_uris: ['http://localhost']
      }
    })).toEqual({
      clientId: '123.apps.googleusercontent.com',
      clientSecret: 'secret'
    })
  })

  it('rejects web credentials and non-loopback redirect URIs', () => {
    expect(() => parseDesktopOAuthConfig({
      web: { client_id: '123.apps.googleusercontent.com', client_secret: 'secret' }
    })).toThrow(/Desktop app/)
    expect(() => parseDesktopOAuthConfig({
      installed: {
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        redirect_uris: ['https://example.com/oauth']
      }
    })).toThrow(/local OAuth callback/)
  })

  it('creates built-in OAuth clients from main-process environment values', () => {
    expect(parseOAuthEnvironment({
      googleClientId: '123.apps.googleusercontent.com',
      googleClientSecret: 'desktop-secret',
      microsoftClientId: '12345678-1234-4234-9234-123456789abc'
    })).toEqual({
      googleConfig: {
        clientId: '123.apps.googleusercontent.com',
        clientSecret: 'desktop-secret'
      },
      microsoftClientId: '12345678-1234-4234-9234-123456789abc'
    })
  })

  it('requires complete and valid environment registrations', () => {
    expect(() => parseOAuthEnvironment({ googleClientId: '123.apps.googleusercontent.com' }))
      .toThrow(/both MAIN_VITE_GOOGLE_CLIENT_ID/)
    expect(() => parseOAuthEnvironment({ microsoftClientId: 'not-a-uuid' }))
      .toThrow(/valid UUID/)
  })

  it('keeps Aerio’s default Microsoft registration valid', () => {
    expect(parseOAuthEnvironment({ microsoftClientId: DEFAULT_MICROSOFT_CLIENT_ID }))
      .toEqual({ googleConfig: undefined, microsoftClientId: DEFAULT_MICROSOFT_CLIENT_ID })
  })

  it('keeps Aerio’s default Google registration valid', () => {
    expect(parseOAuthEnvironment({
      googleClientId: DEFAULT_GOOGLE_CLIENT_ID,
      googleClientSecret: 'desktop-secret'
    }).googleConfig).toEqual({
      clientId: DEFAULT_GOOGLE_CLIENT_ID,
      clientSecret: 'desktop-secret'
    })
  })
})
