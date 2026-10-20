import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { MailStore } from '../core/store';
import type { Secrets } from '../core/types';
export const secrets: Secrets = {
  get: (key) => SecureStore.getItemAsync(key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  set: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: (key) => SecureStore.deleteItemAsync(key)
};
const keyCreations = new Map<string, Promise<string>>();
async function databaseKey(name: string): Promise<string> {
  const pending = keyCreations.get(name); if (pending) return pending;
  const creation = (async () => { const saved = await secrets.get(name); if (saved) return saved; const key = Array.from(await Crypto.getRandomBytesAsync(32), (byte) => byte.toString(16).padStart(2, '0')).join(''); await secrets.set(name, key); return key; })();
  keyCreations.set(name, creation);
  try { return await creation; } finally { keyCreations.delete(name); }
}
export async function openPrivateStore(name: 'aerio-private.db' | 'aerio-native-audit.db' = 'aerio-private.db') {
  if (!await SecureStore.isAvailableAsync()) throw new Error('This device does not provide secure credential storage.');
  const db = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
  try {
    const cipher = db.getFirstSync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new Error('This build has no SQLCipher. Install an Aerio native build; Expo Go cannot securely cache mail.');
    const keyName = name === 'aerio-private.db' ? 'database.key' : 'audit.database.key';
    const key = await databaseKey(keyName);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('The database key is invalid. Restore access to the device keychain.');
    db.execSync(`PRAGMA key="x'${key}'"`);
    return new MailStore(db);
  } catch (error) { db.closeSync(); throw error; }
}
export async function authenticateDevice(): Promise<{ protected: boolean }> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) return { protected: false };
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Aerio', disableDeviceFallback: false, cancelLabel: 'Cancel', fallbackLabel: 'Use device passcode' });
  if (!result.success) throw new Error('Unlock cancelled. Your mail remains hidden.');
  return { protected: true };
}
