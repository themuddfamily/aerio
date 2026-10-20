import type { Draft, MailProvider, Message } from './types';
export class ProviderError extends Error { constructor(message: string, readonly submitted: boolean, readonly status?: number) { super(message); } }
class ResponseLimitError extends ProviderError { constructor(submitted: boolean) { super('This message or page exceeds the mobile download limit. Open it in your provider app.', submitted); } }
export async function boundedJson(response: Response, maximum: number, submitted: boolean) {
  if (Number(response.headers?.get('Content-Length')) > maximum) { void response.body?.cancel().catch(() => {}); throw new ResponseLimitError(submitted); }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('This runtime cannot stream bounded mail responses. Use a native Aerio build.', submitted);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > maximum) { void reader.cancel().catch(() => {}); throw new ResponseLimitError(submitted); } chunks.push(part.value); }
    if (!length) return undefined;
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) { if (error instanceof ResponseLimitError) throw error; throw new ProviderError('The provider response could not be confirmed.', submitted); }
  finally { reader.releaseLock(); }
}
const previewLimit = 250000;
const omittedBody = 'This message is too large or complex for a mobile preview. Open it in your provider app.';
export function recipients(value: string): string[] {
  const addresses = value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  if (!addresses.length || addresses.length > 50 || addresses.some((item) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item))) throw new Error('Enter up to 50 email addresses, separated by commas.');
  return [...new Set(addresses)];
}
const decode64 = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));
const encode64 = (value: string) => btoa(Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''));
const cleanHeader = (value: string) => value.replace(/[\r\n]+/g, ' ');
function encodedSubject(value: string) {
  const chunks: string[] = []; let chunk = '', length = 0;
  for (const character of cleanHeader(value)) { const size = new TextEncoder().encode(character).length; if (length + size > 42) { chunks.push(chunk); chunk = ''; length = 0; } chunk += character; length += size; }
  chunks.push(chunk); return chunks.map((part) => `=?UTF-8?B?${encode64(part)}?=`).join('\r\n ');
}
export function mime(draft: Draft, from: string): string {
  const reference = draft.inReplyTo && /^<[^<>\s]{1,900}>$/.test(draft.inReplyTo) ? draft.inReplyTo : undefined;
  return [`From: ${cleanHeader(from)}`, `To: ${recipients(draft.to).join(',\r\n ')}`, `Subject: ${encodedSubject(draft.subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', ...(reference ? [`In-Reply-To: ${reference}`, `References: ${reference}`] : []), '', encode64(draft.body).replace(/.{76}/g, '$&\r\n')].join('\r\n');
}
const plain = (value: string) => value.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const replyAddress = (value: string) => value.match(/<([^<>]+)>/)?.[1]?.trim() ?? value.trim();
type GmailPart = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: GmailPart[] };
export function googleMessage(accountId: string, source: { id: string; threadId?: string; internalDate?: string; snippet?: string; labelIds?: string[]; payload?: GmailPart }): Message {
  if (typeof source.id !== 'string' || source.id.length > 2048) throw new Error('Invalid Gmail message identity.');
  const payload = source.payload ?? {}, headers = payload.headers ?? [];
  if (!Array.isArray(headers) || headers.length > 100 || headers.some((item) => typeof item.name !== 'string' || typeof item.value !== 'string' || item.value.length > 16000)) throw new Error('Gmail message headers exceed the mobile limit.');
  const header = (name: string) => headers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value.slice(0, 4000) ?? '';
  const parts: GmailPart[] = [], queue = [{ part: payload, depth: 0 }]; let complex = false, encoded = 0;
  while (queue.length) {
    const { part, depth } = queue.pop()!;
    if (parts.length >= 128 || depth > 12) { complex = true; break; }
    if (part.body?.data !== undefined && typeof part.body.data !== 'string') throw new Error('Invalid Gmail body.');
    encoded += part.body?.data?.length ?? 0; if (encoded > 500000) { complex = true; break; }
    parts.push(part);
    if (part.parts !== undefined) { if (!Array.isArray(part.parts) || part.parts.length > 128) { complex = true; break; } for (const child of part.parts) queue.push({ part: child, depth: depth + 1 }); }
  }
  const text = parts.find((part) => !part.filename && part.mimeType === 'text/plain' && part.body?.data), html = parts.find((part) => !part.filename && part.mimeType === 'text/html' && part.body?.data);
  const selected = text?.body?.data ?? html?.body?.data;
  const body = complex || (selected?.length ?? 0) > 333336 ? omittedBody : selected ? (text ? decode64(selected) : plain(decode64(selected))) : source.snippet ?? '';
  return { id: source.id, accountId, threadId: source.threadId, internetMessageId: header('message-id'), from: header('from'), replyTo: replyAddress(header('reply-to') || header('from')), to: header('to'), subject: header('subject') || '(No subject)', preview: source.snippet ?? body.slice(0, 180), body: body.slice(0, 250000), receivedAt: new Date(Number(source.internalDate) || Date.now()).toISOString(), read: !source.labelIds?.includes('UNREAD'), starred: !!source.labelIds?.includes('STARRED'), inbox: !!source.labelIds?.includes('INBOX'), attachmentNames: parts.flatMap((part) => part.filename ? [part.filename] : []) };
}
interface GraphMessage { id: string; conversationId?: string; internetMessageId?: string; from?: { emailAddress?: { name?: string; address?: string } }; replyTo?: { emailAddress?: { address?: string } }[]; toRecipients?: { emailAddress?: { address?: string } }[]; subject?: string; bodyPreview?: string; body?: { contentType?: string; content?: string }; receivedDateTime?: string; isRead?: boolean; flag?: { flagStatus?: string }; hasAttachments?: boolean }
export function microsoftMessage(accountId: string, value: GraphMessage): Message {
  if (typeof value.id !== 'string' || value.id.length > 2048 || value.body?.content !== undefined && typeof value.body.content !== 'string') throw new Error('Invalid Microsoft message.');
  const sender = value.from?.emailAddress, body = value.body?.content ?? '';
  const bounded = body.slice(0, previewLimit), displayed = value.body?.contentType?.toLowerCase() === 'html' ? plain(bounded) : bounded;
  return { id: value.id, accountId, threadId: value.conversationId, internetMessageId: value.internetMessageId, from: sender?.name ? `${sender.name} <${sender.address}>` : sender?.address ?? '', replyTo: value.replyTo?.[0]?.emailAddress?.address ?? sender?.address ?? '', to: value.toRecipients?.map((item) => item.emailAddress?.address ?? '').join(', ') ?? '', subject: value.subject || '(No subject)', preview: value.bodyPreview ?? '', body: body.length > previewLimit ? `${displayed}\n\n[Preview truncated. Open the provider app for the complete message.]` : displayed, receivedAt: value.receivedDateTime ?? '', read: !!value.isRead, starred: value.flag?.flagStatus === 'flagged', inbox: true, attachmentNames: value.hasAttachments ? ['Attachments available in your provider app'] : [] };
}
export function providerClient(provider: 'google' | 'microsoft', request: typeof fetch = fetch): MailProvider {
  const base = provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me' : 'https://graph.microsoft.com/v1.0';
  const call = async (path: string, token: string, init: RequestInit = {}, submitting = false) => {
    let response: Response;
    try { response = await request(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(provider === 'microsoft' ? { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } : {}), ...init.headers }, redirect: 'error' }); }
    catch { throw new ProviderError(submitting ? 'Connection ended before delivery was confirmed. Check Sent mail before sending again.' : 'Unable to reach the mail provider. Cached mail is still available.', submitting); }
    if (!response.ok) throw new ProviderError(response.status === 401 ? 'Reconnect this account to renew access.' : `The provider refused this request (HTTP ${response.status}).`, submitting && (response.status >= 500 || response.status === 408 || response.status === 429), response.status);
    if (response.status === 204 || response.status === 202) return undefined;
    return boundedJson(response, provider === 'google' ? 1500000 : 5000000, submitting);
  };
  return {
    profile: async (token, signal) => {
      const profile = await call(provider === 'google' ? '/profile' : '/me?$select=id,mail,userPrincipalName,displayName', token, { signal });
      if (provider === 'google' ? typeof profile?.emailAddress !== 'string' : typeof profile?.id !== 'string' || typeof (profile?.mail || profile?.userPrincipalName) !== 'string') throw new Error('The provider did not return a valid mailbox identity.');
      return provider === 'google' ? { subject: profile.emailAddress.toLowerCase(), email: profile.emailAddress, name: profile.emailAddress } : { subject: profile.id, email: profile.mail || profile.userPrincipalName, name: profile.displayName || profile.mail || profile.userPrincipalName };
    },
    inbox: async (accountId, token, cursor, signal) => {
      if (provider === 'google') {
        const result = await call(`/messages?labelIds=INBOX&maxResults=40${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`, token, { signal });
        if (result.messages !== undefined && (!Array.isArray(result.messages) || result.messages.length > 40) || result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096)) throw new Error('Gmail returned an oversized or invalid inbox page.');
        const messages: Message[] = [];
        for (let index = 0; index < (result.messages?.length ?? 0); index += 4) {
          const batch = result.messages.slice(index, index + 4);
          const loaded = await Promise.all(batch.map(async (item: { id: string }) => {
            if (typeof item?.id !== 'string' || item.id.length > 2048) throw new Error('Invalid Gmail message identity.');
            try { return googleMessage(accountId, await call(`/messages/${encodeURIComponent(item.id)}?format=full`, token, { signal })); }
            catch (error) { if (!(error instanceof ResponseLimitError)) throw error; const metadata = await call(`/messages/${encodeURIComponent(item.id)}?format=metadata`, token, { signal }); return { ...googleMessage(accountId, metadata), body: omittedBody }; }
          })); messages.push(...loaded);
        }
        return { messages, cursor: result.nextPageToken };
      }
      const path = cursor ? (() => { const url = new URL(cursor); if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== '/v1.0/me/mailFolders/inbox/messages') throw new Error('Invalid provider paging link.'); return url.pathname.slice('/v1.0'.length) + url.search; })() : '/me/mailFolders/inbox/messages?$top=40&$orderby=receivedDateTime%20desc&$select=id,conversationId,internetMessageId,from,replyTo,toRecipients,subject,bodyPreview,body,receivedDateTime,isRead,flag,hasAttachments';
      const result = await call(path, token, { signal });
      if (!Array.isArray(result?.value) || result.value.length > 40 || result['@odata.nextLink'] !== undefined && (typeof result['@odata.nextLink'] !== 'string' || result['@odata.nextLink'].length > 8192)) throw new Error('Microsoft returned an oversized or invalid inbox page.');
      return { messages: result.value.map((item: GraphMessage) => microsoftMessage(accountId, item)), cursor: result['@odata.nextLink'] };
    },
    action: async (token, id, action, signal) => {
      if (provider === 'google') {
        const addLabelIds: string[] = [], removeLabelIds: string[] = [];
        if (action.kind === 'read') (action.value ? removeLabelIds : addLabelIds).push('UNREAD');
        else if (action.kind === 'star') (action.value ? addLabelIds : removeLabelIds).push('STARRED');
        else if (action.kind === 'archive') removeLabelIds.push('INBOX');
        else { addLabelIds.push('TRASH'); removeLabelIds.push('INBOX'); }
        await call(`/messages/${encodeURIComponent(id)}/modify`, token, { method: 'POST', body: JSON.stringify({ addLabelIds, removeLabelIds }), signal }, true);
      } else if (action.kind === 'archive' || action.kind === 'trash') await call(`/me/messages/${encodeURIComponent(id)}/move`, token, { method: 'POST', body: JSON.stringify({ destinationId: action.kind === 'trash' ? 'deleteditems' : 'archive' }), signal }, true);
      else await call(`/me/messages/${encodeURIComponent(id)}`, token, { method: 'PATCH', body: JSON.stringify(action.kind === 'read' ? { isRead: action.value } : { flag: { flagStatus: action.value ? 'flagged' : 'notFlagged' } }), signal }, true);
    },
    send: async (token, draft, from, signal) => {
      if (provider === 'google') await call('/messages/send', token, { method: 'POST', body: JSON.stringify({ raw: encode64(mime(draft, from)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), ...(draft.threadId ? { threadId: draft.threadId } : {}) }), signal }, true);
      else await call('/me/sendMail', token, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: encode64(mime(draft, from)), signal }, true);
    }
  };
}
