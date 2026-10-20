import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import type { MailAction } from '../../core/types';
import { Button, ErrorText, styles, useMail } from '../../ui/common';
export default function Reader() {
  const { id, accountId } = useLocalSearchParams<{ id: string; accountId: string }>(), { service } = useMail();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const message = service?.store.message(accountId, id);
  if (!message || !service) return <View style={styles.content}><Text style={styles.text}>This message is no longer in the local cache. Refresh its inbox.</Text></View>;
  const change = async (action: MailAction) => {
    setError(''); setBusy(true);
    try { service.queueAction(message, action); await service.sync(accountId); if (action.kind === 'archive' || action.kind === 'trash') router.back(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Change saved for later refresh.'); }
    finally { setBusy(false); }
  };
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}><Text style={styles.title}>{message.subject}</Text><Text selectable style={styles.text}>From: {message.from}</Text><Text selectable style={styles.muted}>To: {message.to}{'\n'}{new Date(message.receivedAt).toLocaleString()}</Text><ErrorText error={error} /><View style={styles.row}>
    <Button title="Reply" disabled={busy} onPress={() => router.push({ pathname: '/compose', params: { accountId, replyId: message.id } })} />
    <Button title={message.read ? 'Mark unread' : 'Mark read'} disabled={busy} onPress={() => void change({ kind: 'read', value: !message.read })} />
    <Button title={message.starred ? 'Unstar' : 'Star'} disabled={busy} onPress={() => void change({ kind: 'star', value: !message.starred })} />
    <Button title="Archive" disabled={busy} onPress={() => void change({ kind: 'archive' })} /><Button title="Trash" disabled={busy} danger onPress={() => Alert.alert('Move message to Trash?', 'The change will be sent when you refresh this account.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Move to Trash', style: 'destructive', onPress: () => void change({ kind: 'trash' }) }])} />
  </View><View style={styles.card}><Text selectable style={styles.text}>{message.body || 'No plain-text body is available.'}</Text></View>{message.attachmentNames.length > 0 && <Text style={styles.subtitle}>Attachments: {message.attachmentNames.join(', ')}. Open the provider’s app to download attachments.</Text>}<Text style={styles.muted}>Plain-text view. Remote content is never loaded. Mail changes saved offline appear in Drafts & delivery.</Text></ScrollView>;
}
