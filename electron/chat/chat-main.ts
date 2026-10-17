import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, ipcMain, Notification, safeStorage, session, WebContentsView, type BrowserWindow } from 'electron'
import type { ChatEvent, ChatGateStatus, ChatSnapshot } from '../../src/chat-types'
import { assertSecureCredentialStorage } from '../mail/secure-storage'
import { ChatService } from './chat-service'
import { ChatStore } from './chat-store'
import { ChatVault } from './chat-vault'
import { CHAT_SDK_VERSION, evaluateChatGate, readGateEvidence, writeGateEvidence, type ChatGateEvidence } from './gate'
import type { ChatNotificationPlan } from './notifications'
import { ChatServiceHost } from './service-host'

/**
 * Wires the Matrix connector into the Electron main process. Chat files live
 * beside, but apart from, the mail and productivity stores, and none of them
 * are part of profile backups (see profile-backup-layout.ts):
 *
 * - chat.sqlite: accounts, rooms, sealed events, outbox, media refs, checkpoints
 * - chat-media/: staged and cached attachment ciphertext under random names
 * - chat-vault.dat: OS-encrypted tokens, cache keys and crypto-store keys
 * - chat-gate.json: gate evidence (no secrets)
 * - Partitions/aerio-chat-<account>: the SDK's encrypted IndexedDB crypto store
 */
export interface ChatMainOptions {
  isLocked: () => boolean
  notificationsEnabled: () => boolean
  online: () => boolean
  mainWindow: () => BrowserWindow | null
  openMainWindow: () => void
  iconPath: () => string | undefined
  quietNotifications: boolean
  log: (event: string, details?: Record<string, unknown>, error?: unknown) => void
}

export interface ChatRuntime {
  service: () => ChatService | undefined
  snapshot: () => ChatSnapshot
  isServiceSender: (senderId: number) => boolean
  lockChanged: (locked: boolean) => void
  networkChanged: () => void
  dispose: () => Promise<void>
}

export function initializeChat(options: ChatMainOptions): ChatRuntime {
  const userData = app.getPath('userData')
  const evidencePath = join(userData, 'chat-gate.json')
  const serviceDirectory = join(import.meta.dirname, '../chat-service')
  const host = new ChatServiceHost({
    electron: {
      createView: ({ partition, preload }) => new WebContentsView({
        webPreferences: { partition, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false, devTools: !app.isPackaged }
      }),
      fromPartition: (partition) => session.fromPartition(partition) as never,
      ipcMain
    },
    serviceDirectory,
    preload: join(import.meta.dirname, '../preload/chat-service-preload.cjs'),
    log: (event, details) => options.log(event, details)
  })
  const preview = process.env.AERIO_CHAT_PREVIEW === '1'
  let evidence: ChatGateEvidence | undefined = readGateEvidence(evidencePath)
  const gate = (): ChatGateStatus => evaluateChatGate({
    secureStorage: () => assertSecureCredentialStorage(safeStorage), serviceRuntime: () => host.available(), evidence, electronVersion: process.versions.electron ?? '', preview
  })
  let service: ChatService | undefined
  let pendingRoute: ChatNotificationPlan | undefined
  const broadcast = (event: ChatEvent) => {
    const window = options.mainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('chat:event', event)
  }
  const notify = (plan: ChatNotificationPlan) => {
    if (options.quietNotifications || !Notification.isSupported()) return
    const notification = new Notification({ title: plan.title, body: plan.body, icon: options.iconPath(), silent: false })
    notification.on('click', () => {
      options.openMainWindow()
      // A locked app unlocks first; the room opens afterwards.
      if (options.isLocked()) pendingRoute = plan
      else broadcast({ type: 'open-room', accountId: plan.accountId, roomId: plan.roomId, eventId: plan.eventId || undefined })
    })
    notification.show()
  }
  const startService = () => {
    if (service || !gate().enabled) return
    mkdirSync(join(userData, 'chat-media'), { recursive: true })
    const vault = new ChatVault(join(userData, 'chat-vault.dat'), {
      assertSecure: () => assertSecureCredentialStorage(safeStorage),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    })
    let created: ChatService | undefined
    const store = new ChatStore(join(userData, 'chat.sqlite'), (accountId) => created!.cipherFor(accountId))
    created = new ChatService({
      store, vault, factory: host, gate, mediaDirectory: join(userData, 'chat-media'),
      locked: options.isLocked, notificationsEnabled: options.notificationsEnabled, online: options.online,
      notify, changed: broadcast,
      chooseFile: async () => {
        const window = options.mainWindow()
        const result = window ? await dialog.showOpenDialog(window, { properties: ['openFile'] }) : await dialog.showOpenDialog({ properties: ['openFile'] })
        return result.canceled ? undefined : result.filePaths[0]
      },
      chooseSavePath: async (name) => {
        const window = options.mainWindow()
        const result = window ? await dialog.showSaveDialog(window, { defaultPath: name }) : await dialog.showSaveDialog({ defaultPath: name })
        return result.canceled ? undefined : result.filePath
      },
      log: (event, details) => options.log(event, details)
    })
    service = created
    void created.start().catch((error) => options.log('chat-start-failed', undefined, error))
  }
  const unavailable = (): ChatSnapshot => ({ gate: gate(), accounts: [], rooms: [], verifications: [] })

  // Crypto persistence is proven once per SDK/Electron version in the real runtime
  // (a pass or a failure is recorded; AERIO_CHAT_SELF_TEST=1 forces a rerun).
  const current = gate()
  const recorded = evidence?.sdk === CHAT_SDK_VERSION && evidence.electron === process.versions.electron && evidence.cryptoPersistence
  const prerequisites = current.checks.filter((check) => check.id === 'secure-storage' || check.id === 'service-runtime').every((check) => check.passed)
  if (prerequisites && (!recorded || process.env.AERIO_CHAT_SELF_TEST === '1')) {
    void host.selfTest().then((result) => {
      evidence = { ...(evidence?.sdk === CHAT_SDK_VERSION && evidence.electron === process.versions.electron ? evidence : {}), sdk: CHAT_SDK_VERSION, electron: process.versions.electron ?? '', cryptoPersistence: { ...result, checkedAt: new Date().toISOString() } }
      writeGateEvidence(evidencePath, evidence)
      options.log('chat-self-test', { passed: result.passed })
      startService()
      broadcast({ type: 'snapshot', snapshot: service?.snapshot() ?? unavailable() })
    }).catch((error) => options.log('chat-self-test-failed', undefined, error))
  } else startService()

  return {
    service: () => service,
    snapshot: () => service?.snapshot() ?? unavailable(),
    isServiceSender: (senderId) => host.isServiceSender(senderId),
    lockChanged: (locked) => {
      service?.lockChanged(locked)
      if (!locked && pendingRoute) {
        const route = pendingRoute
        pendingRoute = undefined
        broadcast({ type: 'open-room', accountId: route.accountId, roomId: route.roomId, eventId: route.eventId || undefined })
      }
    },
    networkChanged: () => service?.networkChanged(),
    dispose: async () => { await service?.stop() }
  }
}
