import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { Draft } from '../core/types';
import { recipients } from '../core/providers';
import { Button, ErrorText, Field, styles, useMail } from '../ui/common';
export default function Compose() {
  const params = useLocalSearchParams<{ accountId?: string; id?: string; replyId?: string }>(), { service } = useMail();
  const [draft, setDraft] = useState<Draft>(() => {
    const existing = params.id && service?.store.draft(params.id); if (existing) return existing;
    const accountId = params.accountId ?? service!.store.accounts()[0]?.id ?? '', original = params.replyId ? service?.store.message(accountId, params.replyId) : undefined;
    return { id: Crypto.randomUUID(), accountId, to: original?.replyTo ?? '', subject: (original ? /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}` : '').slice(0, 2000), body: (original ? `\n\nOn ${new Date(original.receivedAt).toLocaleString()}, ${original.from} wrote:\n${original.body.split('\n').map((line) => `> ${line}`).join('\n')}` : '').slice(0, 250000), inReplyTo: original?.internetMessageId, threadId: original?.threadId, status: 'editing', updatedAt: new Date().toISOString() };
  });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (service && !service.store.draft(draft.id) && draft.accountId) service.saveDraft(draft); }, [service, draft]);
  if (!service || !draft.accountId) return <View style={styles.content}><Text>Connect an account before composing.</Text></View>;
  const current = service.store.draft(draft.id) ?? draft, editable = ['editing', 'failed'].includes(current.status);
  const change = (patch: Partial<Draft>) => { const next = { ...draft, ...patch }; try { service.saveDraft(next); setDraft(next); setError(''); } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save draft.'); } };
  const send = () => {
    try { recipients(draft.to); } catch (error) { setError((error as Error).message); return; }
    Alert.alert('Send this email?', `From ${service.store.account(draft.accountId)?.email}\nTo ${draft.to}\n${draft.subject || '(No subject)'}`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Send', onPress: () => { setBusy(true); setError(''); void service.send(draft.id).then(() => router.replace('/outbox')).catch((error) => setError(error.message)).finally(() => setBusy(false)); } }]);
  };
  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Text style={styles.muted}>From {service.store.account(draft.accountId)?.email} · Draft saved on this device</Text><ErrorText error={error || current.error} /><Text style={styles.subtitle}>{current.status === 'sent' ? 'Accepted by the provider. Final delivery may still be pending.' : current.status === 'uncertain' ? 'Delivery is uncertain. Check Sent mail before making a new copy.' : current.status === 'sending' ? 'Submitting to the provider…' : 'Plain-text email. Drafts are never sent automatically.'}</Text>
    <Field label="To" editable={editable && !busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" value={draft.to} onChangeText={(to) => change({ to })} />
    <Field label="Subject" editable={editable && !busy} value={draft.subject} onChangeText={(subject) => change({ subject })} maxLength={2000} />
    <Field label="Message" editable={editable && !busy} value={draft.body} onChangeText={(body) => change({ body })} multiline maxLength={250000} />
    <Button title="Send email" disabled={!editable || busy} onPress={send} />
    {current.status === 'uncertain' && <Button title="Copy into a new draft" onPress={() => Alert.alert('Check Sent mail first', 'A connection failure can happen after your provider accepted the email. Only create another copy if you have checked for the original.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Create unsent copy', onPress: () => { const copy = { ...draft, id: Crypto.randomUUID(), status: 'editing' as const, error: undefined, updatedAt: new Date().toISOString() }; service.saveDraft(copy); router.replace({ pathname: '/compose', params: { id: copy.id } }); setDraft(copy); } }])} />}
  </ScrollView></KeyboardAvoidingView>;
}
