import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailAccountSummary, MailDraftInput } from '../../src/mail-types'
import type { MailMergeJobInput } from '../../src/mail-merge-types'
import { MailDatabase } from './database'
import { createMimeBuffer } from './mime-builder'
import { GmailApiError } from './gmail-client'
import { buildMergeDelivery, classifyMergeSendError, MailMergeNotSubmittedError, MailMergeRunner } from './mail-merge-runner'

const directories: string[] = []
const account: MailAccountSummary = {
  id: 'account-1', provider: 'gmail', email: 'sender@example.com', displayName: 'Sender', color: '#6558e8', status: 'ready',
  archived: false, signature: '', notifications: true, syncEnabled: true
}
const jobInput = (overrides: Partial<MailMergeJobInput> = {}): MailMergeJobInput => ({
  accountId: 'account-1',
  subject: 'Hello {{firstName|there}}',
  text: 'Hi {{firstName|there}} at {{company|your company}}',
  html: '<p>Hi {{firstName|there}}</p>',
  attachmentPaths: [],
  recipients: [
    { email: 'ada@example.com', name: 'Ada Lovelace', company: 'Analytical' },
    { email: 'grace@example.com', firstName: 'Grace' },
    { email: 'linus@example.com' }
  ],
  limits: { perMinute: 60, dailyCap: 100 },
  ...overrides
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-merge-test-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  database.upsertAccount(account)
  return { database, store: database.mailMerge, path, directory }
}

/** A runner with a controllable clock and a scripted transport. */
function runnerFor(database: MailDatabase, script: Array<Error | 'ok'> = []) {
  const clock = { now: Date.parse('2026-10-17T09:00:00.000Z') }
  const sent: MailDraftInput[] = []
  const events: string[] = []
  const state = { online: true }
  const runner = new MailMergeRunner({
    store: database.mailMerge,
    online: () => state.online,
    now: () => clock.now,
    emit: (summary) => events.push(summary.status),
    send: async (delivery) => {
      const next = script.shift() ?? 'ok'
      if (next !== 'ok') throw next
      sent.push(delivery)
      return { messageIdHeader: `<${sent.length}@aerio.local>` }
    }
  })
  return { runner, clock, sent, events, state }
}

const advance = (clock: { now: number }, milliseconds: number) => { clock.now += milliseconds }

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

describe('mail merge deliveries', () => {
  it('builds one personalised delivery per recipient with exactly one To and no Cc or Bcc', async () => {
    const { database, store } = setup()
    const job = store.create('job-1', jobInput())
    const { runner, clock, sent } = runnerFor(database)
    for (let index = 0; index < 3; index++) {
      expect(await runner.tick()).toBe(true)
      advance(clock, 1_000)
    }
    expect(await runner.tick()).toBe(false)
    expect(sent.map((delivery) => [delivery.to, delivery.cc, delivery.bcc, delivery.subject])).toEqual([
      [['"Ada Lovelace" <ada@example.com>'], [], [], 'Hello Ada'],
      [['"Grace" <grace@example.com>'], [], [], 'Hello Grace'],
      [['linus@example.com'], [], [], 'Hello there']
    ])
    expect(sent[0].text).toBe('Hi Ada at Analytical')
    expect(sent[2].text).toBe('Hi there at your company')
    // The built MIME exposes only the one recipient.
    for (const delivery of sent) {
      const headers = createMimeBuffer(delivery, 'Sender <sender@example.com>').toString('utf8').split('\r\n\r\n')[0]
      expect(headers).not.toMatch(/^(Cc|Bcc):/im)
      const others = job.recipients.filter((recipient) => !delivery.to[0].includes(recipient.email))
      for (const other of others) expect(headers).not.toContain(other.email)
    }
    expect(store.get('job-1')).toMatchObject({ status: 'completed', counts: { sent: 3, pending: 0 } })
    expect(store.get('job-1')!.recipients.every((recipient) => recipient.attempts === 1 && recipient.sentAt)).toBe(true)
    database.close()
  })

  it('refuses to build a delivery that would address more than one recipient', () => {
    const delivery = buildMergeDelivery({ id: 'j', accountId: 'a', subject: 's', text: 't', attachmentPaths: [] }, { position: 0, email: 'a@example.com', status: 'pending', attempts: 0, updatedAt: '' })
    expect(delivery).toMatchObject({ to: ['a@example.com'], cc: [], bcc: [], references: [] })
    expect(delivery.threadId).toBeUndefined()
  })

  it('spaces submissions by the per-minute throttle', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput({ limits: { perMinute: 2, dailyCap: 100 } }))
    const { runner, clock, sent } = runnerFor(database)
    expect(await runner.tick()).toBe(true)
    advance(clock, 29_000)
    expect(await runner.tick()).toBe(false)
    advance(clock, 1_000)
    expect(await runner.tick()).toBe(true)
    expect(sent).toHaveLength(2)
    expect(store.summary('job-1')?.nextAttemptAt).toBe(new Date(clock.now + 30_000).toISOString())
    database.close()
  })

  it('stops at the rolling daily cap across jobs and resumes when the window passes', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput({ limits: { perMinute: 60, dailyCap: 2 } }))
    const { runner, clock, sent } = runnerFor(database)
    await runner.tick(); advance(clock, 1_000)
    await runner.tick(); advance(clock, 1_000)
    expect(await runner.tick()).toBe(false)
    expect(sent).toHaveLength(2)
    expect(store.summary('job-1')).toMatchObject({ status: 'running', lastError: expect.stringMatching(/Daily limit of 2/), nextAttemptAt: '2026-10-18T09:00:00.000Z' })
    // A second job on the same account shares the cap.
    store.create('job-2', jobInput({ recipients: [{ email: 'other@example.com' }], limits: { perMinute: 60, dailyCap: 2 } }))
    expect(await runner.tick()).toBe(false)
    clock.now = Date.parse('2026-10-18T09:00:00.500Z')
    expect(await runner.tick()).toBe(true)
    expect(sent).toHaveLength(3)
    database.close()
  })

  it('backs off exponentially after rate-limit replies without losing the recipient', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput({ recipients: [{ email: 'ada@example.com' }] }))
    const { runner, clock, sent } = runnerFor(database, [new GmailApiError('Too many requests', 429), new GmailApiError('User-rate limit exceeded', 403, 'userRateLimitExceeded')])
    await runner.tick()
    expect(store.get('job-1')!.recipients[0]).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringMatching(/slow down/) })
    expect(store.summary('job-1')?.nextAttemptAt).toBe(new Date(clock.now + 60_000).toISOString())
    advance(clock, 60_000)
    await runner.tick()
    expect(store.summary('job-1')?.nextAttemptAt).toBe(new Date(clock.now + 120_000).toISOString())
    advance(clock, 119_000)
    expect(await runner.tick()).toBe(false)
    advance(clock, 1_000)
    await runner.tick()
    expect(sent).toHaveLength(1)
    expect(store.get('job-1')).toMatchObject({ status: 'completed', recipients: [{ status: 'sent', attempts: 3 }] })
    database.close()
  })

  it('marks provider rejections failed and keeps going; failed recipients can be resent', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput({ recipients: [{ email: 'bad@example.com' }, { email: 'good@example.com' }] }))
    const { runner, clock, sent } = runnerFor(database, [new GmailApiError('Invalid To header', 400)])
    await runner.tick(); advance(clock, 1_000)
    await runner.tick()
    expect(store.get('job-1')).toMatchObject({ status: 'completed', counts: { failed: 1, sent: 1 } })
    store.resolve('job-1', [0], 'resend', new Date(clock.now).toISOString())
    expect(store.summary('job-1')?.status).toBe('running')
    advance(clock, 1_000)
    await runner.tick()
    expect(sent.map((delivery) => delivery.to[0])).toEqual(['good@example.com', 'bad@example.com'])
    database.close()
  })

  it('pauses the job when nothing was submitted, e.g. missing credentials', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput({ recipients: [{ email: 'ada@example.com' }] }))
    const { runner, clock, sent } = runnerFor(database, [new MailMergeNotSubmittedError(new Error('Unable to access the account credentials'))])
    await runner.tick()
    expect(store.get('job-1')).toMatchObject({ status: 'paused', lastError: expect.stringMatching(/Reconnect this account/), recipients: [{ status: 'pending' }] })
    advance(clock, 120_000)
    expect(await runner.tick()).toBe(false)
    store.resume('job-1', new Date(clock.now).toISOString())
    await runner.tick()
    expect(sent).toHaveLength(1)
    database.close()
  })

  it('marks an unknown outcome ambiguous, never retries it, and holds the job for review', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput())
    const timeout = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })
    const { runner, clock, sent } = runnerFor(database, [timeout])
    await runner.tick()
    expect(store.get('job-1')).toMatchObject({ status: 'needs-review', counts: { ambiguous: 1, pending: 2 } })
    for (let index = 0; index < 5; index++) {
      advance(clock, 60_000)
      expect(await runner.tick()).toBe(false)
    }
    expect(sent).toHaveLength(0)
    // Skipping the ambiguous recipient re-enables the rest of the merge.
    store.resolve('job-1', [0], 'skip', new Date(clock.now).toISOString())
    expect(store.summary('job-1')?.status).toBe('running')
    await runner.tick(); advance(clock, 1_000)
    await runner.tick()
    expect(sent.map((delivery) => delivery.to[0])).toEqual(['"Grace" <grace@example.com>', 'linus@example.com'])
    expect(store.get('job-1')).toMatchObject({ status: 'completed', counts: { skipped: 1, sent: 2 } })
    database.close()
  })

  it('recovers after a restart: an in-flight delivery becomes ambiguous and is not sent twice', async () => {
    const { database, path, directory } = setup()
    database.mailMerge.create('job-1', jobInput())
    const first = runnerFor(database)
    await first.runner.tick()
    advance(first.clock, 1_000)
    // Simulate a crash after the provider was contacted for Grace.
    expect(database.mailMerge.claim('job-1', 1, new Date(first.clock.now).toISOString())).toBe(true)
    database.close()

    const reopened = new MailDatabase(path, join(directory, 'mail'))
    expect(reopened.mailMerge.recoverInterrupted()).toEqual(['job-1'])
    expect(reopened.mailMerge.recoverInterrupted()).toEqual([])
    const job = reopened.mailMerge.get('job-1')!
    expect(job).toMatchObject({ status: 'needs-review', counts: { sent: 1, ambiguous: 1, pending: 1 } })
    expect(job.recipients[1]).toMatchObject({ status: 'ambiguous', error: expect.stringMatching(/may already have been delivered/) })
    const second = runnerFor(reopened)
    second.clock.now = first.clock.now + 60_000
    expect(await second.runner.tick()).toBe(false)
    // The user chooses to resend; only then is Grace sent again, followed by the rest.
    reopened.mailMerge.resolve('job-1', [1], 'resend', new Date(second.clock.now).toISOString())
    await second.runner.tick(); advance(second.clock, 1_000)
    await second.runner.tick(); advance(second.clock, 1_000)
    expect(await second.runner.tick()).toBe(false)
    expect(second.sent.map((delivery) => delivery.to[0])).toEqual(['"Grace" <grace@example.com>', 'linus@example.com'])
    expect(reopened.mailMerge.get('job-1')!.recipients.map((recipient) => [recipient.status, recipient.attempts])).toEqual([['sent', 1], ['sent', 2], ['sent', 1]])
    reopened.close()
  })

  it('cancels pending recipients; a delivery already submitted records its outcome', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput())
    let release: () => void = () => undefined
    const runner = new MailMergeRunner({
      store, online: () => true, emit: () => undefined,
      send: () => new Promise((resolve) => { release = () => resolve({}) })
    })
    const inFlight = runner.tick()
    await Promise.resolve()
    expect(store.cancel('job-1')).toMatchObject({ status: 'cancelled', counts: { sending: 1, cancelled: 2 } })
    release()
    await inFlight
    expect(store.get('job-1')).toMatchObject({ status: 'cancelled', counts: { sent: 1, cancelled: 2 } })
    expect(() => store.resolve('job-1', [1], 'resend')).toThrow(/cancelled/)
    expect(await runner.tick()).toBe(false)
    expect(store.delete('job-1')).toEqual([])
    expect(store.get('job-1')).toBeUndefined()
    database.close()
  })

  it('waits while offline, refuses to delete a running job, and is removed with its account', async () => {
    const { database, store } = setup()
    store.create('job-1', jobInput())
    const { runner, state, sent } = runnerFor(database)
    state.online = false
    expect(await runner.tick()).toBe(false)
    expect(sent).toHaveLength(0)
    expect(() => store.delete('job-1')).toThrow(/Pause or cancel/)
    expect(store.pause('job-1').status).toBe('paused')
    expect(store.list()).toHaveLength(1)
    database.disconnectAccount('account-1', 'delete')
    expect(store.list()).toEqual([])
    database.close()
  })
})

