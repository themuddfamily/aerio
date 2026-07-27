import { describe, expect, it } from 'vitest'
import { parseDesktopOAuthConfig } from './oauth-config'

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
})
