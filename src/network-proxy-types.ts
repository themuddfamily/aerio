export interface NetworkProxySettings {
  mode: 'system' | 'direct' | 'manual'
  /** HTTP(S) proxy origin only; never includes credentials. */
  server: string
  /** Comma-separated exact hosts or *.domain patterns. Loopback always bypasses. */
  bypass: string
}
export interface NetworkProxyStatus extends NetworkProxySettings {
  hasCredentials: boolean
  secureStorage: boolean
  restartRequired: boolean
}
export interface NetworkProxyInput extends NetworkProxySettings {
  username?: string
  password?: string
  clearCredentials?: boolean
}
export interface NetworkProxyApi {
  status(): Promise<NetworkProxyStatus>
  configure(input: NetworkProxyInput): Promise<NetworkProxyStatus>
}
