import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, View, Text, Pressable, RefreshControl, TextInput } from 'react-native';
import { Button, ErrorText, styles, useMail } from '../ui/common';
import { runtime } from '../native/runtime';
export default function Inbox() {
  const { service, deviceProtected } = useMail();
  const [selected, setSelected] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('');
  if (!service) return null;
  const accounts = service.store.accounts(), messages = service.store.messages(selected).filter((message) => `${message.subject} ${message.from} ${message.preview}`.toLowerCase().includes(query.toLowerCase()));
  const sync = async (more = false) => {
    if (busy) return; setBusy(true); setError('');
    try { for (const account of accounts.filter((account) => !selected || account.id === selected)) if (!more || account.cursor) await service.sync(account.id, more); }
    catch (error) { setError(error instanceof Error ? error.message : 'Refresh failed. Your offline mail remains available.'); }
    finally { setBusy(false); }
  };
  return <View style={styles.page}><FlatList data={messages} keyExtractor={(message) => `${message.accountId}:${message.id}`} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void sync()} />} ListHeaderComponent={<View style={{ gap: 12 }}>
    <View style={styles.row}><Button title="Accounts" onPress={() => router.push('/accounts')} /><Button title="Drafts & delivery" onPress={() => router.push('/outbox')} /><Button title="Lock" onPress={runtime.lock} /></View>
    <Text style={styles.title}>Inbox</Text><Text style={styles.muted}>Encrypted offline cache · {accounts.length} account{accounts.length === 1 ? '' : 's'}</Text>
    {!deviceProtected && <Text style={styles.error}>Set a device passcode or biometrics for authenticated unlocking. This device currently has no enrolled screen lock.</Text>}
    <View style={styles.row}><Button title="All accounts" onPress={() => setSelected(undefined)} />{accounts.map((account) => <Button key={account.id} title={`${selected === account.id ? '✓ ' : ''}${account.email}`} onPress={() => setSelected(account.id)} />)}</View>
    <TextInput accessibilityLabel="Search cached mail" placeholder="Search cached mail" style={styles.input} value={query} onChangeText={setQuery} />
    <View style={styles.row}><Button title="Refresh inbox" disabled={busy || !accounts.length} onPress={() => void sync()} /><Button title="Compose" disabled={!accounts.length} onPress={() => router.push({ pathname: '/compose', params: { accountId: selected ?? accounts[0].id } })} /></View>
    <ErrorText error={error} />
  </View>} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.read ? '' : 'Unread: '}${item.subject}`} onPress={() => router.push({ pathname: '/message/[id]', params: { id: item.id, accountId: item.accountId } })} style={[styles.card, !item.read && { borderLeftWidth: 4, borderLeftColor: '#6558e8' }]}><Text style={styles.muted}>{item.from} {item.starred ? '★' : ''}</Text><Text style={styles.subject}>{item.subject}</Text><Text numberOfLines={2} style={styles.subtitle}>{item.preview}</Text><Text style={styles.muted}>{accounts.find((account) => account.id === item.accountId)?.email} · {new Date(item.receivedAt).toLocaleString()}</Text></Pressable>} ListEmptyComponent={<View style={styles.card}><Text style={styles.subject}>{accounts.length ? 'No cached inbox messages' : 'Welcome to Aerio'}</Text><Text style={styles.text}>{accounts.length ? 'Refresh to download up to 40 messages per account. Cached messages remain readable offline.' : 'Connect a Gmail or Microsoft mailbox in Accounts. Sign-in stays with your provider.'}</Text><Button title="Manage accounts" onPress={() => router.push('/accounts')} /></View>} ListFooterComponent={accounts.some((account) => (!selected || account.id === selected) && account.cursor) ? <Button title="Load more messages" disabled={busy} onPress={() => void sync(true)} /> : <Text style={styles.muted}>Plain-text reading blocks remote images and tracking resources. Attachments and advanced desktop features are not available in this companion.</Text>} /></View>;
}
