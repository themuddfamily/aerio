import { AppState } from 'react-native';
import { Runtime } from '../src/native/runtime';
import { authenticateDevice, openPrivateStore, secrets } from '../src/native/security';
import { connectMicrosoft } from '../src/native/auth';
import { databaseFixture } from './database';
import { credentialKey } from '../src/core/sessions';
jest.mock('../src/native/security', () => ({ authenticateDevice: jest.fn(), openPrivateStore: jest.fn(), secrets: { get: jest.fn(), set: jest.fn(), remove: jest.fn() } }));
jest.mock('../src/native/auth', () => ({ connectGoogle: jest.fn(), connectMicrosoft: jest.fn(), googleToken: jest.fn(), signOutGoogle: jest.fn() }));
jest.mock('expo-constants', () => ({ expoConfig: { extra: {} } }));
const fixtures: ReturnType<typeof databaseFixture>[] = [];
const vault = new Map<string, string>();
beforeEach(() => {
  jest.resetAllMocks(); vault.clear(); Object.defineProperty(AppState, 'currentState', { value: 'active', writable: true, configurable: true });
  (authenticateDevice as jest.Mock).mockResolvedValue({ protected: true });
  (secrets.get as jest.Mock).mockImplementation(async (key) => vault.get(key) ?? null);
  (secrets.set as jest.Mock).mockImplementation(async (key, value) => { vault.set(key, value); });
  (secrets.remove as jest.Mock).mockImplementation(async (key) => { vault.delete(key); });
});
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function store() { const fixture = databaseFixture(); fixtures.push(fixture); return fixture.open(); }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
it('does not undo a manual lock while device authentication is pending', async () => {
  let finish!: (value: { protected: boolean }) => void;
  (authenticateDevice as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const runtime = new Runtime(), pending = runtime.unlock(); runtime.lock(); finish({ protected: true }); await pending;
  expect(runtime.getSnapshot().locked).toBe(true); expect(openPrivateStore).not.toHaveBeenCalled();
});
it('closes a stale database opening without replacing or closing a newer unlocked session', async () => {
  const older = store(), newer = store(); let finish!: (value: typeof older) => void;
  (openPrivateStore as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(newer);
  const runtime = new Runtime(), pending = runtime.unlock(); await tick(); runtime.lock(); await runtime.unlock(); finish(older); await pending;
  expect(runtime.getSnapshot().service?.store).toBe(newer); expect(runtime.getSnapshot().locked).toBe(false);
  expect(() => older.accounts()).toThrow('Unlock'); expect(newer.accounts()).toEqual([]); runtime.lock();
});
it('cleans an orphan Microsoft credential when locking during the native keychain write', async () => {
  (openPrivateStore as jest.Mock).mockResolvedValue(store());
  const account = { id: 'microsoft:test', provider: 'microsoft', subject: 'test', email: 'test@example.test', name: 'Test' };
  (connectMicrosoft as jest.Mock).mockResolvedValue({ account, credential: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } });
  let finish!: () => void;
  (secrets.set as jest.Mock).mockImplementationOnce(async (key, value) => { await new Promise<void>((resolve) => { finish = resolve; }); vault.set(key, value); });
  const runtime = new Runtime(); await runtime.unlock(); const pending = runtime.connect('microsoft'); await tick(); runtime.lock(); finish();
  await expect(pending).rejects.toThrow('Unlock'); expect(vault.has(credentialKey(account.id))).toBe(false);
});
