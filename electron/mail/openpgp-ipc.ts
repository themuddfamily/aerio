import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import PostalMime from 'postal-mime'
import type { MailAccountSummary, MailDraftInput, MailMessageRef, MailMessageSource } from '../../src/mail-types'
import type { MailSenderIdentity } from '../../src/mail-identity-types'
import type { OpenPgpDecryptResult, OpenPgpGenerateInput, OpenPgpMessageStatus, OpenPgpPreflight, OpenPgpPreflightInput, OpenPgpSignatureResult, OpenPgpVerificationState } from '../../src/openpgp-types'
import type { MailWorkerClient } from './worker-client'
import { describeRecipientProblems, NOT_SENT, OpenPgpKeyring, OpenPgpPassphraseRequired } from './openpgp-keyring'
import { normalizeOpenPgpOptions } from './openpgp-draft-store'
import { detectPgpMime, inlinePgpBlock } from './openpgp-mime'
import { sanitizeMessageHtml } from './message-security'
import { safeMessageFilename } from './message-tools'

// IPC for OpenPGP mail. Secret keys and decrypted plaintext never leave the
// main process except as the decrypted message the user asked to read.

type Worker = Pick<MailWorkerClient, 'request'>
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const validRef = (ref: MailMessageRef) => Boolean(ref) && [ref.accountId, ref.threadId, ref.messageId].every((id) => typeof id === 'string' && id.length > 0 && id.length < 1024)
const validFingerprint = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/.test(value)

function fingerprintArgument(value: unknown) {
  if (!validFingerprint(value)) throw new Error('Choose a valid OpenPGP key')
  return value.toUpperCase()
}

/** The From address a draft will be sent with, resolved the same way as delivery. */
export async function draftFromAddress(worker: Worker, accountId: string, fromIdentityId?: string) {
  const account = (await worker.request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === accountId)
  if (!account) throw new Error('Choose a valid sending account')
  if (fromIdentityId) {
    const identity = (await worker.request<MailSenderIdentity[]>({ type: 'identities:list', payload: { accountIds: [accountId] } })).find((item) => item.id === fromIdentityId)
    if (identity) return identity.name ? `${identity.name} <${identity.email}>` : identity.email
  }
  return account.displayName ? `${account.displayName} <${account.email}>` : account.email
}

export async function openPgpPreflight(keyring: OpenPgpKeyring, worker: Worker, input: OpenPgpPreflightInput): Promise<OpenPgpPreflight> {
  if (!input || typeof input !== 'object' || typeof input.accountId !== 'string' || !Array.isArray(input.recipients) || input.recipients.length > 500 || input.recipients.some((item) => typeof item !== 'string' || item.length > 500)) throw new Error('The OpenPGP check is invalid')
  const options = normalizeOpenPgpOptions(input.options) ?? {}
  const from = await draftFromAddress(worker, input.accountId, typeof input.fromIdentityId === 'string' ? input.fromIdentityId : undefined)
  const problems: string[] = []
  if (keyring.locked()) problems.push('Unlock Aerio first.')
  let signer: OpenPgpPreflight['signer']
  if (options.sign) {
    const key = await keyring.signerFor(from)
    if (!key) problems.push(`No usable OpenPGP secret key for ${from} is available to sign with.`)
    else {
      signer = { fingerprint: key.fingerprint, userId: key.userIds[0] ?? key.fingerprint, unlocked: key.unlocked }
      if (!key.unlocked) problems.push('Unlock your signing key with its passphrase.')
    }
  }
  const recipients = options.encrypt ? await keyring.recipientKeys(input.recipients, options.recipientKeys) : []
  const missing = recipients.filter((item) => item.status !== 'ok')
  if (!input.recipients.length && options.encrypt) problems.push('Add at least one recipient.')
  if (missing.length) problems.push(describeRecipientProblems(missing))
  return { ready: problems.length === 0, problems, from, signer, recipients }
}

/** Refuses to queue a Sign/Encrypt draft that cannot be protected right now. */
export async function assertOpenPgpSendable(keyring: OpenPgpKeyring, worker: Worker, input: MailDraftInput) {
  const options = normalizeOpenPgpOptions(input.openPgp)
  if (!options) return
  const check = await openPgpPreflight(keyring, worker, { accountId: input.accountId, fromIdentityId: input.fromIdentityId, recipients: [...input.to, ...input.cc, ...input.bcc], options })
  if (!check.ready) throw new Error(`${check.problems.join(' ')} ${NOT_SENT}`)
}

