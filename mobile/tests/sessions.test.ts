import { response } from './http';
import { credentialKey, microsoftAuthority, Sessions } from '../src/core/sessions';
import type { Account, MicrosoftCredential, Secrets } from '../src/core/types';
const account: Account = { id: 'microsoft:id', subject: 'id', provider: 'microsoft', email: 'person@example.test', name: 'Person' };
const credential: MicrosoftCredential = { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1, clientId: 'public-client', tenant: 'common' };
function setup() {
  const map = new Map([[credentialKey(account.id), JSON.stringify(credential)]]);
  const secrets: jest.Mocked<Secrets> = { get: jest.fn(async (key) => map.get(key) ?? null), set: jest.fn(async (key, value) => { map.set(key, value); }), remove: jest.fn(async (key) => { map.delete(key); }) };
  const request = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }));
  let locked = false; const sessions = new Sessions({ secrets, request, assert: () => { if (locked) throw new Error('locked'); }, google: jest.fn(), now: () => 10000 });
  return { sessions, secrets, request, map, lock: () => { locked = true; } };
}
it('serializes refreshes, rotates tokens only in the secret vault and never sends a client secret', async () => {
  const { sessions, secrets, request } = setup();
  expect(await Promise.all([sessions.token(account), sessions.token(account)])).toEqual(['new-access', 'new-access']);
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][1]?.body).not.toContain('client_secret');
  expect(JSON.parse(secrets.set.mock.calls[0][1])).toMatchObject({ accessToken: 'new-access', refreshToken: 'rotated-refresh' });
});
it('does not recreate credentials if a session locks during refresh', async () => {
  const fixture = setup(); fixture.request.mockImplementationOnce(async () => { fixture.lock(); return response({ access_token: 'new' }); });
  await expect(fixture.sessions.token(account)).rejects.toThrow('locked'); expect(fixture.secrets.set).not.toHaveBeenCalled();
});
it('rejects arbitrary Microsoft authority URLs and generates SecureStore-compatible keys', () => {
  expect(() => microsoftAuthority('common/../../evil')).toThrow(); expect(credentialKey(account.id)).toMatch(/^[a-zA-Z0-9._-]+$/);
});
