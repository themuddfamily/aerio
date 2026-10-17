import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { MailDraftInput, MailMessageRef, MailMessageSource } from '../../src/mail-types'
import type { SmimeDecryptResult, SmimeIdentityDefault, SmimeImportResult, SmimePreflight, SmimePreflightInput, SmimeSender } from '../../src/smime-types'
import type { WorkerOpenPgpRequest } from '../mail-protocol'
import type { MailWorkerClient } from './worker-client'
import { NOT_SENT, type OpenPgpKeyring } from './openpgp-keyring'
import { draftFromAddress } from './openpgp-ipc'
import { assertSingleProtection, normalizeSmimeOptions } from './smime-draft-store'
import { describeSmimeRecipientProblems, SmimePassphraseRequired, SmimeStore, type SmimeDecryptedContent } from './smime-store'
import { sanitizeMessageHtml } from './message-security'
import { safeMessageFilename } from './message-tools'

// IPC for S/MIME mail. Private keys and decrypted plaintext never leave the
// main process except as the decrypted message the user asked to read.

type Worker = Pick<MailWorkerClient, 'request'>
const validRef = (ref: MailMessageRef) => Boolean(ref) && [ref.accountId, ref.threadId, ref.messageId].every((id) => typeof id === 'string' && id.length > 0 && id.length < 1024)
const MAX_FILE_BYTES = 2 * 1024 * 1024

function fingerprintArgument(value: unknown) {
  if (!SmimeStore.validFingerprint(value)) throw new Error('Choose a valid S/MIME certificate')
  return value.toUpperCase()
}

export async function smimePreflight(store: SmimeStore, worker: Worker, input: SmimePreflightInput): Promise<SmimePreflight> {
  if (!input || typeof input !== 'object' || typeof input.accountId !== 'string' || !Array.isArray(input.recipients) || input.recipients.length > 500 || input.recipients.some((item) => typeof item !== 'string' || item.length > 500)) throw new Error('The S/MIME check is invalid')
  const options = normalizeSmimeOptions(input.options) ?? {}
  const from = await draftFromAddress(worker, input.accountId, typeof input.fromIdentityId === 'string' ? input.fromIdentityId : undefined)
  const problems: string[] = []
  const warnings: string[] = []
  if (store.locked()) problems.push('Unlock Aerio first.')
  let signer: SmimePreflight['signer']
  if (options.sign) {
    const cert = await store.signerFor(from)
    if (!cert) problems.push(`No usable S/MIME certificate for ${from} is available to sign with.`)
    else {
      signer = { fingerprint: cert.fingerprint, subject: cert.commonName ?? cert.subject, unlocked: cert.unlocked }
      if (!cert.unlocked) problems.push('Unlock your S/MIME certificate with its passphrase.')
      if (cert.chainStatus !== 'trusted' && !cert.trusted) warnings.push('Your certificate’s issuer is not trusted on this device, so recipients may not trust your signature either.')
    }
  }
  const recipients = options.encrypt ? await store.recipientCertificates(input.recipients, options.recipientCerts) : []
  if (!input.recipients.length && options.encrypt) problems.push('Add at least one recipient.')
  const missing = recipients.filter((item) => item.status !== 'ok')
  if (missing.length) problems.push(describeSmimeRecipientProblems(missing))
  if (options.encrypt && !await store.selfCertificate(from)) warnings.push('None of your certificates can be used for encryption, so the Sent copy will not be readable here.')
  return { ready: problems.length === 0, problems, warnings, from, signer, recipients }
}

/** Refuses to queue an S/MIME draft that cannot be protected right now, or that also asks for OpenPGP. */
export async function assertSmimeSendable(store: SmimeStore, worker: Worker, input: MailDraftInput) {
  assertSingleProtection(input)
  const options = normalizeSmimeOptions(input.smime)
  if (!options) return
  const check = await smimePreflight(store, worker, { accountId: input.accountId, fromIdentityId: input.fromIdentityId, recipients: [...input.to, ...input.cc, ...input.bcc], options })
  if (!check.ready) throw new Error(`${check.problems.join(' ')} ${NOT_SENT}`)
}

/** Routes a worker protection request to S/MIME or OpenPGP. Asking for both is refused. */
export function protectOutgoingMessage(openPgp: () => Pick<OpenPgpKeyring, 'protect'>, smime: () => Pick<SmimeStore, 'protect'>, request: Omit<WorkerOpenPgpRequest, 'kind' | 'id'>) {
  const smimeOptions = normalizeSmimeOptions(request.smime)
  if (smimeOptions) {
    assertSingleProtection({ openPgp: request.options, smime: smimeOptions })
    return smime().protect(request.message, { from: request.from, recipients: request.recipients, options: smimeOptions })
  }
  return openPgp().protect(request.message, request)
}

const bytes = (value: Uint8Array) => Buffer.from(value)