async function messageText(source: string) {
  try { return (await PostalMime.parse(source)).text ?? '' } catch { return '' }
}

export async function inspectMessageSource(keyring: OpenPgpKeyring, source: string): Promise<OpenPgpMessageStatus> {
  const structure = detectPgpMime(source)
  const inline = structure.kind === 'none' ? inlinePgpBlock(await messageText(source)) : undefined
  const kind = inline?.kind ?? structure.kind
  try {
    if (structure.kind === 'signed') return { kind, signatures: await keyring.verifyDetached(structure.signedPart, structure.signature) }
    if (structure.kind === 'encrypted') return { kind, encryptedTo: await keyring.encryptedTo(structure.armored) }
    if (inline?.kind === 'inline-signed') return { kind, signatures: (await keyring.verifyCleartext(inline.block)).signatures }
    if (inline?.kind === 'inline-encrypted') return { kind, encryptedTo: await keyring.encryptedTo(inline.block) }
  } catch (error) {
    return { kind, error: `The OpenPGP data could not be read: ${errorText(error)}` }
  }
  return { kind: 'none' }
}

interface DecryptedContent {
  text: string
  html?: string
  attachments: { filename: string; mimeType: string; content: Uint8Array }[]
  signatures: OpenPgpSignatureResult[]
}

const bytes = (content: ArrayBuffer | Uint8Array | string) => typeof content === 'string' ? Buffer.from(content, 'utf8') : content instanceof Uint8Array ? content : new Uint8Array(content)

export async function decryptMessageSource(keyring: OpenPgpKeyring, source: string, passphrase?: string): Promise<DecryptedContent> {
  const structure = detectPgpMime(source)
  if (structure.kind === 'encrypted') {
    const { data, signatures } = await keyring.decrypt(structure.armored, passphrase)
    const inner = Buffer.from(data).toString('utf8')
    // Sign-then-encrypt clients nest a multipart/signed entity inside.
    const nested = detectPgpMime(inner)
    if (nested.kind === 'signed') signatures.push(...await keyring.verifyDetached(nested.signedPart, nested.signature))
    const parsed = await PostalMime.parse(data)
    return {
      text: parsed.text ?? '',
      html: parsed.html,
      attachments: parsed.attachments
        .filter((item) => !(nested.kind === 'signed' && /^application\/pgp-signature$/i.test(item.mimeType)))
        .map((item) => ({ filename: item.filename || 'attachment', mimeType: item.mimeType || 'application/octet-stream', content: bytes(item.content) })),
      signatures
    }
  }
  const inline = inlinePgpBlock(await messageText(source))
  if (inline?.kind !== 'inline-encrypted') throw new Error('This message is not OpenPGP encrypted')
  const { data, signatures } = await keyring.decrypt(inline.block, passphrase)
  return { text: Buffer.from(data).toString('utf8'), attachments: [], signatures }
}

