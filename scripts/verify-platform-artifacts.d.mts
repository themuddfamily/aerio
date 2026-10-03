export interface PlatformArtifactsOptions {
  directory?: string
  platform: string
  arch?: string
  packageJson: { name: string; version: string; main: string; build: { productName: string; publish: { provider: string; owner: string; repo: string }[] } }
  checkContainers?: (input: { platform: string; arch: string; artifacts: Map<string, { path: string; size: number }> }) => Promise<void>
}
export function verifyPlatformArtifacts(options: PlatformArtifactsOptions): Promise<{ platform: string; arch: string; version: string; artifacts: string[]; manifest: string }>
