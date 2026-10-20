export interface SpotlightSettings { enabled: boolean; accountIds: string[]; includePreview: boolean }
export interface SpotlightStatus { platformSupported: boolean; available: boolean; settings: SpotlightSettings; indexed: number; limit: number; syncing: boolean; lastIndexed?: string; error?: string }
export interface SpotlightApi { status(): Promise<SpotlightStatus>; save(settings: SpotlightSettings): Promise<SpotlightStatus>; refresh(): Promise<SpotlightStatus>; onChanged(callback: (status: SpotlightStatus) => void): () => void }
