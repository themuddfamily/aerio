import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Platform, View, Text, ActivityIndicator } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import { runtime } from '../native/runtime';
import { Button, ErrorText, styles, useMail } from '../ui/common';
import { runNativeAudit } from '../native/audit';
export default function RootLayout() {
  const snapshot = useMail(), [active, setActive] = useState(AppState.currentState === 'active');
  const [audit, setAudit] = useState('');
  useEffect(() => {
    void ScreenCapture.preventScreenCaptureAsync('aerio').catch(() => {});
    if (process.env.EXPO_PUBLIC_NATIVE_AUDIT === '1') void runNativeAudit().then(setAudit);
    if (Platform.OS === 'ios') void ScreenCapture.enableAppSwitcherProtectionAsync().catch(() => {});
    const subscription = AppState.addEventListener('change', (state) => { setActive(state === 'active'); if (state !== 'active') runtime.background(); });
    return () => subscription.remove();
  }, []);
  return <SafeAreaProvider>{!active || snapshot.locked ? <SafeAreaView style={[styles.page, { justifyContent: 'center' }]}><View style={styles.content}><Text style={styles.title}>Aerio</Text><Text style={styles.subtitle}>Your mail, kept private on this device.</Text>{audit && <Text accessibilityLabel={`Native integration audit ${audit}`} style={styles.muted}>Native integration audit: {audit}</Text>}{active && <><Text style={styles.text}>Unlock to open your encrypted offline cache. Device authentication is used when a passcode or biometrics are enrolled.</Text><ErrorText error={snapshot.error} />{snapshot.opening ? <ActivityIndicator accessibilityLabel="Unlocking" /> : <Button title="Unlock Aerio" onPress={() => void runtime.unlock()} />}</>}</View></SafeAreaView> : <Stack screenOptions={{ headerTintColor: '#6558e8', headerStyle: { backgroundColor: '#ffffff' }, contentStyle: styles.page }}><Stack.Screen name="index" options={{ title: 'Aerio Mail' }} /><Stack.Screen name="accounts" options={{ title: 'Accounts' }} /><Stack.Screen name="outbox" options={{ title: 'Drafts & delivery' }} /><Stack.Screen name="compose" options={{ title: 'Compose' }} /><Stack.Screen name="message/[id]" options={{ title: 'Message' }} /></Stack>}</SafeAreaProvider>;
}
