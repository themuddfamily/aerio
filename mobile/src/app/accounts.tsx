import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { runtime } from '../native/runtime';
import { Button, ErrorText, Field, styles, useMail } from '../ui/common';
export default function Accounts() {
  const snapshot = useMail(), [settings, setSettings] = useState(() => runtime.settings()), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const connect = async (provider: 'google' | 'microsoft') => {
    if (busy) return; setBusy(true); setError('');
    try { runtime.saveSettings(settings); await runtime.connect(provider); }
    catch (error) { setError(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  };
  return <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Text style={styles.title}>Your accounts</Text><Text style={styles.subtitle}>Connect directly to Google or Microsoft. Passwords are never entered into Aerio. Account credentials stay in the device keychain.</Text><ErrorText error={error} />
    {snapshot.service?.store.accounts().map((account) => <View key={account.id} style={styles.card}><Text style={styles.subject}>{account.email}</Text><Text style={styles.muted}>{account.provider === 'google' ? 'Google Gmail' : 'Microsoft Graph'} · {account.lastSync ? `Last refreshed ${new Date(account.lastSync).toLocaleString()}` : 'Not refreshed yet'}</Text><View style={styles.row}><Button title={`Reconnect ${account.provider === 'google' ? 'Google' : 'Microsoft'}`} disabled={busy} onPress={() => void connect(account.provider)} /><Button title={`Remove ${account.email}`} disabled={busy} danger onPress={() => Alert.alert('Remove this account?', 'Its cached messages and local drafts will be deleted from this device. Provider mail remains on the server.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { setBusy(true); void runtime.disconnect(account.id).catch((error) => setError(error.message)).finally(() => setBusy(false)); } }])} /></View></View>)}
    <View style={styles.row}><Button title="Connect Google" disabled={busy} onPress={() => void connect('google')} /><Button title="Connect Microsoft" disabled={busy} onPress={() => void connect('microsoft')} /></View>
    <Text style={styles.subject}>Public OAuth configuration</Text><Text style={styles.subtitle}>These are public application IDs, not secrets. Register your own native application before signing in. Google iOS callback schemes are fixed when the app is built.</Text>
    <Field label="Google web client ID" autoCapitalize="none" autoCorrect={false} value={settings.googleWebClientId} onChangeText={(value) => setSettings({ ...settings, googleWebClientId: value.trim() })} />
    <Text style={styles.muted}>Google iOS client ID in this build: {settings.googleIosClientId || 'Not configured — rebuild with EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID'}</Text>
    <Field label="Microsoft application client ID" autoCapitalize="none" autoCorrect={false} value={settings.microsoftClientId} onChangeText={(value) => setSettings({ ...settings, microsoftClientId: value.trim() })} />
    <Field label="Microsoft tenant" autoCapitalize="none" autoCorrect={false} value={settings.microsoftTenant} onChangeText={(value) => setSettings({ ...settings, microsoftTenant: value.trim() })} />
    <Text selectable style={styles.muted}>Microsoft mobile/desktop redirect: aerio://oauth/microsoft</Text>
    <Button title="Save client configuration" disabled={busy} onPress={() => { runtime.saveSettings(settings); Alert.alert('Saved', 'Public client configuration was saved in the encrypted cache.'); }} />
    <Text style={styles.subtitle}>Google’s native SDK keeps one current Google session. Other Gmail accounts retain their offline cache; reconnect the selected Google account before refreshing it. This app supports public Microsoft cloud accounts and Gmail, with foreground refresh only.</Text>
  </ScrollView>;
}
