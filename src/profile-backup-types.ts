export type ProfileBackupTrigger = 'manual' | 'scheduled'

export interface ProfileBackupCount {
  label: string
  count: number
}

export interface ProfileBackupSummary {
  path: string
  createdAt: string
  trigger: ProfileBackupTrigger
  appVersion: string
  totalBytes: number
  fileCount: number
}

export interface ProfileBackupPreview extends ProfileBackupSummary {
  schemaVersion: number
  counts: ProfileBackupCount[]
  /** Outgoing, scheduled, or undo-window sends that restore will hold for review. */
  heldSends: number
  /** Connected task and list writes that restore will hold for review. */
  heldTaskWrites: number
  /** Active mail accounts that must be reauthorized because credentials are never backed up. */
  accountsToReauthorize: number
  /** The backup came from a different profile folder; managed file paths are rebased on restore. */
  differentProfile: boolean
  warnings: string[]
}

export interface ProfileBackupSchedule {
  enabled: boolean
  intervalHours: number
  keep: number
  directory: string
}

export interface ProfileBackupStatus {
  schedule: ProfileBackupSchedule
  running: boolean
  lastBackupAt?: string
  lastBackupPath?: string
  lastError?: string
  nextBackupAt?: string
  backups: ProfileBackupSummary[]
  lastRestore?: ProfileRestoreOutcome
}

export interface ProfileRestoreReport {
  heldSends: number
  heldTaskWrites: number
  accountsToReauthorize: number
  rebasedPaths: boolean
}

export interface ProfileRestoreOutcome {
  status: 'applied' | 'rolled-back'
  backupCreatedAt: string
  completedAt: string
  report?: ProfileRestoreReport
  error?: string
}

export interface ProfileBackupApi {
  status(): Promise<ProfileBackupStatus>
  saveSchedule(schedule: ProfileBackupSchedule): Promise<ProfileBackupStatus>
  chooseDirectory(): Promise<string | undefined>
  backupNow(): Promise<ProfileBackupSummary>
  /** Prompts for a backup folder when no path is given, then verifies it and returns what restore would change. */
  preview(path?: string): Promise<ProfileBackupPreview | undefined>
  /** Stages a verified backup and restarts Aerio to swap it in. */
  restore(path: string): Promise<{ restarting: true }>
  dismissRestoreOutcome(): Promise<void>
}
