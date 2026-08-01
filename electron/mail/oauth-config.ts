export interface DesktopOAuthConfig {
  clientId: string
  clientSecret: string
}

export interface BuiltInOAuthClients {
  googleConfig?: DesktopOAuthConfig
  microsoftClientId?: string
}

// Microsoft desktop applications are public clients; their application ID is not a secret.
export const DEFAULT_MICROSOFT_CLIENT_ID = '4369b922-aba6-4a2c-acef-2e1c51b8f372'

interface OAuthEnvironment {
  googleClientId?: string
  googleClientSecret?: string
  microsoftClientId?: string
}

function parseGoogleDesktopValues(clientIdValue: unknown, clientSecretValue: unknown): DesktopOAuthConfig {
  const clientId = String(clientIdValue ?? '').trim()
  const clientSecret = String(clientSecretValue ?? '').trim()
  if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) {
    throw new Error('The Google Desktop app configuration is missing its client ID or client secret')
  }
  return { clientId, clientSecret }
}

export function parseMicrosoftClientId(value: unknown): string {
  const clientId = String(value ?? '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    throw new Error('The Microsoft application client ID is not a valid UUID')
  }
  return clientId
}

export function parseOAuthEnvironment(environment: OAuthEnvironment): BuiltInOAuthClients {
  const googleClientId = environment.googleClientId?.trim()
  const googleClientSecret = environment.googleClientSecret?.trim()
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error('Set both MAIN_VITE_GOOGLE_CLIENT_ID and MAIN_VITE_GOOGLE_CLIENT_SECRET')
  }
  return {
    googleConfig: googleClientId && googleClientSecret
      ? parseGoogleDesktopValues(googleClientId, googleClientSecret)
      : undefined,
    microsoftClientId: environment.microsoftClientId?.trim()
      ? parseMicrosoftClientId(environment.microsoftClientId)
      : undefined
  }
}

export function parseDesktopOAuthConfig(value: unknown): DesktopOAuthConfig {
  if (!value || typeof value !== 'object') throw new Error('The selected file is not valid JSON')
  const root = value as { installed?: Record<string, unknown>; web?: Record<string, unknown> }
  if (!root.installed || root.web) {
    throw new Error('Choose OAuth credentials created as a Google “Desktop app”, not a web application')
  }
  const config = parseGoogleDesktopValues(root.installed.client_id, root.installed.client_secret)
  const redirectUris = Array.isArray(root.installed.redirect_uris) ? root.installed.redirect_uris.map(String) : []
  if (redirectUris.length && !redirectUris.some((uri) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(uri))) {
    throw new Error('The Desktop app credential does not permit a local OAuth callback')
  }
  return config
}