export function registerSmime(options: { store: SmimeStore; worker(): Worker }) {
  const { store } = options
  let pendingImport: { data: Buffer; filename: string } | undefined
  const status = async () => ({ secureStorage: store.secureStorage(), locked: store.locked(), certificates: await store.list() })
  const sourceFor = async (ref: MailMessageRef) => {
    if (!validRef(ref)) throw new Error('Invalid message reference')
    if (store.locked()) throw new Error('Unlock Aerio before reading S/MIME mail')
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
  const importPending = async (password?: string, passphrase?: string): Promise<SmimeImportResult> => {
    if (!pendingImport) throw new Error('Choose the certificate file again')
    const result = await store.importFile(pendingImport.data, pendingImport.filename, password, passphrase)
    // Keep the file only while its password or passphrase is still being asked for.
    if (!result.needsPassword && !result.needsPassphrase) pendingImport = undefined
    return result
  }
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined

  ipcMain.handle('smime:status', () => status())
  ipcMain.handle('smime:import-file', async (event) => {
    const window = owner(event)
    const settings: Electron.OpenDialogOptions = {
      title: 'Import S/MIME certificate',
      filters: [{ name: 'Certificates and identities', extensions: ['p12', 'pfx', 'cer', 'crt', 'pem', 'der'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile']
    }
    const result = window ? await dialog.showOpenDialog(window, settings) : await dialog.showOpenDialog(settings)
    const path = result.filePaths[0]
    if (result.canceled || !path) return undefined
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error('That certificate file is too large')
    pendingImport = { data: readFileSync(path), filename: basename(path) }
    return importPending()
  })
  ipcMain.handle('smime:retry-import', (_event, password: unknown, passphrase?: unknown) => importPending(typeof password === 'string' ? password : '', text(passphrase)))
  ipcMain.handle('smime:import-text', async (_event, pem: unknown) => {
    if (typeof pem !== 'string' || !pem.trim()) throw new Error('Paste a PEM certificate')
    return store.importCertificates(pem)
  })
  ipcMain.handle('smime:export-certificate', async (event, fingerprint: unknown) => {
    const value = fingerprintArgument(fingerprint)
    return saveFile(event, { title: 'Export certificate', defaultPath: `${value.slice(0, 16)}.cer`, filters: [{ name: 'Certificate', extensions: ['cer', 'pem'] }] }, store.exportCertificate(value))
  })
  ipcMain.handle('smime:export-pkcs12', async (event, fingerprint: unknown, passphrase: unknown, exportPassword: unknown) => {
    const value = fingerprintArgument(fingerprint)
    const data = store.exportPkcs12(value, typeof passphrase === 'string' ? passphrase : '', typeof exportPassword === 'string' ? exportPassword : '')
    return saveFile(event, { title: 'Export certificate and private key (password-protected)', defaultPath: `${value.slice(0, 16)}.p12`, filters: [{ name: 'PKCS#12', extensions: ['p12', 'pfx'] }] }, data, true)
  })
  ipcMain.handle('smime:delete', async (_event, fingerprint: unknown) => {
    store.delete(fingerprintArgument(fingerprint))
    return status()
  })
  ipcMain.handle('smime:trust', (_event, fingerprint: unknown, trusted: unknown) => store.setTrusted(fingerprintArgument(fingerprint), trusted === true))
  ipcMain.handle('smime:unlock', (_event, fingerprint: unknown, passphrase: unknown) => store.unlock(fingerprintArgument(fingerprint), typeof passphrase === 'string' ? passphrase : ''))
  ipcMain.handle('smime:forget', () => store.lock())
  ipcMain.handle('smime:preflight', (_event, input: SmimePreflightInput) => smimePreflight(store, options.worker(), input))
  const senderAddress = (sender: SmimeSender) => {
    if (!sender || typeof sender !== 'object' || typeof sender.accountId !== 'string') throw new Error('Choose a valid sending account')
    return draftFromAddress(options.worker(), sender.accountId, typeof sender.fromIdentityId === 'string' ? sender.fromIdentityId : undefined)
  }
  ipcMain.handle('smime:identity-default', async (_event, sender: SmimeSender) => store.identityDefault(await senderAddress(sender)))
  ipcMain.handle('smime:set-identity-default', async (_event, sender: SmimeSender, value: unknown) => {
    const choice = value && typeof value === 'object' ? value as SmimeIdentityDefault : undefined
    store.setIdentityDefault(await senderAddress(sender), choice)
  })
  ipcMain.handle('smime:inspect', async (_event, ref: MailMessageRef) => store.inspect(await sourceFor(ref)))
  ipcMain.handle('smime:decrypt', async (_event, ref: MailMessageRef, passphrase?: unknown): Promise<SmimeDecryptResult> => {
    const source = await sourceFor(ref)
    try {
      const content = await store.open(source, text(passphrase))
      return {
        status: 'decrypted',
        encrypted: content.encrypted,
        text: content.text,
        ...(content.html ? { sanitizedHtml: sanitizeMessageHtml(content.html) } : {}),
        attachments: content.attachments.map((item, index) => ({ index, filename: item.filename, mimeType: item.mimeType, size: item.content.byteLength })),
        signatures: content.signatures
      }
    } catch (error) {
      if (error instanceof SmimePassphraseRequired) return { status: 'passphrase-required', fingerprint: error.fingerprint, subject: error.subject, ...(passphrase ? { error: error.message } : {}) }
      throw error
    }
  })
  ipcMain.handle('smime:save-attachment', async (event, ref: MailMessageRef, index: unknown) => {
    const source = await sourceFor(ref)
    if (!Number.isInteger(index) || Number(index) < 0) throw new Error('Choose a valid attachment')
    let content: SmimeDecryptedContent
    try { content = await store.open(source) } catch (error) {
      if (error instanceof SmimePassphraseRequired) throw new Error('Decrypt the message again before saving its attachments')
      throw error
    }
    const attachment = content.attachments[Number(index)]
    if (!attachment) throw new Error('That attachment is no longer available')
    return saveFile(event, { title: 'Save decrypted attachment', defaultPath: safeMessageFilename(attachment.filename) }, bytes(attachment.content))
  })
  return store
}
