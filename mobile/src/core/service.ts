import { ProviderError, recipients } from './providers';
import { MailStore } from './store';
import type { Account, Draft, MailAction, MailProvider, Message, PendingAction } from './types';
export class MailService {
  private epoch = 0;
  private locked = false;
  private controllers = new Set<AbortController>();
  private busy = new Set<string>();
  constructor(readonly store: MailStore, private readonly options: { token(account: Account): Promise<string>; provider(account: Account): MailProvider; id(): string; changed(): void }) {}
  lock() { this.locked = true; this.epoch++; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.store.close(); }
  assert() { if (this.locked) throw new Error('Unlock Aerio to use your mail.'); this.store.assertOpen(); }
  private async run<T>(accountId: string, work: (account: Account, token: string, signal: AbortSignal, guard: () => void) => Promise<T>): Promise<T> {
    this.assert(); if (this.busy.has(accountId)) throw new Error('Wait for this account to finish its current request.');
    const account = this.store.account(accountId); if (!account) throw new Error('Account not found.');
    const epoch = this.epoch, controller = new AbortController(); this.controllers.add(controller); this.busy.add(accountId);
    const timer = setTimeout(() => controller.abort(), 45000);
    const guard = () => { this.assert(); if (epoch !== this.epoch) throw new Error('This session has ended.'); };
    try { const token = await this.options.token(account); guard(); return await work(account, token, controller.signal, guard); }
    finally { clearTimeout(timer); this.controllers.delete(controller); this.busy.delete(accountId); if (!this.locked) this.options.changed(); }
  }
  async sync(accountId: string, append = false) {
    return this.run(accountId, async (account, token, signal, guard) => {
      const provider = this.options.provider(account);
      if (!append) for (const action of this.store.actions(accountId).filter((item) => item.state === 'pending')) {
        guard(); this.store.saveAction({ ...action, state: 'running' });
        try { await provider.action(token, action.messageId, action.action, signal); guard(); this.store.completeAction(action); }
        catch (error) { guard(); this.store.saveAction({ ...action, state: error instanceof ProviderError && !error.submitted ? 'failed' : 'review', error: error instanceof Error ? error.message : 'Change could not be confirmed.' }); }
      }
      guard(); const fresh = this.store.account(accountId)!;
      const result = await provider.inbox(accountId, token, append ? fresh.cursor : undefined, signal); guard();
      this.store.saveInbox({ ...fresh, cursor: result.cursor, lastSync: new Date().toISOString() }, result.messages, append);
    });
  }
  queueAction(message: Message, action: MailAction) {
    this.assert(); const operation: PendingAction = { id: this.options.id(), accountId: message.accountId, messageId: message.id, action, state: 'pending' };
    this.store.saveAction(operation); this.options.changed(); return operation;
  }
  saveDraft(value: Draft) {
    this.assert(); const previous = this.store.draft(value.id);
    if (value.body.length > 250000 || value.subject.length > 2000 || value.to.length > 16000) throw new Error('This draft exceeds the mobile message size limit.');
    if (previous && !['editing', 'failed'].includes(previous.status)) throw new Error('This draft was submitted. Check its delivery status before creating another message.');
    this.store.saveDraft({ ...value, status: 'editing', error: undefined, updatedAt: new Date().toISOString() }); this.options.changed();
  }
  async send(id: string) {
    this.assert(); const initial = this.store.draft(id); if (!initial) throw new Error('Draft not found.');
    recipients(initial.to);
    if (!['editing', 'failed'].includes(initial.status)) throw new Error('This message has already been submitted. Check Sent mail.');
    // Obtain a token before recording submission. An authentication failure cannot have delivered mail.
    return this.run(initial.accountId, async (account, token, signal, guard) => {
      const draft = this.store.draft(id)!;
      if (draft.updatedAt !== initial.updatedAt || !['editing', 'failed'].includes(draft.status)) throw new Error('This draft changed. Review it before sending.');
      this.store.saveDraft({ ...draft, status: 'sending', error: undefined }); this.options.changed();
      try {
        await this.options.provider(account).send(token, draft, account.email, signal); guard();
        this.store.saveDraft({ ...draft, status: 'sent', updatedAt: new Date().toISOString(), error: undefined });
      } catch (error) {
        guard(); this.store.saveDraft({ ...draft, status: error instanceof ProviderError && !error.submitted ? 'failed' : 'uncertain', error: error instanceof Error ? error.message : 'Delivery could not be confirmed.', updatedAt: new Date().toISOString() }); throw error;
      }
    });
  }
}
