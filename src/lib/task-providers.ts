import type { TaskProvider } from '../task-provider-types'

/** Product names for connected task sources. */
export const taskProviderName = (provider: TaskProvider | undefined) => provider === 'microsoft' ? 'Microsoft To Do' : provider === 'dav' ? 'CalDAV tasks' : 'Google Tasks'

/** Short provider names used in "Refresh … tasks" and review text. */
export const taskProviderShortName = (provider: TaskProvider | undefined) => provider === 'microsoft' ? 'Microsoft' : provider === 'dav' ? 'CalDAV' : 'Google'

/** The account fallback label when no mail account matches. */
export const taskAccountLabel = (provider: TaskProvider, recovered?: boolean) => recovered
  ? `Recovered ${taskProviderShortName(provider)} tasks`
  : provider === 'microsoft' ? 'Microsoft account' : provider === 'dav' ? 'CalDAV account' : 'Google account'