describe('classifyMergeSendError', () => {
  it('treats only proven refusals as safe and everything else as ambiguous', () => {
    expect(classifyMergeSendError(new GmailApiError('rate', 429))).toBe('rate-limited')
    expect(classifyMergeSendError(new GmailApiError('Daily user sending quota exceeded', 403, 'dailyLimitExceeded'))).toBe('rate-limited')
    expect(classifyMergeSendError(new GmailApiError('Forbidden', 403))).toBe('rejected')
    expect(classifyMergeSendError(new GmailApiError('Unauthorized', 401))).toBe('not-submitted')
    expect(classifyMergeSendError(new GmailApiError('Backend error', 503))).toBe('ambiguous')
    expect(classifyMergeSendError(new GmailApiError('Timeout', 408))).toBe('ambiguous')
    expect(classifyMergeSendError(Object.assign(new Error('Try again later'), { responseCode: 451 }))).toBe('rate-limited')
    expect(classifyMergeSendError(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }))).toBe('rejected')
    expect(classifyMergeSendError(Object.assign(new Error('5.7.0 sending limit exceeded'), { responseCode: 554 }))).toBe('rate-limited')
    expect(classifyMergeSendError(Object.assign(new Error('Invalid login'), { responseCode: 535 }))).toBe('not-submitted')
    expect(classifyMergeSendError(Object.assign(new Error('Recipient refused'), { code: 'EENVELOPE' }))).toBe('rejected')
    expect(classifyMergeSendError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe('ambiguous')
    expect(classifyMergeSendError(new TypeError('fetch failed'))).toBe('ambiguous')
    expect(classifyMergeSendError(undefined)).toBe('ambiguous')
    expect(classifyMergeSendError(new MailMergeNotSubmittedError('no token'))).toBe('not-submitted')
  })
})
