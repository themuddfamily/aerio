import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ChatGateCheck, ChatGateStatus } from '../../src/chat-types'

/**
 * The Chat enablement gate (docs/chat-implementation-proposal.md, step 1 and
 * step 6). Chat navigation appears only when every check passes:
 *
 * - secure-storage: OS-backed credential encryption (no Linux `basic_text`).
 * - service-runtime: the packaged chat service bundle and preload exist.
 * - crypto-persistence: a runtime self-test in the pinned Electron proved the
 *   SDK's Rust crypto store persists in an isolated partition, reopens with the
 *   same identity, and refuses to open with a different storage key.
 * - interoperability: recorded evidence of two-device verification and
 *   encrypted messaging against a configured (hosted) homeserver for this SDK
 *   and Electron version. The loopback fixture cannot supply this.
 *
 * AERIO_CHAT_PREVIEW=1 waives only the interoperability check, for development.
 */
export const CHAT_SDK_VERSION = 'matrix-js-sdk 43.0.0'

export interface ChatGateEvidence {
  sdk: string
  electron: string
  cryptoPersistence?: { passed: boolean; detail: string; checkedAt: string }
  interoperability?: { passed: boolean; detail: string; checkedAt: string; homeserver: string }
}

export interface ChatGateInputs {
  secureStorage: () => void
  serviceRuntime: () => boolean
  evidence: ChatGateEvidence | undefined
  electronVersion: string
  preview: boolean
}

export function readGateEvidence(path: string): ChatGateEvidence | undefined {
  try {
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as ChatGateEvidence
    return typeof value.sdk === 'string' && typeof value.electron === 'string' ? value : undefined
  } catch { return undefined }
}

export function writeGateEvidence(path: string, evidence: ChatGateEvidence) {
  writeFileSync(path, JSON.stringify(evidence, null, 2))
}

export function evaluateChatGate(inputs: ChatGateInputs): ChatGateStatus {
  const checks: ChatGateCheck[] = []
  try {
    inputs.secureStorage()
    checks.push({ id: 'secure-storage', label: 'Secure credential storage', passed: true, detail: 'OS-backed encryption is available for Chat tokens and keys.' })
  } catch (error) {
    checks.push({ id: 'secure-storage', label: 'Secure credential storage', passed: false, detail: error instanceof Error ? error.message : 'Secure credential storage is unavailable.' })
  }
  const runtime = inputs.serviceRuntime()
  checks.push({ id: 'service-runtime', label: 'Isolated chat service', passed: runtime, detail: runtime ? 'The packaged chat service is present.' : 'The chat service bundle is missing from this build.' })
  const current = inputs.evidence && inputs.evidence.sdk === CHAT_SDK_VERSION && inputs.evidence.electron === inputs.electronVersion ? inputs.evidence : undefined
  const persistence = current?.cryptoPersistence
  checks.push({
    id: 'crypto-persistence', label: 'Encrypted crypto-store persistence', passed: Boolean(persistence?.passed), checkedAt: persistence?.checkedAt,
    detail: persistence ? persistence.detail : 'Not yet verified for this SDK and Electron version.'
  })
  const interop = current?.interoperability
  checks.push({
    id: 'interoperability', label: 'Two-device interoperability', passed: Boolean(interop?.passed), checkedAt: interop?.checkedAt,
    detail: interop ? `${interop.detail} (${interop.homeserver})` : 'No hosted two-device verification and encrypted-messaging evidence is recorded for this version. A local test fixture cannot establish it.'
  })
  const essential = checks.filter((check) => check.id !== 'interoperability').every((check) => check.passed)
  const enabled = essential && (checks.every((check) => check.passed) || inputs.preview)
  const failing = checks.filter((check) => !check.passed)
  return {
    enabled,
    preview: enabled && !checks.every((check) => check.passed),
    checks,
    sdkVersion: CHAT_SDK_VERSION,
    message: !failing.length ? 'Chat is available.'
      : enabled ? 'Chat preview: hosted interoperability is unverified for this version.'
        : `Chat stays unavailable until these checks pass: ${failing.map((check) => check.label.toLowerCase()).join(', ')}.`
  }
}
