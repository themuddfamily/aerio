export interface HostedConfig { homeserver: string; userA: string; passwordA: string; userB: string; passwordB: string; disposableAccounts: true; acceptServerMutations: true }
export interface HostedReport { sdk: string; electron: string; homeserver: string; checkedAt: string; versions: string[]; capabilities: { password: true; names: string[] }; checks: { id: string; passed: boolean }[] }
export const HOSTED_CHECKS: readonly string[]
export function publicAddress(value: string): boolean
export function validateHostedConfig(value: unknown): HostedConfig
export function validateReport(report: unknown, expected: Pick<HostedReport, 'sdk' | 'electron' | 'homeserver'>): HostedReport & { schema: number; passwordLogin: true }
