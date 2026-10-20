import { useSyncExternalStore } from 'react';
import { Pressable, Text, StyleSheet, View, TextInput, type TextInputProps } from 'react-native';
import { runtime } from '../native/runtime';
export const useMail = () => useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
export function Button({ title, onPress, disabled = false, danger = false }: { title: string; onPress(): void; disabled?: boolean; danger?: boolean }) { return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} disabled={disabled} style={[styles.button, danger && styles.danger, disabled && styles.disabled]}><Text style={styles.buttonText}>{title}</Text></Pressable>; }
export function Field({ label, ...props }: TextInputProps & { label: string }) { return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} style={[styles.input, props.multiline && styles.multiline]} placeholderTextColor="#6b7080" {...props} /></View>; }
export function ErrorText({ error }: { error?: string }) { return error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null; }
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f6f7fb' }, content: { padding: 20, gap: 14 }, title: { fontSize: 28, fontWeight: '700', color: '#242535' }, subtitle: { fontSize: 15, lineHeight: 22, color: '#62677b' },
  card: { backgroundColor: '#ffffff', padding: 18, borderRadius: 14, gap: 8, borderWidth: 1, borderColor: '#e3e5ef' }, subject: { color: '#242535', fontSize: 17, fontWeight: '600' }, text: { color: '#34384a', fontSize: 16, lineHeight: 25 }, muted: { color: '#656b80', fontSize: 13 },
  button: { backgroundColor: '#6558e8', paddingHorizontal: 16, paddingVertical: 13, minHeight: 46, borderRadius: 10, alignItems: 'center' }, buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 15 }, disabled: { opacity: 0.45 }, danger: { backgroundColor: '#b52f43' },
  field: { gap: 6 }, label: { color: '#4a5066', fontWeight: '600', fontSize: 14 }, input: { borderColor: '#cbd0e0', borderWidth: 1, backgroundColor: 'white', color: '#242535', padding: 12, borderRadius: 10, fontSize: 16, minHeight: 48 }, multiline: { minHeight: 150, textAlignVertical: 'top' }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, error: { color: '#a3263b', fontSize: 15, lineHeight: 22 },
});
