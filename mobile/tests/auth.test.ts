import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { fetch as nativeFetch } from 'expo/fetch';
import { googleToken } from '../src/native/auth';
import { response } from './http';
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: { configure: jest.fn(), getCurrentUser: jest.fn(), signInSilently: jest.fn(), getTokens: jest.fn() } }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
const account = { id: 'google:a@example.test', subject: 'a@example.test', email: 'a@example.test', name: 'A', provider: 'google' as const };
const settings = { googleIosClientId: 'ios.apps.googleusercontent.com', googleWebClientId: 'web.apps.googleusercontent.com', microsoftClientId: '', microsoftTenant: 'common' };
beforeEach(() => { jest.resetAllMocks(); });
it('rejects a Google token returned after the native singleton switches mailboxes', async () => {
  (GoogleSignin.getCurrentUser as jest.Mock).mockReturnValue({ user: { email: account.email } });
  let finish!: (value: { accessToken: string }) => void;
  (GoogleSignin.getTokens as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  (nativeFetch as jest.Mock).mockResolvedValue(response({ emailAddress: 'b@example.test' }));
  const pending = googleToken(account, settings);
  (GoogleSignin.getCurrentUser as jest.Mock).mockReturnValue({ user: { email: 'b@example.test' } }); finish({ accessToken: 'mailbox-b-token' });
  await expect(pending).rejects.toThrow('session changed accounts');
  expect(nativeFetch).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/profile', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer mailbox-b-token' }) }));
});
it('returns a native Google token only after confirming its Gmail identity', async () => {
  (GoogleSignin.getCurrentUser as jest.Mock).mockReturnValue({ user: { email: account.email } });
  (GoogleSignin.getTokens as jest.Mock).mockResolvedValue({ accessToken: 'mailbox-a-token' });
  (nativeFetch as jest.Mock).mockResolvedValue(response({ emailAddress: account.email }));
  await expect(googleToken(account, settings)).resolves.toBe('mailbox-a-token');
});