export function registerOpenPgp(options: { keyring: OpenPgpKeyring; worker(): Worker }) {
  const { keyring } = options
  const status = async () => ({ secureStorage: keyring.secureStorage(), locked: keyring.locked(), keys: await keyring.list() })
  const sourceFor = async (ref: MailMessageRef) => {
    if (!validRef(ref)) throw new Error('Invalid message reference')
    if (keyring.locked()) throw new Error('Unlock Aerio before reading OpenPGP mail')
    return (await options.worker().request<MailMessageSource>({ type: 'mail:source', payload: { accountId: ref.accountId, messageId: ref.messageId } })).source
  }
  const owner = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)
  const saveFile = async (event: Electron.IpcMainInvokeEvent, settings: Electron.SaveDialogOptions, data: string | Uint8Array, secret = false) => {
    const window = owner(event)
    const result = window ? await dialog.showSaveDialog(window, settings) : await dialog.showSaveDialog(settings)
    if (result.canceled || !result.filePath) return {}
    writeFileSync(result.filePath, data, { mode: secret ? 0o600 : 0o644 })
    return { savedPath: result.filePath }
  }

  ipcMain.handle('openpgp:status', () => status())
  ipcMain.handle('openpgp:generate', (_event, input: OpenPgpGenerateInput) => keyring.generate(input))
  ipcMain.handle('openpgp:import-text', (_event, armored: unknown, passphrase?: unknown) => {
    if (typeof armored !== 'string' || !armored.trim()) throw new Error('Paste an armored OpenPGP key')
    return keyring.importKeys(armored, typeof passphrase === 'string' && passphrase ? passphrase : undefined)
  })
  ipcMain.handle('openpgp:import-file', async (event, passphrase?: unknown) => {
    const window = owner(event)
    const settings: Electron.OpenDialogOptions = { title: 'Import OpenPGP key', filters: [{ name: 'OpenPGP keys', extensions: ['asc', 'gpg', 'pgp', 'key', 'pub', 'sec'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] }
    const result = window ? await dialog.showOpenDialog(window, settings) : await dialog.showOpenDialog(settings)
    const path = result.filePaths[0]
    if (result.canceled || !path) return undefined
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('That key file is too large')
    const content = readFileSync(path)
    const text = content.toString('utf8')
    return keyring.importKeys(/-----BEGIN PGP /.test(text) ? text : new Uint8Array(content), typeof passphrase === 'string' && passphrase ? passphrase : undefined)
  })
  ipcMain.handle('openpgp:export-public', async (event, fingerprint: unknown) => {
    const value = fingerprintArgument(fingerprint)
    const armored = await keyring.exportPublic(value)
    return saveFile(event, { title: 'Export public key', defaultPath: `${value.slice(-16)}-public.asc`, filters: [{ name: 'OpenPGP public key', extensions: ['asc'] }] }, armored)
  })
  ipcMain.handle('openpgp:export-private', async (event, fingerprint: unknown, passphrase: unknown) => {
    const value = fingerprintArgument(fingerprint)
    // The export stays protected by the key's own passphrase.
    const armored = await keyring.exportPrivate(value, typeof passphrase === 'string' ? passphrase : '')
    return saveFile(event, { title: 'Export private key (passphrase-protected)', defaultPath: `${value.slice(-16)}-secret.asc`, filters: [{ name: 'OpenPGP secret key', extensions: ['asc'] }] }, armored, true)
  })
  ipcMain.handle('openpgp:delete', async (_event, fingerprint: unknown) => {
    keyring.delete(fingerprintArgument(fingerprint))
    return status()
  })
  ipcMain.handle('openpgp:verification', (_event, fingerprint: unknown, state: OpenPgpVerificationState) => keyring.setVerification(fingerprintArgument(fingerprint), state))
  ipcMain.handle('openpgp:unlock', (_event, fingerprint: unknown, passphrase: unknown) => keyring.unlock(fingerprintArgument(fingerprint), typeof passphrase === 'string' ? passphrase : ''))
  ipcMain.handle('openpgp:forget', () => keyring.lock())
  ipcMain.handle('openpgp:preflight', (_event, input: OpenPgpPreflightInput) => openPgpPreflight(keyring, options.worker(), input))
  ipcMain.handle('openpgp:inspect', async (_event, ref: MailMessageRef) => inspectMessageSource(keyring, await sourceFor(ref)))
  ipcMain.handle('openpgp:decrypt', async (_event, ref: MailMessageRef, passphrase?: unknown): Promise<OpenPgpDecryptResult> => {
    const source = await sourceFor(ref)
    try {
      const content = await decryptMessageSource(keyring, source, typeof passphrase === 'string' && passphrase ? passphrase : undefined)
      return {
        status: 'decrypted',
        text: content.text,
        ...(content.html ? { sanitizedHtml: sanitizeMessageHtml(content.html) } : {}),
        attachments: content.attachments.map((item, index) => ({ index, filename: item.filename, mimeType: item.mimeType, size: item.content.byteLength })),
        signatures: content.signatures
      }
    } catch (error) {
      if (error instanceof OpenPgpPassphraseRequired) return { status: 'passphrase-required', fingerprint: error.fingerprint, userId: error.userId, ...(passphrase ? { error: error.message } : {}) }
      throw error
    }
  })
  ipcMain.handle('openpgp:save-attachment', async (event, ref: MailMessageRef, index: unknown) => {
    const source = await sourceFor(ref)
    if (!Number.isInteger(index) || Number(index) < 0) throw new Error('Choose a valid attachment')
    let content: DecryptedContent
    try { content = await decryptMessageSource(keyring, source) } catch (error) {
      if (error instanceof OpenPgpPassphraseRequired) throw new Error('Decrypt the message again before saving its attachments')
      throw error
    }
    const attachment = content.attachments[Number(index)]
    if (!attachment) throw new Error('That attachment is no longer available')
    return saveFile(event, { title: 'Save decrypted attachment', defaultPath: safeMessageFilename(attachment.filename) }, attachment.content)
  })
  return keyring
}
