import { databaseFixture } from './database';
import { MailService } from '../src/core/service';
import { ProviderError } from '../src/core/providers';
import type { Account, Draft, MailProvider, Message } from '../src/core/types';
const account: Account = { id: 'google:one', subject: 'one', email: 'one@example.test', name: 'One', provider: 'google' };
const draft: Draft = { id: 'draft', accountId: account.id, to: 'recipient@example.test', subject: 'Test', body: 'Body', status: 'editing', updatedAt: 'revision' };
const message: Message = { id: 'message', accountId: account.id, from: 'Sender', replyTo: 'sender@example.test', to: account.email, subject: 'Cached message', preview: 'Preview', body: 'Offline body', receivedAt: '2026-10-20T10:00:00Z', read: false, starred: false, inbox: true, attachmentNames: [] };
const fixtures: ReturnType<typeof databaseFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = databaseFixture(); fixtures.push(fixture); const store = fixture.open(); store.saveAccount(account);
  const provider: jest.Mocked<MailProvider> = { profile: jest.fn(), inbox: jest.fn<ReturnType<MailProvider['inbox']>, Parameters<MailProvider['inbox']>>(async () => ({ messages: [message] })), action: jest.fn<ReturnType<MailProvider['action']>, Parameters<MailProvider['action']>>(async () => {}), send: jest.fn<ReturnType<MailProvider['send']>, Parameters<MailProvider['send']>>(async () => {}) };
  let sequence = 0;
  const token = jest.fn(async () => 'secret-token');
  const service = new MailService(store, { token, provider: () => provider, id: () => `id-${++sequence}`, changed: jest.fn() });
  return { fixture, store, provider, service, token };
}
describe('mobile cache and submission safety', () => {
  it('persists isolated offline inboxes and drafts across restart, and deletes only a removed account', async () => {
    const { fixture, store, service } = setup();
    await service.sync(account.id); service.saveDraft(draft);
    store.saveAccount({ ...account, id: 'microsoft:two', email: 'two@example.test', provider: 'microsoft' });
    store.saveInbox(store.account('microsoft:two')!, [{ ...message, accountId: 'microsoft:two', subject: 'Other account' }], false);
    store.close(); const restored = fixture.open();
    expect(restored.message(account.id, message.id)?.body).toBe('Offline body'); expect(restored.draft('draft')?.body).toBe('Body');
    restored.removeAccount(account.id);
    expect(restored.drafts()).toEqual([]); expect(restored.messages()).toHaveLength(1); expect(restored.messages()[0].subject).toBe('Other account');
  });
  it('sends only explicitly and prevents a second submission after provider acceptance', async () => {
    const { service, store, provider } = setup(); service.saveDraft(draft); await service.sync(account.id);
    expect(provider.send).not.toHaveBeenCalled();
    await service.send(draft.id); expect(store.draft(draft.id)?.status).toBe('sent');
    await expect(service.send(draft.id)).rejects.toThrow('already been submitted'); expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain delivery durable and refuses automatic replay', async () => {
    const { service, store, provider, fixture } = setup(); service.saveDraft(draft);
    provider.send.mockRejectedValueOnce(new ProviderError('Lost response', true));
    await expect(service.send(draft.id)).rejects.toThrow('Lost response'); expect(store.draft(draft.id)?.status).toBe('uncertain');
    await service.sync(account.id); expect(provider.send).toHaveBeenCalledTimes(1);
    store.close(); const restored = fixture.open(); expect(restored.draft(draft.id)?.status).toBe('uncertain');
  });
  it('records an interrupted send as uncertain after locking and does not touch closed stores', async () => {
    const { service, store, provider, fixture } = setup(); service.saveDraft(draft);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); provider.send.mockImplementationOnce(() => gate);
    const pending = service.send(draft.id); await new Promise((resolve) => setImmediate(resolve));
    expect(store.draft(draft.id)?.status).toBe('sending'); service.lock(); release();
    await expect(pending).rejects.toThrow('Unlock'); expect(fixture.open().draft(draft.id)?.status).toBe('uncertain');
  });
  it('does not mark a draft submitted when token acquisition fails, and rejects edits made while acquiring a token', async () => {
    const { service, store, provider, token } = setup(); service.saveDraft(draft); token.mockRejectedValueOnce(new Error('Offline auth'));
    await expect(service.send(draft.id)).rejects.toThrow('Offline auth'); expect(store.draft(draft.id)?.status).toBe('editing');
    token.mockImplementationOnce(async () => { store.saveDraft({ ...store.draft(draft.id)!, body: 'New body', updatedAt: 'new-revision' }); return 'token'; });
    await expect(service.send(draft.id)).rejects.toThrow('draft changed'); expect(provider.send).not.toHaveBeenCalled();
  });
  it('queues mailbox actions offline and retains uncertain move review without replay', async () => {
    const { service, store, provider } = setup(); await service.sync(account.id);
    service.queueAction(message, { kind: 'archive' }); expect(provider.action).not.toHaveBeenCalled();
    provider.action.mockRejectedValueOnce(new ProviderError('Lost move response', true));
    await service.sync(account.id); expect(store.actions()[0].state).toBe('review');
    await service.sync(account.id); expect(provider.action).toHaveBeenCalledTimes(1);
    service.queueAction(message, { kind: 'star', value: true }); await service.sync(account.id);
    expect(store.actions()[1].state).toBe('applied');
  });
});
