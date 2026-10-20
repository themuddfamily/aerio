import { writeSecret } from '../src/core/secret-writes';
import type { Secrets } from '../src/core/types';
it('cleans a stale write before a newer session writes the same key', async () => {
  const map = new Map<string, string>(); let finish!: () => void, stale = false, initial = true;
  const secrets: Secrets = { get: async (key) => map.get(key) ?? null, remove: async (key) => { map.delete(key); }, set: async (key, value) => { if (initial) { initial = false; await new Promise<void>((resolve) => { finish = resolve; }); } map.set(key, value); } };
  const older = writeSecret(secrets, 'account', 'old-secret', () => { if (stale) throw new Error('stale'); }).catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve)); stale = true;
  const newer = writeSecret(secrets, 'account', 'new-secret', () => {}); finish(); await Promise.all([older, newer]);
  expect(map.get('account')).toBe('new-secret');
});
it('cleans a keychain write that commits but returns an error', async () => {
  const map = new Map<string, string>();
  const secrets: Secrets = { get: async (key) => map.get(key) ?? null, remove: async (key) => { map.delete(key); }, set: async (key, value) => { map.set(key, value); throw new Error('Native response lost'); } };
  await expect(writeSecret(secrets, 'account', 'orphan', () => {})).rejects.toThrow('Native response lost'); expect(map.has('account')).toBe(false);
});
