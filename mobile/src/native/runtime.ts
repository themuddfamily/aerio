import { AppState } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { fetch as nativeFetch } from 'expo/fetch';
import { MailService } from '../core/service';
import { Sessions, credentialKey } from '../core/sessions';
import { removeSecret, writeSecret } from '../core/secret-writes';
import { providerClient } from '../core/providers';
import type { ClientSettings, Provider } from '../core/types';
import { authenticateDevice, openPrivateStore, secrets } from './security';
import { connectGoogle, connectMicrosoft, googleToken, signOutGoogle } from './auth';
const defaults: ClientSettings = { googleIosClientId: Constants.expoConfig?.extra?.googleIosClientId ?? '', googleWebClientId: Constants.expoConfig?.extra?.googleWebClientId ?? '', microsoftClientId: Constants.expoConfig?.extra?.microsoftClientId ?? '', microsoftTenant: Constants.expoConfig?.extra?.microsoftTenant ?? 'common' };
type Snapshot = { locked: boolean; opening: boolean; error: string; deviceProtected: boolean; version: number; service?: MailService };
export class Runtime {
  private snapshot: Snapshot = { locked: true, opening: false, error: '', deviceProtected: false, version: 0 };
  private listeners = new Set<() => void>();
  private externalAuth = false;
  private generation = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  changed = () => { this.snapshot = { ...this.snapshot, version: this.snapshot.version + 1 }; for (const listener of this.listeners) listener(); };
  assert = () => { if (this.snapshot.locked || !this.snapshot.service) throw new Error('Unlock Aerio to use your mail.'); this.snapshot.service.assert(); };
  settings(): ClientSettings { this.assert(); return { ...defaults, ...this.snapshot.service!.store.setting<Partial<ClientSettings>>('clients'), googleIosClientId: defaults.googleIosClientId }; }
  saveSettings(settings: ClientSettings) { this.assert(); this.snapshot.service!.store.setSetting('clients', { ...settings, googleIosClientId: defaults.googleIosClientId }); this.changed(); }
  lock = () => { this.generation++; this.snapshot.service?.lock(); this.snapshot = { ...this.snapshot, locked: true, opening: false, service: undefined, error: '', version: this.snapshot.version + 1 }; for (const listener of this.listeners) listener(); };
  async unlock() {
    if (this.snapshot.opening || !this.snapshot.locked) return;
    const generation = ++this.generation;
    this.snapshot = { ...this.snapshot, opening: true, error: '' }; this.changed();
    try {
      const device = await authenticateDevice();
      if (generation !== this.generation) return;
      const store = await openPrivateStore();
      if (generation !== this.generation) { store.close(); return; }
      if (AppState.currentState !== 'active') { store.close(); throw new Error('Return to Aerio to unlock your mail.'); }
      const sessions = new Sessions({ secrets, request: nativeFetch, assert: () => { this.assert(); if (this.snapshot.service !== service) throw new Error('This session has ended.'); }, google: (account) => googleToken(account, this.settings()) });
      const service = new MailService(store, { token: (account) => sessions.token(account), provider: (account) => providerClient(account.provider, nativeFetch), id: () => Crypto.randomUUID(), changed: this.changed });
      this.snapshot = { locked: false, opening: false, error: '', deviceProtected: device.protected, service, version: this.snapshot.version + 1 };
    } catch (error) { if (generation !== this.generation) return; this.snapshot = { ...this.snapshot, locked: true, opening: false, error: error instanceof Error ? error.message : 'Unable to unlock the encrypted cache.' }; }
    if (generation === this.generation) this.changed();
  }
  background() { if (!this.externalAuth) this.lock(); }
  async connect(provider: Provider) {
    this.assert(); if (this.externalAuth) throw new Error('Finish the current sign-in first.');
    const service = this.snapshot.service!, generation = this.generation; const settings = this.settings(); this.externalAuth = true;
    const guard = () => { this.assert(); if (generation !== this.generation || this.snapshot.service !== service) throw new Error('Session ended. Reconnect after unlocking.'); };
    try {
      if (provider === 'google') { const account = await connectGoogle(settings); guard(); const previous = service.store.account(account.id); service.store.saveAccount({ ...previous, ...account }); }
      else { const { account, credential } = await connectMicrosoft(settings); guard(); await writeSecret(secrets, credentialKey(account.id), JSON.stringify(credential), guard); guard(); const previous = service.store.account(account.id); service.store.saveAccount({ ...previous, ...account }); }
    } finally { this.externalAuth = false; if (generation === this.generation) { if (AppState.currentState !== 'active') this.lock(); else this.changed(); } }
  }
  async disconnect(id: string) {
    this.assert(); const service = this.snapshot.service!, account = service.store.account(id); if (!account) return;
    if (this.externalAuth) throw new Error('Finish the current sign-in first.');
    service.store.removeAccount(id);
    // End this generation before awaiting keychain/native sign-out work.
    this.lock();
    await removeSecret(secrets, credentialKey(id));
    if (account.provider === 'google') await signOutGoogle(account);
  }
}
export const runtime = new Runtime();
