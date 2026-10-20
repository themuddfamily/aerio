import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import Inbox from '../src/app/index';
import Compose from '../src/app/compose';
import Outbox from '../src/app/outbox';
import { runtime } from '../src/native/runtime';
import { MailService } from '../src/core/service';
import { databaseFixture } from './database';
import type { Account, MailProvider, Message } from '../src/core/types';
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({ accountId: 'google:fixture' }) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'ui-draft' }));
jest.mock('../src/native/runtime', () => ({ runtime: { subscribe: () => () => {}, getSnapshot: jest.fn(), changed: jest.fn(), lock: jest.fn() } }));
const fixtures: ReturnType<typeof databaseFixture>[] = [];
const account: Account = { id: 'google:fixture', subject: 'fixture', provider: 'google', email: 'fixture@example.test', name: 'Fixture' };
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = databaseFixture(); fixtures.push(fixture); const store = fixture.open(); store.saveAccount(account);
  const provider: MailProvider = { profile: jest.fn(), inbox: async () => ({ messages: [] }), action: async () => {}, send: jest.fn(async () => {}) };
  const service = new MailService(store, { token: async () => 'fixture', provider: () => provider, id: () => 'action', changed: () => {} });
  (runtime.getSnapshot as jest.Mock).mockReturnValue({ locked: false, deviceProtected: true, service, version: 0 }); return { store, service, provider };
}
it('renders cached mail and navigates to a native reader with the account identity', async () => {
  const { store } = setup(); const message: Message = { id: 'message', accountId: account.id, from: 'Sender', replyTo: 'sender@example.test', to: account.email, subject: 'Offline review', preview: 'Cached preview', body: 'Private body', receivedAt: '2026-10-20T10:00:00Z', read: false, starred: false, inbox: true, attachmentNames: [] };
  store.saveInbox(account, [message], false); await render(<Inbox />);
  await fireEvent.press(screen.getByRole('button', { name: 'Unread: Offline review' }));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/message/[id]', params: { id: 'message', accountId: account.id } });
}, 15000);
it('saves a native compose draft as text changes and requires explicit send confirmation', async () => {
  const { store, provider } = setup(); const alert = jest.spyOn(Alert, 'alert'); await render(<Compose />);
  await fireEvent.changeText(screen.getByLabelText('To'), 'recipient@example.test');
  await fireEvent.changeText(screen.getByLabelText('Subject'), 'Review'); await fireEvent.changeText(screen.getByLabelText('Message'), 'Offline draft');
  expect(store.draft('ui-draft')?.body).toBe('Offline draft'); expect(provider.send).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Send email' })); expect(alert).toHaveBeenCalledWith('Send this email?', expect.stringContaining('recipient@example.test'), expect.any(Array));
  expect(provider.send).not.toHaveBeenCalled(); const send = alert.mock.calls.at(-1)![2]!.find((item) => item.text === 'Send')!;
  await act(async () => { send.onPress?.(); });
  await waitFor(() => expect(provider.send).toHaveBeenCalledTimes(1));
  expect(store.draft('ui-draft')?.status).toBe('sent'); expect(router.replace).toHaveBeenCalledWith('/outbox'); alert.mockRestore();
});
it('shows uncertain delivery review instead of a retry-send control', async () => {
  const { store } = setup(); store.saveDraft({ id: 'uncertain', accountId: account.id, to: 'recipient@example.test', subject: 'Uncertain', body: 'Body', status: 'uncertain', updatedAt: '' });
  await render(<Outbox />); expect(screen.getByText('Delivery uncertain — check Sent mail')).toBeTruthy(); expect(screen.queryByText('Retry send')).toBeNull();
});
