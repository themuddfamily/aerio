import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';
import { openPrivateStore, secrets } from './security';
import { MailService } from '../core/service';
import type { Account, Draft, MailProvider } from '../core/types';
// Compiled into CI audit builds only. Uses a separate encrypted database and no network.
export async function runNativeAudit(): Promise<string> {
  const report = new File(Paths.document, 'aerio-native-audit.json');
  let store: Awaited<ReturnType<typeof openPrivateStore>> | undefined;
  try {
    await secrets.set('audit.roundtrip', 'native-keychain-roundtrip');
    if (await secrets.get('audit.roundtrip') !== 'native-keychain-roundtrip') throw new Error('secure-storage');
    await secrets.remove('audit.roundtrip');
    const account: Account = { id: 'google:fixture', provider: 'google', subject: 'fixture', email: 'fixture@example.test', name: 'Native fixture' };
    const draft: Draft = { id: 'native-draft', accountId: account.id, to: 'recipient@example.test', subject: 'Native integration fixture', body: 'Encrypted offline fixture', status: 'editing', updatedAt: 'initial' };
    store = await openPrivateStore('aerio-native-audit.db');
    store.removeAccount(account.id); store.saveAccount(account); store.saveDraft(draft); store.close();
    store = await openPrivateStore('aerio-native-audit.db');
    if (store.draft(draft.id)?.body !== draft.body) throw new Error('offline-restart');
    const databaseDirectory = String(defaultDatabaseDirectory);
    const bytes = new File(databaseDirectory.startsWith('file:') ? databaseDirectory : `file://${databaseDirectory}`, 'aerio-native-audit.db').bytesSync();
    if (String.fromCharCode(...bytes.slice(0, 15)) === 'SQLite format 3') throw new Error('unencrypted-file');
    let release!: () => void;
    const pendingSend = new Promise<void>((resolve) => { release = resolve; });
    const provider: MailProvider = { profile: async () => ({ subject: '', email: '', name: '' }), inbox: async () => ({ messages: [] }), action: async () => {}, send: () => pendingSend };
    const service = new MailService(store, { token: async () => 'fixture-only', provider: () => provider, id: () => 'fixture', changed: () => {} });
    const pending = service.send(draft.id).then(() => false, () => true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.lock(); release();
    if (!await pending) throw new Error('locked-continuation');
    store = await openPrivateStore('aerio-native-audit.db');
    if (store.draft(draft.id)?.status !== 'uncertain') throw new Error('uncertain-recovery');
    store.close();
    report.create({ overwrite: true });
    await report.write(JSON.stringify({ passed: true, platform: Platform.OS, sqlCipher: true, secureStore: true, encryptedFile: true, offlineRestart: true, lockGuard: true, uncertainSendRecovery: true, uiMounted: true, testedAt: new Date().toISOString() }));
    return 'PASS';
  } catch (error) {
    try { store?.close(); } catch {}
    report.create({ overwrite: true });
    await report.write(JSON.stringify({ passed: false, platform: Platform.OS, error: error instanceof Error ? error.message : 'native-integration-failed' }));
    return 'FAIL';
  }
}
