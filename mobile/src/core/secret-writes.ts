import type { Secrets } from './types';
const queues = new WeakMap<Secrets, Map<string, Promise<void>>>();
async function serialized<T>(secrets: Secrets, key: string, work: () => Promise<T>): Promise<T> {
  let keys = queues.get(secrets); if (!keys) { keys = new Map(); queues.set(secrets, keys); }
  const previous = keys.get(key) ?? Promise.resolve();
  let release!: () => void; const next = new Promise<void>((resolve) => { release = resolve; }); keys.set(key, next);
  await previous.catch(() => {});
  try { return await work(); } finally { release(); if (keys.get(key) === next) keys.delete(key); }
}
/** Cleanup is inside the same key queue, before a later session can store a credential. */
export function writeSecret(secrets: Secrets, key: string, value: string, guard: () => void) {
  return serialized(secrets, key, async () => {
    guard(); const previous = await secrets.get(key); guard();
    try { await secrets.set(key, value); guard(); }
    catch (error) {
      if (await secrets.get(key) === value) { if (previous === null) await secrets.remove(key); else await secrets.set(key, previous); }
      throw error;
    }
  });
}
export const removeSecret = (secrets: Secrets, key: string) => serialized(secrets, key, () => secrets.remove(key));
