export interface DesktopOAuthConfig {
  clientId: string
  clientSecret: string
}

export function parseDesktopOAuthConfig(value: unknown): DesktopOAuthConfig {
  if (!value || typeof value !== 'object') throw new Error('The selected file is not valid JSON')
  const root = value as { installed?: Record<string, unknown>; web?: Record<string, unknown> }
  if (!root.installed || root.web) {
    throw new Error('Choose OAuth credentials created as a Google “Desktop app”, not a web application')
  }
  const clientId = String(root.installed.client_id ?? '')
  const clientSecret = String(root.installed.client_secret ?? '')
  const redirectUris = Array.isArray(root.installed.redirect_uris) ? root.installed.redirect_uris.map(String) : []
  if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) {
    throw new Error('The credential file is missing its client ID or client secret')
  }
  if (redirectUris.length && !redirectUris.some((uri) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(uri))) {
    throw new Error('The Desktop app credential does not permit a local OAuth callback')
  }
  return { clientId, clientSecret }
}
