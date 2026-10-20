import type { Account, MicrosoftCredential, Secrets } from './types';
import { writeSecret } from './secret-writes';
import { boundedJson } from './providers';
export const credentialKey = (id: string) => `account.${Array.from(new TextEncoder().encode(id), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
export function microsoftAuthority(tenant: string) {
  if (!/^[a-zA-Z0-9.-]{1,100}$/.test(tenant)) throw new Error('Enter a Microsoft tenant ID, or common, organizations or consumers.');
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}
export class Sessions {
  private refreshing = new Map<string, Promise<string>>();
  constructor(private readonly options: { secrets: Secrets; assert(): void; google(account: Account): Promise<string>; request?: typeof fetch; now?: () => number }) {}
  async token(account: Account): Promise<string> {
    this.options.assert();
    if (account.provider === 'google') { const token = await this.options.google(account); this.options.assert(); return token; }
    const pending = this.refreshing.get(account.id); if (pending) return pending;
    const task = this.microsoft(account);
    this.refreshing.set(account.id, task);
    try { return await task; } finally { this.refreshing.delete(account.id); }
  }
  private async microsoft(account: Account) {
    const saved = await this.options.secrets.get(credentialKey(account.id)); this.options.assert();
    if (!saved) throw new Error('Reconnect your Microsoft account.');
    const credential = JSON.parse(saved) as MicrosoftCredential;
    if (credential.expiresAt > (this.options.now?.() ?? Date.now()) + 60000) return credential.accessToken;
    if (!credential.refreshToken) throw new Error('Reconnect your Microsoft account to renew access.');
    const response = await (this.options.request ?? fetch)(`${microsoftAuthority(credential.tenant)}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: credential.clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken, scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send' }).toString(), redirect: 'error' });
    this.options.assert();
    if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'Reconnect your Microsoft account to renew access.' : 'Token refresh failed. Your offline mail is still available.');
    const token = await boundedJson(response, 128000, false); this.options.assert();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Microsoft did not return an access token.');
    const next: MicrosoftCredential = { ...credential, accessToken: token.access_token, refreshToken: token.refresh_token || credential.refreshToken, expiresAt: (this.options.now?.() ?? Date.now()) + Number(token.expires_in || 3600) * 1000 };
    await writeSecret(this.options.secrets, credentialKey(account.id), JSON.stringify(next), this.options.assert); this.options.assert(); return next.accessToken;
  }
}
